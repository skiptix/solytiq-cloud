import crypto from 'crypto';
// ---------------------------------------------------------------------------
// Shared AI tool registry — THE single source of truth for AI capabilities.
//
// Every tool is defined once here with (1) a JSON-Schema parameter spec and
// (2) a server-side SQL handler. Both consumers use this registry:
//   • the MCP server (routes/mcp.ts)   — exposes tools to external agents
//   • the internal "Sol" assistant     — via GET /api/ai/tools + POST /api/ai/execute
//
// SECURITY: handlers receive a `userId` that is ALWAYS derived from the verified
// credential (session JWT or PAT) — never from tool arguments. Every query is
// scoped by user_id so an agent can only ever touch its own data. There is no
// `user_id` parameter on any tool, by design, to remove any prompt-injection
// surface for cross-user access.
// ---------------------------------------------------------------------------

import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from './db';
import { broadcastToUser } from './sse';
import { resolveWorkspaceForUser } from './workspaceUtil';
import { softDeleteListTree, snapshotTimelineToTrash } from './trashUtil';
import { extractTextFromBuffer, MAX_TEXT_CHARS } from './fileText';
import { UPLOAD_DIR } from './routes/files';
import {
  mutateMarkdownListBlocks,
  createMarkdownListForUser,
  deleteMarkdownListForUser,
  type MarkdownBlockLike,
} from './routes/markdownLists';
import { parseRecurrenceRule, computeRecurrenceDates } from './recurrence';
import { resolveInviteeIds, setMeetingAttendees } from './meetingAttendees';
import { hashPassword } from './auth';
import {
  captureListStructure,
  captureTimelineStructure,
  instantiateListStructure,
  instantiateTimelineStructure,
  makeTaskIdGenerator,
  todayISODate,
  type TemplateListNode,
  type TemplateTimelineNode,
} from './templateUtil';
import { isValidEntityType, parseSrn, formatSrn } from './graph/srn';
import { isEntityVisible, canWriteEntity } from './graph/visibility';
import { searchEntityIndex } from './graph/entityIndex';
import { upsertLink, deleteLink, getLinkById, getEntityLinks, getBacklinks, findUnlinkedMentions, LinkError } from './graph/links';
import { hybridSearch } from './knowledge/search';
import { getQueueStats } from './knowledge/queue';
import { isPgvectorAvailable } from './knowledge/state';
import { getEmbeddingConfig } from './knowledge/embedProvider';
import { userCanAccessWorkspace } from './workspaceUtil';
import { lookupTerm, listGlossary } from './knowledgeBase/lookup';
import { enqueueEmbedding } from './knowledge/queue';
import {
  getBaseForWorkspace, createBase, createEntry, updateEntry, deleteEntry, getEntry, getBaseById,
  ENTRY_TYPES, type BlockLike, type KnowledgeBaseRow, type KnowledgeEntryRow,
} from './knowledgeBase/entries';
import { mutateEntryBlocks } from './knowledgeBase/blocks';
import { startAgentRun } from './agent/runtime';
import {
  listSkills, findSkill, createSkill, updateSkill, deleteSkill,
  listSkillFiles, getSkillFile, setSkillFile, removeSkillFile, isUserAdmin,
} from './aiSkills/skills';
import { listMemory, addMemory, removeMemory } from './aiMemory';

// A minimal JSON Schema object for a tool's parameters.
export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolResult {
  ok: boolean;
  /** Human/AI-readable result text (returned to the model / MCP client). */
  result: string;
  /** Short past-tense summary for the internal AI's action chip (optional). */
  summary?: string;
}

export interface AiTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  handler: (userId: string, args: Record<string, unknown>) => Promise<ToolResult>;
  /**
   * Excluded from getOpenRouterToolDefs() (the internal "Sol" assistant AND
   * the Agent Runtime's own tool-calling loop — see agent/runtime.ts, which
   * builds its tool list from the same function) — still exposed via
   * getMcpToolDefs() to external MCP clients. Used for the Agent Runtime
   * meta-tools (start/list/accept/reject a run or proposal): those let an
   * EXTERNAL orchestrator control our agent, but must never be callable BY
   * the agent itself, which would let a run recursively spawn more runs with
   * no bound beyond each new run's own separate budget — an unbounded-fork
   * risk, not just a bad idea.
   */
  mcpOnly?: boolean;
}

// ── small helpers ────────────────────────────────────────────────────────

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined);
const PRIORITIES = new Set(['High', 'Medium', 'Low']);
const STATUSES = new Set(['upcoming', 'in-progress', 'done']);
const LAYOUTS = new Set(['vertical', 'compact', 'detailed']);

function genTaskId(): number {
  return Date.now() * 1000 + crypto.randomInt(1000);
}

// ---------------------------------------------------------------------------
// Knowledge Base access helpers.
//
// Reads need workspace ACCESS; writes need workspace MEMBERSHIP — the same
// asymmetry routes/knowledgeBase.ts enforces, restated here because tools are a
// second entry point into the same data and must not be the looser one. Both
// return a plain `{ error }` so a tool can surface it verbatim rather than
// throwing through the tool loop.
// ---------------------------------------------------------------------------

