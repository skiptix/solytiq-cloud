// ---------------------------------------------------------------------------
// Template structure capture/instantiate helpers.
//
// A template snapshots a list's or timeline's full structure into a portable
// JSON tree (templates.structure): sections/tasks — including nested owned
// sublists — for lists, milestones for timelines. Dates are stored as
// day-offsets relative to "today" at capture time (see daysBetween/addDaysISO)
// so a template is meaningful however long it sits before being reused —
// instantiation resolves offsets against "today" again.
//
// Attachments: only 'linked'-type attachments (which reference a durable,
// independently-owned shared_files row) are captured. 'upload'-type
// attachments are 1:1 with their physical file — re-referencing one from a
// second task_attachments/milestone_attachments row would risk a dangling
// file if either copy is later deleted — so those are intentionally skipped.
// Captured attachments are only re-linked on instantiation when the
// instantiating user is the template's owner (they already own the file);
// a shared/public template used by someone else never carries attachments.
// ---------------------------------------------------------------------------

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query } from './db';

// ---------------------------------------------------------------------------
// Structure shapes
// ---------------------------------------------------------------------------

export interface TemplateAttachmentRef {
  sharedFileId: string;
  title: string;
}

export interface TemplateTaskNode {
  title: string;
  note: string | null;
  priority: string | null;
  badge: string | null;
  position: number;
  deadlineOffsetDays: number | null;
  timeVal: string | null;
  attachments: TemplateAttachmentRef[];
  sublist?: TemplateListNode;
}

export interface TemplateSectionNode {
  label: string;
  emoji: string | null;
  position: number;
  tasks: TemplateTaskNode[];
}

export interface TemplateListNode {
  version: 1;
  name: string;
  emoji: string | null;
  color: string | null;
  colorBg: string | null;
  isPublic: boolean;
  sections: TemplateSectionNode[];
}

export interface TemplateMilestoneNode {
  title: string;
  description: string | null;
  status: string;
  emoji: string | null;
  color: string | null;
  position: number;
  dateOffsetDays: number | null;
  timeVal: string | null;
  attachments: TemplateAttachmentRef[];
}

export interface TemplateTimelineNode {
  version: 1;
  name: string;
  emoji: string | null;
  color: string | null;
  colorBg: string | null;
  isPublic: boolean;
  layout: string;
  milestones: TemplateMilestoneNode[];
}

// ---------------------------------------------------------------------------
// Date helpers — day-only offsets, independent of time zone drift within a day.
// ---------------------------------------------------------------------------

