// ---------------------------------------------------------------------------
// Trash snapshot helpers — shared by the per-item delete endpoints and the
// workspace cascade delete, so every destructive path produces the same
// restorable JSON shape in the trash_* tables (30-day soft delete).
//
// The shapes mirror the sanitizers in routes/lists.ts / routes/timelines.ts /
// routes/folders.ts; the restore endpoints in routes/trash.ts read exactly
// these camelCase fields.
// ---------------------------------------------------------------------------

import type { QueryExec } from './workspaceUtil';

interface ListRowLike {
  id: string;
  user_id: string;
  name: string;
  emoji: string | null;
  color: string | null;
  color_bg: string | null;
  subtitle: string | null;
  is_public: boolean;
  folder_id: string | null;
  position: number;
  created_at: string;
  parent_task_id: string | null;
  depth: number;
  workspace_id: string | null;
}

interface TaskRowLike {
  id: string;
  user_id: string;
  title: string;
  note: string | null;
  checked: boolean;
  deadline: string | null;
  time_val: string | null;
  priority: string | null;
  badge: string | null;
  source: string;
  list_id: string | null;
  section_id: string | null;
  position: number;
  created_at: string;
  linked_list_id: string | null;
  linked_list_type: string | null;
}

interface SectionRowLike {
  id: string;
  list_id: string;
  label: string;
  emoji: string | null;
  position: number;
}

interface TimelineRowLike {
  id: string;
  user_id: string;
  name: string;
  emoji: string | null;
  color: string | null;
  color_bg: string | null;
  subtitle: string | null;
  layout: string;
  is_public: boolean;
  folder_id: string | null;
  workspace_id: string | null;
  position: number;
  created_at: string;
}

interface MilestoneRowLike {
  id: string;
  timeline_id: string;
  title: string;
  description: string | null;
  milestone_date: string | null;
  time_val: string | null;
  status: string;
  emoji: string | null;
  color: string | null;
  position: number;
  created_at: string;
}

interface FolderRowLike {
  id: string;
  user_id: string;
  name: string;
  emoji: string | null;
  color: string | null;
  position: number;
  is_public: boolean;
  collapsed: boolean;
  workspace_id: string | null;
}

/** Recursively collect the ids of every sublist nested under a list. */
export async function collectDescendantListIds(exec: QueryExec, rootId: string): Promise<string[]> {
  const out = new Set<string>();
  const visit = async (id: string) => {
    const sub = await exec(
      `SELECT l.id FROM lists l
       JOIN tasks t ON l.parent_task_id = t.id
       WHERE t.list_id = $1 AND l.id <> $1`,
      [id]
    );
    for (const row of sub.rows as Array<{ id: string }>) {
      if (out.has(row.id)) continue;
      out.add(row.id);
      await visit(row.id);
    }
  };
  await visit(rootId);
  return Array.from(out);
}

function taskData(t: TaskRowLike) {
  return {
    id:             t.id,
    creatorId:      t.user_id,
    title:          t.title,
    note:           t.note,
    checked:        t.checked,
    deadline:       t.deadline,
    time:           t.time_val,
    priority:       t.priority,
    badge:          t.badge,
    source:         t.source,
    listId:         t.list_id,
    sectionId:      t.section_id,
    position:       t.position,
    createdAt:      t.created_at,
    _source:        t.source,
    _listId:        t.list_id,
    linkedListId:   t.linked_list_id ?? null,
    linkedListType: t.linked_list_type ?? null,
  };
}

/**
 * Snapshot a single list (with its sections and tasks) into trash_lists,
 * attributed to the list's OWNER so it lands in that user's trash.
 * Returns false when the list no longer exists.
 */