async function isWorkspaceMemberForTools(userId: string, workspaceId: string): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2
     UNION
     SELECT 1 FROM workspaces WHERE id = $1 AND owner_id = $2`,
    [workspaceId, userId]
  );
  return r.rows.length > 0;
}

async function requireWritableBase(
  userId: string,
  workspaceId: string
): Promise<{ base: KnowledgeBaseRow } | { error: string }> {
  if (!(await isWorkspaceMemberForTools(userId, workspaceId))) return { error: 'workspace not found' };
  const base = await getBaseForWorkspace(workspaceId);
  // Name the tool that fixes this. An MCP client has no sidebar to be pointed
  // at, so an instruction it cannot follow reads as a dead end rather than a
  // recoverable step.
  if (!base) return { error: 'this workspace has no Knowledge Base yet — call create_knowledge_base first' };
  return { base };
}

async function requireWritableEntry(
  userId: string,
  entryId: string
): Promise<{ entry: KnowledgeEntryRow; base: KnowledgeBaseRow } | { error: string }> {
  const entry = await getEntry(entryId);
  if (!entry) return { error: 'entry not found' };
  const base = await getBaseById(entry.kb_id);
  // Existence-safe: an entry in a workspace the caller can't reach reports as
  // absent, never as forbidden.
  if (!base || !(await isWorkspaceMemberForTools(userId, base.workspace_id))) return { error: 'entry not found' };
  return { entry, base };
}

/**
 * Plain text → paragraph blocks, the body format both Knowledge Base write
 * tools accept. A model hands us prose, not the editor's block JSON, so the
 * split is on blank lines — the same paragraph boundary knowledge/chunker.ts
 * already treats as meaningful.
 */
function knowledgeBodyBlocks(raw: string): BlockLike[] {
  return raw
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((text) => ({ id: genBlockId(), type: 'paragraph', text }));
}

function ok(result: string, summary?: string): ToolResult {
  return { ok: true, result, summary };
}
function fail(result: string): ToolResult {
  return { ok: false, result: result.startsWith('Error') ? result : `Error: ${result}` };
}

// ── markdown page block helpers ────────────────────────────────────────────

// Block types the AI may CREATE from scratch (image is excluded — it needs a
// real file upload from the UI; it can only ever be preserved/reordered).
const MARKDOWN_BLOCK_TYPES = new Set(['heading', 'paragraph', 'bulleted-list-item', 'numbered-list-item', 'todo', 'quote', 'divider', 'link', 'table']);
const MARKDOWN_TABLE_AGGREGATES = new Set(['sum', 'avg', 'median', 'max', 'min']);
// Plain text-bearing block types (build a block from just its `text`).
const MARKDOWN_TEXT_BLOCK_TYPES = new Set(['paragraph', 'bulleted-list-item', 'numbered-list-item', 'quote']);

function genBlockId(): string {
  return `blk_${uuidv4()}`;
}

function describeMarkdownBlock(b: MarkdownBlockLike): string {
  switch (b.type) {
    case 'heading': return `[heading h${b.level}] ${(b.text as string) || '(empty)'}`;
    case 'todo': return `[todo${b.checked ? ' x' : ' '}] ${(b.text as string) || '(empty)'}`;
    case 'divider': return b.layout === 'columns' ? '[divider · 2-column layout] ───' : '[divider] ───';
    case 'link': return `[link] ${(b.title as string) || (b.url as string)} (${b.url})${b.description ? ` — ${b.description}` : ''}`;
    case 'image': return `[image] (image_id: ${(b.imageId as string) ?? '?'})${b.caption ? ` caption: "${b.caption}"` : ''}`;
    case 'table': {
      const cols = Array.isArray(b.columns) ? b.columns.length : 0;
      const rws = Array.isArray(b.rows) ? b.rows.length : 0;
      return `[table] ${cols} column(s) × ${rws} row(s) incl. header`;
    }
    default: return `[${b.type}] ${(b.text as string) || '(empty)'}`;
  }
}

/**
 * Build (and validate) one markdown block from a loose spec object — shared by
 * add_markdown_block, add_markdown_blocks, create_markdown_list, and
 * set_markdown_content so every entry point constructs blocks identically.
 *
 * `ctx.allowImagePreserve` (used only by set_markdown_content) permits an image
 * block, but strictly as a *reference to an already-existing* image on the page
 * — never a newly-invented one — because images require a real file upload the
 * AI cannot perform. Todos may carry over their mirror task by referencing an
 * existing todo block's id (`ctx.todoTaskIdByBlockId`).
 */
export interface BlockBuildContext {
  allowImagePreserve?: boolean;
  existingImageIds?: Set<string>;
  todoTaskIdByBlockId?: Map<string, string | null>;
}

export function buildMarkdownBlockFromSpec(
  spec: Record<string, unknown>,
  ctx?: BlockBuildContext
): { block: MarkdownBlockLike } | { error: string } {
  const type = str(spec.type);
  if (!type) return { error: 'each block needs a "type"' };
  const providedId = str(spec.id);
  const blockId = providedId ?? genBlockId();

  switch (type) {
    case 'divider': {
      const layout = str(spec.layout);
      if (layout && layout !== 'stack' && layout !== 'columns') return { error: 'divider layout must be "stack" or "columns"' };
      return { block: layout === 'columns' ? { id: blockId, type: 'divider', layout: 'columns' } : { id: blockId, type: 'divider' } };
    }
    case 'heading': {
      const level = Number(spec.level);
      if (![1, 2, 3].includes(level)) return { error: 'heading blocks require level 1, 2, or 3' };
      return { block: { id: blockId, type: 'heading', level, text: str(spec.text) ?? '' } };
    }
    case 'todo': {
      const priorTaskId = providedId ? (ctx?.todoTaskIdByBlockId?.get(providedId) ?? null) : null;
      return { block: { id: blockId, type: 'todo', text: str(spec.text) ?? '', checked: spec.checked === true, taskId: priorTaskId } };
    }
    case 'link': {
      const url = str(spec.url);
      if (!url) return { error: 'link blocks require a "url"' };
      return { block: { id: blockId, type: 'link', url, title: str(spec.title) ?? null, description: str(spec.description) ?? null } };
    }
    case 'image': {
      if (!ctx?.allowImagePreserve) return { error: 'image blocks cannot be created by AI — they require a real file upload from the UI' };
      const imageId = str(spec.image_id) ?? str(spec.imageId);
      if (!imageId) return { error: 'to keep an image block, pass its image_id (from get_markdown_list)' };
      if (ctx.existingImageIds && !ctx.existingImageIds.has(imageId)) return { error: `image ${imageId} is not an existing image on this page (images cannot be created by AI)` };
      const block: MarkdownBlockLike = { id: blockId, type: 'image', imageId };
      const caption = str(spec.caption);
      if (caption !== undefined) block.caption = caption;
      return { block };
    }
    case 'table': {
      const rawCols = Array.isArray(spec.columns) ? spec.columns : null;
      if (!rawCols || rawCols.length === 0) return { error: 'table blocks require a non-empty "columns" array of header labels' };
      // A column may be a plain header string or { text, aggregate }.
      const headerLabels = rawCols.map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object' && typeof (c as Record<string, unknown>).text === 'string') return (c as Record<string, string>).text;
        return '';
      });
      const n = headerLabels.length;
      const cell = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
      const padRow = (arr: unknown): string[] => {
        const src = Array.isArray(arr) ? arr : [];
        return Array.from({ length: n }, (_, i) => cell(src[i]));
      };
      // Per-column aggregate: from an explicit `aggregates` array, or a column object's own `aggregate`.
      const rawAggs = Array.isArray(spec.aggregates) ? spec.aggregates : [];
      const columns = headerLabels.map((_, i) => {
        const fromCol = rawCols[i] && typeof rawCols[i] === 'object' ? (rawCols[i] as Record<string, unknown>).aggregate : undefined;
        const a = str(rawAggs[i]) ?? str(fromCol);
        return { id: `col_${uuidv4()}`, width: 160, aggregate: a && MARKDOWN_TABLE_AGGREGATES.has(a) ? a : null };
      });
      const headerRow = { id: `row_${uuidv4()}`, height: 40, cells: padRow(headerLabels) };
      const bodyRows = (Array.isArray(spec.rows) ? spec.rows : []).map((r) => ({ id: `row_${uuidv4()}`, height: 40, cells: padRow(r) }));
      return { block: { id: blockId, type: 'table', columns, rows: [headerRow, ...bodyRows] } };
    }
    default:
      if (!MARKDOWN_TEXT_BLOCK_TYPES.has(type)) return { error: `unknown block type "${type}"` };
      return { block: { id: blockId, type, text: str(spec.text) ?? '' } };
  }
}

/** Splices `block` into `blocks` per a shared start/end/after position contract used by add + move. */
function insertAtPosition(
  blocks: MarkdownBlockLike[],
  block: MarkdownBlockLike,
  position: string | undefined,
  afterBlockId: string | undefined
): MarkdownBlockLike[] | { error: string } {
  return insertManyAtPosition(blocks, [block], position, afterBlockId);
}

/** Splices `newBlocks` (in order) into `blocks` at the shared start/end/after position. */
function insertManyAtPosition(
  blocks: MarkdownBlockLike[],
  newBlocks: MarkdownBlockLike[],
  position: string | undefined,
  afterBlockId: string | undefined
): MarkdownBlockLike[] | { error: string } {
  if (position === 'start') return [...newBlocks, ...blocks];
  if (position === 'after') {
    if (!afterBlockId) return { error: 'after_block_id is required when position is "after"' };
    const idx = blocks.findIndex((b) => b.id === afterBlockId);
    if (idx === -1) return { error: `block ${afterBlockId} not found` };
    const next = [...blocks];
    next.splice(idx + 1, 0, ...newBlocks);
    return next;
  }
  return [...blocks, ...newBlocks]; // 'end', or unspecified
}

// ── tool definitions ───────────────────────────────────────────────────────

export const aiTools: AiTool[] = [
  // ───────────────────────────── reads ─────────────────────────────
  {
    name: 'list_workspaces',
    description: "List every workspace the user belongs to (id, name, description, visibility, role). Use this — together with the workspace_id shown on list_lists/list_folders/list_timelines — to figure out which workspace a batch of new content thematically belongs to when the user hasn't said which one to use.",
    parameters: { type: 'object', properties: {} },
    handler: async (userId) => {
      const rows = await query<{ id: string; name: string; description: string | null; visibility: string; role: string }>(
        `SELECT w.id, w.name, w.description, w.visibility, wm.role
         FROM workspaces w
         LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = $1
         WHERE wm.user_id = $1 OR w.owner_id = $1 OR w.visibility = 'public'
         ORDER BY w.created_at ASC`,
        [userId]
      );
      if (!rows.rows.length) return ok('You have no workspaces.');
      return ok(rows.rows.map((w) => `• "${w.name}" (workspace_id: ${w.id}; ${w.visibility}; role: ${w.role ?? 'member'}${w.description ? `; "${w.description}"` : ''})`).join('\n'));
    },
  },
  {
    name: 'list_lists',
    description: "List all of the user's lists across every workspace, with their sections (ids included) and which workspace each belongs to. Use to discover list_id and section_id before creating tasks, and workspace_id to figure out which workspace a list lives in.",
    parameters: { type: 'object', properties: {} },
    handler: async (userId) => {
      const lists = await query<{ id: string; name: string; emoji: string | null; folder_id: string | null; workspace_id: string | null; workspace_name: string | null }>(
        `SELECT l.id, l.name, l.emoji, l.folder_id, l.workspace_id, w.name AS workspace_name
         FROM lists l LEFT JOIN workspaces w ON w.id = l.workspace_id
         WHERE l.user_id = $1 AND l.depth = 0 ORDER BY l.position ASC`,
        [userId]
      );
      if (!lists.rows.length) return ok('You have no lists yet.');
      const ids = lists.rows.map((l) => l.id);
      const secs = await query<{ id: string; list_id: string; label: string }>(
        `SELECT id, list_id, label FROM sections WHERE list_id = ANY($1::varchar[]) ORDER BY position ASC`,
        [ids]
      );
      const byList: Record<string, string[]> = {};
      for (const s of secs.rows) (byList[s.list_id] ??= []).push(`"${s.label}" (section_id: ${s.id})`);
      const text = lists.rows
        .map((l) => `• ${l.emoji ?? ''} "${l.name}" (list_id: ${l.id}; workspace: "${l.workspace_name ?? 'unknown'}" [workspace_id: ${l.workspace_id}])\n    sections: ${(byList[l.id] ?? ['none']).join(', ')}`)
        .join('\n');
      return ok(text);
    },
  },
  {
    name: 'get_list',
    description: 'Get a single list with all its sections and tasks (titles, completion, deadlines, priorities, ids).',
    parameters: {
      type: 'object',
      properties: { list_id: { type: 'string', description: 'ID of the list to read' } },
      required: ['list_id'],
    },
    handler: async (userId, args) => {
      const listId = str(args.list_id);
      if (!listId) return fail('list_id is required');
      const list = await query<{ name: string; emoji: string | null }>(
        `SELECT name, emoji FROM lists WHERE id = $1 AND user_id = $2`,
        [listId, userId]
      );
      if (!list.rows.length) return fail('list not found');
      const secs = await query<{ id: string; label: string }>(
        `SELECT id, label FROM sections WHERE list_id = $1 ORDER BY position ASC`,
        [listId]
      );
      const tasks = await query<{ id: string; title: string; checked: boolean; deadline: string | null; priority: string | null; section_id: string | null }>(
        `SELECT id, title, checked, deadline, priority, section_id FROM tasks
         WHERE list_id = $1 AND source = 'list' ORDER BY position ASC, created_at ASC`,
        [listId]
      );
      const lines: string[] = [`${list.rows[0].emoji ?? ''} "${list.rows[0].name}" (list_id: ${listId})`];
      for (const s of secs.rows) {
        lines.push(`  § "${s.label}" (section_id: ${s.id})`);
        const items = tasks.rows.filter((t) => t.section_id === s.id);
        if (!items.length) lines.push('      (no tasks)');
        for (const t of items) {
          const meta = [t.checked ? 'done' : 'open', t.deadline ? `due ${t.deadline}` : null, t.priority].filter(Boolean).join(', ');
          lines.push(`      - [${t.checked ? 'x' : ' '}] ${t.title} (task_id: ${t.id}${meta ? `; ${meta}` : ''})`);
        }
      }
      return ok(lines.join('\n'));
    },
  },
  {
    name: 'list_tasks',
    description: 'List the dashboard tasks (quick-add tasks not inside any list). By default hides completed tasks.',
    parameters: {
      type: 'object',
      properties: { include_completed: { type: 'boolean', description: 'Include completed tasks (default false)' } },
    },
    handler: async (userId, args) => {
      const includeDone = args.include_completed === true;
      const rows = await query<{ id: string; title: string; checked: boolean; deadline: string | null; priority: string | null }>(
        `SELECT id, title, checked, deadline, priority FROM tasks
         WHERE user_id = $1 AND source = 'dash' ${includeDone ? '' : 'AND checked = false'}
         ORDER BY position ASC, created_at ASC`,
        [userId]
      );
      if (!rows.rows.length) return ok('No dashboard tasks.');
      const text = rows.rows
        .map((t) => `- [${t.checked ? 'x' : ' '}] ${t.title} (task_id: ${t.id}${t.deadline ? `; due ${t.deadline}` : ''}${t.priority ? `; ${t.priority}` : ''})`)
        .join('\n');
      return ok(text);
    },
  },
  {
    name: 'list_folders',
    description: "List all of the user's folders across every workspace (ids included), used to group lists and timelines. Includes which workspace each folder belongs to.",
    parameters: { type: 'object', properties: {} },
    handler: async (userId) => {
      const rows = await query<{ id: string; name: string; emoji: string | null; workspace_id: string | null; workspace_name: string | null }>(
        `SELECT f.id, f.name, f.emoji, f.workspace_id, w.name AS workspace_name
         FROM folders f LEFT JOIN workspaces w ON w.id = f.workspace_id
         WHERE f.user_id = $1 ORDER BY f.position ASC`,
        [userId]
      );
      if (!rows.rows.length) return ok('You have no folders yet.');
      return ok(rows.rows.map((f) => `• ${f.emoji ?? ''} "${f.name}" (folder_id: ${f.id}; workspace: "${f.workspace_name ?? 'unknown'}" [workspace_id: ${f.workspace_id}])`).join('\n'));
    },
  },
  {
    name: 'list_timelines',
    description: "List all of the user's timelines across every workspace with milestone counts (ids included) and which workspace each belongs to.",
    parameters: { type: 'object', properties: {} },
    handler: async (userId) => {
      const rows = await query<{ id: string; name: string; emoji: string | null; total: string; done: string; workspace_id: string | null; workspace_name: string | null }>(
        `SELECT t.id, t.name, t.emoji, t.workspace_id, w.name AS workspace_name,
                (SELECT COUNT(*) FROM milestones m WHERE m.timeline_id = t.id) AS total,
                (SELECT COUNT(*) FROM milestones m WHERE m.timeline_id = t.id AND m.status = 'done') AS done
         FROM timelines t LEFT JOIN workspaces w ON w.id = t.workspace_id
         WHERE t.user_id = $1 ORDER BY t.position ASC`,
        [userId]
      );
      if (!rows.rows.length) return ok('You have no timelines yet.');
      return ok(rows.rows.map((t) => `• ${t.emoji ?? ''} "${t.name}" (timeline_id: ${t.id}; ${t.done}/${t.total} done; workspace: "${t.workspace_name ?? 'unknown'}" [workspace_id: ${t.workspace_id}])`).join('\n'));
    },
  },
  {
    name: 'get_timeline',
    description: 'Get a single timeline with all its milestones (titles, dates, status, ids).',
    parameters: {
      type: 'object',
      properties: { timeline_id: { type: 'string', description: 'ID of the timeline to read' } },
      required: ['timeline_id'],
    },
    handler: async (userId, args) => {
      const tlId = str(args.timeline_id);
      if (!tlId) return fail('timeline_id is required');
      const tl = await query<{ name: string; emoji: string | null }>(
        `SELECT name, emoji FROM timelines WHERE id = $1 AND user_id = $2`,
        [tlId, userId]
      );
      if (!tl.rows.length) return fail('timeline not found');
      const ms = await query<{ id: string; title: string; milestone_date: string | null; status: string }>(
        `SELECT id, title, milestone_date, status FROM milestones WHERE timeline_id = $1
         ORDER BY milestone_date ASC NULLS LAST, position ASC, created_at ASC`,
        [tlId]
      );
      const lines = [`${tl.rows[0].emoji ?? ''} "${tl.rows[0].name}" (timeline_id: ${tlId})`];
      if (!ms.rows.length) lines.push('  (no milestones)');
      for (const m of ms.rows) lines.push(`  - ${m.title} (milestone_id: ${m.id}; ${m.status}${m.milestone_date ? `; ${m.milestone_date}` : ''})`);
      return ok(lines.join('\n'));
    },
  },

  // ───────────────────────────── tasks ─────────────────────────────
  {
    name: 'create_dashboard_task',
    description: 'Create a new task on the Dashboard (a quick-add task not inside any list). If the user did not say which workspace to use, pass workspace_id only when you have good evidence (from list_workspaces/list_lists) that a workspace other than the current one is the better fit — otherwise omit it to use the current workspace.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title' },
        deadline: { type: 'string', description: 'Due date YYYY-MM-DD (optional)' },
        priority: { type: 'string', enum: ['High', 'Medium', 'Low'] },
        note: { type: 'string', description: 'Optional notes' },
        workspace_id: { type: 'string', description: 'Target workspace ID (from list_workspaces). Omit to use the current/personal workspace.' },
      },
      required: ['title'],
    },
    handler: async (userId, args) => {
      const title = str(args.title);
      if (!title) return fail('title is required');
      const priority = str(args.priority);
      if (priority && !PRIORITIES.has(priority)) return fail('priority must be High, Medium, or Low');
      const ws = await resolveWorkspaceForUser(userId, str(args.workspace_id) ?? null);
      const pos = await query<{ max: string | null }>(
        `SELECT MAX(position) AS max FROM tasks WHERE user_id = $1 AND source = 'dash'`,
        [userId]
      );
      const nextPos = pos.rows[0].max !== null ? parseInt(pos.rows[0].max, 10) + 1 : 0;
      const id = genTaskId();
      await query(
        `INSERT INTO tasks (id, user_id, title, note, deadline, priority, source, position, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'dash', $7, $8)`,
        [id, userId, title, str(args.note) ?? null, str(args.deadline) ?? null, priority ?? null, nextPos, ws]
      );
      broadcastToUser(userId, 'tasks');
      return ok(`Created dashboard task "${title}" (task_id: ${id})`, `Added "${title}"`);
    },
  },
  {
    name: 'create_task_in_list',
    description: 'Create a task inside a specific list section. Use list_lists or get_list first to find list_id and section_id.',
    parameters: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'Target list ID' },
        section_id: { type: 'string', description: 'Target section ID within that list' },
        title: { type: 'string', description: 'Task title' },
        deadline: { type: 'string', description: 'Due date YYYY-MM-DD (optional)' },
        priority: { type: 'string', enum: ['High', 'Medium', 'Low'] },
        note: { type: 'string' },
      },
      required: ['list_id', 'section_id', 'title'],
    },
    handler: async (userId, args) => {
      const listId = str(args.list_id);
      const sectionId = str(args.section_id);
      const title = str(args.title);
      if (!listId || !sectionId || !title) return fail('list_id, section_id and title are required');
      const priority = str(args.priority);
      if (priority && !PRIORITIES.has(priority)) return fail('priority must be High, Medium, or Low');
      const list = await query<{ workspace_id: string | null }>(
        `SELECT workspace_id FROM lists WHERE id = $1 AND user_id = $2`,
        [listId, userId]
      );
      if (!list.rows.length) return fail('list not found');
      const sec = await query(`SELECT 1 FROM sections WHERE id = $1 AND list_id = $2`, [sectionId, listId]);
      if (!sec.rows.length) return fail('section not found in that list');
      const pos = await query<{ max: string | null }>(`SELECT MAX(position) AS max FROM tasks WHERE section_id = $1`, [sectionId]);
      const nextPos = pos.rows[0].max !== null ? parseInt(pos.rows[0].max, 10) + 1 : 0;
      const id = genTaskId();
      await query(
        `INSERT INTO tasks (id, user_id, title, note, deadline, priority, source, list_id, section_id, position, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'list', $7, $8, $9, $10)`,
        [id, userId, title, str(args.note) ?? null, str(args.deadline) ?? null, priority ?? null, listId, sectionId, nextPos, list.rows[0].workspace_id]
      );
      broadcastToUser(userId, 'tasks');
      broadcastToUser(userId, 'lists');
      return ok(`Created task "${title}" (task_id: ${id})`, `Added "${title}"`);
    },
  },
  {
    name: 'update_task',
    description: 'Update a task (dashboard or list). Pass only the fields to change. Set deadline to "" to clear it. Use checked to complete/uncomplete.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'ID of the task to update' },
        title: { type: 'string' },
        deadline: { type: 'string', description: 'YYYY-MM-DD, or "" to remove' },
        priority: { type: 'string', enum: ['High', 'Medium', 'Low'] },
        note: { type: 'string' },
        checked: { type: 'boolean', description: 'Mark complete (true) or incomplete (false)' },
      },
      required: ['task_id'],
    },
    handler: async (userId, args) => {
      const taskId = Number(args.task_id);
      if (!Number.isFinite(taskId)) return fail('task_id is required');
      const priority = str(args.priority);
      if (priority && !PRIORITIES.has(priority)) return fail('priority must be High, Medium, or Low');
      const sets: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      const add = (col: string, val: unknown) => { sets.push(`${col} = $${i++}`); params.push(val); };
      if (args.title !== undefined) add('title', str(args.title));
      if (args.deadline !== undefined) add('deadline', str(args.deadline) ?? null);
      if (args.priority !== undefined) add('priority', priority ?? null);
      if (args.note !== undefined) add('note', args.note ?? null);
      if (args.checked !== undefined) add('checked', Boolean(args.checked));
      if (!sets.length) return fail('no fields to update');
      params.push(taskId, userId);
      const r = await query<{ title: string }>(
        `UPDATE tasks SET ${sets.join(', ')} WHERE id = $${i++} AND user_id = $${i} RETURNING title`,
        params
      );
      if (!r.rows.length) return fail('task not found');
      broadcastToUser(userId, 'tasks');
      broadcastToUser(userId, 'lists');
      return ok(`Updated task "${r.rows[0].title}"`, `Updated "${r.rows[0].title}"`);
    },
  },
  {
    name: 'delete_task',
    description: 'Permanently delete a task (dashboard or list) by id.',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'number', description: 'ID of the task to delete' } },
      required: ['task_id'],
    },
    handler: async (userId, args) => {
      const taskId = Number(args.task_id);
      if (!Number.isFinite(taskId)) return fail('task_id is required');
      const r = await query<{ title: string }>(`DELETE FROM tasks WHERE id = $1 AND user_id = $2 RETURNING title`, [taskId, userId]);
      if (!r.rows.length) return fail('task not found');
      broadcastToUser(userId, 'tasks');
      broadcastToUser(userId, 'lists');
      return ok(`Deleted task "${r.rows[0].title}"`, `Deleted "${r.rows[0].title}"`);
    },
  },

  // ───────────────────────────── lists & sections ─────────────────────────────
  {
    name: 'create_list',
    description: 'Create a new list. A default "Tasks" section is created automatically — the result includes its section_id for immediate use. If the user did not say which workspace to use, pass workspace_id only when you have good evidence (from list_workspaces/list_lists) that a workspace other than the current one is the better fit — otherwise omit it to use the current workspace.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'List name' },
        emoji: { type: 'string', description: 'Optional emoji icon' },
        folder_id: { type: 'string', description: 'Optional folder ID to place the list in' },
        is_public: { type: 'boolean', description: 'Workspace visibility (default false)' },
        workspace_id: { type: 'string', description: 'Target workspace ID (from list_workspaces). Omit to use the current/personal workspace.' },
      },
      required: ['name'],
    },
    handler: async (userId, args) => {
      const name = str(args.name);
      if (!name) return fail('name is required');
      const folderId = str(args.folder_id);
      if (folderId) {
        const f = await query(`SELECT 1 FROM folders WHERE id = $1 AND user_id = $2`, [folderId, userId]);
        if (!f.rows.length) return fail('folder not found');
      }
      const ws = await resolveWorkspaceForUser(userId, str(args.workspace_id) ?? null);
      const listId = `list_${uuidv4()}`;
      const pos = await query<{ max: string | null }>(`SELECT MAX(position) AS max FROM lists WHERE user_id = $1`, [userId]);
      const nextPos = pos.rows[0].max !== null ? parseInt(pos.rows[0].max, 10) + 1 : 0;
      await query(
        `INSERT INTO lists (id, user_id, name, emoji, is_public, folder_id, position, depth, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8)`,
        [listId, userId, name, str(args.emoji) ?? null, args.is_public === true, folderId ?? null, nextPos, ws]
      );
      const sectionId = `sec_${uuidv4()}`;
      await query(`INSERT INTO sections (id, list_id, label, position) VALUES ($1, $2, 'Tasks', 0)`, [sectionId, listId]);
      broadcastToUser(userId, 'lists');
      return ok(`Created list "${name}" (list_id: ${listId}) with default section "Tasks" (section_id: ${sectionId})`, `Created list "${name}"`);
    },
  },
  {
    name: 'update_list',
    description: "Update a list's name, emoji, or workspace visibility.",
    parameters: {
      type: 'object',
      properties: {
        list_id: { type: 'string' },
        name: { type: 'string' },
        emoji: { type: 'string' },
        is_public: { type: 'boolean' },
      },
      required: ['list_id'],
    },
    handler: async (userId, args) => {
      const listId = str(args.list_id);
      if (!listId) return fail('list_id is required');
      const sets: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      if (args.name !== undefined) { sets.push(`name = $${i++}`); params.push(str(args.name)); }
      if (args.emoji !== undefined) { sets.push(`emoji = $${i++}`); params.push(str(args.emoji) ?? null); }
      if (args.is_public !== undefined) { sets.push(`is_public = $${i++}`); params.push(Boolean(args.is_public)); }
      if (!sets.length) return fail('no fields to update');
      params.push(listId, userId);
      const r = await query<{ name: string }>(
        `UPDATE lists SET ${sets.join(', ')} WHERE id = $${i++} AND user_id = $${i} RETURNING name`,
        params
      );
      if (!r.rows.length) return fail('list not found');
      broadcastToUser(userId, 'lists');
      return ok(`Updated list "${r.rows[0].name}"`, `Updated list "${r.rows[0].name}"`);
    },
  },
  {
    name: 'delete_list',
    description: 'Permanently delete a list and all of its tasks. Confirm with the user first.',
    parameters: {
      type: 'object',
      properties: { list_id: { type: 'string' } },
      required: ['list_id'],
    },
    handler: async (userId, args) => {
      const listId = str(args.list_id);
      if (!listId) return fail('list_id is required');
      const owned = await query<{ name: string }>(`SELECT name FROM lists WHERE id = $1 AND user_id = $2`, [listId, userId]);
      if (!owned.rows.length) return fail('list not found');
      // Soft delete: snapshot the list (and nested sublists) to trash, exactly
      // like deleting from the UI, so the user can restore it for 30 days.
      await softDeleteListTree(listId);
      broadcastToUser(userId, 'lists');
      broadcastToUser(userId, 'trash');
      return ok(`Deleted list "${owned.rows[0].name}" (moved to trash)`, `Deleted list "${owned.rows[0].name}"`);
    },
  },
  {
    name: 'create_section',
    description: 'Create a new section (task group) within a list.',
    parameters: {
      type: 'object',
      properties: {
        list_id: { type: 'string' },
        label: { type: 'string', description: 'Section name' },
        emoji: { type: 'string', description: 'Optional emoji' },
      },
      required: ['list_id', 'label'],
    },
    handler: async (userId, args) => {
      const listId = str(args.list_id);
      const label = str(args.label);
      if (!listId || !label) return fail('list_id and label are required');
      const list = await query(`SELECT 1 FROM lists WHERE id = $1 AND user_id = $2`, [listId, userId]);
      if (!list.rows.length) return fail('list not found');
      const pos = await query<{ max: string | null }>(`SELECT MAX(position) AS max FROM sections WHERE list_id = $1`, [listId]);
      const nextPos = pos.rows[0].max !== null ? parseInt(pos.rows[0].max, 10) + 1 : 0;
      const id = `sec_${uuidv4()}`;
      await query(`INSERT INTO sections (id, list_id, label, emoji, position) VALUES ($1, $2, $3, $4, $5)`, [id, listId, label, str(args.emoji) ?? null, nextPos]);
      broadcastToUser(userId, 'lists');
      return ok(`Created section "${label}" (section_id: ${id})`, `Created section "${label}"`);
    },
  },

  // ───────────────────────────── folders ─────────────────────────────
  {
    name: 'create_folder',
    description: 'Create a folder to organise lists and timelines. If the user did not say which workspace to use, pass workspace_id only when you have good evidence (from list_workspaces/list_folders) that a workspace other than the current one is the better fit — otherwise omit it to use the current workspace.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        emoji: { type: 'string' },
        is_public: { type: 'boolean', description: 'Workspace visibility (default true)' },
        workspace_id: { type: 'string', description: 'Target workspace ID (from list_workspaces). Omit to use the current/personal workspace.' },
      },
      required: ['name'],
    },
    handler: async (userId, args) => {
      const name = str(args.name);
      if (!name) return fail('name is required');
      const ws = await resolveWorkspaceForUser(userId, str(args.workspace_id) ?? null);
      const id = `folder_${uuidv4()}`;
      const pos = await query<{ max: string | null }>(`SELECT MAX(position) AS max FROM folders WHERE user_id = $1`, [userId]);
      const nextPos = pos.rows[0].max !== null ? parseInt(pos.rows[0].max, 10) + 1 : 0;
      await query(
        `INSERT INTO folders (id, user_id, name, emoji, position, is_public, workspace_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, userId, name, str(args.emoji) ?? null, nextPos, args.is_public !== false, ws]
      );
      broadcastToUser(userId, 'lists');
      return ok(`Created folder "${name}" (folder_id: ${id})`, `Created folder "${name}"`);
    },
  },
  {
    name: 'update_folder',
    description: "Update a folder's name, emoji, or visibility.",
    parameters: {
      type: 'object',
      properties: {
        folder_id: { type: 'string' },
        name: { type: 'string' },
        emoji: { type: 'string' },
        is_public: { type: 'boolean' },
      },
      required: ['folder_id'],
    },
    handler: async (userId, args) => {
      const folderId = str(args.folder_id);
      if (!folderId) return fail('folder_id is required');
      const sets: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      if (args.name !== undefined) { sets.push(`name = $${i++}`); params.push(str(args.name)); }
      if (args.emoji !== undefined) { sets.push(`emoji = $${i++}`); params.push(str(args.emoji) ?? null); }
      if (args.is_public !== undefined) { sets.push(`is_public = $${i++}`); params.push(Boolean(args.is_public)); }
      if (!sets.length) return fail('no fields to update');
      params.push(folderId, userId);
      const r = await query<{ name: string }>(
        `UPDATE folders SET ${sets.join(', ')} WHERE id = $${i++} AND user_id = $${i} RETURNING name`,
        params
      );
      if (!r.rows.length) return fail('folder not found');
      broadcastToUser(userId, 'lists');
      return ok(`Updated folder "${r.rows[0].name}"`, `Updated folder "${r.rows[0].name}"`);
    },
  },
  {
    name: 'delete_folder',
    description: 'Delete a folder. Lists inside it are moved out (not deleted). Confirm with the user first.',
    parameters: {
      type: 'object',
      properties: { folder_id: { type: 'string' } },
      required: ['folder_id'],
    },
    handler: async (userId, args) => {
      const folderId = str(args.folder_id);
      if (!folderId) return fail('folder_id is required');
      const r = await query<{ name: string }>(`DELETE FROM folders WHERE id = $1 AND user_id = $2 RETURNING name`, [folderId, userId]);
      if (!r.rows.length) return fail('folder not found');
      broadcastToUser(userId, 'lists');
      return ok(`Deleted folder "${r.rows[0].name}"`, `Deleted folder "${r.rows[0].name}"`);
    },
  },

  // ───────────────────────────── timelines & milestones ─────────────────────────────
  {
    name: 'create_timeline',
    description: 'Create a new timeline to track milestones and project progress. If the user did not say which workspace to use, pass workspace_id only when you have good evidence (from list_workspaces/list_timelines) that a workspace other than the current one is the better fit — otherwise omit it to use the current workspace.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        emoji: { type: 'string' },
        subtitle: { type: 'string' },
        color: { type: 'string', description: 'Accent color hex (e.g. "#5e4dbb")' },
        layout: { type: 'string', enum: ['vertical', 'compact', 'detailed'] },
        is_public: { type: 'boolean' },
        folder_id: { type: 'string' },
        workspace_id: { type: 'string', description: 'Target workspace ID (from list_workspaces). Omit to use the current/personal workspace.' },
      },
      required: ['name'],
    },
    handler: async (userId, args) => {
      const name = str(args.name);
      if (!name) return fail('name is required');
      const layout = str(args.layout);
      if (layout && !LAYOUTS.has(layout)) return fail('layout must be vertical, compact, or detailed');
      const ws = await resolveWorkspaceForUser(userId, str(args.workspace_id) ?? null);
      const id = `timeline_${uuidv4()}`;
      const pos = await query<{ max: string | null }>(`SELECT MAX(position) AS max FROM timelines WHERE user_id = $1`, [userId]);
      const nextPos = pos.rows[0].max !== null ? parseInt(pos.rows[0].max, 10) + 1 : 0;
      await query(
        `INSERT INTO timelines (id, user_id, name, emoji, subtitle, color, layout, is_public, folder_id, position, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, userId, name, str(args.emoji) ?? null, str(args.subtitle) ?? null, str(args.color) ?? null, layout ?? 'vertical', args.is_public === true, str(args.folder_id) ?? null, nextPos, ws]
      );
      broadcastToUser(userId, 'timelines');
      return ok(`Created timeline "${name}" (timeline_id: ${id})`, `Created timeline "${name}"`);
    },
  },
  {
    name: 'update_timeline',
    description: "Update a timeline's name, emoji, subtitle, color, layout, or visibility.",
    parameters: {
      type: 'object',
      properties: {
        timeline_id: { type: 'string' },
        name: { type: 'string' },
        emoji: { type: 'string' },
        subtitle: { type: 'string' },
        color: { type: 'string' },
        layout: { type: 'string', enum: ['vertical', 'compact', 'detailed'] },
        is_public: { type: 'boolean' },
      },
      required: ['timeline_id'],
    },
    handler: async (userId, args) => {
      const tlId = str(args.timeline_id);
      if (!tlId) return fail('timeline_id is required');
      const layout = str(args.layout);
      if (layout && !LAYOUTS.has(layout)) return fail('layout must be vertical, compact, or detailed');
      const sets: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      if (args.name !== undefined) { sets.push(`name = $${i++}`); params.push(str(args.name)); }
      if (args.emoji !== undefined) { sets.push(`emoji = $${i++}`); params.push(str(args.emoji) ?? null); }
      if (args.subtitle !== undefined) { sets.push(`subtitle = $${i++}`); params.push(str(args.subtitle) ?? null); }
      if (args.color !== undefined) { sets.push(`color = $${i++}`); params.push(str(args.color) ?? null); }
      if (args.layout !== undefined) { sets.push(`layout = $${i++}`); params.push(layout); }
      if (args.is_public !== undefined) { sets.push(`is_public = $${i++}`); params.push(Boolean(args.is_public)); }
      if (!sets.length) return fail('no fields to update');
      params.push(tlId, userId);
      const r = await query<{ name: string }>(
        `UPDATE timelines SET ${sets.join(', ')} WHERE id = $${i++} AND user_id = $${i} RETURNING name`,
        params
      );
      if (!r.rows.length) return fail('timeline not found');
      broadcastToUser(userId, 'timelines');
      return ok(`Updated timeline "${r.rows[0].name}"`, `Updated timeline "${r.rows[0].name}"`);
    },
  },
  {
    name: 'delete_timeline',
    description: 'Permanently delete a timeline and all its milestones. Confirm with the user first.',
    parameters: {
      type: 'object',
      properties: { timeline_id: { type: 'string' } },
      required: ['timeline_id'],
    },
    handler: async (userId, args) => {
      const tlId = str(args.timeline_id);
      if (!tlId) return fail('timeline_id is required');
      const owned = await query<{ name: string }>(`SELECT name FROM timelines WHERE id = $1 AND user_id = $2`, [tlId, userId]);
      if (!owned.rows.length) return fail('timeline not found');
      // Soft delete: snapshot to trash first, same as deleting from the UI.
      await withTransaction(async (client) => {
        const exec = (text: string, params?: unknown[]) => client.query(text, params);
        await snapshotTimelineToTrash(exec, tlId);
        await client.query(`DELETE FROM timelines WHERE id = $1`, [tlId]);
      });
      broadcastToUser(userId, 'timelines');
      broadcastToUser(userId, 'trash');
      return ok(`Deleted timeline "${owned.rows[0].name}" (moved to trash)`, `Deleted timeline "${owned.rows[0].name}"`);
    },
  },
  {
    name: 'add_milestone',
    description: 'Add a milestone to a timeline.',
    parameters: {
      type: 'object',
      properties: {
        timeline_id: { type: 'string' },
        title: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD (optional)' },
        time: { type: 'string', description: 'HH:MM (optional)' },
        status: { type: 'string', enum: ['upcoming', 'in-progress', 'done'] },
        emoji: { type: 'string' },
        color: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['timeline_id', 'title'],
    },
    handler: async (userId, args) => {
      const tlId = str(args.timeline_id);
      const title = str(args.title);
      if (!tlId || !title) return fail('timeline_id and title are required');
      const status = str(args.status);
      if (status && !STATUSES.has(status)) return fail('status must be upcoming, in-progress, or done');
      const tl = await query(`SELECT 1 FROM timelines WHERE id = $1 AND user_id = $2`, [tlId, userId]);
      if (!tl.rows.length) return fail('timeline not found');
      const pos = await query<{ max: string | null }>(`SELECT MAX(position) AS max FROM milestones WHERE timeline_id = $1`, [tlId]);
      const nextPos = pos.rows[0].max !== null ? parseInt(pos.rows[0].max, 10) + 1 : 0;
      const id = `milestone_${uuidv4()}`;
      await query(
        `INSERT INTO milestones (id, timeline_id, title, description, milestone_date, time_val, status, emoji, color, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, tlId, title, str(args.description) ?? null, str(args.date) ?? null, str(args.time) ?? null, status ?? 'upcoming', str(args.emoji) ?? null, str(args.color) ?? null, nextPos]
      );
      broadcastToUser(userId, 'timelines');
      return ok(`Added milestone "${title}" (milestone_id: ${id})`, `Added milestone "${title}"`);
    },
  },
  {
    name: 'update_milestone',
    description: 'Update a milestone. Pass only fields to change. Set date/time to "" to clear them.',
    parameters: {
      type: 'object',
      properties: {
        milestone_id: { type: 'string' },
        title: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD, or "" to remove' },
        time: { type: 'string', description: 'HH:MM, or "" to remove' },
        status: { type: 'string', enum: ['upcoming', 'in-progress', 'done'] },
        emoji: { type: 'string' },
        color: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['milestone_id'],
    },
    handler: async (userId, args) => {
      const msId = str(args.milestone_id);
      if (!msId) return fail('milestone_id is required');
      const status = str(args.status);
      if (status && !STATUSES.has(status)) return fail('status must be upcoming, in-progress, or done');
      // Ownership: the milestone's timeline must belong to the user.
      const owns = await query(
        `SELECT 1 FROM milestones m JOIN timelines t ON m.timeline_id = t.id WHERE m.id = $1 AND t.user_id = $2`,
        [msId, userId]
      );
      if (!owns.rows.length) return fail('milestone not found');
      const sets: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      if (args.title !== undefined) { sets.push(`title = $${i++}`); params.push(str(args.title)); }
      if (args.date !== undefined) { sets.push(`milestone_date = $${i++}`); params.push(str(args.date) ?? null); }
      if (args.time !== undefined) { sets.push(`time_val = $${i++}`); params.push(str(args.time) ?? null); }
      if (args.status !== undefined) { sets.push(`status = $${i++}`); params.push(status); }
      if (args.emoji !== undefined) { sets.push(`emoji = $${i++}`); params.push(str(args.emoji) ?? null); }
      if (args.color !== undefined) { sets.push(`color = $${i++}`); params.push(str(args.color) ?? null); }
      if (args.description !== undefined) { sets.push(`description = $${i++}`); params.push(args.description ?? null); }
      if (!sets.length) return fail('no fields to update');
      params.push(msId);
      const r = await query<{ title: string }>(`UPDATE milestones SET ${sets.join(', ')} WHERE id = $${i} RETURNING title`, params);
      broadcastToUser(userId, 'timelines');
      return ok(`Updated milestone "${r.rows[0].title}"`, `Updated milestone "${r.rows[0].title}"`);
    },
  },
  {
    name: 'delete_milestone',
    description: 'Delete a milestone. Confirm with the user first.',
    parameters: {
      type: 'object',
      properties: { milestone_id: { type: 'string' } },
      required: ['milestone_id'],
    },
    handler: async (userId, args) => {
      const msId = str(args.milestone_id);
      if (!msId) return fail('milestone_id is required');
      const r = await query<{ title: string }>(
        `DELETE FROM milestones m USING timelines t
         WHERE m.id = $1 AND m.timeline_id = t.id AND t.user_id = $2 RETURNING m.title`,
        [msId, userId]
      );
      if (!r.rows.length) return fail('milestone not found');
      broadcastToUser(userId, 'timelines');
      return ok(`Deleted milestone "${r.rows[0].title}"`, `Deleted milestone "${r.rows[0].title}"`);
    },
  },

  // ───────────────────────────── markdown pages ─────────────────────────────
  {
    name: 'list_markdown_lists',
    description: "List all of the user's Markdown pages (freeform documents built from '/' command blocks — headings, paragraphs, lists, to-dos, quotes, dividers, links, images, tables), across every workspace.",
    parameters: { type: 'object', properties: {} },
    handler: async (userId) => {
      const rows = await query<{ id: string; name: string; emoji: string | null; workspace_id: string | null; workspace_name: string | null }>(
        `SELECT m.id, m.name, m.emoji, m.workspace_id, w.name AS workspace_name
         FROM markdown_lists m LEFT JOIN workspaces w ON w.id = m.workspace_id
         WHERE m.user_id = $1 ORDER BY m.position ASC`,
        [userId]
      );
      if (!rows.rows.length) return ok('You have no Markdown pages yet.');
      return ok(rows.rows.map((m) => `• ${m.emoji ?? ''} "${m.name}" (markdown_list_id: ${m.id}; workspace: "${m.workspace_name ?? 'unknown'}" [workspace_id: ${m.workspace_id}])`).join('\n'));
    },
  },
  {
    name: 'create_markdown_list',
    description: "Create a new Markdown page — a freeform document built from '/' command blocks (headings, paragraphs, bulleted/numbered lists, to-dos, quotes, dividers, links, tables). Optionally seed it with initial blocks in one call. If the user didn't say which workspace, omit workspace_id to use the current/personal workspace.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Page name/title' },
        emoji: { type: 'string', description: 'Optional emoji icon' },
        color: { type: 'string', description: 'Optional accent color hex (e.g. "#5e4dbb")' },
        subtitle: { type: 'string', description: 'Optional subtitle shown under the title' },
        is_public: { type: 'boolean', description: 'Workspace visibility to members (default false)' },
        folder_id: { type: 'string', description: 'Optional folder ID to place the page in' },
        workspace_id: { type: 'string', description: 'Target workspace ID (from list_workspaces). Omit to use the current/personal workspace.' },
        blocks: {
          type: 'array',
          description: 'Optional initial blocks, inserted in order. Each block is an object like { type, text?, level?, checked?, url?, title?, description?, layout?, columns?, rows?, aggregates? } — same shape as add_markdown_block (columns/rows/aggregates build a table). Image blocks are not allowed here.',
          items: { type: 'object' },
        },
      },
      required: ['name'],
    },
    handler: async (userId, args) => {
      const name = str(args.name);
      if (!name) return fail('name is required');
      const folderId = str(args.folder_id);
      if (folderId) {
        const f = await query(`SELECT 1 FROM folders WHERE id = $1 AND user_id = $2`, [folderId, userId]);
        if (!f.rows.length) return fail('folder not found');
      }
      // Validate every seed block BEFORE creating the page, so a bad spec can't
      // leave an empty page behind.
      const specs = Array.isArray(args.blocks) ? args.blocks : [];
      const initialBlocks: MarkdownBlockLike[] = [];
      for (const spec of specs) {
        if (!spec || typeof spec !== 'object') return fail('each block must be an object');
        const built = buildMarkdownBlockFromSpec(spec as Record<string, unknown>);
        if ('error' in built) return fail(built.error);
        initialBlocks.push(built.block);
      }
      const created = await createMarkdownListForUser(userId, {
        name,
        emoji: str(args.emoji) ?? null,
        color: str(args.color) ?? null,
        subtitle: str(args.subtitle) ?? null,
        isPublic: args.is_public === true,
        folderId: folderId ?? null,
        workspaceId: str(args.workspace_id) ?? null,
      });
      if (initialBlocks.length > 0) {
        const seeded = await mutateMarkdownListBlocks(userId, created.id, () => initialBlocks);
        if (!seeded.ok) return fail(seeded.error);
      }
      const blockNote = initialBlocks.length ? ` with ${initialBlocks.length} block${initialBlocks.length === 1 ? '' : 's'}` : '';
      return ok(`Created Markdown page "${name}" (markdown_list_id: ${created.id})${blockNote}`, `Created page "${name}"`);
    },
  },
  {
    name: 'update_markdown_list',
    description: "Update a Markdown page's own settings — name, emoji, accent color, subtitle, workspace visibility, full-width layout, or folder. This edits the page itself, not its block content (use the block tools / set_markdown_content for content). Owner only.",
    parameters: {
      type: 'object',
      properties: {
        markdown_list_id: { type: 'string' },
        name: { type: 'string' },
        emoji: { type: 'string' },
        color: { type: 'string', description: 'Accent color hex, or "" to clear' },
        subtitle: { type: 'string', description: 'Subtitle, or "" to clear' },
        is_public: { type: 'boolean', description: 'Workspace visibility to members' },
        full_width: { type: 'boolean', description: 'Stretch content to full app width instead of the centered reading column' },
        folder_id: { type: 'string', description: 'Move into this folder, or "" to remove from its folder' },
      },
      required: ['markdown_list_id'],
    },
    handler: async (userId, args) => {
      const id = str(args.markdown_list_id);
      if (!id) return fail('markdown_list_id is required');
      // Page settings are owner-only (content edits allow invited collaborators,
      // but not the page's own settings).
      const owned = await query<{ name: string }>(`SELECT name FROM markdown_lists WHERE id = $1 AND user_id = $2`, [id, userId]);
      if (!owned.rows.length) return fail('markdown page not found');
      const folderId = str(args.folder_id);
      if (folderId) {
        const f = await query(`SELECT 1 FROM folders WHERE id = $1 AND user_id = $2`, [folderId, userId]);
        if (!f.rows.length) return fail('folder not found');
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      if (args.name !== undefined) { sets.push(`name = $${i++}`); params.push(str(args.name)); }
      if (args.emoji !== undefined) { sets.push(`emoji = $${i++}`); params.push(str(args.emoji) ?? null); }
      if (args.color !== undefined) { sets.push(`color = $${i++}`); params.push(str(args.color) ?? null); }
      if (args.subtitle !== undefined) { sets.push(`subtitle = $${i++}`); params.push(str(args.subtitle) ?? null); }
      if (args.is_public !== undefined) { sets.push(`is_public = $${i++}`); params.push(Boolean(args.is_public)); }
      if (args.full_width !== undefined) { sets.push(`full_width = $${i++}`); params.push(Boolean(args.full_width)); }
      if (args.folder_id !== undefined) { sets.push(`folder_id = $${i++}`); params.push(str(args.folder_id) ?? null); }
      if (!sets.length) return fail('no fields to update');
      sets.push('updated_at = NOW()');
      params.push(id, userId);
      const r = await query<{ name: string }>(
        `UPDATE markdown_lists SET ${sets.join(', ')} WHERE id = $${i++} AND user_id = $${i} RETURNING name`,
        params
      );
      if (!r.rows.length) return fail('markdown page not found');
      broadcastToUser(userId, 'markdownLists');
      return ok(`Updated Markdown page "${r.rows[0].name}"`, `Updated page "${r.rows[0].name}"`);
    },
  },
  {
    name: 'delete_markdown_list',
    description: 'Delete a Markdown page (soft delete — moved to Trash, recoverable for 30 days; its auto-managed Todo list goes with it). Confirm with the user first.',
    parameters: {
      type: 'object',
      properties: { markdown_list_id: { type: 'string' } },
      required: ['markdown_list_id'],
    },
    handler: async (userId, args) => {
      const id = str(args.markdown_list_id);
      if (!id) return fail('markdown_list_id is required');
      const result = await deleteMarkdownListForUser(userId, id);
      if (!result.ok) return fail(result.error);
      return ok(`Deleted Markdown page "${result.name}" (moved to trash)`, `Deleted page "${result.name}"`);
    },
  },
  {
    name: 'get_markdown_list',
    description: "Get a Markdown page's full block-by-block content, with each block's id and type — use the ids with the block tools (add/update/remove/move/reorder_markdown_block(s), set_markdown_content). Valid block types (matching the document's own '/' commands): heading (level 1-3), paragraph, bulleted-list-item, numbered-list-item, todo (mirrors to an auto-managed Todo list), quote, divider (optional 2-column layout — shown as '· 2-column layout'), link (url/title/description), and image (read/reorder/caption-edit only — cannot be created by AI, it requires a real file upload from the UI; its image_id is shown so you can keep it when restructuring).",
    parameters: {
      type: 'object',
      properties: { markdown_list_id: { type: 'string' } },
      required: ['markdown_list_id'],
    },
    handler: async (userId, args) => {
      const id = str(args.markdown_list_id);
      if (!id) return fail('markdown_list_id is required');
      const r = await query<{ name: string; emoji: string | null; content: unknown }>(
        `SELECT name, emoji, content FROM markdown_lists WHERE id = $1 AND user_id = $2`,
        [id, userId]
      );
      if (!r.rows.length) return fail('markdown page not found');
      const blocks = ((r.rows[0].content as { blocks?: MarkdownBlockLike[] } | null)?.blocks ?? []);
      if (!blocks.length) return ok(`${r.rows[0].emoji ?? ''} "${r.rows[0].name}" (markdown_list_id: ${id}) — empty document.`);
      const lines = [
        `${r.rows[0].emoji ?? ''} "${r.rows[0].name}" (markdown_list_id: ${id})`,
        ...blocks.map((b, i) => `  ${i + 1}. (block_id: ${b.id}) ${describeMarkdownBlock(b)}`),
      ];
      return ok(lines.join('\n'));
    },
  },
  {
    name: 'add_markdown_block',
    description: "Insert a new block into a Markdown page — the same thing a '/' slash command does in the editor. type maps to: heading → /h1,/h2,/h3 (set level), paragraph → plain text, bulleted-list-item → /bullet, numbered-list-item → /number, todo → /todo (checked todos mirror live to this page's auto-managed Todo list), quote → /quote, divider → /divider (set layout:'columns' to make the sections on either side sit side-by-side in 2 columns), link → /link (needs url), table → /table (a grid — pass `columns` header labels and optional `rows` of body cells, plus optional per-column `aggregates`). Image blocks cannot be created this way — they require a real file upload from the UI. Call get_markdown_list first to see existing block ids for positioning. To add several blocks at once, use add_markdown_blocks.",
    parameters: {
      type: 'object',
      properties: {
        markdown_list_id: { type: 'string' },
        type: { type: 'string', enum: ['heading', 'paragraph', 'bulleted-list-item', 'numbered-list-item', 'todo', 'quote', 'divider', 'link', 'table'] },
        text: { type: 'string', description: 'Text content — required for heading/paragraph/bulleted-list-item/numbered-list-item/todo/quote.' },
        level: { type: 'number', enum: [1, 2, 3], description: 'Heading level — required when type is "heading".' },
        checked: { type: 'boolean', description: 'Initial checked state for a todo block (default false).' },
        url: { type: 'string', description: 'Required when type is "link".' },
        title: { type: 'string', description: 'Optional link title.' },
        description: { type: 'string', description: 'Optional link description.' },
        layout: { type: 'string', enum: ['stack', 'columns'], description: "For divider blocks only — 'columns' pairs the sections on either side of the divider into a 2-column side-by-side layout; 'stack' (default) keeps them full-width." },
        columns: { type: 'array', description: 'For table blocks (required) — header labels, one per column; these become the bold header row. Each item is a string, or { text, aggregate } to also set that column’s footer aggregate.', items: { type: 'string' } },
        rows: { type: 'array', description: 'For table blocks — BODY rows only (the header comes from `columns`). Each item is an array of cell strings aligned to columns; short/long rows are padded/truncated.', items: { type: 'array', items: { type: 'string' } } },
        aggregates: { type: 'array', description: "For table blocks — optional per-column footer aggregate over that column's numeric body cells: one of sum, avg, median, max, min (null/omit for none), aligned to columns.", items: { type: 'string' } },
        position: { type: 'string', enum: ['start', 'end', 'after'], description: "Where to insert — 'start' (top of doc), 'end' (bottom, default), or 'after' (needs after_block_id)." },
        after_block_id: { type: 'string', description: 'Required when position is "after" — the block to insert immediately after.' },
      },
      required: ['markdown_list_id', 'type'],
    },
    handler: async (userId, args) => {
      const id = str(args.markdown_list_id);
      const type = str(args.type);
      if (!id || !type) return fail('markdown_list_id and type are required');
      if (!MARKDOWN_BLOCK_TYPES.has(type)) return fail(`type must be one of: ${[...MARKDOWN_BLOCK_TYPES].join(', ')} (image blocks cannot be created by AI)`);
      const built = buildMarkdownBlockFromSpec(args);
      if ('error' in built) return fail(built.error);
      const block = built.block;

      const position = str(args.position);
      const afterBlockId = str(args.after_block_id);
      const result = await mutateMarkdownListBlocks(userId, id, (blocks) => insertAtPosition(blocks, block, position, afterBlockId));
      if (!result.ok) return fail(result.error);
      return ok(`Added ${type} block (block_id: ${block.id}) to "${result.markdownList.name}"`, `Added a ${type} block`);
    },
  },
  {
    name: 'add_markdown_blocks',
    description: "Insert SEVERAL blocks into a Markdown page in one call, in the given order, at one position — use this to build out a whole section at once (e.g. a heading followed by several bullets and a divider) instead of many add_markdown_block calls. Same block types/fields as add_markdown_block; image blocks cannot be created.",
    parameters: {
      type: 'object',
      properties: {
        markdown_list_id: { type: 'string' },
        blocks: {
          type: 'array',
          description: 'Ordered list of blocks to insert. Each: { type, text?, level?, checked?, url?, title?, description?, layout?, columns?, rows?, aggregates? } — see add_markdown_block for what each field means (columns/rows/aggregates are for table blocks).',
          items: { type: 'object' },
        },
        position: { type: 'string', enum: ['start', 'end', 'after'], description: "Where to insert the whole group — 'start', 'end' (default), or 'after' (needs after_block_id)." },
        after_block_id: { type: 'string', description: 'Required when position is "after" — the block the group is inserted immediately after.' },
      },
      required: ['markdown_list_id', 'blocks'],
    },
    handler: async (userId, args) => {
      const id = str(args.markdown_list_id);
      if (!id) return fail('markdown_list_id is required');
      const specs = Array.isArray(args.blocks) ? args.blocks : null;
      if (!specs || specs.length === 0) return fail('blocks (a non-empty array) is required');
      const newBlocks: MarkdownBlockLike[] = [];
      for (const spec of specs) {
        if (!spec || typeof spec !== 'object') return fail('each block must be an object');
        const type = str((spec as Record<string, unknown>).type);
        if (type && !MARKDOWN_BLOCK_TYPES.has(type)) return fail(`type must be one of: ${[...MARKDOWN_BLOCK_TYPES].join(', ')} (image blocks cannot be created by AI)`);
        const built = buildMarkdownBlockFromSpec(spec as Record<string, unknown>);
        if ('error' in built) return fail(built.error);
        newBlocks.push(built.block);
      }
      const position = str(args.position);
      const afterBlockId = str(args.after_block_id);
      const result = await mutateMarkdownListBlocks(userId, id, (blocks) => insertManyAtPosition(blocks, newBlocks, position, afterBlockId));
      if (!result.ok) return fail(result.error);
      return ok(`Added ${newBlocks.length} block${newBlocks.length === 1 ? '' : 's'} to "${result.markdownList.name}"`, `Added ${newBlocks.length} blocks`);
    },
  },
  {
    name: 'update_markdown_block',
    description: "Edit an existing block in a Markdown page. Pass only the fields relevant to that block's type (text for heading/paragraph/bulleted-list-item/numbered-list-item/todo/quote; level for heading; checked for todo; url/title/description for link; caption for image; layout for divider; columns/rows/aggregates for table — a table edit REPLACES the grid, so pass its full columns (and rows/aggregates you want to keep)). Call get_markdown_list first to find the block_id.",
    parameters: {
      type: 'object',
      properties: {
        markdown_list_id: { type: 'string' },
        block_id: { type: 'string' },
        text: { type: 'string' },
        level: { type: 'number', enum: [1, 2, 3] },
        checked: { type: 'boolean' },
        url: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        caption: { type: 'string', description: 'Caption for an image block.' },
        layout: { type: 'string', enum: ['stack', 'columns'], description: "For divider blocks — 'columns' pairs the sections on either side into a 2-column layout; 'stack' reverts to full-width." },
        columns: { type: 'array', description: 'For table blocks — header labels (see add_markdown_block). Required to edit a table; the edit rebuilds the grid.', items: { type: 'string' } },
        rows: { type: 'array', description: 'For table blocks — body rows (arrays of cell strings). Omit to clear body rows.', items: { type: 'array', items: { type: 'string' } } },
        aggregates: { type: 'array', description: 'For table blocks — per-column footer aggregate (sum/avg/median/max/min or null), aligned to columns.', items: { type: 'string' } },
      },
      required: ['markdown_list_id', 'block_id'],
    },
    handler: async (userId, args) => {
      const id = str(args.markdown_list_id);
      const blockId = str(args.block_id);
      if (!id || !blockId) return fail('markdown_list_id and block_id are required');
      let updatedType = '';
      const result = await mutateMarkdownListBlocks(userId, id, (blocks) => {
        const idx = blocks.findIndex((b) => b.id === blockId);
        if (idx === -1) return { error: `block ${blockId} not found` };
        const b = blocks[idx];
        updatedType = String(b.type);
        const next = [...blocks];
        switch (b.type) {
          case 'heading':
            next[idx] = { ...b, text: args.text !== undefined ? (str(args.text) ?? '') : b.text, level: args.level !== undefined ? Number(args.level) : b.level };
            break;
          case 'todo':
            next[idx] = { ...b, text: args.text !== undefined ? (str(args.text) ?? '') : b.text, checked: args.checked !== undefined ? Boolean(args.checked) : b.checked };
            break;
          case 'link':
            next[idx] = {
              ...b,
              url: args.url !== undefined ? (str(args.url) ?? b.url) : b.url,
              title: args.title !== undefined ? (str(args.title) ?? null) : b.title,
              description: args.description !== undefined ? (str(args.description) ?? null) : b.description,
            };
            break;
          case 'image':
            next[idx] = { ...b, caption: args.caption !== undefined ? (str(args.caption) ?? null) : b.caption };
            break;
          case 'divider':
            if (args.layout !== undefined) {
              const layout = str(args.layout);
              if (layout && layout !== 'stack' && layout !== 'columns') return { error: 'divider layout must be "stack" or "columns"' };
              next[idx] = { ...b, layout: layout === 'columns' ? 'columns' : 'stack' };
            }
            break;
          case 'table': {
            // A table edit rebuilds the whole grid (its structure is too coupled
            // for field-by-field patching) — keep the same block id.
            if (args.columns === undefined && args.rows === undefined && args.aggregates === undefined) break;
            const built = buildMarkdownBlockFromSpec({ type: 'table', id: blockId, columns: args.columns, rows: args.rows, aggregates: args.aggregates });
            if ('error' in built) return { error: built.error };
            next[idx] = built.block;
            break;
          }
          default:
            if (args.text !== undefined) next[idx] = { ...b, text: str(args.text) ?? '' };
        }
        return next;
      });
      if (!result.ok) return fail(result.error);
      return ok(`Updated ${updatedType} block in "${result.markdownList.name}"`, 'Updated a block');
    },
  },
  {
    name: 'remove_markdown_block',
    description: "Delete a block from a Markdown page. A document is never left completely empty by this — if it would remove the last remaining block, an empty paragraph block is kept in its place (mirroring the editor's own behavior).",
    parameters: {
      type: 'object',
      properties: { markdown_list_id: { type: 'string' }, block_id: { type: 'string' } },
      required: ['markdown_list_id', 'block_id'],
    },
    handler: async (userId, args) => {
      const id = str(args.markdown_list_id);
      const blockId = str(args.block_id);
      if (!id || !blockId) return fail('markdown_list_id and block_id are required');
      const result = await mutateMarkdownListBlocks(userId, id, (blocks) => {
        if (!blocks.some((b) => b.id === blockId)) return { error: `block ${blockId} not found` };
        const next = blocks.filter((b) => b.id !== blockId);
        return next.length > 0 ? next : [{ id: genBlockId(), type: 'paragraph', text: '' }];
      });
      if (!result.ok) return fail(result.error);
      return ok(`Removed block from "${result.markdownList.name}"`, 'Removed a block');
    },
  },
  {
    name: 'move_markdown_block',
    description: 'Reorder a block within a Markdown page — the same effect as dragging it in the editor.',
    parameters: {
      type: 'object',
      properties: {
        markdown_list_id: { type: 'string' },
        block_id: { type: 'string', description: 'The block to move.' },
        position: { type: 'string', enum: ['start', 'end', 'after'], description: "'start' = top of doc, 'end' = bottom of doc, 'after' = right after another block (needs after_block_id)." },
        after_block_id: { type: 'string', description: 'Required when position is "after" — the block to place it right after. Must not be the block being moved.' },
      },
      required: ['markdown_list_id', 'block_id', 'position'],
    },
    handler: async (userId, args) => {
      const id = str(args.markdown_list_id);
      const blockId = str(args.block_id);
      const position = str(args.position);
      const afterBlockId = str(args.after_block_id);
      if (!id || !blockId || !position) return fail('markdown_list_id, block_id and position are required');
      if (position === 'after' && !afterBlockId) return fail('after_block_id is required when position is "after"');
      if (afterBlockId && afterBlockId === blockId) return fail('after_block_id cannot be the block being moved');
      const result = await mutateMarkdownListBlocks(userId, id, (blocks) => {
        const fromIdx = blocks.findIndex((b) => b.id === blockId);
        if (fromIdx === -1) return { error: `block ${blockId} not found` };
        const without = [...blocks];
        const [moved] = without.splice(fromIdx, 1);
        return insertAtPosition(without, moved, position, afterBlockId);
      });
      if (!result.ok) return fail(result.error);
      return ok(`Moved block in "${result.markdownList.name}"`, 'Reordered a block');
    },
  },
  {
    name: 'reorder_markdown_blocks',
    description: "Reorder ALL blocks in a Markdown page at once by giving the full list of block ids in the new top-to-bottom order. block_ids must contain exactly the page's current block ids — every one, each once, with nothing added or removed (call get_markdown_list first to read them). Use add/remove_markdown_block or set_markdown_content to add or remove blocks.",
    parameters: {
      type: 'object',
      properties: {
        markdown_list_id: { type: 'string' },
        block_ids: { type: 'array', items: { type: 'string' }, description: "Every current block id, in the desired new top-to-bottom order." },
      },
      required: ['markdown_list_id', 'block_ids'],
    },
    handler: async (userId, args) => {
      const id = str(args.markdown_list_id);
      if (!id) return fail('markdown_list_id is required');
      const orderRaw = Array.isArray(args.block_ids) ? args.block_ids : null;
      if (!orderRaw) return fail('block_ids (an array) is required');
      const order = orderRaw.filter((x): x is string => typeof x === 'string');
      const result = await mutateMarkdownListBlocks(userId, id, (blocks) => {
        const orderSet = new Set(order);
        if (order.length !== blocks.length || orderSet.size !== order.length || blocks.some((b) => !orderSet.has(b.id))) {
          return { error: `block_ids must list every current block id exactly once. Page has ${blocks.length} block(s): ${blocks.map((b) => b.id).join(', ')}` };
        }
        const byId = new Map(blocks.map((b) => [b.id, b]));
        return order.map((bid) => byId.get(bid)!);
      });
      if (!result.ok) return fail(result.error);
      return ok(`Reordered blocks in "${result.markdownList.name}"`, 'Reordered the page');
    },
  },
  {
    name: 'set_markdown_content',
    description: "Replace a Markdown page's ENTIRE content with a new ordered list of blocks in one call — the most powerful way to fully restructure a page (reorder, retype, rewrite, regroup all at once). Each block: { type, text?, level?, checked?, url?, title?, description?, layout?, columns?, rows?, aggregates? } (columns/rows/aggregates build a table). IMPORTANT: this overwrites everything, so include EVERY block you want to keep. To keep an existing image, include a block { type:'image', image_id:'<its image_id from get_markdown_list>' } (optionally with a caption) — any image not included is permanently removed. To keep a to-do's live checkbox link, include its original block id as `id` (from get_markdown_list); otherwise a new mirror task is created. Passing an empty array clears the page to a single empty paragraph. Prefer the targeted block tools for small edits; use this for wholesale restructuring.",
    parameters: {
      type: 'object',
      properties: {
        markdown_list_id: { type: 'string' },
        blocks: {
          type: 'array',
          description: 'The full new ordered block list. Each is an object like { type, text?, level?, checked?, url?, title?, description?, layout?, id?, image_id? }.',
          items: { type: 'object' },
        },
      },
      required: ['markdown_list_id', 'blocks'],
    },
    handler: async (userId, args) => {
      const id = str(args.markdown_list_id);
      if (!id) return fail('markdown_list_id is required');
      const specs = Array.isArray(args.blocks) ? args.blocks : null;
      if (!specs) return fail('blocks (an array) is required');
      const result = await mutateMarkdownListBlocks(userId, id, (current) => {
        const existingImageIds = new Set(
          current.filter((b) => b.type === 'image' && typeof b.imageId === 'string').map((b) => b.imageId as string)
        );
        const todoTaskIdByBlockId = new Map<string, string | null>();
        for (const b of current) {
          if (b.type === 'todo') todoTaskIdByBlockId.set(b.id, typeof b.taskId === 'string' ? b.taskId : null);
        }
        const ctx: BlockBuildContext = { allowImagePreserve: true, existingImageIds, todoTaskIdByBlockId };
        const built: MarkdownBlockLike[] = [];
        const seenIds = new Set<string>();
        for (const spec of specs) {
          if (!spec || typeof spec !== 'object') return { error: 'each block must be an object' };
          const res = buildMarkdownBlockFromSpec(spec as Record<string, unknown>, ctx);
          if ('error' in res) return { error: res.error };
          // Guard against duplicate ids (e.g. the model reusing one) — a fresh
          // id keeps blocks distinct; todo mirror linkage is by taskId, which
          // was already resolved above, so it survives an id change.
          if (seenIds.has(res.block.id)) res.block.id = genBlockId();
          seenIds.add(res.block.id);
          built.push(res.block);
        }
        return built.length > 0 ? built : [{ id: genBlockId(), type: 'paragraph', text: '' }];
      });
      if (!result.ok) return fail(result.error);
      return ok(`Replaced the content of "${result.markdownList.name}" (${specs.length} block${specs.length === 1 ? '' : 's'})`, 'Restructured the page');
    },
  },

  // ───────────────────────────── files ─────────────────────────────
  {
    name: 'list_files',
    description: "List the user's uploaded/shared files (ids, names, types, sizes). Use read_file to extract a file's text content.",
    parameters: { type: 'object', properties: {} },
    handler: async (userId) => {
      const rows = await query<{ id: string; original_name: string; mime_type: string; file_size: string }>(
        `SELECT id, original_name, mime_type, file_size FROM shared_files WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [userId]
      );
      if (!rows.rows.length) return ok('You have no uploaded files.');
      return ok(rows.rows.map((f) => `• "${f.original_name}" (file_id: ${f.id}; ${f.mime_type}; ${Math.round(Number(f.file_size) / 1024)} KB)`).join('\n'));
    },
  },
  {
    name: 'read_file',
    description: 'Extract and return the text content of one of the user\'s uploaded files (PDF, spreadsheet, CSV, text, code) — e.g. a contract or other large document. The full extracted text is never silently cut off: if it does not fit in one call, the result tells you the total length and the offset to pass on your next call so you can read the whole document across multiple calls.',
    parameters: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'ID of the file (from list_files)' },
        offset: { type: 'number', description: 'Character offset to start reading from (default 0). Use the "next offset" from a previous truncated read_file result to continue.' },
        max_chars: { type: 'number', description: `Max characters to return in this call (default ${MAX_TEXT_CHARS}, capped at ${MAX_TEXT_CHARS * 4}).` },
      },
      required: ['file_id'],
    },
    handler: async (userId, args) => {
      const fileId = str(args.file_id);
      if (!fileId) return fail('file_id is required');
      const r = await query<{ file_path: string; mime_type: string; original_name: string }>(
        `SELECT file_path, mime_type, original_name FROM shared_files WHERE id = $1 AND user_id = $2`,
        [fileId, userId]
      );
      if (!r.rows.length) return fail('file not found');
      const { file_path, mime_type, original_name } = r.rows[0];
      // Resolve safely and confirm the path stays inside the upload dir.
      const baseDir = path.resolve(UPLOAD_DIR);
      const filePath = path.resolve(baseDir, path.basename(file_path));
      if (!filePath.startsWith(baseDir + path.sep)) return fail('invalid file path');
      if (!fs.existsSync(filePath)) return fail('file not found on disk');
      const buffer = await fs.promises.readFile(filePath);
      // Extract the FULL text (no cap) so pagination below can walk arbitrarily
      // large documents (contracts, long reports) without ever losing content.
      const { contentText, isImage } = await extractTextFromBuffer(buffer, mime_type, original_name, Infinity);
      if (isImage) return ok(`"${original_name}" is an image; image content cannot be returned as text.`);
      const full = contentText ?? '';
      const offset = Math.max(0, Math.trunc(Number(args.offset) || 0));
      const requested = Math.trunc(Number(args.max_chars) || MAX_TEXT_CHARS);
      const maxChars = Math.min(Math.max(requested, 1000), MAX_TEXT_CHARS * 4);
      const chunk = full.slice(offset, offset + maxChars);
      const nextOffset = offset + chunk.length;
      const hasMore = nextOffset < full.length;
      const header = full.length > maxChars
        ? `Content of "${original_name}" (characters ${offset}-${nextOffset} of ${full.length} total):`
        : `Content of "${original_name}":`;
      const footer = hasMore
        ? `\n\n[${full.length - nextOffset} more characters remain — call read_file again with file_id "${fileId}" and offset ${nextOffset} to continue reading]`
        : '';
      return ok(`${header}\n\n${chunk || '(empty)'}${footer}`);
    },
  },
  {
    name: 'share_file',
    description: 'Enable, update, or disable the public share link for one of the user\'s uploaded files. Enabling returns the share token; the public URL is /share/<token>.',
    parameters: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'ID of the file (from list_files)' },
        enabled: { type: 'boolean', description: 'true to enable/keep the public link, false to disable it' },
        password: { type: 'string', description: 'Optional password to protect the link. Omit to leave the current password as-is, or pass "" to remove password protection.' },
        expires_at: { type: 'string', description: 'Optional ISO expiry timestamp, or "" to clear it' },
      },
      required: ['file_id', 'enabled'],
    },
    handler: async (userId, args) => {
      const fileId = str(args.file_id);
      if (!fileId) return fail('file_id is required');
      if (typeof args.enabled !== 'boolean') return fail('enabled is required');
      const existing = await query<{ id: string; original_name: string; share_token: string }>(
        `SELECT id, original_name, share_token FROM shared_files WHERE id = $1 AND user_id = $2`,
        [fileId, userId]
      );
      if (!existing.rows.length) return fail('file not found');
      const password = str(args.password);
      const clearPassword = args.password === '';
      const clearExpiry = args.expires_at === '';
      const expiresAt = clearExpiry ? null : (str(args.expires_at) ?? undefined);
      const sets: string[] = ['is_public = $1'];
      const params: unknown[] = [args.enabled];
      let i = 2;
      if (password) { sets.push(`password_hash = $${i++}`); params.push(await hashPassword(password)); }
      else if (clearPassword) { sets.push(`password_hash = $${i++}`); params.push(null); }
      if (expiresAt !== undefined) { sets.push(`expires_at = $${i++}`); params.push(expiresAt); }
      params.push(fileId, userId);
      await query(`UPDATE shared_files SET ${sets.join(', ')} WHERE id = $${i++} AND user_id = $${i}`, params);
      const { original_name, share_token } = existing.rows[0];
      return args.enabled
        ? ok(`Enabled sharing for "${original_name}" — public link: /share/${share_token}`, `Shared "${original_name}"`)
        : ok(`Disabled sharing for "${original_name}"`, `Unshared "${original_name}"`);
    },
  },
  {
    name: 'delete_file',
    description: "Permanently delete one of the user's uploaded files (and any bundle it belongs to). Confirm with the user first.",
    parameters: {
      type: 'object',
      properties: { file_id: { type: 'string', description: 'ID of the file (from list_files)' } },
      required: ['file_id'],
    },
    handler: async (userId, args) => {
      const fileId = str(args.file_id);
      if (!fileId) return fail('file_id is required');
      const existing = await query<{ original_name: string }>(
        `SELECT original_name FROM shared_files WHERE id = $1 AND user_id = $2`,
        [fileId, userId]
      );
      if (!existing.rows.length) return fail('file not found');
      const deleted = await query<{ file_path: string }>(
        `DELETE FROM shared_files sf
         WHERE sf.user_id = $2
           AND COALESCE(sf.bundle_id, sf.id) = COALESCE((SELECT bundle_id FROM shared_files WHERE id = $1), $1)
         RETURNING file_path`,
        [fileId, userId]
      );
      const baseDir = path.resolve(UPLOAD_DIR);
      for (const row of deleted.rows) {
        const filePath = path.join(baseDir, path.basename(row.file_path));
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
      broadcastToUser(userId, 'files');
      return ok(`Deleted file "${existing.rows[0].original_name}"`, `Deleted "${existing.rows[0].original_name}"`);
    },
  },
  {
    name: 'list_task_attachments',
    description: "List the files attached to a task.",
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'number', description: 'ID of the task' } },
      required: ['task_id'],
    },
    handler: async (userId, args) => {
      const taskId = Number(args.task_id);
      if (!Number.isFinite(taskId)) return fail('task_id is required');
      const owns = await query(`SELECT 1 FROM tasks WHERE id = $1 AND user_id = $2`, [taskId, userId]);
      if (!owns.rows.length) return fail('task not found');
      const rows = await query<{ id: string; attachment_type: string; original_name: string | null; sf_name: string | null }>(
        `SELECT ta.id, ta.attachment_type, ta.original_name, sf.original_name AS sf_name
         FROM task_attachments ta LEFT JOIN shared_files sf ON ta.shared_file_id = sf.id
         WHERE ta.task_id = $1 ORDER BY ta.created_at ASC`,
        [taskId]
      );
      if (!rows.rows.length) return ok('No attachments on this task.');
      return ok(rows.rows.map((a) => `• "${a.original_name ?? a.sf_name}" (attachment_id: ${a.id}; ${a.attachment_type})`).join('\n'));
    },
  },
  {
    name: 'attach_file_to_task',
    description: "Attach one of the user's existing uploaded files (from list_files) to a task as a linked attachment.",
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'ID of the task to attach to' },
        file_id: { type: 'string', description: 'ID of the file (from list_files)' },
      },
      required: ['task_id', 'file_id'],
    },
    handler: async (userId, args) => {
      const taskId = Number(args.task_id);
      const fileId = str(args.file_id);
      if (!Number.isFinite(taskId) || !fileId) return fail('task_id and file_id are required');
      const owns = await query(`SELECT 1 FROM tasks WHERE id = $1 AND user_id = $2`, [taskId, userId]);
      if (!owns.rows.length) return fail('task not found');
      const file = await query<{ original_name: string; mime_type: string; file_size: number }>(
        `SELECT original_name, mime_type, file_size FROM shared_files WHERE id = $1 AND user_id = $2`,
        [fileId, userId]
      );
      if (!file.rows.length) return fail('file not found');
      const dup = await query(`SELECT 1 FROM task_attachments WHERE task_id = $1 AND shared_file_id = $2`, [taskId, fileId]);
      if (dup.rows.length) return fail('file already attached to this task');
      const id = uuidv4();
      await query(
        `INSERT INTO task_attachments (id, task_id, user_id, attachment_type, original_name, mime_type, file_size, shared_file_id)
         VALUES ($1, $2, $3, 'linked', $4, $5, $6, $7)`,
        [id, taskId, userId, file.rows[0].original_name, file.rows[0].mime_type, file.rows[0].file_size, fileId]
      );
      broadcastToUser(userId, 'tasks');
      return ok(`Attached "${file.rows[0].original_name}" to task (attachment_id: ${id})`, `Attached "${file.rows[0].original_name}"`);
    },
  },
  {
    name: 'remove_task_attachment',
    description: 'Remove an attachment from a task (only removes the link for linked attachments; the underlying file in Files is not deleted).',
    parameters: {
      type: 'object',
      properties: { attachment_id: { type: 'string', description: 'ID of the attachment (from list_task_attachments)' } },
      required: ['attachment_id'],
    },
    handler: async (userId, args) => {
      const attachmentId = str(args.attachment_id);
      if (!attachmentId) return fail('attachment_id is required');
      const r = await query<{ attachment_type: string; file_path: string | null; original_name: string | null }>(
        `DELETE FROM task_attachments WHERE id = $1 AND user_id = $2 RETURNING attachment_type, file_path, original_name`,
        [attachmentId, userId]
      );
      if (!r.rows.length) return fail('attachment not found');
      const { attachment_type, file_path, original_name } = r.rows[0];
      if (attachment_type === 'upload' && file_path) {
        const filePath = path.join(path.resolve(UPLOAD_DIR), path.basename(file_path));
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
      broadcastToUser(userId, 'tasks');
      return ok(`Removed attachment "${original_name ?? attachmentId}"`, `Removed attachment "${original_name ?? attachmentId}"`);
    },
  },
  // ───────────────────────────── meetings ─────────────────────────────
  {
    name: 'list_meetings',
    description: "List the user's calendar meetings. Optionally filter by date range (from_date to to_date, format YYYY-MM-DD).",
    parameters: {
      type: 'object',
      properties: {
        from_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        to_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
      },
    },
    handler: async (userId, args) => {
      const from = str(args.from_date);
      const to = str(args.to_date);
      const params: unknown[] = [userId];
      let filter = '';
      if (from) { params.push(from); filter += ` AND meeting_date >= $${params.length}`; }
      if (to) { params.push(to); filter += ` AND meeting_date <= $${params.length}`; }
      const r = await query<{ id: string; title: string; meeting_date: string; start_time: string | null; end_time: string | null; all_day: boolean; location: string | null }>(
        `SELECT id, title, meeting_date, start_time, end_time, all_day, location FROM meetings WHERE user_id = $1 ${filter} ORDER BY meeting_date ASC, start_time ASC NULLS FIRST`,
        params
      );
      if (!r.rows.length) return ok('No meetings found.');
      return ok(r.rows.map(m => `• [${m.meeting_date}] ${m.all_day ? '(All Day)' : `${m.start_time ?? '?'} - ${m.end_time ?? '?'}`} "${m.title}" (id: ${m.id})${m.location ? ` at ${m.location}` : ''}`).join('\n'));
    },
  },
  {
    name: 'create_meeting',
    description: 'Schedule a new calendar meeting. Optionally repeat it on a schedule (daily/weekly/monthly/yearly, with an interval and a total occurrence count) to create a whole series in one call.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        start_time: { type: 'string', description: 'HH:MM (24-hour)' },
        end_time: { type: 'string', description: 'HH:MM (24-hour)' },
        all_day: { type: 'boolean' },
        color: { type: 'string', description: 'Hex color string (e.g. #3b82f6)' },
        repeat: {
          type: 'object',
          description: 'Omit for a one-off meeting. When set, creates a recurring series starting on `date`.',
          properties: {
            freq: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
            interval: { type: 'number', description: 'Repeat every N units of freq (e.g. freq=weekly, interval=2 → every 2 weeks). Default 1.' },
            count: { type: 'number', description: 'Total number of occurrences including the first, 2-104.' },
          },
          required: ['freq', 'count'],
        },
        invitee_usernames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Usernames of other instance users to invite. The meeting appears on their calendar too. Unknown usernames are silently skipped.',
        },
      },
      required: ['title', 'date'],
    },
    handler: async (userId, args) => {
      const title = str(args.title);
      const date = str(args.date);
      if (!title || !date) return fail('title and date are required');
      const allDay = args.all_day === true;
      const meetingId = `mt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const rule = parseRecurrenceRule(args.repeat);
      const dates = rule ? computeRecurrenceDates(date, rule) : [date];
      const usernames = Array.isArray(args.invitee_usernames) ? args.invitee_usernames.filter((x): x is string => typeof x === 'string') : [];
      const invitees = usernames.length
        ? (await query<{ id: string }>(`SELECT id FROM users WHERE username = ANY($1::text[])`, [usernames])).rows.map(r => r.id)
        : [];
      const resolvedInvitees = await resolveInviteeIds(invitees, userId);
      for (let i = 0; i < dates.length; i++) {
        const occurrenceId = i === 0 ? meetingId : `mt_${Date.now()}_${Math.floor(Math.random() * 1e6)}_${i}`;
        await query(
          `INSERT INTO meetings (id, user_id, title, description, location, meeting_date, start_time, end_time, all_day, color, recurrence_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [occurrenceId, userId, title, str(args.description) ?? null, str(args.location) ?? null, dates[i], allDay ? null : (str(args.start_time) ?? null), allDay ? null : (str(args.end_time) ?? null), allDay, str(args.color) ?? null, dates.length > 1 ? meetingId : null]
        );
        if (resolvedInvitees.length > 0) await setMeetingAttendees(occurrenceId, resolvedInvitees);
      }
      broadcastToUser(userId, 'meetings');
      for (const inviteeId of resolvedInvitees) broadcastToUser(inviteeId, 'meetings');
      const invitedNote = resolvedInvitees.length > 0 ? ` and invited ${resolvedInvitees.length} ${resolvedInvitees.length === 1 ? 'person' : 'people'}` : '';
      return dates.length > 1
        ? ok(`Scheduled ${dates.length} occurrences of "${title}" starting ${date}${invitedNote}`, `Scheduled "${title}" (${dates.length}x)`)
        : ok(`Scheduled meeting "${title}" on ${date}${invitedNote}`, `Scheduled meeting "${title}"`);
    },
  },
  {
    name: 'update_meeting',
    description: 'Update an existing calendar meeting.',
    parameters: {
      type: 'object',
      properties: {
        meeting_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        start_time: { type: 'string', description: 'HH:MM (24-hour)' },
        end_time: { type: 'string', description: 'HH:MM (24-hour)' },
        all_day: { type: 'boolean' },
        color: { type: 'string' },
      },
      required: ['meeting_id'],
    },
    handler: async (userId, args) => {
      const id = str(args.meeting_id);
      if (!id) return fail('meeting_id is required');
      
      const allDayParam = typeof args.all_day === 'boolean' ? args.all_day : null;
      
      const r = await query<{ title: string }>(
        `UPDATE meetings
         SET title = COALESCE($1, title), description = $2, location = $3, meeting_date = COALESCE($4, meeting_date),
             start_time = $5, end_time = $6, all_day = COALESCE($7, all_day), color = $8, updated_at = NOW()
         WHERE id = $9 AND user_id = $10 RETURNING title`,
        [str(args.title) ?? null, str(args.description) ?? null, str(args.location) ?? null, str(args.date) ?? null, 
         str(args.start_time) ?? null, str(args.end_time) ?? null, allDayParam, str(args.color) ?? null, id, userId]
      );
      if (!r.rows.length) return fail('meeting not found');
      broadcastToUser(userId, 'meetings');
      return ok(`Updated meeting "${r.rows[0].title}"`, `Updated meeting "${r.rows[0].title}"`);
    },
  },
  {
    name: 'delete_meeting',
    description: 'Delete a calendar meeting. Set delete_series to remove every occurrence of a recurring series instead of just this one.',
    parameters: {
      type: 'object',
      properties: {
        meeting_id: { type: 'string' },
        delete_series: { type: 'boolean', description: 'Delete every occurrence in this meeting\'s recurring series, not just this one.' },
      },
      required: ['meeting_id'],
    },
    handler: async (userId, args) => {
      const id = str(args.meeting_id);
      if (!id) return fail('meeting_id is required');
      const r = args.delete_series === true
        ? await query<{ title: string }>(
            `DELETE FROM meetings
             WHERE user_id = $2 AND (
               id = $1
               OR recurrence_id = (SELECT recurrence_id FROM meetings WHERE id = $1 AND user_id = $2)
             ) RETURNING title`,
            [id, userId]
          )
        : await query<{ title: string }>(`DELETE FROM meetings WHERE id = $1 AND user_id = $2 RETURNING title`, [id, userId]);
      if (!r.rows.length) return fail('meeting not found');
      broadcastToUser(userId, 'meetings');
      return r.rows.length > 1
        ? ok(`Deleted ${r.rows.length} occurrences of "${r.rows[0].title}"`, `Deleted "${r.rows[0].title}" series`)
        : ok(`Deleted meeting "${r.rows[0].title}"`, `Deleted meeting "${r.rows[0].title}"`);
    },
  },
  // ───────────────────────────── global search ─────────────────────────────
  {
    name: 'universal_search',
    description: 'Search across all tasks, lists, timelines, milestones, workspaces, and calendar meetings by text query. Use this to find IDs of items when you only know their names.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Text to search for (e.g. meeting name, task title)' } },
      required: ['query'],
    },
    handler: async (userId, args) => {
      const q = str(args.query);
      if (!q) return fail('query is required');
      const term = `%${q}%`;
      
      const [tasksRes, listsRes, timelinesRes, milestonesRes, meetingsRes, workspacesRes] = await Promise.all([
        query<{ id: string; title: string; source: string; list_id: string | null }>(
          `SELECT id, title, source, list_id FROM tasks WHERE user_id = $1 AND (title ILIKE $2 OR note ILIKE $2) LIMIT 10`,
          [userId, term]
        ),
        query<{ id: string; name: string }>(
          `SELECT id, name FROM lists WHERE user_id = $1 AND name ILIKE $2 LIMIT 5`,
          [userId, term]
        ),
        query<{ id: string; name: string }>(
          `SELECT id, name FROM timelines WHERE user_id = $1 AND name ILIKE $2 LIMIT 5`,
          [userId, term]
        ),
        query<{ id: string; title: string; t_name: string }>(
          `SELECT m.id, m.title, t.name as t_name 
           FROM milestones m 
           JOIN timelines t ON m.timeline_id = t.id 
           WHERE t.user_id = $1 AND m.title ILIKE $2 LIMIT 10`,
          [userId, term]
        ),
        query<{ id: string; title: string; meeting_date: string }>(
          `SELECT id, title, meeting_date FROM meetings WHERE user_id = $1 AND (title ILIKE $2 OR location ILIKE $2) LIMIT 5`,
          [userId, term]
        ),
        query<{ id: string; name: string }>(
          `SELECT w.id, w.name FROM workspaces w
           JOIN workspace_members wm ON w.id = wm.workspace_id
           WHERE wm.user_id = $1 AND w.name ILIKE $2 LIMIT 5`,
          [userId, term]
        )
      ]);

      const lines: string[] = [];
      if (tasksRes.rows.length) lines.push('Tasks:', ...tasksRes.rows.map(t => `  - [Task] ${t.title} (id: ${t.id}, in ${t.source === 'dash' ? 'dashboard' : `list ${t.list_id}`})`));
      if (listsRes.rows.length) lines.push('Lists:', ...listsRes.rows.map(l => `  - [List] ${l.name} (id: ${l.id})`));
      if (timelinesRes.rows.length) lines.push('Timelines:', ...timelinesRes.rows.map(t => `  - [Timeline] ${t.name} (id: ${t.id})`));
      if (milestonesRes.rows.length) lines.push('Milestones:', ...milestonesRes.rows.map(m => `  - [Milestone] ${m.title} (id: ${m.id}, in timeline ${m.t_name})`));
      if (meetingsRes.rows.length) lines.push('Meetings:', ...meetingsRes.rows.map(m => `  - [Meeting] ${m.title} (id: ${m.id}, on ${m.meeting_date})`));
      if (workspacesRes.rows.length) lines.push('Workspaces:', ...workspacesRes.rows.map(w => `  - [Workspace] ${w.name} (id: ${w.id})`));

      if (!lines.length) return ok(`No items found matching "${q}".`);
      return ok(lines.join('\n'));
    },
  },

  // ───────────────────────────── templates ─────────────────────────────
  {
    name: 'list_templates',
    description: "List the user's saved templates (own + every shared template from other users of this instance) — reusable snapshots of a list's or timeline's structure. Use use_template to materialize one into a new list/timeline.",
    parameters: {
      type: 'object',
      properties: { type: { type: 'string', enum: ['list', 'timeline'], description: 'Optional filter' } },
    },
    handler: async (userId, args) => {
      const type = str(args.type);
      const params: unknown[] = [userId];
      let typeFilter = '';
      if (type === 'list' || type === 'timeline') { params.push(type); typeFilter = `AND t.type = $${params.length}`; }
      const rows = await query<{ id: string; type: string; name: string; is_shared: boolean; user_id: string }>(
        `SELECT t.id, t.type, t.name, t.is_shared, t.user_id
         FROM templates t WHERE (t.user_id = $1 OR t.is_shared = true) ${typeFilter} ORDER BY t.updated_at DESC`,
        params
      );
      if (!rows.rows.length) return ok('No templates found.');
      return ok(rows.rows.map((t) => `• "${t.name}" (template_id: ${t.id}; ${t.type}${t.user_id === userId ? '; yours' : '; shared by another user'})`).join('\n'));
    },
  },
  {
    name: 'create_template',
    description: "Save one of the user's own lists or timelines as a reusable template. Deadlines/milestone dates are stored as relative day-offsets so the template stays meaningful whenever it's reused.",
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['list', 'timeline'] },
        source_id: { type: 'string', description: 'ID of the list or timeline to capture (must be owned by the user)' },
        name: { type: 'string', description: 'Template name (defaults to the source name)' },
        description: { type: 'string' },
        is_shared: { type: 'boolean', description: 'Make this template visible read-only to every other user of this instance (default false)' },
      },
      required: ['type', 'source_id'],
    },
    handler: async (userId, args) => {
      const type = str(args.type);
      const sourceId = str(args.source_id);
      if (type !== 'list' && type !== 'timeline') return fail('type must be "list" or "timeline"');
      if (!sourceId) return fail('source_id is required');
      const today = todayISODate();
      let structure: TemplateListNode | TemplateTimelineNode;
      let templateName = str(args.name);
      if (type === 'list') {
        const own = await query<{ user_id: string; name: string }>('SELECT user_id, name FROM lists WHERE id = $1', [sourceId]);
        if (!own.rows.length) return fail('list not found');
        if (own.rows[0].user_id !== userId) return fail('you can only save your own lists as templates');
        structure = await captureListStructure(sourceId, userId, today);
        if (!templateName) templateName = own.rows[0].name;
      } else {
        const own = await query<{ user_id: string; name: string }>('SELECT user_id, name FROM timelines WHERE id = $1', [sourceId]);
        if (!own.rows.length) return fail('timeline not found');
        if (own.rows[0].user_id !== userId) return fail('you can only save your own timelines as templates');
        structure = await captureTimelineStructure(sourceId, userId, today);
        if (!templateName) templateName = own.rows[0].name;
      }
      const templateId = `template_${uuidv4()}`;
      await query(
        `INSERT INTO templates (id, user_id, type, name, description, emoji, color, color_bg, is_shared, structure)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [templateId, userId, type, templateName, str(args.description) ?? null, structure.emoji, structure.color, structure.colorBg, args.is_shared === true, JSON.stringify(structure)]
      );
      broadcastToUser(userId, 'template');
      return ok(`Saved template "${templateName}" (template_id: ${templateId})`, `Saved template "${templateName}"`);
    },
  },
  {
    name: 'use_template',
    description: 'Materialize a new list or timeline from a saved template (own or shared). Dates are resolved against today.',
    parameters: {
      type: 'object',
      properties: {
        template_id: { type: 'string', description: 'ID of the template (from list_templates)' },
        name: { type: 'string', description: 'Name for the new list/timeline (defaults to the template name)' },
        is_public: { type: 'boolean' },
        workspace_id: { type: 'string', description: 'Target workspace ID. Omit to use the current/personal workspace.' },
        folder_id: { type: 'string' },
      },
      required: ['template_id'],
    },
    handler: async (userId, args) => {
      const templateId = str(args.template_id);
      if (!templateId) return fail('template_id is required');
      const tRes = await query<{ id: string; user_id: string; type: string; is_shared: boolean; structure: TemplateListNode | TemplateTimelineNode }>(
        'SELECT id, user_id, type, is_shared, structure FROM templates WHERE id = $1', [templateId]
      );
      if (!tRes.rows.length) return fail('template not found');
      const tpl = tRes.rows[0];
      if (tpl.user_id !== userId && !tpl.is_shared) return fail('template not found');
      const resolvedWs = await resolveWorkspaceForUser(userId, str(args.workspace_id) ?? null);
      const allowAttachments = tpl.user_id === userId;
      const nextTaskId = makeTaskIdGenerator();
      const trimmedName = str(args.name);
      const folderId = str(args.folder_id) ?? null;
      if (tpl.type === 'list') {
        const node = tpl.structure as TemplateListNode;
        const createdId = await withTransaction((client) =>
          instantiateListStructure(client, node, { userId, workspaceId: resolvedWs, folderId, depth: 0, allowAttachments, nextTaskId }, trimmedName, args.is_public as boolean | undefined)
        );
        broadcastToUser(userId, 'lists');
        return ok(`Created list "${trimmedName ?? node.name}" from template (list_id: ${createdId})`, `Created list "${trimmedName ?? node.name}"`);
      } else {
        const node = tpl.structure as TemplateTimelineNode;
        const createdId = await withTransaction((client) =>
          instantiateTimelineStructure(client, node, { userId, workspaceId: resolvedWs, folderId, allowAttachments }, trimmedName, args.is_public as boolean | undefined)
        );
        broadcastToUser(userId, 'timelines');
        return ok(`Created timeline "${trimmedName ?? node.name}" from template (timeline_id: ${createdId})`, `Created timeline "${trimmedName ?? node.name}"`);
      }
    },
  },
  {
    name: 'delete_template',
    description: 'Delete a saved template (metadata only — does not affect any lists/timelines created from it). Confirm with the user first.',
    parameters: {
      type: 'object',
      properties: { template_id: { type: 'string' } },
      required: ['template_id'],
    },
    handler: async (userId, args) => {
      const templateId = str(args.template_id);
      if (!templateId) return fail('template_id is required');
      const existing = await query<{ user_id: string; name: string }>('SELECT user_id, name FROM templates WHERE id = $1', [templateId]);
      if (!existing.rows.length) return fail('template not found');
      if (existing.rows[0].user_id !== userId) return fail('you can only delete your own templates');
      await query('DELETE FROM templates WHERE id = $1', [templateId]);
      broadcastToUser(userId, 'template');
      return ok(`Deleted template "${existing.rows[0].name}"`, `Deleted template "${existing.rows[0].name}"`);
    },
  },

  // ───────────────────────────── GPS files ─────────────────────────────
  {
    name: 'list_gps_files',
    description: 'List the GPS route/workout files (.gpx/.fit) the user has uploaded — names, ids, distance, elevation gain, duration.',
    parameters: { type: 'object', properties: {} },
    handler: async (userId) => {
      const rows = await query<{ id: string; original_name: string; file_type: string; metadata: { totalDistance?: number; totalElevationGain?: number; duration?: number } | null }>(
        `SELECT id, original_name, file_type, metadata FROM gps_files WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId]
      );
      if (!rows.rows.length) return ok('No GPS files uploaded.');
      return ok(rows.rows.map((r) => {
        const m = r.metadata;
        const dist = m?.totalDistance != null ? ` ${(m.totalDistance / 1000).toFixed(1)} km` : '';
        const elev = m?.totalElevationGain != null ? ` ↑${Math.round(m.totalElevationGain)}m` : '';
        const dur = m?.duration != null ? ` ${Math.round(m.duration / 60)}min` : '';
        return `• "${r.original_name}" (gps_file_id: ${r.id}; ${r.file_type.toUpperCase()}${dist}${elev}${dur})`;
      }).join('\n'));
    },
  },
  {
    name: 'rename_gps_file',
    description: 'Rename a GPS route/workout file.',
    parameters: {
      type: 'object',
      properties: {
        gps_file_id: { type: 'string' },
        name: { type: 'string', description: 'New file name' },
      },
      required: ['gps_file_id', 'name'],
    },
    handler: async (userId, args) => {
      const id = str(args.gps_file_id);
      const name = str(args.name);
      if (!id || !name) return fail('gps_file_id and name are required');
      const r = await query<{ original_name: string }>(
        `UPDATE gps_files SET original_name = $1 WHERE id = $2 AND user_id = $3 RETURNING original_name`,
        [name, id, userId]
      );
      if (!r.rows.length) return fail('GPS file not found');
      broadcastToUser(userId, 'gps');
      return ok(`Renamed GPS file to "${r.rows[0].original_name}"`, `Renamed to "${r.rows[0].original_name}"`);
    },
  },
  {
    name: 'delete_gps_file',
    description: 'Permanently delete a GPS route/workout file. Confirm with the user first.',
    parameters: {
      type: 'object',
      properties: { gps_file_id: { type: 'string' } },
      required: ['gps_file_id'],
    },
    handler: async (userId, args) => {
      const id = str(args.gps_file_id);
      if (!id) return fail('gps_file_id is required');
      const r = await query<{ original_name: string; file_path: string }>(
        `DELETE FROM gps_files WHERE id = $1 AND user_id = $2 RETURNING original_name, file_path`,
        [id, userId]
      );
      if (!r.rows.length) return fail('GPS file not found');
      const filePath = path.join(path.resolve(UPLOAD_DIR), path.basename(r.rows[0].file_path));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      broadcastToUser(userId, 'gps');
      return ok(`Deleted GPS file "${r.rows[0].original_name}"`, `Deleted "${r.rows[0].original_name}"`);
    },
  },

  // ───────────────────────────── trash (read-only) ─────────────────────────────
  {
    name: 'list_trash',
    description: 'List everything currently in the trash (deleted tasks, lists, folders, and timelines — each recoverable for 30 days from deletion). Use this to check what was recently deleted; restoring must be done from the Trash view in the app.',
    parameters: { type: 'object', properties: {} },
    handler: async (userId) => {
      const [tasks, lists, folders, timelines] = await Promise.all([
        query<{ id: number; task_data: { title?: string }; deleted_at: string }>(
          `SELECT id, task_data, deleted_at FROM trash WHERE user_id = $1 AND expires_at > NOW() ORDER BY deleted_at DESC`, [userId]
        ),
        query<{ id: number; list_data: { name?: string }; deleted_at: string }>(
          `SELECT id, list_data, deleted_at FROM trash_lists WHERE user_id = $1 AND expires_at > NOW() ORDER BY deleted_at DESC`, [userId]
        ),
        query<{ id: number; folder_data: { name?: string }; deleted_at: string }>(
          `SELECT id, folder_data, deleted_at FROM trash_folders WHERE user_id = $1 AND expires_at > NOW() ORDER BY deleted_at DESC`, [userId]
        ),
        query<{ id: number; timeline_data: { name?: string }; deleted_at: string }>(
          `SELECT id, timeline_data, deleted_at FROM trash_timelines WHERE user_id = $1 AND expires_at > NOW() ORDER BY deleted_at DESC`, [userId]
        ),
      ]);
      const lines: string[] = [];
      if (tasks.rows.length) lines.push('Tasks:', ...tasks.rows.map(t => `  - "${t.task_data?.title ?? 'untitled'}" (trash_id: ${t.id}, deleted ${t.deleted_at})`));
      if (lists.rows.length) lines.push('Lists:', ...lists.rows.map(l => `  - "${l.list_data?.name ?? 'untitled'}" (trash_id: ${l.id}, deleted ${l.deleted_at})`));
      if (folders.rows.length) lines.push('Folders:', ...folders.rows.map(f => `  - "${f.folder_data?.name ?? 'untitled'}" (trash_id: ${f.id}, deleted ${f.deleted_at})`));
      if (timelines.rows.length) lines.push('Timelines:', ...timelines.rows.map(t => `  - "${t.timeline_data?.name ?? 'untitled'}" (trash_id: ${t.id}, deleted ${t.deleted_at})`));
      if (!lines.length) return ok('Trash is empty.');
      return ok(lines.join('\n'));
    },
  },

  // ───────────────────────────── Graph Layer (WP-8) ───────────────────────────
  {
    name: 'search_graph',
    description: 'Search across every linkable item (tasks, boards, pages, timelines, milestones, meetings, folders, files) by title. Returns each match\'s SRN (a stable "srn:type:id" reference) for use with the other graph tools.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Title search text' },
        entity_types: { type: 'string', description: 'Comma-separated entity types to restrict to, e.g. "task,list"' },
        limit: { type: 'number', description: 'Max results (default 20, capped at 50)' },
      },
      required: ['query'],
    },
    handler: async (userId, args) => {
      const q = str(args.query);
      if (!q) return fail('query is required');
      const typesRaw = str(args.entity_types);
      const entityTypes = typesRaw ? typesRaw.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
      if (entityTypes && !entityTypes.every(isValidEntityType)) return fail('entity_types contains an unknown entity type');
      const results = await searchEntityIndex(userId, q, { entityTypes, limit: typeof args.limit === 'number' ? args.limit : undefined });
      if (!results.length) return ok('No matches.');
      return ok(results.map((e) => `- ${formatSrn(e.entityType, e.entityId)} — "${e.title}"${e.subtitle ? ` (${e.subtitle})` : ''}`).join('\n'));
    },
  },
  {
    name: 'get_entity_links',
    description: 'Get every graph relation touching an item (both directions), grouped by relation type — e.g. "this task blocks that milestone". Use search_graph first if you only have a title.',
    parameters: {
      type: 'object',
      properties: { entity_srn: { type: 'string', description: 'e.g. srn:task:1751293847221' } },
      required: ['entity_srn'],
    },
    handler: async (userId, args) => {
      const srn = str(args.entity_srn);
      if (!srn) return fail('entity_srn is required');
      const ref = parseSrn(srn);
      if (!ref) return fail('entity_srn is not a valid SRN');
      if (!(await isEntityVisible(query, userId, ref.entityType, ref.entityId))) return fail('entity not found');
      const links = await getEntityLinks(userId, ref);
      if (!links.length) return ok('No relations.');
      const byType = new Map<string, typeof links>();
      for (const l of links) (byType.get(l.link.linkType) ?? byType.set(l.link.linkType, []).get(l.link.linkType)!).push(l);
      const lines: string[] = [];
      for (const [type, group] of byType) {
        lines.push(`${type}:`);
        for (const l of group) {
          const other = l.direction === 'out' ? `${l.link.dstType}:${l.link.dstId}` : `${l.link.srcType}:${l.link.srcId}`;
          lines.push(`  - [${l.direction}] srn:${other}${l.neighbor ? ` — "${l.neighbor.title}"` : ' (restricted)'} (link_id: ${l.link.id}${l.link.origin === 'system' ? ', system-managed' : ''})`);
        }
      }
      return ok(lines.join('\n'));
    },
  },
  {
    name: 'get_backlinks',
    description: 'Get only the INCOMING relations to an item — everything that references it.',
    parameters: {
      type: 'object',
      properties: { entity_srn: { type: 'string', description: 'e.g. srn:list:list_7f3a9c21' } },
      required: ['entity_srn'],
    },
    handler: async (userId, args) => {
      const srn = str(args.entity_srn);
      if (!srn) return fail('entity_srn is required');
      const ref = parseSrn(srn);
      if (!ref) return fail('entity_srn is not a valid SRN');
      if (!(await isEntityVisible(query, userId, ref.entityType, ref.entityId))) return fail('entity not found');
      const backlinks = await getBacklinks(userId, ref);
      if (!backlinks.length) return ok('Nothing links to this item.');
      return ok(backlinks.map((l) => `- srn:${l.link.srcType}:${l.link.srcId}${l.neighbor ? ` — "${l.neighbor.title}"` : ' (restricted)'} [${l.link.linkType}]`).join('\n'));
    },
  },
  {
    name: 'create_link',
    description: 'Create a typed relation between two items, e.g. "this task blocks that milestone". Requires edit access to the source item; the destination only needs to be visible to you.',
    parameters: {
      type: 'object',
      properties: {
        src_srn: { type: 'string', description: 'The relation points FROM this item' },
        dst_srn: { type: 'string', description: 'The relation points TO this item' },
        link_type: { type: 'string', description: 'e.g. blocks, relates_to, references, tracks, child_of, duplicates' },
      },
      required: ['src_srn', 'dst_srn', 'link_type'],
    },
    handler: async (userId, args) => {
      const srcSrn = str(args.src_srn), dstSrn = str(args.dst_srn), linkType = str(args.link_type);
      if (!srcSrn || !dstSrn || !linkType) return fail('src_srn, dst_srn, and link_type are required');
      const src = parseSrn(srcSrn), dst = parseSrn(dstSrn);
      if (!src || !dst) return fail('src_srn or dst_srn is not a valid SRN');
      if (!(await isEntityVisible(query, userId, src.entityType, src.entityId))) return fail('source entity not found');
      if (!(await isEntityVisible(query, userId, dst.entityType, dst.entityId))) return fail('destination entity not found');
      if (!(await canWriteEntity(userId, false, src.entityType, src.entityId))) return fail('no permission to link from this item');
      try {
        const link = await upsertLink(query, { srcType: src.entityType, srcId: src.entityId, dstType: dst.entityType, dstId: dst.entityId, linkType, origin: 'manual', createdBy: userId });
        return ok(`Linked ${srcSrn} --[${linkType}]--> ${dstSrn} (link_id: ${link.id})`, `Created a "${linkType}" link`);
      } catch (err) {
        return fail(err instanceof LinkError ? err.message : 'could not create the link');
      }
    },
  },
  {
    name: 'delete_link',
    description: 'Remove a relation by its link_id (from get_entity_links/create_link). System-managed relations (mirrored from e.g. sublists or attachments) cannot be deleted this way — edit them from where they were created instead.',
    parameters: {
      type: 'object',
      properties: { link_id: { type: 'string' } },
      required: ['link_id'],
    },
    handler: async (userId, args) => {
      const linkId = str(args.link_id);
      if (!linkId) return fail('link_id is required');
      const link = await getLinkById(query, linkId);
      if (!link) return fail('link not found');
      if (link.origin === 'system') return fail('this relation is system-managed and cannot be deleted directly');
      const canManage = (await canWriteEntity(userId, false, link.srcType, link.srcId)) || (await canWriteEntity(userId, false, link.dstType, link.dstId));
      if (!canManage) return fail('no permission to remove this relation');
      await deleteLink(query, linkId);
      return ok('Relation removed.');
    },
  },
  {
    name: 'find_unlinked_mentions',
    description: 'Find other items whose title mentions this one but aren\'t linked to it yet — candidates for create_link. A title-substring heuristic, not full content parsing.',
    parameters: {
      type: 'object',
      properties: { entity_srn: { type: 'string' }, limit: { type: 'number' } },
      required: ['entity_srn'],
    },
    handler: async (userId, args) => {
      const srn = str(args.entity_srn);
      if (!srn) return fail('entity_srn is required');
      const ref = parseSrn(srn);
      if (!ref) return fail('entity_srn is not a valid SRN');
      const candidates = await findUnlinkedMentions(userId, ref, { limit: typeof args.limit === 'number' ? args.limit : undefined });
      if (!candidates.length) return ok('No unlinked mentions found.');
      return ok(candidates.map((c) => `- ${formatSrn(c.entityType, c.entityId)} — "${c.title}"`).join('\n'));
    },
  },

  // ─────────────────────────── Knowledge Layer (WP-8) ─────────────────────────
  {
    name: 'knowledge_search',
    description: 'Semantic + lexical search over the CONTENT of notes, pages, milestones, and meetings (not just titles) — finds things by what they say, not just what they\'re called.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        entity_types: { type: 'string', description: 'Comma-separated, e.g. "task,markdownList"' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
    handler: async (userId, args) => {
      const q = str(args.query);
      if (!q) return fail('query is required');
      const typesRaw = str(args.entity_types);
      const entityTypes = typesRaw ? typesRaw.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
      if (entityTypes && !entityTypes.every(isValidEntityType)) return fail('entity_types contains an unknown entity type');
      const settingsRes = await query<{ key: string; value: string }>(`SELECT key, value FROM app_settings`);
      const settings: Record<string, string> = {};
      for (const row of settingsRes.rows) settings[row.key] = row.value;
      const hits = await hybridSearch(userId, q, settings, { entityTypes, limit: typeof args.limit === 'number' ? args.limit : undefined });
      if (!hits.length) return ok('No matches.');
      return ok(hits.map((h) => `- ${h.entity.srn} — "${h.entity.title}": ${h.chunkContent.slice(0, 200)}${h.chunkContent.length > 200 ? '…' : ''}`).join('\n\n'));
    },
  },
  {
    name: 'get_knowledge_status',
    description: 'Check whether semantic search is available (pgvector installed, an embedding provider configured) and the current indexing queue depth.',
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      const settingsRes = await query<{ key: string; value: string }>(`SELECT key, value FROM app_settings`);
      const settings: Record<string, string> = {};
      for (const row of settingsRes.rows) settings[row.key] = row.value;
      const stats = await getQueueStats();
      return ok(
        `Semantic search: ${isPgvectorAvailable() ? (getEmbeddingConfig(settings) ? 'active' : 'pgvector ready, no provider configured') : 'unavailable (lexical/trigram search only)'}. ` +
        `Queue: ${stats.pending} pending, ${stats.processing} processing, ${stats.done} indexed, ${stats.failed} failed.`
      );
    },
  },

  // ───────────────────────────── Knowledge Base ───────────────────────────────
  // The workspace's curated dictionary. Distinct from knowledge_search above:
  // that ranks CONTENT by relevance, this resolves a TERM to a definition or
  // to nothing. When a model is about to state a fact about the user's own
  // vocabulary, a clean miss beats a 60%-right guess — so lookup never falls
  // back to fuzzy matching, it returns near-misses labelled as such.
  {
    name: 'create_knowledge_base',
    description: "Create a workspace's Knowledge Base — the single curated dictionary each workspace can have. Call this when another Knowledge Base tool reports the workspace has none yet. Safe to call twice: it returns the existing base rather than creating a second one.",
    parameters: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        name: { type: 'string', description: 'Defaults to "Knowledge".' },
        description: { type: 'string', description: 'Optional one-line description of what this workspace\'s vocabulary covers.' },
      },
      required: ['workspace_id'],
    },
    handler: async (userId, args) => {
      const workspaceId = str(args.workspace_id);
      if (!workspaceId) return fail('workspace_id is required');
      // Creating the base is a WRITE, so it needs membership — not the looser
      // workspace access the read tools take.
      if (!(await isWorkspaceMemberForTools(userId, workspaceId))) return fail('workspace not found');
      const { base, created } = await createBase(userId, workspaceId, {
        name: str(args.name),
        description: str(args.description) ?? null,
      });
      return created
        ? ok(`Created this workspace's Knowledge Base. Define terms in it with create_knowledge_entry.`, 'Created the Knowledge Base')
        : ok(`This workspace already has a Knowledge Base ("${base.name}"). Define terms in it with create_knowledge_entry.`);
    },
  },
  {
    name: 'lookup_knowledge',
    description: "Look up what a workspace means by a specific term, in its Knowledge Base. Use this BEFORE guessing at any project/system/acronym name you don't recognise. Returns the definition, or an explicit \"not defined\" plus near-miss terms — never an invented answer.",
    parameters: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        term: { type: 'string', description: 'The exact term or one of its aliases.' },
      },
      required: ['workspace_id', 'term'],
    },
    handler: async (userId, args) => {
      const workspaceId = str(args.workspace_id);
      const term = str(args.term);
      if (!workspaceId || !term) return fail('workspace_id and term are required');
      if (!(await userCanAccessWorkspace(userId, workspaceId))) return fail('workspace not found');
      const res = await lookupTerm(workspaceId, term);
      if (!res.found) {
        const near = res.suggestions.length
          ? ` Closest defined terms: ${res.suggestions.map((s) => `"${s.term}"`).join(', ')}.`
          : '';
        return ok(`"${term}" is not defined in this workspace's Knowledge Base.${near}`);
      }
      const e = res.entry;
      const lines = [
        `${e.term}${res.matchedOn === 'alias' ? ` (matched alias "${res.matchedAlias}")` : ''} — ${e.entryType} (entry_id: ${e.id})`,
        e.summary ? `Summary: ${e.summary}` : null,
        e.aliases.length ? `Also known as: ${e.aliases.join(', ')}` : null,
        Object.keys(e.properties).length ? `Properties: ${JSON.stringify(e.properties)}` : null,
        res.body ? `\n${res.body}` : null,
      ].filter(Boolean);
      return ok(lines.join('\n'), `Defined: ${e.term}`);
    },
  },
  {
    name: 'list_knowledge_terms',
    description: "List every term defined in a workspace's Knowledge Base, with one-line summaries and the entry_id needed to revise, delete or link each one. Use this to orient yourself in an unfamiliar workspace before answering questions about it.",
    parameters: {
      type: 'object',
      properties: { workspace_id: { type: 'string' } },
      required: ['workspace_id'],
    },
    handler: async (userId, args) => {
      const workspaceId = str(args.workspace_id);
      if (!workspaceId) return fail('workspace_id is required');
      if (!(await userCanAccessWorkspace(userId, workspaceId))) return fail('workspace not found');
      // "No base at all" and "a base with nothing in it" are different
      // situations with different fixes, so they must not collapse into one
      // message — the first is actionable, the second is just empty.
      const base = await getBaseForWorkspace(workspaceId);
      if (!base) return ok('This workspace has no Knowledge Base yet. Create one with create_knowledge_base.');
      const terms = await listGlossary(workspaceId);
      if (!terms.length) return ok('This workspace has a Knowledge Base, but no terms are defined in it yet.');
      // The entry_id is carried here because nothing else produces one, and
      // update/delete/link_knowledge_entry all require it.
      return ok(terms.map((t) =>
        `- ${t.term}${t.aliases.length ? ` (aka ${t.aliases.join(', ')})` : ''} [${t.entryType}] (entry_id: ${t.id})${t.summary ? `: ${t.summary}` : ''}`
      ).join('\n'));
    },
  },
  {
    name: 'create_knowledge_entry',
    description: "Define a new term in a workspace's Knowledge Base. Only record things that are actually established in that workspace — this is an authoritative source other people and agents will rely on, not a scratchpad for guesses.",
    parameters: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        term: { type: 'string' },
        summary: { type: 'string', description: 'One line. This is what gets carried into future context.' },
        entry_type: { type: 'string', description: `One of: ${ENTRY_TYPES.join(', ')}` },
        aliases: { type: 'string', description: 'Comma-separated alternative names.' },
        body: { type: 'string', description: 'Optional longer definition. Blank-line-separated paragraphs.' },
      },
      required: ['workspace_id', 'term'],
    },
    handler: async (userId, args) => {
      const workspaceId = str(args.workspace_id);
      const term = str(args.term);
      if (!workspaceId || !term) return fail('workspace_id and term are required');
      const base = await requireWritableBase(userId, workspaceId);
      if ('error' in base) return fail(base.error);

      const aliasRaw = str(args.aliases);
      const bodyRaw = str(args.body);
      const blocks = bodyRaw ? knowledgeBodyBlocks(bodyRaw) : [];

      const created = await createEntry(userId, base.base.id, {
        term,
        summary: str(args.summary) ?? null,
        entryType: str(args.entry_type) ?? 'concept',
        aliases: aliasRaw ? aliasRaw.split(',').map((a) => a.trim()).filter(Boolean) : [],
        content: { version: 1, blocks },
        // Flagged so the UI can show a human that this definition came from an
        // assistant rather than a person — reviewable, not silently trusted.
        origin: 'ai',
      });
      if (!created.ok) return fail(created.error);
      await enqueueEmbedding('knowledgeEntry', created.entry.id, workspaceId);
      return ok(
        `Defined "${created.entry.term}" in the Knowledge Base (entry_id: ${created.entry.id}).`,
        `Defined ${created.entry.term}`
      );
    },
  },
  {
    name: 'update_knowledge_entry',
    description: "Revise an existing Knowledge Base term — its definition body, summary, aliases, type, or the term itself. Get the entry_id from list_knowledge_terms or lookup_knowledge. Only the fields you pass change.",
    parameters: {
      type: 'object',
      properties: {
        entry_id: { type: 'string' },
        term: { type: 'string' },
        summary: { type: 'string' },
        entry_type: { type: 'string', description: `One of: ${ENTRY_TYPES.join(', ')}` },
        aliases: { type: 'string', description: 'Comma-separated. Replaces the existing aliases.' },
        body: {
          type: 'string',
          description: "Replaces the entry's full definition body. Blank-line-separated paragraphs. Read the current body with lookup_knowledge first if you mean to extend it rather than overwrite it. Pass an empty string to clear the body; omit to leave it untouched.",
        },
      },
      required: ['entry_id'],
    },
    handler: async (userId, args) => {
      const entryId = str(args.entry_id);
      if (!entryId) return fail('entry_id is required');
      const found = await requireWritableEntry(userId, entryId);
      if ('error' in found) return fail(found.error);

      const aliasRaw = str(args.aliases);
      const updated = await updateEntry(entryId, {
        term: str(args.term),
        summary: args.summary !== undefined ? (str(args.summary) ?? null) : undefined,
        entryType: str(args.entry_type),
        aliases: aliasRaw !== undefined ? aliasRaw.split(',').map((a) => a.trim()).filter(Boolean) : undefined,
      });
      if (!updated.ok) return fail(updated.error);

      // The body goes through mutateEntryBlocks rather than a bare content
      // write, so an AI edit runs the same post-save pipeline a human edit does:
      // inline `[[...]]` link sync, @-mention notifications, image pruning and
      // the embedding enqueue. `str()` is deliberately not used here — it maps
      // '' to undefined, which would make clearing a body impossible.
      let bodyNote = '';
      if (typeof args.body === 'string') {
        const blocks = knowledgeBodyBlocks(args.body);
        const res = await mutateEntryBlocks(userId, entryId, found.base.workspace_id, () => blocks);
        if (!res.ok) return fail(res.error);
        bodyNote = blocks.length ? ' Body replaced.' : ' Body cleared.';
      }

      await enqueueEmbedding('knowledgeEntry', entryId, found.base.workspace_id);
      return ok(`Updated "${updated.entry.term}".${bodyNote}`, `Updated ${updated.entry.term}`);
    },
  },
  {
    name: 'delete_knowledge_entry',
    description: "Remove a term from a workspace's Knowledge Base. Prefer updating a definition over deleting it — other people and agents may be relying on it.",
    parameters: {
      type: 'object',
      properties: { entry_id: { type: 'string' } },
      required: ['entry_id'],
    },
    handler: async (userId, args) => {
      const entryId = str(args.entry_id);
      if (!entryId) return fail('entry_id is required');
      const found = await requireWritableEntry(userId, entryId);
      if ('error' in found) return fail(found.error);
      await deleteEntry(entryId);
      return ok(`Removed "${found.entry.term}" from the Knowledge Base.`, `Removed ${found.entry.term}`);
    },
  },
  {
    name: 'link_knowledge_entry',
    description: 'Relate a Knowledge Base term to another term or to any item (board, page, task, timeline). Use synonym_of for equivalent terms, broader_than for a parent concept, documents/references to point at the thing the term is about.',
    parameters: {
      type: 'object',
      properties: {
        entry_id: { type: 'string' },
        target_srn: { type: 'string', description: 'e.g. srn:list:list_7f3a — get one from search_graph.' },
        link_type: { type: 'string', description: 'synonym_of | broader_than | references | documents | relates_to (default)' },
      },
      required: ['entry_id', 'target_srn'],
    },
    handler: async (userId, args) => {
      const entryId = str(args.entry_id);
      const targetSrn = str(args.target_srn);
      if (!entryId || !targetSrn) return fail('entry_id and target_srn are required');
      const found = await requireWritableEntry(userId, entryId);
      if ('error' in found) return fail(found.error);
      const ref = parseSrn(targetSrn);
      if (!ref) return fail('target_srn is not a valid SRN');
      try {
        await upsertLink(query, {
          srcType: 'knowledgeEntry', srcId: entryId,
          dstType: ref.entityType, dstId: ref.entityId,
          linkType: str(args.link_type) ?? 'relates_to',
          origin: 'agent', createdBy: userId,
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'Could not create that relation');
      }
      return ok(`Linked "${found.entry.term}" to ${targetSrn}.`);
    },
  },

  // ───────────────────────────── AI Skills ─────────────────────────────────
  // Admin-curated, instance-wide context bundles (Settings → AI Skills) that
  // personalize/extend Sol, the Agent Runtime, and MCP clients — a SKILL.md
  // body plus optional bundled reference files. Progressive disclosure: every
  // enabled skill's name+description already rides in the system prompt (see
  // buildSystemPrompt in useAIStore.ts); these tools are how a model pulls
  // the FULL content once a task actually matches one, and — for an admin —
  // how it manages skills entirely by being asked to, no UI required.
  //
  // Reads (list/read) are open to any signed-in user but only ever surface
  // ENABLED skills unless the caller is an admin — a disabled skill isn't
  // "active" instance context yet. Writes (create/update/delete/file edits)
  // are admin-only. Handlers only ever receive a userId (see the AiTool type
  // above), so admin-gating happens by querying users.is_admin directly
  // (isUserAdmin) rather than trusting anything the model claims.
  {
    name: 'list_skills',
    description: 'List AI Skills — admin-curated context bundles that personalize this assistant. By default only ENABLED skills are shown (the ones actually informing responses right now). Pass include_disabled=true (admin only) to also see disabled ones.',
    parameters: {
      type: 'object',
      properties: { include_disabled: { type: 'boolean', description: 'Admin only — also list disabled skills.' } },
    },
    handler: async (userId, args) => {
      const includeDisabled = args.include_disabled === true;
      if (includeDisabled && !(await isUserAdmin(userId))) return fail('admin access required to list disabled skills');
      const skills = await listSkills({ enabledOnly: !includeDisabled });
      if (!skills.length) return ok('No AI Skills defined yet.');
      return ok(skills.map((s) => `- "${s.name}" (id: ${s.id})${s.enabled ? '' : ' [disabled]'}${s.file_count ? ` [${s.file_count} file${s.file_count === 1 ? '' : 's'}]` : ''}: ${s.description || 'no description'}`).join('\n'));
    },
  },
  {
    name: 'read_skill',
    description: 'Get the full instructions (SKILL.md content) of one AI Skill by id or name, plus the names of any bundled reference files. Call this before acting on a task that matches a skill from list_skills.',
    parameters: { type: 'object', properties: { skill_id: { type: 'string', description: 'The skill\'s id or name.' } }, required: ['skill_id'] },
    handler: async (userId, args) => {
      const skillRef = str(args.skill_id);
      if (!skillRef) return fail('skill_id is required');
      const skill = await findSkill(skillRef);
      if (!skill) return fail('skill not found');
      if (!skill.enabled && !(await isUserAdmin(userId))) return fail('this skill is currently disabled');
      const files = await listSkillFiles(skill.id);
      const fileList = files.length ? `\n\nBundled reference files (call read_skill_file to read one):\n${files.map((f) => `- ${f.file_path} (${f.size_bytes}B)`).join('\n')}` : '';
      return ok(`# ${skill.name}\n\n${skill.content}${fileList}`);
    },
  },
  {
    name: 'list_skill_files',
    description: 'List the bundled reference files (name + size) attached to an AI Skill.',
    parameters: { type: 'object', properties: { skill_id: { type: 'string' } }, required: ['skill_id'] },
    handler: async (userId, args) => {
      const skillRef = str(args.skill_id);
      if (!skillRef) return fail('skill_id is required');
      const skill = await findSkill(skillRef);
      if (!skill) return fail('skill not found');
      if (!skill.enabled && !(await isUserAdmin(userId))) return fail('this skill is currently disabled');
      const files = await listSkillFiles(skill.id);
      if (!files.length) return ok('This skill has no bundled reference files.');
      return ok(files.map((f) => `- ${f.file_path} (${f.size_bytes}B)`).join('\n'));
    },
  },
  {
    name: 'read_skill_file',
    description: 'Read the text content of one bundled reference file attached to an AI Skill.',
    parameters: {
      type: 'object',
      properties: { skill_id: { type: 'string' }, file_path: { type: 'string', description: 'Exact path as shown by list_skill_files/read_skill.' } },
      required: ['skill_id', 'file_path'],
    },
    handler: async (userId, args) => {
      const skillRef = str(args.skill_id), filePath = str(args.file_path);
      if (!skillRef || !filePath) return fail('skill_id and file_path are required');
      const skill = await findSkill(skillRef);
      if (!skill) return fail('skill not found');
      if (!skill.enabled && !(await isUserAdmin(userId))) return fail('this skill is currently disabled');
      const file = await getSkillFile(skill.id, filePath);
      if (!file) return fail(`no file "${filePath}" on this skill — check list_skill_files for exact paths`);
      return ok(file.content);
    },
  },
  {
    name: 'create_skill',
    description: 'ADMIN ONLY. Create a new AI Skill from raw text — name, a one-line description, and the SKILL.md content (instructions the assistant should follow when this skill applies). Skills are instance-wide and affect every user\'s assistant, so only an admin may create one.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string', description: 'One line — this is what rides in every chat\'s context, so keep it short and specific about when to use the skill.' },
        content: { type: 'string', description: 'The full SKILL.md body — detailed instructions, examples, conventions.' },
      },
      required: ['name', 'content'],
    },
    handler: async (userId, args) => {
      if (!(await isUserAdmin(userId))) return fail('admin access required');
      const name = str(args.name), content = str(args.content);
      if (!name || !content) return fail('name and content are required');
      const result = await createSkill({ name, description: str(args.description) ?? '', content, source: 'manual', origin: 'ai', createdBy: userId });
      if (!result.ok) return fail(result.error);
      return ok(`Created the "${result.skill.name}" skill (id: ${result.skill.id}), enabled by default.`, `Created skill "${result.skill.name}"`);
    },
  },
  {
    name: 'update_skill',
    description: 'ADMIN ONLY. Edit an AI Skill\'s name, description, content, or enabled state. Only the fields you pass are changed.',
    parameters: {
      type: 'object',
      properties: {
        skill_id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        content: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['skill_id'],
    },
    handler: async (userId, args) => {
      if (!(await isUserAdmin(userId))) return fail('admin access required');
      const skillRef = str(args.skill_id);
      if (!skillRef) return fail('skill_id is required');
      const skill = await findSkill(skillRef);
      if (!skill) return fail('skill not found');
      const result = await updateSkill(skill.id, {
        name: str(args.name), description: str(args.description), content: str(args.content),
        enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
        updatedBy: userId,
      });
      if (!result.ok) return fail(result.error);
      return ok(`Updated "${result.skill.name}"${typeof args.enabled === 'boolean' ? ` (now ${result.skill.enabled ? 'enabled' : 'disabled'})` : ''}.`, `Updated skill "${result.skill.name}"`);
    },
  },
  {
    name: 'delete_skill',
    description: 'ADMIN ONLY. Permanently delete an AI Skill and any bundled reference files. There is no undo.',
    parameters: { type: 'object', properties: { skill_id: { type: 'string' } }, required: ['skill_id'] },
    handler: async (userId, args) => {
      if (!(await isUserAdmin(userId))) return fail('admin access required');
      const skillRef = str(args.skill_id);
      if (!skillRef) return fail('skill_id is required');
      const skill = await findSkill(skillRef);
      if (!skill) return fail('skill not found');
      await deleteSkill(skill.id);
      return ok(`Deleted the "${skill.name}" skill.`, `Deleted skill "${skill.name}"`);
    },
  },
  {
    name: 'set_skill_file',
    description: 'ADMIN ONLY. Add or update one bundled text reference file on an AI Skill (e.g. a checklist or style guide alongside its main SKILL.md content). Reference-only — files are never executed.',
    parameters: {
      type: 'object',
      properties: {
        skill_id: { type: 'string' },
        file_path: { type: 'string', description: 'Relative path, e.g. "reference/checklist.md".' },
        content: { type: 'string' },
      },
      required: ['skill_id', 'file_path', 'content'],
    },
    handler: async (userId, args) => {
      if (!(await isUserAdmin(userId))) return fail('admin access required');
      const skillRef = str(args.skill_id), filePath = str(args.file_path), content = str(args.content);
      if (!skillRef || !filePath || content === undefined) return fail('skill_id, file_path and content are required');
      const skill = await findSkill(skillRef);
      if (!skill) return fail('skill not found');
      const result = await setSkillFile(skill.id, filePath, content);
      if (!result.ok) return fail(result.error);
      return ok(`Saved "${result.skill.file_path}" on "${skill.name}".`, `Updated a file on skill "${skill.name}"`);
    },
  },
  {
    name: 'remove_skill_file',
    description: 'ADMIN ONLY. Remove one bundled reference file from an AI Skill.',
    parameters: { type: 'object', properties: { skill_id: { type: 'string' }, file_path: { type: 'string' } }, required: ['skill_id', 'file_path'] },
    handler: async (userId, args) => {
      if (!(await isUserAdmin(userId))) return fail('admin access required');
      const skillRef = str(args.skill_id), filePath = str(args.file_path);
      if (!skillRef || !filePath) return fail('skill_id and file_path are required');
      const skill = await findSkill(skillRef);
      if (!skill) return fail('skill not found');
      const removed = await removeSkillFile(skill.id, filePath);
      if (!removed) return fail(`no file "${filePath}" on this skill`);
      return ok(`Removed "${filePath}" from "${skill.name}".`, `Removed a file from skill "${skill.name}"`);
    },
  },

  // ───────────────────────────── Long-term memory (per user) ──────────────────
  // Small, durable facts about the calling user — the current entries already
  // ride in every chat's system prompt (see the MEMORY note buildSystemPrompt
  // injects in useAIStore.ts), so these tools exist for the model to WRITE new
  // ones and to get an explicit, fresh read when needed, not as the primary
  // way memory reaches the model. Unlike AI Skills these are user-scoped, not
  // admin-gated — every signed-in user manages only their own memory, enforced
  // by the userId-scoped queries in aiMemory.ts.
  {
    name: 'list_memory',
    description: 'List every long-term memory entry saved for the CURRENT user, each with its id. These are usually already shown in your system prompt under MEMORY — call this only for an explicit fresh read (e.g. right before remove_memory) or if the prompt shows none yet.',
    parameters: { type: 'object', properties: {} },
    handler: async (userId) => {
      const rows = await listMemory(userId);
      if (!rows.length) return ok('No memory saved yet for this user.');
      return ok(rows.map((r) => `- [${r.id}] ${r.content}`).join('\n'));
    },
  },
  {
    name: 'add_memory',
    description: 'Save ONE short, durable fact or preference about the current user that should be remembered in EVERY future conversation, not just this one — e.g. their preferred units, a standing constraint, a recurring project name, how they like responses formatted. Call this when the user explicitly asks you to remember something, or when a clearly durable preference comes up naturally. Do NOT use this for one-off task details already tracked elsewhere (tasks/lists/notes/timelines) — memory is for things that should color EVERY chat, not this task.',
    parameters: {
      type: 'object',
      properties: { content: { type: 'string', description: 'One specific fact, as a short sentence.' } },
      required: ['content'],
    },
    handler: async (userId, args) => {
      const content = str(args.content);
      if (!content) return fail('content is required');
      const result = await addMemory(userId, content);
      if (!result.ok) return fail(result.error);
      return ok(`Remembered: "${result.memory.content}" (id: ${result.memory.id}).`, 'Saved a memory');
    },
  },
  {
    name: 'remove_memory',
    description: 'Delete one saved long-term memory entry by id (see list_memory or the MEMORY section already in your context for ids) — e.g. when the user says to forget something, or a saved fact is now outdated or wrong.',
    parameters: { type: 'object', properties: { memory_id: { type: 'string' } }, required: ['memory_id'] },
    handler: async (userId, args) => {
      const id = str(args.memory_id);
      if (!id) return fail('memory_id is required');
      const removed = await removeMemory(userId, id);
      if (!removed) return fail('no memory entry with that id');
      return ok('Forgot that.', 'Removed a memory');
    },
  },

  // ───────────────────────────── Past chat history (on demand only) ───────────
  // Deliberately the ONE piece of context in this whole registry that is never
  // preloaded into the system prompt — full history is comparatively huge, and
  // most turns have nothing to do with an earlier conversation. This tool is
  // the entire mechanism: call it only when the user's own message references
  // something from a past chat, and skip it otherwise. See the "PAST
  // CONVERSATIONS" guideline in buildSystemPrompt (useAIStore.ts).
  {
    name: 'search_chat_history',
    description: 'Search the CURRENT user\'s own past conversations with you (Sol), across every earlier chat session, not the current one. Use this ONLY when the user is explicitly asking about something from an earlier conversation — e.g. "what did I ask you on Monday", "did we talk about this before", "what did you tell me about X last week". Do NOT call this for ordinary questions about the current conversation or unrelated topics — it costs real tokens and most turns don\'t need it.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search for — a topic, name, or phrase the user is trying to recall.' },
        limit: { type: 'number', description: 'Max results, default 10, capped at 25.' },
      },
      required: ['query'],
    },
    handler: async (userId, args) => {
      const q = str(args.query);
      if (!q) return fail('query is required');
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
      // Escape LIKE metacharacters in the model-supplied query so a literal
      // "%"/"_" in the search term can't silently widen the match.
      const likeTerm = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const r = await query<{ id: number; role: string; content: string; created_at: string; session_title: string | null }>(
        `SELECT c.id, c.role, c.content, c.created_at, s.title AS session_title
           FROM ai_chats c
           LEFT JOIN ai_chat_sessions s ON s.id = c.session_id
          WHERE c.user_id = $1 AND c.role IN ('user', 'assistant') AND c.content ILIKE $2 ESCAPE '\\'
          ORDER BY c.created_at DESC
          LIMIT $3`,
        [userId, likeTerm, limit]
      );
      if (!r.rows.length) return ok(`No past conversation matched "${q}".`);
      const snippet = (s: string) => (s.length > 280 ? `${s.slice(0, 280)}…` : s);
      return ok(r.rows.map((row) => `- [${row.created_at}] ${row.session_title ? `"${row.session_title}" — ` : ''}${row.role}: ${snippet(row.content)}`).join('\n'));
    },
  },

  // ───────────────────────────── Agent Runtime (WP-8, MCP-only) ───────────────
  // These let an EXTERNAL orchestrator (e.g. Claude via the MCP connector)
  // drive OUR agent — never callable BY the agent itself (mcpOnly excludes
  // them from getOpenRouterToolDefs(), which both Sol and agent/runtime.ts's
  // own tool-calling loop draw from). Without that exclusion, an agent could
  // call start_agent_run on itself with no bound but each new run's own
  // budget — an unbounded-fork risk, not just a bad idea.
  {
    name: 'start_agent_run',
    description: 'Hand a goal to a workspace\'s AI agent to carry out — subject to that workspace\'s own agent mode and policy (Settings → Workspace → Agent). A "suggest"-mode workspace queues proposals for a human instead of acting immediately.',
    mcpOnly: true,
    parameters: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        goal: { type: 'string' },
      },
      required: ['workspace_id', 'goal'],
    },
    handler: async (userId, args) => {
      const workspaceId = str(args.workspace_id), goal = str(args.goal);
      if (!workspaceId || !goal) return fail('workspace_id and goal are required');
      if (!(await userCanAccessWorkspace(userId, workspaceId))) return fail('workspace not found');
      try {
        const { runId, mode } = await startAgentRun({ workspaceId, userId, goal, triggerType: 'mcp' });
        return ok(`Started agent run ${runId} (mode: ${mode}).`, 'Started an agent run');
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'could not start the agent run');
      }
    },
  },
  {
    name: 'list_agent_runs',
    description: 'List recent agent runs for a workspace.',
    mcpOnly: true,
    parameters: {
      type: 'object',
      properties: { workspace_id: { type: 'string' }, status: { type: 'string', enum: ['running', 'success', 'failed', 'blocked', 'cancelled'] } },
      required: ['workspace_id'],
    },
    handler: async (userId, args) => {
      const workspaceId = str(args.workspace_id);
      if (!workspaceId) return fail('workspace_id is required');
      if (!(await userCanAccessWorkspace(userId, workspaceId))) return fail('workspace not found');
      const status = str(args.status);
      const params: unknown[] = [workspaceId];
      let filter = '';
      if (status) { params.push(status); filter = ` AND status = $${params.length}`; }
      const r = await query<{ id: string; goal: string; status: string; started_at: string }>(
        `SELECT id, goal, status, started_at FROM agent_runs WHERE workspace_id = $1 ${filter} ORDER BY started_at DESC LIMIT 20`, params
      );
      if (!r.rows.length) return ok('No agent runs yet.');
      return ok(r.rows.map((row) => `- ${row.id} [${row.status}] "${row.goal}" (started ${row.started_at})`).join('\n'));
    },
  },
  {
    name: 'get_agent_run',
    description: 'Get the full step-by-step trace of one agent run.',
    mcpOnly: true,
    parameters: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] },
    handler: async (userId, args) => {
      const runId = str(args.run_id);
      if (!runId) return fail('run_id is required');
      const r = await query<{ workspace_id: string; goal: string; status: string; steps: unknown; error: string | null }>(
        `SELECT workspace_id, goal, status, steps, error FROM agent_runs WHERE id = $1`, [runId]
      );
      const row = r.rows[0];
      if (!row || !(await userCanAccessWorkspace(userId, row.workspace_id))) return fail('run not found');
      const steps = (row.steps as Array<{ nodeType: string; toolName?: string; status: string; error?: string }>) ?? [];
      const lines = [`Goal: ${row.goal}`, `Status: ${row.status}`, row.error ? `Error: ${row.error}` : null, 'Steps:',
        ...steps.map((s) => `  - [${s.status}] ${s.nodeType === 'trigger' ? 'started' : s.toolName}${s.error ? ` — ${s.error}` : ''}`)];
      return ok(lines.filter((l): l is string => l !== null).join('\n'));
    },
  },
  {
    name: 'list_agent_proposals',
    description: 'List an agent\'s pending (or other-status) proposals awaiting human approval in a workspace.',
    mcpOnly: true,
    parameters: {
      type: 'object',
      properties: { workspace_id: { type: 'string' }, status: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'expired', 'applied', 'failed'] } },
      required: ['workspace_id'],
    },
    handler: async (userId, args) => {
      const workspaceId = str(args.workspace_id);
      if (!workspaceId) return fail('workspace_id is required');
      if (!(await userCanAccessWorkspace(userId, workspaceId))) return fail('workspace not found');
      const status = str(args.status) ?? 'pending';
      const r = await query<{ id: string; tool_name: string; tool_args: unknown; created_at: string }>(
        `SELECT id, tool_name, tool_args, created_at FROM agent_proposals WHERE workspace_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 20`,
        [workspaceId, status]
      );
      if (!r.rows.length) return ok(`No ${status} proposals.`);
      return ok(r.rows.map((row) => `- ${row.id}: ${row.tool_name}(${JSON.stringify(row.tool_args)}) — queued ${row.created_at}`).join('\n'));
    },
  },
  {
    name: 'accept_agent_proposal',
    description: 'Approve a pending agent proposal, running it now as the original run\'s owner.',
    mcpOnly: true,
    parameters: { type: 'object', properties: { proposal_id: { type: 'string' } }, required: ['proposal_id'] },
    handler: async (userId, args) => {
      const proposalId = str(args.proposal_id);
      if (!proposalId) return fail('proposal_id is required');
      const r = await query<{ workspace_id: string; run_id: string; tool_name: string; tool_args: unknown; status: string }>(
        `SELECT workspace_id, run_id, tool_name, tool_args, status FROM agent_proposals WHERE id = $1`, [proposalId]
      );
      const row = r.rows[0];
      if (!row || !(await userCanAccessWorkspace(userId, row.workspace_id))) return fail('proposal not found');
      if (row.status !== 'pending') return fail(`proposal already ${row.status}`);
      const runRes = await query<{ user_id: string }>(`SELECT user_id FROM agent_runs WHERE id = $1`, [row.run_id]);
      const actingUserId = runRes.rows[0]?.user_id ?? userId;
      const result = await executeAiTool(actingUserId, row.tool_name, (row.tool_args as Record<string, unknown>) ?? {});
      await query(`UPDATE agent_proposals SET status = $1, decided_by = $2, decided_at = NOW() WHERE id = $3`, [result.ok ? 'applied' : 'failed', userId, proposalId]);
      return result.ok ? ok(`Applied: ${result.result}`) : fail(result.result);
    },
  },
  {
    name: 'reject_agent_proposal',
    description: 'Reject a pending agent proposal — it will never run.',
    mcpOnly: true,
    parameters: { type: 'object', properties: { proposal_id: { type: 'string' }, reason: { type: 'string' } }, required: ['proposal_id'] },
    handler: async (userId, args) => {
      const proposalId = str(args.proposal_id);
      if (!proposalId) return fail('proposal_id is required');
      const r = await query<{ workspace_id: string; status: string }>(`SELECT workspace_id, status FROM agent_proposals WHERE id = $1`, [proposalId]);
      const row = r.rows[0];
      if (!row || !(await userCanAccessWorkspace(userId, row.workspace_id))) return fail('proposal not found');
      if (row.status !== 'pending') return fail(`proposal already ${row.status}`);
      await query(`UPDATE agent_proposals SET status = 'rejected', decided_by = $1, decided_at = NOW() WHERE id = $2`, [userId, proposalId]);
      return ok('Proposal rejected.');
    },
  },
];

