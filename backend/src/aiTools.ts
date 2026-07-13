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
}

// ── small helpers ────────────────────────────────────────────────────────

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined);
const PRIORITIES = new Set(['High', 'Medium', 'Low']);
const STATUSES = new Set(['upcoming', 'in-progress', 'done']);
const LAYOUTS = new Set(['vertical', 'compact', 'detailed']);

function genTaskId(): number {
  return Date.now() * 1000 + crypto.randomInt(1000);
}

function ok(result: string, summary?: string): ToolResult {
  return { ok: true, result, summary };
}
function fail(result: string): ToolResult {
  return { ok: false, result: result.startsWith('Error') ? result : `Error: ${result}` };
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

/** OpenRouter / OpenAI "tools" array shape (used by the internal Sol assistant). */
export function getOpenRouterToolDefs(): Array<{ type: 'function'; function: { name: string; description: string; parameters: JsonSchema } }> {
  return aiTools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/** MCP tools/list shape (name, description, inputSchema as JSON Schema). */
export function getMcpToolDefs(): Array<{ name: string; description: string; inputSchema: JsonSchema }> {
  return aiTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));
}