export async function snapshotListToTrash(exec: QueryExec, listId: string): Promise<boolean> {
  const listRes = await exec(`SELECT * FROM lists WHERE id = $1`, [listId]);
  if (listRes.rows.length === 0) return false;
  const l = listRes.rows[0] as unknown as ListRowLike;

  const sectionsRes = await exec(
    `SELECT * FROM sections WHERE list_id = $1 ORDER BY position ASC`,
    [listId]
  );
  const tasksRes = await exec(
    `SELECT * FROM tasks WHERE list_id = $1 AND source = 'list' ORDER BY position ASC, created_at ASC`,
    [listId]
  );

  const tasksBySection: Record<string, ReturnType<typeof taskData>[]> = {};
  for (const row of tasksRes.rows as unknown as TaskRowLike[]) {
    const key = row.section_id ?? '__none__';
    if (!tasksBySection[key]) tasksBySection[key] = [];
    tasksBySection[key].push(taskData(row));
  }

  const data = {
    id:           l.id,
    userId:       l.user_id,
    name:         l.name,
    emoji:        l.emoji,
    color:        l.color,
    colorBg:      l.color_bg,
    subtitle:     l.subtitle,
    isPublic:     l.is_public,
    folderId:     l.folder_id ?? undefined,
    workspaceId:  l.workspace_id ?? undefined,
    position:     l.position,
    createdAt:    l.created_at,
    parentTaskId: l.parent_task_id ?? null,
    depth:        l.depth ?? 0,
    sections: (sectionsRes.rows as unknown as SectionRowLike[]).map((s) => ({
      id:       s.id,
      listId:   s.list_id,
      label:    s.label,
      emoji:    s.emoji,
      position: s.position,
      tasks:    tasksBySection[s.id] ?? [],
    })),
  };

  await exec(
    `INSERT INTO trash_lists (list_id, user_id, list_data) VALUES ($1, $2, $3)`,
    [l.id, l.user_id, JSON.stringify(data)]
  );
  return true;
}

/**
 * Snapshot a timeline (with milestones) into trash_timelines, attributed to
 * the timeline's owner. Returns false when the timeline no longer exists.
 */
export async function snapshotTimelineToTrash(exec: QueryExec, timelineId: string): Promise<boolean> {
  const tlRes = await exec(`SELECT * FROM timelines WHERE id = $1`, [timelineId]);
  if (tlRes.rows.length === 0) return false;
  const t = tlRes.rows[0] as unknown as TimelineRowLike;

  const msRes = await exec(
    `SELECT * FROM milestones WHERE timeline_id = $1 ORDER BY position ASC`,
    [timelineId]
  );

  const data = {
    id:          t.id,
    userId:      t.user_id,
    name:        t.name,
    emoji:       t.emoji,
    color:       t.color,
    colorBg:     t.color_bg,
    subtitle:    t.subtitle,
    layout:      t.layout,
    isPublic:    t.is_public,
    folderId:    t.folder_id ?? undefined,
    workspaceId: t.workspace_id ?? undefined,
    position:    t.position,
    createdAt:   t.created_at,
    milestones: (msRes.rows as unknown as MilestoneRowLike[]).map((m) => ({
      id:          m.id,
      timelineId:  m.timeline_id,
      title:       m.title,
      description: m.description,
      date:        m.milestone_date,
      time:        m.time_val,
      status:      m.status,
      emoji:       m.emoji,
      color:       m.color,
      position:    m.position,
      createdAt:   m.created_at,
    })),
  };

  await exec(
    `INSERT INTO trash_timelines (timeline_id, user_id, timeline_data) VALUES ($1, $2, $3)`,
    [t.id, t.user_id, JSON.stringify(data)]
  );
  return true;
}

/**
 * Snapshot a folder (with the ids of the lists inside it) into trash_folders,
 * attributed to the folder's owner. Returns false when the folder is gone.
 */
export async function snapshotFolderToTrash(exec: QueryExec, folderId: string): Promise<boolean> {
  const fRes = await exec(`SELECT * FROM folders WHERE id = $1`, [folderId]);
  if (fRes.rows.length === 0) return false;
  const f = fRes.rows[0] as unknown as FolderRowLike;

  const listsRes = await exec(`SELECT id FROM lists WHERE folder_id = $1`, [folderId]);
  const listIds = (listsRes.rows as Array<{ id: string }>).map((r) => r.id);

  const data = {
    id:          f.id,
    userId:      f.user_id,
    name:        f.name,
    emoji:       f.emoji ?? undefined,
    color:       f.color ?? undefined,
    position:    f.position,
    isPublic:    f.is_public,
    collapsed:   f.collapsed ?? false,
    workspaceId: f.workspace_id ?? undefined,
    listIds,
  };

  await exec(
    `INSERT INTO trash_folders (folder_id, user_id, folder_data) VALUES ($1, $2, $3)`,
    [f.id, f.user_id, JSON.stringify(data)]
  );
  return true;
}