// ── lookup & execution ───────────────────────────────────────────────────────

const toolsByName: Map<string, AiTool> = new Map(aiTools.map((t) => [t.name, t]));

export function getToolNames(): string[] {
  return aiTools.map((t) => t.name);
}

/**
 * Execute a registry tool for a verified user. The userId is authoritative and
 * is never taken from `args`. Unknown tools and handler errors are returned as
 * failed ToolResults rather than thrown.
 */
export async function executeAiTool(
  userId: string,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const tool = toolsByName.get(name);
  if (!tool) return fail(`unknown tool "${name}"`);
  try {
    return await tool.handler(userId, args ?? {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return fail(msg);
  }
}

// ── format adapters ───────────────────────────────────────────────────────

/** OpenRouter / OpenAI "tools" array shape — used by the internal Sol assistant AND the Agent Runtime (agent/runtime.ts). Excludes mcpOnly tools (see AiTool.mcpOnly). */
export function getOpenRouterToolDefs(): Array<{ type: 'function'; function: { name: string; description: string; parameters: JsonSchema } }> {
  return aiTools.filter((t) => !t.mcpOnly).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/** MCP tools/list shape (name, description, inputSchema as JSON Schema). */
export function getMcpToolDefs(): Array<{ name: string; description: string; inputSchema: JsonSchema }> {
  return aiTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));
}