function toDateOnlyUTC(isoDate: string): Date {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

export function daysBetween(fromISODate: string, toISODate: string): number {
  return Math.round((toDateOnlyUTC(toISODate).getTime() - toDateOnlyUTC(fromISODate).getTime()) / 86_400_000);
}

export function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysISO(baseISODate: string, offsetDays: number): string {
  const result = new Date(toDateOnlyUTC(baseISODate).getTime() + offsetDays * 86_400_000);
  return result.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Task id generation — BIGINT-safe (built via BigInt, passed to pg as a
// decimal string) so a request that creates many tasks in one transaction
// never risks exceeding Number.MAX_SAFE_INTEGER precision.
// ---------------------------------------------------------------------------

export function makeTaskIdGenerator(): () => string {
  const base = BigInt(Date.now()) * 1000n;
  let seq = 0n;
  return () => (base + seq++).toString();
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

const MAX_SUBLIST_DEPTH = 12;

async function captureAttachments(taskId: string): Promise<TemplateAttachmentRef[]> {
  const res = await query<{ shared_file_id: string; original_name: string | null }>(
    `SELECT ta.shared_file_id, sf.original_name
     FROM task_attachments ta JOIN shared_files sf ON ta.shared_file_id = sf.id
     WHERE ta.task_id = $1 AND ta.attachment_type = 'linked'`,
    [taskId]
  );
  return res.rows.map((r) => ({ sharedFileId: r.shared_file_id, title: r.original_name ?? 'file' }));
}

async function captureMilestoneAttachments(milestoneId: string): Promise<TemplateAttachmentRef[]> {
  const res = await query<{ shared_file_id: string; original_name: string | null }>(
    `SELECT ma.shared_file_id, sf.original_name
     FROM milestone_attachments ma JOIN shared_files sf ON ma.shared_file_id = sf.id
     WHERE ma.milestone_id = $1 AND ma.attachment_type = 'linked'`,
    [milestoneId]
  );
  return res.rows.map((r) => ({ sharedFileId: r.shared_file_id, title: r.original_name ?? 'file' }));
}

interface ListRowForCapture {
  name: string;
  emoji: string | null;
  color: string | null;
  color_bg: string | null;
  is_public: boolean;
}
interface SectionRowForCapture { id: string; label: string; emoji: string | null; position: number; }
interface TaskRowForCapture {
  id: string;
  title: string;
  note: string | null;
  priority: string | null;
  badge: string | null;
  position: number;
  deadline: string | null;
  time_val: string | null;
  section_id: string | null;
  linked_list_id: string | null;
  linked_list_type: string | null;
}

/**
 * Recursively capture a list — and any of its owned sublists — into a
 * template node. Caller must have already verified `userId` owns the root
 * list; every nested sublist is owned by the same user by construction
 * (sublists always belong to their creating user), so no repeated ownership
 * check is needed at each recursion level, only a scoping `user_id` filter as
 * defense in depth.
 */
export async function captureListStructure(
  listId: string,
  userId: string,
  today: string,
  depth = 0,
  visited: Set<string> = new Set(),
): Promise<TemplateListNode> {
  if (depth > MAX_SUBLIST_DEPTH || visited.has(listId)) {
    return { version: 1, name: '(nested list omitted)', emoji: null, color: null, colorBg: null, isPublic: false, sections: [] };
  }
  visited.add(listId);

  const listRes = await query<ListRowForCapture>(
    `SELECT name, emoji, color, color_bg, is_public FROM lists WHERE id = $1 AND user_id = $2`,
    [listId, userId]
  );
  if (listRes.rows.length === 0) {
    return { version: 1, name: '(list not found)', emoji: null, color: null, colorBg: null, isPublic: false, sections: [] };
  }
  const list = listRes.rows[0];

  const sectionsRes = await query<SectionRowForCapture>(
    `SELECT id, label, emoji, position FROM sections WHERE list_id = $1 ORDER BY position ASC`,
    [listId]
  );
  const tasksRes = await query<TaskRowForCapture>(
    `SELECT id, title, note, priority, badge, position, deadline, time_val, section_id, linked_list_id, linked_list_type
     FROM tasks WHERE list_id = $1 AND source = 'list' ORDER BY position ASC`,
    [listId]
  );
  const tasksBySection = new Map<string, TaskRowForCapture[]>();
  for (const t of tasksRes.rows) {
    const key = t.section_id ?? '';
    const arr = tasksBySection.get(key);
    if (arr) arr.push(t); else tasksBySection.set(key, [t]);
  }

  const sections: TemplateSectionNode[] = [];
  for (const s of sectionsRes.rows) {
    const tasks: TemplateTaskNode[] = [];
    for (const t of tasksBySection.get(s.id) ?? []) {
      const attachments = await captureAttachments(t.id);
      let sublist: TemplateListNode | undefined;
      if (t.linked_list_type === 'sublist' && t.linked_list_id) {
        sublist = await captureListStructure(t.linked_list_id, userId, today, depth + 1, visited);
      }
      tasks.push({
        title: t.title,
        note: t.note,
        priority: t.priority,
        badge: t.badge,
        position: t.position,
        deadlineOffsetDays: t.deadline ? daysBetween(today, t.deadline) : null,
        timeVal: t.time_val,
        attachments,
        ...(sublist ? { sublist } : {}),
      });
    }
    sections.push({ label: s.label, emoji: s.emoji, position: s.position, tasks });
  }

  return {
    version: 1,
    name: list.name,
    emoji: list.emoji,
    color: list.color,
    colorBg: list.color_bg,
    isPublic: list.is_public,
    sections,
  };
}

interface MilestoneRowForCapture {
  id: string;
  title: string;
  description: string | null;
  milestone_date: string | null;
  time_val: string | null;
  status: string;
  emoji: string | null;
  color: string | null;
  position: number;
}

/** Caller must have already verified `userId` owns the timeline. */
export async function captureTimelineStructure(
  timelineId: string,
  userId: string,
  today: string,
): Promise<TemplateTimelineNode> {
  const tRes = await query<{ name: string; emoji: string | null; color: string | null; color_bg: string | null; is_public: boolean; layout: string }>(
    `SELECT name, emoji, color, color_bg, is_public, layout FROM timelines WHERE id = $1 AND user_id = $2`,
    [timelineId, userId]
  );
  if (tRes.rows.length === 0) throw new Error('Timeline not found');
  const t = tRes.rows[0];

  const mRes = await query<MilestoneRowForCapture>(
    `SELECT id, title, description, milestone_date, time_val, status, emoji, color, position
     FROM milestones WHERE timeline_id = $1 ORDER BY position ASC`,
    [timelineId]
  );

  const milestones: TemplateMilestoneNode[] = [];
  for (const m of mRes.rows) {
    const attachments = await captureMilestoneAttachments(m.id);
    milestones.push({
      title: m.title,
      description: m.description,
      status: m.status,
      emoji: m.emoji,
      color: m.color,
      position: m.position,
      dateOffsetDays: m.milestone_date ? daysBetween(today, m.milestone_date) : null,
      timeVal: m.time_val,
      attachments,
    });
  }

  return {
    version: 1,
    name: t.name,
    emoji: t.emoji,
    color: t.color,
    colorBg: t.color_bg,
    isPublic: t.is_public,
    layout: t.layout,
    milestones,
  };
}

// ---------------------------------------------------------------------------
// Instantiate
// ---------------------------------------------------------------------------

interface InstantiateListCtx {
  userId: string;
  workspaceId: string;
  folderId: string | null; // only applied at depth 0 — sublists never take a folder
  depth: number;
  allowAttachments: boolean;
  nextTaskId: () => string;
}

async function linkAttachment(
  client: PoolClient,
  table: 'task_attachments' | 'milestone_attachments',
  ownerColumn: 'task_id' | 'milestone_id',
  ownerId: string,
  userId: string,
  ref: TemplateAttachmentRef,
): Promise<void> {
  // Re-verify the file still exists and is owned by this user — it may have
  // been deleted or transferred since the template was captured.
  const sf = await client.query<{ id: string; original_name: string; mime_type: string; file_size: string }>(
    `SELECT id, original_name, mime_type, file_size FROM shared_files WHERE id = $1 AND user_id = $2`,
    [ref.sharedFileId, userId]
  );
  if (sf.rows.length === 0) return;
  const f = sf.rows[0];
  await client.query(
    `INSERT INTO ${table} (id, ${ownerColumn}, user_id, attachment_type, original_name, mime_type, file_size, shared_file_id)
     VALUES ($1, $2, $3, 'linked', $4, $5, $6, $7)`,
    [crypto.randomUUID(), ownerId, userId, f.original_name, f.mime_type, f.file_size, f.id]
  );
}

/** Materializes a list (recursively for sublists) inside the caller's transaction. Returns the new list's id. */
export async function instantiateListStructure(
  client: PoolClient,
  node: TemplateListNode,
  ctx: InstantiateListCtx,
  overrideName?: string,
  overrideIsPublic?: boolean,
): Promise<string> {
  const listId = `list_${uuidv4()}`;
  const posRes = await client.query<{ max: string | null }>(`SELECT MAX(position) AS max FROM lists WHERE user_id = $1`, [ctx.userId]);
  const nextPos = posRes.rows[0].max !== null ? parseInt(posRes.rows[0].max, 10) + 1 : 0;

  // parent_task_id is left NULL here even for a sublist being instantiated —
  // it has an FK to tasks(id), and the linking task doesn't exist yet at this
  // point. The caller sets it via UPDATE right after that task is created.
  await client.query(
    `INSERT INTO lists (id, user_id, name, emoji, color, color_bg, is_public, folder_id, position, depth, workspace_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      listId, ctx.userId,
      overrideName ?? node.name, node.emoji, node.color, node.colorBg,
      overrideIsPublic ?? node.isPublic,
      ctx.depth === 0 ? ctx.folderId : null,
      nextPos, ctx.depth, ctx.workspaceId,
    ]
  );

  const today = todayISODate();
  for (const section of node.sections) {
    const sectionId = `section_${uuidv4()}`;
    await client.query(
      `INSERT INTO sections (id, list_id, label, emoji, position) VALUES ($1,$2,$3,$4,$5)`,
      [sectionId, listId, section.label, section.emoji, section.position]
    );

    for (const task of section.tasks) {
      const taskId = ctx.nextTaskId();
      const deadline = task.deadlineOffsetDays != null ? addDaysISO(today, task.deadlineOffsetDays) : null;

      let childListId: string | null = null;
      if (task.sublist) {
        childListId = await instantiateListStructure(client, task.sublist, {
          ...ctx, folderId: null, depth: ctx.depth + 1,
        });
      }

      await client.query(
        `INSERT INTO tasks
           (id, user_id, title, note, priority, badge, deadline, time_val, source, list_id, section_id, position, linked_list_id, linked_list_type, workspace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'list',$9,$10,$11,$12,$13,$14)`,
        [
          taskId, ctx.userId, task.title, task.note, task.priority, task.badge, deadline, task.timeVal,
          listId, sectionId, task.position, childListId, childListId ? 'sublist' : null, ctx.workspaceId,
        ]
      );

      if (childListId) {
        await client.query(`UPDATE lists SET parent_task_id = $1 WHERE id = $2`, [taskId, childListId]);
      }

      if (ctx.allowAttachments) {
        for (const ref of task.attachments) {
          await linkAttachment(client, 'task_attachments', 'task_id', taskId, ctx.userId, ref);
        }
      }
    }
  }

  return listId;
}

/** Materializes a timeline + its milestones inside the caller's transaction. Returns the new timeline's id. */
export async function instantiateTimelineStructure(
  client: PoolClient,
  node: TemplateTimelineNode,
  ctx: { userId: string; workspaceId: string; folderId: string | null; allowAttachments: boolean },
  overrideName?: string,
  overrideIsPublic?: boolean,
): Promise<string> {
  const timelineId = `timeline_${uuidv4()}`;
  const posRes = await client.query<{ max: string | null }>(`SELECT MAX(position) AS max FROM timelines WHERE user_id = $1`, [ctx.userId]);
  const nextPos = posRes.rows[0].max !== null ? parseInt(posRes.rows[0].max, 10) + 1 : 0;

  await client.query(
    `INSERT INTO timelines (id, user_id, name, emoji, color, color_bg, layout, is_public, folder_id, position, workspace_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      timelineId, ctx.userId, overrideName ?? node.name, node.emoji, node.color, node.colorBg,
      node.layout, overrideIsPublic ?? node.isPublic, ctx.folderId, nextPos, ctx.workspaceId,
    ]
  );

  const today = todayISODate();
  for (const m of node.milestones) {
    const milestoneId = `milestone_${uuidv4()}`;
    const date = m.dateOffsetDays != null ? addDaysISO(today, m.dateOffsetDays) : null;
    await client.query(
      `INSERT INTO milestones (id, timeline_id, title, description, milestone_date, time_val, status, emoji, color, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [milestoneId, timelineId, m.title, m.description, date, m.timeVal, m.status, m.emoji, m.color, m.position]
    );
    if (ctx.allowAttachments) {
      for (const ref of m.attachments) {
        await linkAttachment(client, 'milestone_attachments', 'milestone_id', milestoneId, ctx.userId, ref);
      }
    }
  }

  return timelineId;
}
