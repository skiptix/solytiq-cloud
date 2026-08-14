import { Router, Request, Response } from 'express';
import crypto, { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db';
import { authenticate } from '../middleware';
import { hashPassword } from '../auth';
import { broadcastToUser } from '../sse';
import { versionGuardSql, resolveVersionedUpdateFailure } from '../concurrency';
import { validateReorderIds, bulkSetPositions } from '../reorderUtil';
import { resolveWorkspaceForUser, userCanAccessWorkspace, wlog, wwarn, werr, QueryExec } from '../workspaceUtil';
import { softDeleteListTree, collectDescendantListIds as collectDescendantListIdsShared } from '../trashUtil';
import { getPrivateAncestors, buildPromoteConflict, promoteAncestors, buildRestrictConflict } from '../visibility';
import type { MutationActor } from '../automationEngine';
import { recordTaskChanges } from '../taskChangeLog';
import { notifyNewMentions } from '../mentions';
import { isItemSharedWith } from '../itemShares';
import { objectAccessCondition, workspaceMembersJoin } from '../objectPolicy';
import { syncInlineLinksForText } from '../graph/inlineLinks';
import { enqueueEmbedding } from '../knowledge/queue';
import { recordPlacement, getMemoryStats } from '../quickAdd/memory';
import { suggestSections } from '../quickAdd/predict';
import { ensureBubble, syncBubble } from '../quickAdd/kbBubble';
import { decodeKeysetCursor, encodeKeysetCursor, parsePageLimit, paginateRows, type KeysetCursor } from '../pagination';

const router = Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface ListRow {
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
  share_token: string | null;
  share_enabled: boolean;
  share_password_hash: string | null;
  share_expires_at: string | null;
  share_subpages: boolean;
  share_view_mode: string | null;
  version?: number;
  view_mode: string;
  is_archived?: boolean;
  archived_at?: string | null;
  quick_add_enabled?: boolean;
  quick_add_kb_entry_id?: string | null;
}

interface SectionRow {
  id: string;
  list_id: string;
  label: string;
  emoji: string | null;
  position: number;
}

interface TaskRow {
  id: string;
  user_id: string;
  title: string;
  note: string | null;
  note_markdown: boolean;
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
  updated_at: string;
  completed_at: string | null;
  linked_list_id: string | null;
  linked_list_type: string | null;
  attachment_count?: string;
}

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------

function sanitizeTask(task: TaskRow) {
  return {
    id:             task.id,
    creatorId:      task.user_id,
    title:          task.title,
    note:           task.note,
    noteMarkdown:   task.note_markdown ?? false,
    checked:        task.checked,
    deadline:       task.deadline,
    time:           task.time_val,
    priority:       task.priority,
    badge:          task.badge,
    source:         task.source,
    listId:         task.list_id,
    sectionId:      task.section_id,
    position:       task.position,
    createdAt:      task.created_at,
    updatedAt:      task.updated_at,
    completedAt:    task.completed_at ?? null,
    _source:        task.source,
    _listId:        task.list_id,
    linkedListId:    task.linked_list_id ?? null,
    linkedListType:  task.linked_list_type ?? null,
    attachmentCount: Number(task.attachment_count ?? 0),
  };
}

function sanitizeSection(section: SectionRow, tasks: ReturnType<typeof sanitizeTask>[]) {
  return {
    id:       section.id,
    listId:   section.list_id,
    label:    section.label,
    emoji:    section.emoji,
    position: section.position,
    tasks,
  };
}

/**
 * Items belonging to this list that sit in NO section — the Quick Add staging
 * tray, rendered directly under the Quick Add bar.
 *
 * `tasks.section_id` has always been `ON DELETE SET NULL`, so these rows could
 * already exist before this feature: deleting a section orphaned its items into
 * a state no screen rendered. They were still counted in the board's progress
 * totals, which is what made an orphan look like data loss rather than a hidden
 * row. Surfacing the tray gives every one of them a visible home again.
 */
function stagedTasksOf(tasksBySection: Record<string, ReturnType<typeof sanitizeTask>[]>, listId: string) {
  return (tasksBySection['__none__'] ?? []).filter((t) => t.listId === listId);
}

function sanitizeList(
  list: ListRow,
  sections: ReturnType<typeof sanitizeSection>[],
  linkedProgress?: { total: number; completed: number },
  stagedTasks: ReturnType<typeof sanitizeTask>[] = []
) {
  return {
    id:           list.id,
    userId:       list.user_id,
    name:         list.name,
    emoji:        list.emoji,
    color:        list.color,
    colorBg:      list.color_bg,
    subtitle:     list.subtitle,
    isPublic:     list.is_public,
    folderId:     list.folder_id  ?? undefined,
    workspaceId:  list.workspace_id ?? undefined,
    position:     list.position,
    createdAt:    list.created_at,
    parentTaskId: list.parent_task_id ?? null,
    depth:        list.depth ?? 0,
    shareEnabled:     list.share_enabled ?? false,
    shareToken:       list.share_token ?? null,
    shareHasPassword: list.share_password_hash != null,
    shareExpiresAt:   list.share_expires_at ?? null,
    shareSubpages:    list.share_subpages ?? false,
    shareViewMode:    (list.share_view_mode === 'kanban' || list.share_view_mode === 'timeline' || list.share_view_mode === 'list') ? list.share_view_mode : null,
    version:      list.version ?? 1,
    viewMode:     (list.view_mode === 'kanban' || list.view_mode === 'timeline' ? list.view_mode : 'list') as 'list' | 'kanban' | 'timeline',
    isArchived:   list.is_archived ?? false,
    archivedAt:   list.archived_at ?? null,
    quickAddEnabled: list.quick_add_enabled ?? false,
    quickAddEntryId: list.quick_add_kb_entry_id ?? null,
    sections,
    stagedTasks,
    ...(linkedProgress !== undefined ? { linkedProgress } : {}),
  };
}

// ---------------------------------------------------------------------------
// Helper: build full list objects (lists → sections → tasks)
// ---------------------------------------------------------------------------

function summarizeListRows(rows: ListRow[]): string {
  if (rows.length === 0) return 'none';
  return rows
    .slice(0, 25)
    .map((l) => `${l.id}{ws=${l.workspace_id ?? 'NULL'},folder=${l.folder_id ?? 'root'},owner=${l.user_id},public=${l.is_public}}`)
    .join(', ') + (rows.length > 25 ? `, … +${rows.length - 25} more` : '');
}

export async function buildListsForUser(userId: string, workspaceId?: string, includeArchived = false) {
  // When workspaceId is provided: return lists in that workspace the user can access,
  // plus the user's own lists with no workspace assigned (backward-compatible "personal" lists).
  // When omitted: return all lists the user owns or has access to (global view).
  const params: unknown[] = [userId];
  const wsFilter = workspaceId
    ? `AND (l.workspace_id = $2 OR l.workspace_id IS NULL)`
    : '';
  if (workspaceId) params.push(workspaceId);

  const accessCondition = objectAccessCondition('l', 'list');
  const wmJoin = workspaceMembersJoin('l');
  // Archived lists are hidden from the normal workspace view (sidebar, dashboards,
  // etc.) — surfaced only via the dedicated Archived modal (GET /?archived=true).
  const archivedFilter = includeArchived ? 'AND l.is_archived = true' : 'AND l.is_archived = false';

  const [listsResult, sectionsResult, tasksResult] = await Promise.all([
    query<ListRow>(
      `SELECT l.* FROM lists l
       ${wmJoin}
       WHERE ${accessCondition}
       ${wsFilter}
       ${archivedFilter}
       ORDER BY l.position ASC, l.created_at ASC`,
      params
    ),
    query<SectionRow>(
      `SELECT s.* FROM sections s
       JOIN lists l ON s.list_id = l.id
       ${wmJoin}
       WHERE ${accessCondition}
       ${wsFilter}
       ORDER BY s.position ASC`,
      params
    ),
    query<TaskRow>(
      `SELECT t.*,
              (SELECT COUNT(*) FROM task_attachments ta WHERE ta.task_id = t.id) AS attachment_count
       FROM tasks t
       JOIN lists l ON t.list_id = l.id
       ${wmJoin}
       WHERE ${accessCondition}
       AND t.source = 'list'
       ${wsFilter}
       ORDER BY t.position ASC, t.created_at ASC`,
      params
    ),
  ]);

  const tasksBySection: Record<string, ReturnType<typeof sanitizeTask>[]> = {};
  for (const task of tasksResult.rows) {
    const key = task.section_id ?? '__none__';
    if (!tasksBySection[key]) tasksBySection[key] = [];
    tasksBySection[key].push(sanitizeTask(task));
  }

  const sectionsByList: Record<string, ReturnType<typeof sanitizeSection>[]> = {};
  for (const section of sectionsResult.rows) {
    if (!sectionsByList[section.list_id]) sectionsByList[section.list_id] = [];
    sectionsByList[section.list_id].push(
      sanitizeSection(section, tasksBySection[section.id] ?? [])
    );
  }

  // Build a map from list id → all direct task counts for linkedProgress
  const taskCountByList: Record<string, { total: number; completed: number }> = {};
  for (const task of tasksResult.rows) {
    if (!task.list_id) continue;
    if (!taskCountByList[task.list_id]) taskCountByList[task.list_id] = { total: 0, completed: 0 };
    taskCountByList[task.list_id].total++;
    if (task.checked) taskCountByList[task.list_id].completed++;
  }

  wlog(
    `lists BUILD user=${userId} requestedWorkspace=${workspaceId ?? 'ALL'} → ` +
    `${listsResult.rows.length} list(s), ${sectionsResult.rows.length} section(s), ${tasksResult.rows.length} item(s); ` +
    `lists=[${summarizeListRows(listsResult.rows)}]`
  );

  return listsResult.rows.map((list: ListRow) =>
    sanitizeList(list, sectionsByList[list.id] ?? [], taskCountByList[list.id] ?? { total: 0, completed: 0 }, stagedTasksOf(tasksBySection, list.id))
  );
}

// B5 (Phase 2 follow-up): keyset-paginated variant of buildListsForUser.
// Lists are NOT a flat row like tasks/files/folders — each one nests its own
// sections+tasks — so this can't just add a LIMIT to buildListsForUser's own
// query. Instead: cursor-bound the TOP-LEVEL `lists` rows first (same keyset
// predicate as tasks.ts's buildTasksPageForUser), then hydrate sections/tasks
// scoped to ONLY that page's list ids (`list_id = ANY($ids)`) rather than the
// full access-condition scan buildListsForUser uses — this is what keeps a
// page's cost bounded by the page size, not by the workspace's total list
// count, and avoids re-deriving sections/tasks for lists outside this page.
export async function buildListsPageForUser(
  userId: string,
  workspaceId: string | undefined,
  opts: { cursor: KeysetCursor | null; limit: number; includeArchived?: boolean }
): Promise<{ lists: ReturnType<typeof sanitizeList>[]; nextCursor: string | null }> {
  const params: unknown[] = [userId];
  const wsClause = workspaceId ? `AND (l.workspace_id = $2 OR l.workspace_id IS NULL)` : '';
  if (workspaceId) params.push(workspaceId);
  const archivedFilter = opts.includeArchived ? 'AND l.is_archived = true' : 'AND l.is_archived = false';

  let cursorClause = '';
  if (opts.cursor) {
    params.push(opts.cursor.position, opts.cursor.createdAt, opts.cursor.id);
    const n = params.length;
    cursorClause = `AND (l.position, EXTRACT(EPOCH FROM l.created_at)::double precision, l.id) > ($${n - 2}, $${n - 1}::double precision, $${n})`;
  }

  params.push(opts.limit + 1);
  const limitParamIndex = params.length;

  const listsResult = await query<ListRow & { created_at_epoch: number }>(
    `SELECT l.*, EXTRACT(EPOCH FROM l.created_at)::double precision AS created_at_epoch
     FROM lists l
     ${workspaceMembersJoin('l')}
     WHERE ${objectAccessCondition('l', 'list')}
     ${wsClause}
     ${archivedFilter}
     ${cursorClause}
     ORDER BY l.position ASC, l.created_at ASC, l.id ASC
     LIMIT $${limitParamIndex}`,
    params
  );

  const { page, nextCursor } = paginateRows(listsResult.rows, opts.limit, (row) => ({
    position: row.position,
    createdAt: row.created_at_epoch,
    id: row.id,
  }), encodeKeysetCursor);

  if (page.length === 0) return { lists: [], nextCursor };

  const listIds = page.map((l) => l.id);
  const [sectionsResult, tasksResult] = await Promise.all([
    query<SectionRow>(`SELECT * FROM sections WHERE list_id = ANY($1::varchar[]) ORDER BY position ASC`, [listIds]),
    query<TaskRow>(
      `SELECT t.*, (SELECT COUNT(*) FROM task_attachments ta WHERE ta.task_id = t.id) AS attachment_count
       FROM tasks t WHERE t.list_id = ANY($1::varchar[]) AND t.source = 'list'
       ORDER BY t.position ASC, t.created_at ASC`,
      [listIds]
    ),
  ]);

  const tasksBySection: Record<string, ReturnType<typeof sanitizeTask>[]> = {};
  for (const task of tasksResult.rows) {
    const key = task.section_id ?? '__none__';
    if (!tasksBySection[key]) tasksBySection[key] = [];
    tasksBySection[key].push(sanitizeTask(task));
  }
  const sectionsByList: Record<string, ReturnType<typeof sanitizeSection>[]> = {};
  for (const section of sectionsResult.rows) {
    if (!sectionsByList[section.list_id]) sectionsByList[section.list_id] = [];
    sectionsByList[section.list_id].push(sanitizeSection(section, tasksBySection[section.id] ?? []));
  }
  const taskCountByList: Record<string, { total: number; completed: number }> = {};
  for (const task of tasksResult.rows) {
    if (!task.list_id) continue;
    if (!taskCountByList[task.list_id]) taskCountByList[task.list_id] = { total: 0, completed: 0 };
    taskCountByList[task.list_id].total++;
    if (task.checked) taskCountByList[task.list_id].completed++;
  }

  const lists = page.map((list) =>
    sanitizeList(list, sectionsByList[list.id] ?? [], taskCountByList[list.id] ?? { total: 0, completed: 0 }, stagedTasksOf(tasksBySection, list.id))
  );
  return { lists, nextCursor };
}

/**
 * Build a single fully-hydrated list (sections → tasks → progress) if the user
 * can see it, else null. Same shape as one element of `buildListsForUser`, so
 * the delta engine can re-serialize exactly what the app renders — scoped to the
 * requesting user, which is the real access boundary (IDOR-safe). Returns null
 * when the list is gone or no longer visible → the client removes it.
 */
export async function getListForUser(userId: string, listId: string) {
  const accessCondition = objectAccessCondition('l', 'list');
  const listRes = await query<ListRow>(
    `SELECT l.* FROM lists l
     ${workspaceMembersJoin('l')}
     WHERE l.id = $2 AND ${accessCondition}`,
    [userId, listId]
  );
  if (listRes.rows.length === 0) return null;
  const list = listRes.rows[0];

  const [sectionsRes, tasksRes] = await Promise.all([
    query<SectionRow>(`SELECT * FROM sections WHERE list_id = $1 ORDER BY position ASC`, [listId]),
    query<TaskRow>(
      `SELECT t.*, (SELECT COUNT(*) FROM task_attachments ta WHERE ta.task_id = t.id) AS attachment_count
       FROM tasks t WHERE t.list_id = $1 AND t.source = 'list'
       ORDER BY t.position ASC, t.created_at ASC`,
      [listId]
    ),
  ]);

  const tasksBySection: Record<string, ReturnType<typeof sanitizeTask>[]> = {};
  for (const task of tasksRes.rows) {
    const key = task.section_id ?? '__none__';
    if (!tasksBySection[key]) tasksBySection[key] = [];
    tasksBySection[key].push(sanitizeTask(task));
  }
  const sections = sectionsRes.rows.map((s) => sanitizeSection(s, tasksBySection[s.id] ?? []));
  const progress = {
    total: tasksRes.rows.length,
    completed: tasksRes.rows.filter((t) => t.checked).length,
  };
  return sanitizeList(list, sections, progress, stagedTasksOf(tasksBySection, listId));
}

/**
 * B5: batch-hydrate MANY lists in a bounded, small, fixed number of queries
 * (3, regardless of how many list ids are requested) instead of the N
 * round-trips `getListForUser` would need called in a loop — used by
 * `/api/sync/delta`'s re-serialization of a batch of changed list ids in one
 * pass. SAME per-row access boundary as `getListForUser`/`buildListsForUser`
 * (a requested id the caller can't see is silently absent from the returned
 * Map, exactly like `getListForUser` returning null for it) — batching never
 * widens what's visible, it only changes how many round trips it costs to
 * find out.
 */
export async function getListsForUserBatch(userId: string, listIds: string[]): Promise<Map<string, ReturnType<typeof sanitizeList>>> {
  const map = new Map<string, ReturnType<typeof sanitizeList>>();
  if (listIds.length === 0) return map;

  const accessCondition = objectAccessCondition('l', 'list');
  const listsRes = await query<ListRow>(
    `SELECT l.* FROM lists l
     ${workspaceMembersJoin('l')}
     WHERE l.id = ANY($2::varchar[]) AND ${accessCondition}`,
    [userId, listIds]
  );
  if (listsRes.rows.length === 0) return map;
  const visibleIds = listsRes.rows.map((l) => l.id);

  const [sectionsRes, tasksRes] = await Promise.all([
    query<SectionRow>(`SELECT * FROM sections WHERE list_id = ANY($1::varchar[]) ORDER BY position ASC`, [visibleIds]),
    query<TaskRow>(
      `SELECT t.*, (SELECT COUNT(*) FROM task_attachments ta WHERE ta.task_id = t.id) AS attachment_count
       FROM tasks t WHERE t.list_id = ANY($1::varchar[]) AND t.source = 'list'
       ORDER BY t.position ASC, t.created_at ASC`,
      [visibleIds]
    ),
  ]);

  const tasksBySection: Record<string, ReturnType<typeof sanitizeTask>[]> = {};
  for (const task of tasksRes.rows) {
    const key = task.section_id ?? '__none__';
    if (!tasksBySection[key]) tasksBySection[key] = [];
    tasksBySection[key].push(sanitizeTask(task));
  }
  const sectionsByList: Record<string, ReturnType<typeof sanitizeSection>[]> = {};
  for (const section of sectionsRes.rows) {
    if (!sectionsByList[section.list_id]) sectionsByList[section.list_id] = [];
    sectionsByList[section.list_id].push(sanitizeSection(section, tasksBySection[section.id] ?? []));
  }
  const progressByList: Record<string, { total: number; completed: number }> = {};
  for (const task of tasksRes.rows) {
    if (!task.list_id) continue;
    if (!progressByList[task.list_id]) progressByList[task.list_id] = { total: 0, completed: 0 };
    progressByList[task.list_id].total++;
    if (task.checked) progressByList[task.list_id].completed++;
  }

  for (const list of listsRes.rows) {
    map.set(
      list.id,
      sanitizeList(list, sectionsByList[list.id] ?? [], progressByList[list.id] ?? { total: 0, completed: 0 }, stagedTasksOf(tasksBySection, list.id))
    );
  }
  return map;
}

/**
 * Whether `userId` may READ this list — the same access boundary as
 * buildListsForUser/getListForUser. Critically, `is_public` on its own is NOT
 * sufficient: an in-app-public list is only visible to members of its workspace
 * (or when it has no workspace, or the workspace is itself public). Using the
 * bare `is_public` flag as a grant would expose a private workspace's list to
 * any authenticated user. Shared by the progress/changelog read endpoints.
 */
async function userCanViewListRow(
  listObj: { user_id: string; workspace_id: string | null; is_public: boolean },
  userId: string,
  isAdmin: boolean,
): Promise<boolean> {
  if (listObj.user_id === userId || isAdmin) return true;
  if (!listObj.is_public) return false;
  // Public list with no workspace is world-visible in-app (mirrors buildListsForUser).
  if (listObj.workspace_id == null) return true;
  const r = await query(
    `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2
     UNION SELECT 1 FROM workspaces WHERE id = $1 AND visibility = 'public'`,
    [listObj.workspace_id, userId],
  );
  return r.rows.length > 0;
}

// ---------------------------------------------------------------------------
// Lists CRUD
// ---------------------------------------------------------------------------

// GET /api/lists
// Backward-compatible: no cursor/limit → identical unbounded {lists}
// response as before. Either param → paginated {lists, nextCursor} shape.
router.get('/', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    const includeArchived = req.query.archived === 'true';
    const wantsPage = req.query.cursor !== undefined || req.query.limit !== undefined;
    if (wantsPage) {
      const cursor = decodeKeysetCursor(req.query.cursor);
      const limit = parsePageLimit(req.query.limit);
      const { lists, nextCursor } = await buildListsPageForUser(req.userId!, workspaceId, { cursor, limit, includeArchived });
      wlog(`lists GET(paged) user=${req.userId} workspace=${workspaceId ?? 'ALL'} limit=${limit} → ${lists.length} list(s), nextCursor=${nextCursor ? 'yes' : 'no'}`);
      res.json({ lists, nextCursor });
      return;
    }
    wlog(`lists GET ⇢ user=${req.userId} requestedWorkspace=${workspaceId ?? 'ALL'} archived=${includeArchived} rawQuery=${JSON.stringify(req.query)}`);
    const lists = await buildListsForUser(req.userId!, workspaceId, includeArchived);
    wlog(`lists GET ⇠ user=${req.userId} requestedWorkspace=${workspaceId ?? 'ALL'} returned=${lists.length} ids=[${lists.slice(0, 25).map(l => `${l.id}{ws=${l.workspaceId ?? 'NULL'},folder=${l.folderId ?? 'root'}}`).join(', ')}${lists.length > 25 ? `, … +${lists.length - 25} more` : ''}]`);
    res.json({ lists });
  } catch (err) {
    werr('lists GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/lists/:listId/unarchive — owner/admin only. archive_list itself is
// performed by the Automation Hub action or directly by the owner via the
// Archived modal; there is no manual "archive" endpoint in V1 since archiving
// is intended to be an automation-driven action (see automationTypes.ts).
router.put('/:listId/unarchive', async (req: Request, res: Response) => {
  try {
    const { listId } = req.params;
    const ownerCheck = await query<{ user_id: string }>('SELECT user_id FROM lists WHERE id = $1', [listId]);
    if (ownerCheck.rows.length === 0) {
      res.status(404).json({ error: 'List not found' });
      return;
    }
    if (ownerCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    const updated = await setListArchived(query, listId, false);
    if (!updated) {
      res.status(404).json({ error: 'List not found' });
      return;
    }

    res.json({ list: sanitizeList(updated, []) });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    werr('list unarchive error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/lists
router.post('/', async (req: Request, res: Response) => {
  try {
    const { id, name, emoji, color, colorBg, subtitle, isPublic, folderId, parentTaskId, depth, workspaceId, viewMode } = req.body as {
      id?: string;
      name?: string;
      emoji?: string;
      color?: string;
      colorBg?: string;
      subtitle?: string;
      isPublic?: boolean;
      folderId?: string;
      parentTaskId?: number;
      depth?: number;
      workspaceId?: string;
      viewMode?: string;
    };
    const initialViewMode = viewMode === 'kanban' || viewMode === 'timeline' ? viewMode : 'list';

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const listId = id ?? `list_${uuidv4()}`;
    wlog(
      `list CREATE ⇢ user=${req.userId} id=${listId} name=${JSON.stringify(name)} ` +
      `requestedWorkspace=${workspaceId ?? 'none'} folder=${folderId ?? 'root'} parentTask=${parentTaskId ?? 'none'} ` +
      `isPublic=${isPublic ?? false}`
    );

    // Resolve to a workspace the user can actually access. Guarantees the list
    // lands in a real, visible workspace (never NULL / never a dangling id), so
    // it reliably reappears on reload.
    const resolvedWs = await resolveWorkspaceForUser(req.userId!, workspaceId);
    wlog(`list CREATE workspace resolved user=${req.userId} id=${listId} requested=${workspaceId ?? 'none'} resolved=${resolvedWs}`);

    const posResult = await query<{ max: string | null }>(
      'SELECT MAX(position) AS max FROM lists WHERE user_id = $1',
      [req.userId]
    );
    const nextPos = posResult.rows[0].max !== null
      ? parseInt(posResult.rows[0].max, 10) + 1
      : 0;

    const result = await query<ListRow>(
      `INSERT INTO lists (id, user_id, name, emoji, color, color_bg, subtitle, is_public, folder_id, position, parent_task_id, depth, workspace_id, view_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [listId, req.userId, name, emoji ?? null, color ?? null, colorBg ?? null, subtitle ?? null, isPublic ?? false, folderId ?? null, nextPos, parentTaskId ?? null, depth ?? 0, resolvedWs, initialViewMode]
    );

    const persisted = result.rows[0];
    const visibleCheck = await buildListsForUser(req.userId!, persisted.workspace_id ?? undefined);
    const visibleInResolvedWorkspace = visibleCheck.some((l) => l.id === persisted.id);
    wlog(
      `list CREATE ✓ id=${persisted.id} name=${JSON.stringify(name)} owner=${req.userId} ` +
      `requestedWorkspace=${workspaceId ?? 'none'} persistedWorkspace=${persisted.workspace_id ?? 'NULL'} ` +
      `position=${persisted.position} visibleOnReload=${visibleInResolvedWorkspace}`
    );
    if (!visibleInResolvedWorkspace) {
      wwarn(
        `list CREATE visibility anomaly id=${persisted.id} user=${req.userId} ` +
        `workspace=${persisted.workspace_id ?? 'NULL'} reloadIds=[${visibleCheck.map((l) => l.id).join(', ')}]`
      );
    }
    res.status(201).json({ list: sanitizeList(persisted, []) });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    werr('lists POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/lists/:listId/reorder
//
// NOTE: despite the `:listId` path segment, this reorders the caller's
// TOP-LEVEL lists globally (the param is unused in the query below) — kept
// exactly as the pre-existing route shape/behavior; only the write itself
// is now atomic + validated (B4).
router.put('/:listId/reorder', async (req: Request, res: Response) => {
  try {
    const validation = validateReorderIds((req.body as { ids?: unknown }).ids, 'string');
    if (!validation.ok) { res.status(validation.status).json({ error: validation.error }); return; }
    const { ids } = validation;
    if (ids.length === 0) { res.json({ success: true }); return; }

    // Prove every id belongs to a list THIS user owns before mutating
    // anything — a foreign id is rejected wholesale, not silently skipped.
    const owned = await query<{ id: string }>(
      `SELECT id FROM lists WHERE id = ANY($1::varchar[]) AND user_id = $2`,
      [ids, req.userId]
    );
    if (owned.rows.length !== ids.length) {
      res.status(400).json({ error: 'One or more ids do not belong to a list you own' });
      return;
    }

    // ONE bulk statement — atomically all-or-nothing, closing the partial-
    // reorder failure mode the previous N-separate-UPDATEs implementation had.
    await bulkSetPositions('lists', 'varchar', ids, 't.user_id = $3', [req.userId]);

    res.json({ success: true });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    werr('lists reorder error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Recursively collect the ids of every sublist nested under a list.
async function collectDescendantListIds(rootId: string): Promise<string[]> {
  return collectDescendantListIdsShared(query, rootId);
}

// PUT /api/lists/:listId/share — manage the public read-only share link.
// Body: { enabled?, password?: string|null, expiresAt?: string|null, subpages?, viewMode? }
//  - password/expiresAt: omit = unchanged, null = clear, value = set.
//  - subpages: when enabled together with sharing, cascades the share state
//    (token + password + expiry) onto every nested sublist so the public page
//    can deep-link to them; turning it off disables sharing on those sublists.
//  - viewMode: 'list'|'kanban'|'timeline' — which layout the public page renders.
//    Independent of the list's own `view_mode`; omit to leave unchanged (read-time
//    falls back to the list's current view_mode until this is explicitly set).
router.put('/:listId/share', async (req: Request, res: Response) => {
  try {
    const { listId } = req.params;
    const { enabled, password, expiresAt, subpages, viewMode } = req.body as {
      enabled?: boolean;
      password?: string | null;
      expiresAt?: string | null;
      subpages?: boolean;
      viewMode?: 'list' | 'kanban' | 'timeline';
    };

    const existing = await query<ListRow>('SELECT * FROM lists WHERE id = $1', [listId]);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'List not found' }); return; }

    const isOwner = existing.rows[0].user_id === req.userId;
    const isAdmin = req.user?.isAdmin === true;
    if (!isOwner && !isAdmin) { res.status(403).json({ error: 'Permission denied' }); return; }

    const row = existing.rows[0];
    const updatePw  = 'password'  in req.body;
    const updateExp = 'expiresAt' in req.body;
    const updateSub = 'subpages'  in req.body;
    const updateEnabled = 'enabled' in req.body;
    const updateView = 'viewMode' in req.body;
    if (updateView && viewMode !== 'list' && viewMode !== 'kanban' && viewMode !== 'timeline') {
      res.status(400).json({ error: 'Invalid view mode' }); return;
    }

    const willBeEnabled = updateEnabled ? Boolean(enabled) : row.share_enabled;
    // Generate an opaque token the first time sharing is turned on.
    let token = row.share_token;
    if (willBeEnabled && !token) token = randomBytes(24).toString('hex');

    let pwHash: string | null = null;
    if (updatePw && typeof password === 'string' && password.length > 0) {
      pwHash = await hashPassword(password);
    }

    const result = await query<ListRow>(
      `UPDATE lists
       SET share_enabled       = COALESCE($2, share_enabled),
           share_token         = $3,
           share_password_hash = CASE WHEN $4 THEN $5 ELSE share_password_hash END,
           share_expires_at    = CASE WHEN $6 THEN $7 ELSE share_expires_at END,
           share_subpages      = COALESCE($8, share_subpages),
           share_view_mode     = CASE WHEN $9 THEN $10 ELSE share_view_mode END
       WHERE id = $1
       RETURNING *`,
      [listId, updateEnabled ? enabled : null, token, updatePw, pwHash, updateExp, expiresAt ?? null, updateSub ? subpages : null, updateView, updateView ? viewMode : null]
    );

    const saved = result.rows[0];

    // Cascade onto nested sublists.
    if (saved.share_subpages) {
      const descendants = await collectDescendantListIds(listId);
      if (descendants.length > 0) {
        if (saved.share_enabled) {
          // Share each descendant, minting a token where missing and inheriting
          // the parent's password + expiry so protection stays consistent.
          const tokens = descendants.map(() => randomBytes(24).toString('hex'));
          await query(
            `UPDATE lists l
             SET share_enabled = true,
                 share_token = COALESCE(l.share_token, map.token),
                 share_password_hash = $3,
                 share_expires_at = $4
             FROM unnest($1::varchar[], $2::varchar[]) AS map(id, token)
             WHERE l.id = map.id`,
            [descendants, tokens, saved.share_password_hash, saved.share_expires_at]
          );
        } else {
          await query(`UPDATE lists SET share_enabled = false WHERE id = ANY($1::varchar[])`, [descendants]);
        }
      }
    } else if (updateSub && subpages === false) {
      // Subpage sharing explicitly turned off — revoke it on descendants.
      const descendants = await collectDescendantListIds(listId);
      if (descendants.length > 0) {
        await query(`UPDATE lists SET share_enabled = false WHERE id = ANY($1::varchar[])`, [descendants]);
      }
    }

    res.json({
      share: {
        enabled: saved.share_enabled,
        token: saved.share_token,
        hasPassword: saved.share_password_hash != null,
        expiresAt: saved.share_expires_at ?? null,
        subpages: saved.share_subpages,
        viewMode: saved.share_view_mode ?? null,
      },
    });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    werr('lists share PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/lists/:listId
router.put('/:listId', async (req: Request, res: Response) => {
  try {
    const { listId } = req.params;
    const { name, emoji, color, colorBg, subtitle, position, isPublic, folderId, cascade, viewMode, quickAddEnabled } = req.body as {
      name?: string;
      emoji?: string;
      color?: string;
      colorBg?: string;
      subtitle?: string;
      position?: number;
      isPublic?: boolean;
      folderId?: string | null;
      cascade?: boolean;
      viewMode?: string;
      quickAddEnabled?: boolean;
    };
    const validViewMode = viewMode === 'list' || viewMode === 'kanban' || viewMode === 'timeline' ? viewMode : null;
    const validQuickAdd = typeof quickAddEnabled === 'boolean' ? quickAddEnabled : null;

    const existing = await query<ListRow>('SELECT user_id, workspace_id, folder_id, name FROM lists WHERE id = $1', [listId]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'List not found' });
      return;
    }

    const isOwner = existing.rows[0].user_id === req.userId;
    const isAdmin = req.user?.isAdmin === true;

    if (!isOwner && !isAdmin) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    // Optimistic concurrency (B4): the version check is folded directly into
    // the UPDATE's own WHERE clause below (versionGuardSql) rather than run
    // as a separate SELECT beforehand — see concurrency.ts's header for why
    // a standalone pre-check is a genuine check-then-act race under
    // concurrent writers, and why embedding it in the write statement itself
    // closes that race atomically.
    const expectedVersion = (req.body as { expectedVersion?: number }).expectedVersion;

    const updateFolderId = 'folderId' in req.body;

    // Enforce the visibility hierarchy: a list can only be public if its folder
    // (if any) and workspace are public too. On conflict, return a structured
    // 409 unless the client opts into a cascade promote.
    let promote: Awaited<ReturnType<typeof getPrivateAncestors>> = [];
    if (isPublic === true) {
      const targetFolderId = updateFolderId ? (folderId ?? null) : existing.rows[0].folder_id;
      const ancestors = await getPrivateAncestors(query, {
        workspaceId: existing.rows[0].workspace_id, folderId: targetFolderId, userId: req.userId!, isAdmin,
      });
      if (ancestors.length > 0) {
        const conflict = buildPromoteConflict('list', existing.rows[0].name, ancestors);
        if (!cascade) { res.status(409).json(conflict); return; }
        if (!conflict.canResolve) { res.status(403).json(conflict); return; }
        promote = ancestors;
      }
    }

    const updateParams: unknown[] = [name ?? null, emoji ?? null, color ?? null, colorBg ?? null, subtitle ?? null, position ?? null, isPublic ?? null, listId,
      updateFolderId, folderId ?? null, validViewMode, validQuickAdd];
    const versionClause = versionGuardSql(updateParams, expectedVersion);
    const updateSql =
      `UPDATE lists
       SET name      = COALESCE($1, name),
           emoji     = COALESCE($2, emoji),
           color     = COALESCE($3, color),
           color_bg  = COALESCE($4, color_bg),
           subtitle  = COALESCE($5, subtitle),
           position  = COALESCE($6, position),
           is_public = COALESCE($7, is_public),
           folder_id = CASE WHEN $9 THEN $10 ELSE folder_id END,
           view_mode = COALESCE($11, view_mode),
           quick_add_enabled = COALESCE($12, quick_add_enabled)
       WHERE id = $8${versionClause}
       RETURNING *`;

    let result;
    if (promote.length > 0) {
      result = await withTransaction(async (client) => {
        await promoteAncestors(client, promote);
        return client.query<ListRow>(updateSql, updateParams);
      });
    } else {
      result = await query<ListRow>(updateSql, updateParams);
    }

    if (result.rows.length === 0) {
      // The WHERE clause matched nothing — either the row is gone (404) or
      // (when expectedVersion was sent) another writer already moved the
      // version past what this request expected (409). See concurrency.ts.
      const failure = await resolveVersionedUpdateFailure('lists', listId);
      if (failure.notFound) { res.status(404).json({ error: 'List not found' }); return; }
      res.status(409).json({ error: 'version_conflict', currentVersion: failure.currentVersion, list: await getListForUser(req.userId!, listId) });
      return;
    }

    // Turning Quick Add on gives the board its Knowledge Base bubble (creating
    // the workspace's Knowledge Base first if it doesn't have one) and fills it
    // from whatever the board already remembers. Fire-and-forget: the toggle is
    // saved either way, and the bubble sweep reconciles a failure on its next
    // pass rather than turning a settings save into an error the user has to
    // resolve.
    if (validQuickAdd === true) {
      const saved = result.rows[0];
      if (saved.workspace_id) {
        void ensureBubble({ listId, listName: saved.name, workspaceId: saved.workspace_id, userId: saved.user_id })
          .then((entryId) => { if (entryId) return syncBubble(listId); })
          .catch((e) => werr('quickAdd bubble provisioning failed (non-fatal):', e));
      }
    }

    res.json({ list: sanitizeList(result.rows[0], []) });
    broadcastToUser(req.userId!, 'lists');
    if (promote.length > 0) { broadcastToUser(req.userId!, 'folders'); broadcastToUser(req.userId!, 'workspaces'); broadcastToUser(req.userId!, 'timelines'); }
  } catch (err) {
    werr('lists PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/lists/:listId/workspace — move this list (and any owned sublists +
// their tasks) into a different workspace the user has access to. If the list
// or a sublist is public and the target workspace is private, the caller must
// confirm via `cascade: true`, which forces those items private as part of
// the same move (mirrors the promote/restrict visibility conflict above).
router.put('/:listId/workspace', async (req: Request, res: Response) => {
  try {
    const { listId } = req.params;
    const { workspaceId, cascade } = req.body as { workspaceId?: string; cascade?: boolean };
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId is required' });
      return;
    }

    const existing = await query<ListRow>('SELECT user_id, workspace_id, folder_id, is_public, name FROM lists WHERE id = $1', [listId]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'List not found' });
      return;
    }
    const list = existing.rows[0];
    const isOwner = list.user_id === req.userId;
    const isAdmin = req.user?.isAdmin === true;
    if (!isOwner && !isAdmin) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    if (list.workspace_id === workspaceId) {
      res.json({ list: await getListForUser(req.userId!, listId) });
      return;
    }

    const canAccess = await userCanAccessWorkspace(req.userId!, workspaceId);
    if (!canAccess) {
      res.status(403).json({ error: 'You do not have access to that workspace' });
      return;
    }

    const descendantIds = await collectDescendantListIdsShared(query, listId);
    const allIds = [listId, ...descendantIds];

    const targetWs = await query<{ visibility: string }>('SELECT visibility FROM workspaces WHERE id = $1', [workspaceId]);
    const targetIsPrivate = targetWs.rows[0]?.visibility !== 'public';

    let forcePrivateIds: string[] = [];
    if (targetIsPrivate) {
      const publicRows = await query<{ id: string; name: string }>(
        `SELECT id, name FROM lists WHERE id = ANY($1::varchar[]) AND is_public = true`,
        [allIds]
      );
      if (publicRows.rows.length > 0) {
        const conflict = buildRestrictConflict('list', list.name, publicRows.rows.map(r => ({ type: 'list' as const, id: r.id, name: r.name })));
        if (!cascade) { res.status(409).json(conflict); return; }
        forcePrivateIds = publicRows.rows.map(r => r.id);
      }
    }

    // If the list's current folder isn't in the target workspace, detach it —
    // a folder and its contents must always share one workspace.
    let detachFolder = false;
    if (list.folder_id) {
      const f = await query<{ workspace_id: string | null }>('SELECT workspace_id FROM folders WHERE id = $1', [list.folder_id]);
      if (f.rows[0]?.workspace_id !== workspaceId) detachFolder = true;
    }

    await withTransaction(async (client) => {
      if (forcePrivateIds.length > 0) {
        await client.query(`UPDATE lists SET is_public = false WHERE id = ANY($1::varchar[])`, [forcePrivateIds]);
      }
      await client.query(
        `UPDATE lists SET workspace_id = $1${detachFolder ? ', folder_id = NULL' : ''} WHERE id = ANY($2::varchar[])`,
        [workspaceId, allIds]
      );
      await client.query(`UPDATE tasks SET workspace_id = $1 WHERE list_id = ANY($2::varchar[])`, [workspaceId, allIds]);
    });

    wlog(`list MOVE-WORKSPACE ✓ id=${listId} (+${descendantIds.length} sublist(s)) → workspace=${workspaceId} owner=${req.userId}`);
    res.json({ list: await getListForUser(req.userId!, listId) });
    broadcastToUser(req.userId!, 'lists');
    broadcastToUser(req.userId!, 'tasks');
    broadcastToUser(req.userId!, 'workspaces');
  } catch (err) {
    werr('lists PUT /workspace error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/lists/:listId
router.delete('/:listId', async (req: Request, res: Response) => {
  try {
    const { listId } = req.params;

    const existing = await query<ListRow>('SELECT * FROM lists WHERE id = $1', [listId]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'List not found' });
      return;
    }

    const isOwner = existing.rows[0].user_id === req.userId;
    const isAdmin = req.user?.isAdmin === true;

    if (!isOwner && !isAdmin) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    // Soft delete: the list AND every nested sublist are snapshotted to trash,
    // then their tasks and list rows are removed atomically (shared helper —
    // the AI delete_list tool uses the exact same path).
    const sublistCount = await softDeleteListTree(listId); // clears item_shares for the whole tree

    wlog(`list DELETE ✓ id=${listId} (+${sublistCount} sublist(s)) → trashed by user ${req.userId}`);
    res.json({ success: true });
    broadcastToUser(req.userId!, 'lists');
    broadcastToUser(req.userId!, 'trash');
  } catch (err) {
    werr('lists DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

// POST /api/lists/:listId/sections
router.post('/:listId/sections', async (req: Request, res: Response) => {
  try {
    const { listId } = req.params;
    const { id, label, emoji } = req.body as {
      id?: string;
      label?: string;
      emoji?: string;
    };

    wlog(`section listId=${listId} requestedId=${id} label=${label}`);

    if (!label) {
      res.status(400).json({ error: 'label is required' });
      return;
    }

    // Only owner or admin can add sections
    const listCheck = await query<{ user_id: string }>(
      'SELECT user_id FROM lists WHERE id = $1',
      [listId]
    );
    if (listCheck.rows.length === 0) {
      wlog(`section ✗ 404 — list ${listId} not found for userId=${req.userId}`);
      res.status(404).json({ error: 'List not found' });
      return;
    }
    if (listCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin && !(await isItemSharedWith('list', listId, req.userId!))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    const sectionId = id ?? `section_${uuidv4()}`;

    const posResult = await query<{ max: string | null }>(
      'SELECT MAX(position) AS max FROM sections WHERE list_id = $1',
      [listId]
    );
    const nextPos = posResult.rows[0].max !== null
      ? parseInt(posResult.rows[0].max, 10) + 1
      : 0;

    const result = await query<SectionRow>(
      `INSERT INTO sections (id, list_id, label, emoji, position)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [sectionId, listId, label, emoji ?? null, nextPos]
    );

    wlog(`section ✓ created sectionId=${result.rows[0].id}`);
    res.status(201).json({ section: sanitizeSection(result.rows[0], []) });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    werr('sections POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/lists/sections/:sectionId
router.put('/sections/:sectionId', async (req: Request, res: Response) => {
  try {
    const { sectionId } = req.params;
    const { label, emoji, position } = req.body as {
      label?: string;
      emoji?: string;
      position?: number;
    };

    // Owner, admin, or an invited collaborator can update sections
    const ownerCheck = await query<{ user_id: string; list_id: string }>(
      `SELECT l.user_id, l.id AS list_id FROM sections s JOIN lists l ON s.list_id = l.id WHERE s.id = $1`,
      [sectionId]
    );
    if (ownerCheck.rows.length === 0) {
      res.status(404).json({ error: 'Section not found' });
      return;
    }
    if (ownerCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin && !(await isItemSharedWith('list', ownerCheck.rows[0].list_id, req.userId!))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    const result = await query<SectionRow>(
      `UPDATE sections
       SET label    = COALESCE($1, label),
           emoji    = COALESCE($2, emoji),
           position = COALESCE($3, position)
       WHERE id = $4
       RETURNING *`,
      [label ?? null, emoji ?? null, position ?? null, sectionId]
    );

    res.json({ section: sanitizeSection(result.rows[0], []) });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    werr('sections PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/lists/:listId/sections/reorder
router.put('/:listId/sections/reorder', async (req: Request, res: Response) => {
  try {
    const { listId } = req.params;
    const validation = validateReorderIds((req.body as { section_ids?: unknown }).section_ids, 'string');
    if (!validation.ok) { res.status(validation.status).json({ error: validation.error.replace('ids', 'section_ids') }); return; }
    const section_ids = validation.ids as string[];

    const listCheck = await query<{ user_id: string }>(
      'SELECT user_id FROM lists WHERE id = $1',
      [listId]
    );
    if (listCheck.rows.length === 0) {
      res.status(404).json({ error: 'List not found' });
      return;
    }
    if (listCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin && !(await isItemSharedWith('list', listId, req.userId!))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    if (section_ids.length > 0) {
      // Prove every section belongs to THIS list before mutating anything.
      const owned = await query<{ id: string }>(
        `SELECT id FROM sections WHERE id = ANY($1::varchar[]) AND list_id = $2`,
        [section_ids, listId]
      );
      if (owned.rows.length !== section_ids.length) {
        res.status(400).json({ error: 'One or more section_ids do not belong to this list' });
        return;
      }
      // ONE bulk statement — atomically all-or-nothing (B4).
      await bulkSetPositions('sections', 'varchar', section_ids, 't.list_id = $3', [listId]);
    }

    res.json({ success: true });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    werr('sections reorder error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/lists/:listId/sections/:sectionId/tasks/reorder
router.put('/:listId/sections/:sectionId/tasks/reorder', async (req: Request, res: Response) => {
  try {
    const { listId, sectionId } = req.params;
    const validation = validateReorderIds((req.body as { task_ids?: unknown }).task_ids, 'number');
    if (!validation.ok) { res.status(validation.status).json({ error: validation.error.replace('ids', 'task_ids') }); return; }
    const task_ids = validation.ids as number[];

    const ownerCheck = await query<{ user_id: string }>(
      `SELECT l.user_id FROM sections s JOIN lists l ON s.list_id = l.id WHERE s.id = $1 AND l.id = $2`,
      [sectionId, listId]
    );
    if (ownerCheck.rows.length === 0) {
      res.status(404).json({ error: 'Section not found' });
      return;
    }
    if (ownerCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin && !(await isItemSharedWith('list', listId, req.userId!))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    if (task_ids.length > 0) {
      // Prove every task belongs to THIS section before mutating anything.
      const owned = await query<{ id: string }>(
        `SELECT id FROM tasks WHERE id = ANY($1::bigint[]) AND section_id = $2`,
        [task_ids, sectionId]
      );
      if (owned.rows.length !== task_ids.length) {
        res.status(400).json({ error: 'One or more task_ids do not belong to this section' });
        return;
      }
      // ONE bulk statement — atomically all-or-nothing (B4).
      await bulkSetPositions('tasks', 'bigint', task_ids, 't.section_id = $3', [sectionId]);
    }

    res.json({ success: true });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    werr('tasks reorder error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/lists/sections/:sectionId
router.delete('/sections/:sectionId', async (req: Request, res: Response) => {
  try {
    const { sectionId } = req.params;

    // Owner, admin, or an invited collaborator can delete sections
    const ownerCheck = await query<{ user_id: string; list_id: string }>(
      `SELECT l.user_id, l.id AS list_id FROM sections s JOIN lists l ON s.list_id = l.id WHERE s.id = $1`,
      [sectionId]
    );
    if (ownerCheck.rows.length === 0) {
      res.status(404).json({ error: 'Section not found' });
      return;
    }
    if (ownerCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin && !(await isItemSharedWith('list', ownerCheck.rows[0].list_id, req.userId!))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    await query('DELETE FROM sections WHERE id = $1', [sectionId]);

    res.json({ success: true });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    werr('sections DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// List Tasks — mutation core
//
// These are the actual reads/writes behind the HTTP handlers below. They're
// extracted (rather than inlined in the route closures) so the Automation
// Hub engine (backend/src/automationEngine.ts) can perform the exact same
// mutations for its delete_task/create_task actions. Every caller passes an
// explicit MutationActor; createListTask/updateListTaskFields fire the
// matching automation trigger only for actor.type === 'user' — an
// automation's own writes can therefore never re-trigger another automation
// run (loop prevention by construction, see automationEngine.ts).
// ---------------------------------------------------------------------------

export async function createListTask(
  exec: QueryExec,
  listId: string,
  // null = the Quick Add staging tray: a real item on this board that hasn't
  // been filed into a section yet. See stagedTasksOf() above.
  sectionId: string | null,
  userId: string,
  fields: {
    id?: number;
    title: string;
    note?: string | null;
    deadline?: string | null;
    priority?: string | null;
    badge?: string | null;
    linkedListId?: string | null;
    linkedListType?: string | null;
  },
  actor: MutationActor
): Promise<{ task: TaskRow; workspaceId: string | null } | null> {
  // An item ALWAYS inherits its parent list's workspace — never trust a
  // client-supplied workspaceId here, so an item can never drift out of the
  // workspace its list lives in (which would make it vanish on reload).
  const listInfo = sectionId
    ? await exec(
        `SELECT l.workspace_id, l.name FROM sections s JOIN lists l ON s.list_id = l.id WHERE s.id = $1 AND l.id = $2`,
        [sectionId, listId]
      )
    : await exec(`SELECT workspace_id, name FROM lists WHERE id = $1`, [listId]);
  if (listInfo.rows.length === 0) return null;
  const itemWorkspaceId = (listInfo.rows[0] as { workspace_id: string | null }).workspace_id;
  const listName = (listInfo.rows[0] as { name: string }).name;

  const taskId = fields.id ?? (Date.now() * 1000 + crypto.randomInt(1000));

  // Staged items are positioned against the tray (the board's other
  // section-less items), not against a section that doesn't apply to them.
  const posResult = sectionId
    ? await exec(`SELECT MAX(position) AS max FROM tasks WHERE section_id = $1`, [sectionId])
    : await exec(`SELECT MAX(position) AS max FROM tasks WHERE list_id = $1 AND section_id IS NULL`, [listId]);
  const maxPos = (posResult.rows[0] as { max: string | null }).max;
  const nextPos = maxPos !== null ? parseInt(maxPos, 10) + 1 : 0;

  const result = await exec(
    `INSERT INTO tasks
       (id, user_id, title, note, deadline, priority, badge, source, list_id, section_id, position, linked_list_id, linked_list_type, workspace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'list', $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [taskId, userId, fields.title, fields.note ?? null, fields.deadline ?? null, fields.priority ?? null, fields.badge ?? null, listId, sectionId, nextPos, fields.linkedListId ?? null, fields.linkedListType ?? null, itemWorkspaceId]
  );
  const task = result.rows[0] as unknown as TaskRow;

  // Quick Add memory. A create straight into a section is evidence ("an item
  // called this belongs there"); a create into the staging tray is recorded as
  // history but teaches nothing yet — recordPlacement only updates the
  // projection when the item actually landed somewhere.
  await recordPlacement(exec, {
    listId, taskId: task.id, title: task.title,
    fromSectionId: null, toSectionId: sectionId,
    eventType: sectionId ? 'created' : 'staged',
    actor,
  });

  if (itemWorkspaceId) {
    const { fireTrigger } = await import('../automationEngine');
    await fireTrigger('task_created', {
      workspaceId: itemWorkspaceId,
      task: {
        id: String(task.id), title: task.title, listId, checked: task.checked,
        note: task.note, noteMarkdown: task.note_markdown ?? false, deadline: task.deadline, time: task.time_val,
        priority: task.priority, badge: task.badge, sectionId: task.section_id, position: task.position,
        createdAt: task.created_at, updatedAt: task.updated_at,
      },
      list: { id: listId, name: listName },
    }, actor).catch((e) => werr('fireTrigger task_created failed:', e));
  }

  return { task, workspaceId: itemWorkspaceId };
}

export async function updateListTaskFields(
  exec: QueryExec,
  listId: string,
  taskId: string,
  fields: {
    title?: string | null;
    note?: string | null;
    noteMarkdown?: boolean | null;
    checked?: boolean | null;
    deadline?: string | null;
    time_val?: string | null;
    priority?: string | null;
    badge?: string | null;
    position?: number | null;
    sectionId?: string | null;
    /** Explicitly move the item BACK to the Quick Add staging tray. `sectionId: null`
     *  can't express this — every other field here treats null as "unchanged"
     *  (COALESCE), so clearing a column needs its own flag, the same shape
     *  `updateLinkedList` already uses for the linked-list pair. */
    clearSection?: boolean;
    updateLinkedList: boolean;
    linkedListId?: string | null;
    linkedListType?: string | null;
  },
  actor: MutationActor
): Promise<TaskRow | null> {
  const before = await exec(
    `SELECT title, note, checked, deadline, priority, badge, section_id FROM tasks WHERE id = $1 AND list_id = $2`,
    [taskId, listId]
  );
  if (before.rows.length === 0) return null;
  const beforeRow = before.rows[0] as { title: string; note: string | null; checked: boolean; deadline: string | null; priority: string | null; badge: string | null; section_id: string | null };
  const wasChecked = beforeRow.checked;

  const result = await exec(
    `UPDATE tasks
     SET title          = COALESCE($1, title),
         note           = COALESCE($2, note),
         note_markdown  = COALESCE($14, note_markdown),
         checked        = COALESCE($3, checked),
         completed_at   = CASE WHEN $3::boolean IS NULL THEN completed_at WHEN $3::boolean THEN NOW() ELSE NULL END,
         deadline       = COALESCE($4, deadline),
         time_val       = COALESCE($5, time_val),
         priority       = COALESCE($6, priority),
         badge          = COALESCE($7, badge),
         position       = COALESCE($8, position),
         section_id     = CASE WHEN $15 THEN NULL ELSE COALESCE($9, section_id) END,
         linked_list_id   = CASE WHEN $11 THEN $12 ELSE linked_list_id END,
         linked_list_type = CASE WHEN $11 THEN $13 ELSE linked_list_type END
     WHERE id = $10
     RETURNING *`,
    [
      fields.title ?? null,
      fields.note ?? null,
      fields.checked ?? null,
      fields.deadline ?? null,
      fields.time_val ?? null,
      fields.priority ?? null,
      fields.badge ?? null,
      fields.position ?? null,
      fields.sectionId ?? null,
      taskId,
      fields.updateLinkedList,
      fields.linkedListId ?? null,
      fields.linkedListType ?? null,
      typeof fields.noteMarkdown === 'boolean' ? fields.noteMarkdown : null,
      fields.clearSection === true,
    ]
  );

  if (result.rows.length === 0) return null;
  const saved = result.rows[0] as unknown as TaskRow;

  // Audit trail for the Timeline view's change markers/changelog panel —
  // logs whichever of title/note/deadline/priority/badge/section/checked
  // actually moved. No-ops (cheaply) when this call touched none of them.
  await recordTaskChanges(
    exec, listId, taskId,
    { title: beforeRow.title, note: beforeRow.note, deadline: beforeRow.deadline, priority: beforeRow.priority, badge: beforeRow.badge, section_id: beforeRow.section_id, checked: beforeRow.checked },
    { title: saved.title, note: saved.note, deadline: saved.deadline, priority: saved.priority, badge: saved.badge, section_id: saved.section_id, checked: saved.checked },
    actor
  );

  // Quick Add memory. THE choke point: every section move in the app —
  // drag-and-drop between sections or Kanban columns, the TaskDialog, an
  // accepted Quick Add suggestion, an automation's move_task — lands on this
  // one UPDATE, so recording here catches all of them without each call site
  // having to remember to teach the board anything.
  //
  // `beforeRow.section_id !== undefined` guards the same thing
  // recordTaskChanges guards with its "only keys present in BOTH" rule: a
  // caller that fetched a narrower before-state doesn't know where the item
  // was, and `undefined !== 'sec_1'` would otherwise record a phantom move out
  // of nowhere on an ordinary rename.
  if (beforeRow.section_id !== undefined && beforeRow.section_id !== saved.section_id) {
    await recordPlacement(exec, {
      listId, taskId, title: saved.title,
      fromSectionId: beforeRow.section_id, toSectionId: saved.section_id,
      eventType: saved.section_id ? 'moved' : 'staged',
      actor,
    });
  }

  // @-mention notifications — only for genuine USER note edits that changed the
  // text (an automation's writes never mention-notify). notifyNewMentions diffs
  // old→new so re-saving the same note never re-notifies.
  if (actor.type === 'user' && fields.note != null && saved.note !== beforeRow.note) {
    const listInfo = await exec(`SELECT workspace_id FROM lists WHERE id = $1`, [listId]);
    const wsId = listInfo.rows.length > 0 ? (listInfo.rows[0] as { workspace_id: string | null }).workspace_id : null;
    await notifyNewMentions({
      beforeText: beforeRow.note,
      afterText: saved.note,
      workspaceId: wsId,
      actorId: actor.userId,
      title: `mentioned you in "${saved.title}"`,
      entityType: 'task',
      entityId: String(saved.id),
      data: { listId, source: 'list' },
      shareItem: { itemType: 'list', itemId: listId },
    });
    await syncInlineLinksForText({ entityType: 'task', entityId: String(saved.id) }, saved.note, actor.userId, exec);
    await enqueueEmbedding('task', String(saved.id), wsId, exec);
  }

  // Fire triggers only on a false → true checked transition, and only for
  // genuine user actions (see file header). A list-all-completed check piggy
  // -backs on the same transition since it can only ever become true here.
  if (fields.checked === true && !wasChecked) {
    const listRow = await exec(`SELECT workspace_id, name FROM lists WHERE id = $1`, [listId]);
    const wsId = listRow.rows.length > 0 ? (listRow.rows[0] as { workspace_id: string | null }).workspace_id : null;
    if (wsId) {
      const { fireTrigger } = await import('../automationEngine');
      const listCtx = { id: listId, name: (listRow.rows[0] as { name: string }).name };
      await fireTrigger('task_completed', {
        workspaceId: wsId,
        task: {
          id: String(saved.id), title: saved.title, listId, checked: saved.checked,
          note: saved.note, noteMarkdown: saved.note_markdown ?? false, deadline: saved.deadline, time: saved.time_val,
          priority: saved.priority, badge: saved.badge, sectionId: saved.section_id, position: saved.position,
          createdAt: saved.created_at, updatedAt: saved.updated_at,
        },
        list: listCtx,
      }, actor).catch((e) => werr('fireTrigger task_completed failed:', e));

      const remaining = await exec(`SELECT COUNT(*)::int AS n FROM tasks WHERE list_id = $1 AND checked = false`, [listId]);
      if (Number((remaining.rows[0] as { n: number }).n) === 0) {
        await fireTrigger('list_all_completed', { workspaceId: wsId, list: listCtx }, actor)
          .catch((e) => werr('fireTrigger list_all_completed failed:', e));
      }
    }
  }

  return saved;
}

export async function deleteTaskRow(
  exec: QueryExec,
  listId: string,
  taskId: string,
  actor: MutationActor = { type: 'user', userId: 'unknown' }
): Promise<boolean> {
  // Read the row BEFORE deleting it: the placement history keeps a record of
  // where an item was when it left, and after the DELETE there is nothing left
  // to read it from.
  //
  // Note what this does NOT do — it does not clear the item's memory. "Where
  // does an item called this belong" stays true after the specific task is
  // gone, deleted or moved elsewhere, which is exactly the behaviour this
  // feature was asked for: the board remembers items it no longer holds.
  const before = await exec(`SELECT title, section_id FROM tasks WHERE id = $1 AND list_id = $2`, [taskId, listId]);
  const row = before.rows[0] as { title: string; section_id: string | null } | undefined;

  const result = await exec(`DELETE FROM tasks WHERE id = $1 AND list_id = $2`, [taskId, listId]);
  const deleted = (result.rowCount ?? 0) > 0;

  if (deleted && row) {
    await recordPlacement(exec, {
      listId, taskId, title: row.title,
      fromSectionId: row.section_id, toSectionId: null,
      eventType: 'deleted', actor,
    });
  }
  return deleted;
}

export async function setListArchived(exec: QueryExec, listId: string, archived: boolean): Promise<ListRow | null> {
  const result = await exec(
    `UPDATE lists SET is_archived = $1, archived_at = CASE WHEN $1 THEN NOW() ELSE NULL END WHERE id = $2 RETURNING *`,
    [archived, listId]
  );
  return result.rows.length > 0 ? (result.rows[0] as unknown as ListRow) : null;
}

// ---------------------------------------------------------------------------
// List Tasks
// ---------------------------------------------------------------------------

// POST /api/lists/:listId/sections/:sectionId/tasks
router.post('/:listId/sections/:sectionId/tasks', async (req: Request, res: Response) => {
  try {
    const { listId, sectionId } = req.params;
    wlog(`item CREATE → list=${listId} section=${sectionId} title="${req.body?.title}" user=${req.userId}`);
    const { id, title, note, deadline, priority, badge, linked_list_id, linked_list_type } = req.body as {
      id?: number;
      title?: string;
      note?: string;
      deadline?: string;
      priority?: string;
      badge?: string;
      linked_list_id?: string;
      linked_list_type?: 'sublist' | 'link';
      workspaceId?: string;
    };

    if (!title) {
      res.status(400).json({ error: 'title is required' });
      return;
    }

    // Only owner or admin can add tasks
    const ownerCheck = await query<{ user_id: string }>(
      `SELECT l.user_id FROM sections s JOIN lists l ON s.list_id = l.id WHERE s.id = $1 AND l.id = $2`,
      [sectionId, listId]
    );
    if (ownerCheck.rows.length === 0) {
      werr(`item CREATE 404 — section ${sectionId} not found in list ${listId} for user=${req.userId}`);
      res.status(404).json({ error: 'List or section not found' });
      return;
    }
    if (ownerCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin && !(await isItemSharedWith('list', listId, req.userId!))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    const created = await createListTask(query, listId, sectionId, req.userId!, {
      id,
      title,
      note: note ?? null,
      deadline: deadline ?? null,
      priority: priority ?? null,
      badge: badge ?? null,
      linkedListId: linked_list_id ?? null,
      linkedListType: linked_list_type ?? null,
    }, { type: 'user', userId: req.userId! });

    if (!created) {
      werr(`item CREATE 404 — section ${sectionId} not found in list ${listId} for user=${req.userId}`);
      res.status(404).json({ error: 'List or section not found' });
      return;
    }

    wlog(`item CREATE ✓ id=${created.task.id} list=${listId} section=${sectionId} workspace=${created.workspaceId ?? 'null'}`);
    res.status(201).json({ task: sanitizeTask(created.task) });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    werr('list task POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/lists/:listId/tasks/:taskId
router.put('/:listId/tasks/:taskId', async (req: Request, res: Response) => {
  try {
    const { listId, taskId } = req.params;
    const {
      title, note, noteMarkdown, checked, deadline, time_val, priority, badge, position, sectionId, stage,
      linked_list_id: _ll_snake,
      linkedListId: _ll_camel,
      linked_list_type: _llt_snake,
      linkedListType: _llt_camel,
    } = req.body as {
      title?: string;
      note?: string;
      noteMarkdown?: boolean;
      checked?: boolean;
      deadline?: string;
      time_val?: string;
      priority?: string;
      badge?: string;
      position?: number;
      sectionId?: string;
      /** Move this item back to the Quick Add staging tray (drag out of a section). */
      stage?: boolean;
      linked_list_id?: string | null;
      linkedListId?: string | null;
      linked_list_type?: 'sublist' | 'link' | null;
      linkedListType?: 'sublist' | 'link' | null;
    };

    const linked_list_id = _ll_snake ?? _ll_camel;
    const linked_list_type = _llt_snake ?? _llt_camel;
    const updateLinkedList = 'linked_list_id' in req.body || 'linkedListId' in req.body;

    wlog(`item UPDATE taskId=${taskId} listId=${listId} userId=${req.userId}`);
    wlog(`item UPDATE body keys: ${Object.keys(req.body).join(', ')}`);
    wlog(`item UPDATE updateLinkedList=${updateLinkedList} linked_list_id=${linked_list_id} linked_list_type=${linked_list_type}`);

    // Verify the task belongs to a list owned by this user (or admin)
    const permCheck = await query<{ user_id: string }>(
      `SELECT l.user_id FROM tasks t JOIN lists l ON t.list_id = l.id WHERE t.id = $1 AND t.list_id = $2`,
      [taskId, listId]
    );
    if (permCheck.rows.length === 0) {
      wlog(`item UPDATE ✗ 404 — taskId=${taskId} not found in listId=${listId}`);
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (permCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin && !(await isItemSharedWith('list', listId, req.userId!))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    const saved = await updateListTaskFields(query, listId, taskId, {
      title: title ?? null,
      note: note ?? null,
      noteMarkdown: typeof noteMarkdown === 'boolean' ? noteMarkdown : null,
      checked: checked ?? null,
      deadline: deadline ?? null,
      time_val: time_val ?? null,
      priority: priority ?? null,
      badge: badge ?? null,
      position: position ?? null,
      sectionId: sectionId ?? null,
      clearSection: stage === true,
      updateLinkedList,
      linkedListId: linked_list_id ?? null,
      linkedListType: linked_list_type ?? null,
    }, { type: 'user', userId: req.userId! });

    if (!saved) {
      wlog(`item UPDATE ✗ 404 — taskId=${taskId} not found in listId=${listId} for userId=${req.userId}`);
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    wlog(`item UPDATE ✓ updated → linked_list_id=${saved.linked_list_id} linked_list_type=${saved.linked_list_type}`);
    res.json({ task: sanitizeTask(saved) });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    werr('list task PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/lists/:listId/tasks/:taskId
router.delete('/:listId/tasks/:taskId', async (req: Request, res: Response) => {
  try {
    const { listId, taskId } = req.params;

    // Only owner or admin can delete tasks
    const permCheck = await query<{ user_id: string }>(
      `SELECT l.user_id FROM tasks t JOIN lists l ON t.list_id = l.id WHERE t.id = $1 AND t.list_id = $2`,
      [taskId, listId]
    );
    if (permCheck.rows.length === 0) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (permCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin && !(await isItemSharedWith('list', listId, req.userId!))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    const deleted = await deleteTaskRow(query, listId, taskId, { type: 'user', userId: req.userId! });
    if (!deleted) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    res.json({ success: true });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    werr('list task DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Quick Add
//
// The staging tray + placement prediction (see backend/src/quickAdd/). Write
// access is the same boundary as any other item mutation on this board — owner,
// instance admin, or an item-share collaborator — so enabling Quick Add never
// widens who can add to a board.
// ---------------------------------------------------------------------------

/** Owner/admin/collaborator check for a board, shared by the Quick Add endpoints. */
async function assertCanWriteList(listId: string, req: Request): Promise<{ ok: true; list: { user_id: string; workspace_id: string | null; name: string; quick_add_enabled: boolean } } | { ok: false; status: number; error: string }> {
  const r = await query<{ user_id: string; workspace_id: string | null; name: string; quick_add_enabled: boolean }>(
    `SELECT user_id, workspace_id, name, quick_add_enabled FROM lists WHERE id = $1`,
    [listId]
  );
  if (r.rows.length === 0) return { ok: false, status: 404, error: 'List not found' };
  const list = r.rows[0];
  if (list.user_id !== req.userId && !req.user?.isAdmin && !(await isItemSharedWith('list', listId, req.userId!))) {
    return { ok: false, status: 403, error: 'Permission denied' };
  }
  return { ok: true, list };
}

// POST /api/lists/:listId/quick-add/predict — { title } → ranked section suggestions.
// Drives the live hint while typing; `lexicalOnly` skips the embedding provider
// round trip so a keystroke-debounced call stays local and free.
router.post('/:listId/quick-add/predict', async (req: Request, res: Response) => {
  try {
    const { listId } = req.params;
    const { title, lexicalOnly } = req.body as { title?: string; lexicalOnly?: boolean };
    if (!title || !title.trim()) {
      res.json({ suggestions: [] });
      return;
    }

    const perm = await assertCanWriteList(listId, req);
    if (!perm.ok) { res.status(perm.status).json({ error: perm.error }); return; }

    const suggestions = await suggestSections(listId, title, { lexicalOnly: lexicalOnly === true });
    res.json({ suggestions });
  } catch (err) {
    werr('quick-add predict error:', err);
    // A prediction is an enhancement, never the point of the request — an empty
    // suggestion list degrades to "no hint", which is a working Quick Add bar.
    res.json({ suggestions: [] });
  }
});

// POST /api/lists/:listId/quick-add/items — create an item in the STAGING TRAY
// (no section) and return the suggestions for where it should go.
router.post('/:listId/quick-add/items', async (req: Request, res: Response) => {
  try {
    const { listId } = req.params;
    const { title, note, deadline, priority, badge } = req.body as {
      title?: string; note?: string; deadline?: string; priority?: string; badge?: string;
    };
    if (!title || !title.trim()) {
      res.status(400).json({ error: 'title is required' });
      return;
    }

    const perm = await assertCanWriteList(listId, req);
    if (!perm.ok) { res.status(perm.status).json({ error: perm.error }); return; }

    // Predict BEFORE creating: the item about to be inserted would otherwise be
    // its own strongest piece of evidence, and every suggestion would read
    // "this went here last time" about the thing you are adding right now.
    const suggestions = await suggestSections(listId, title);

    const created = await createListTask(query, listId, null, req.userId!, {
      title: title.trim(),
      note: note ?? null,
      deadline: deadline ?? null,
      priority: priority ?? null,
      badge: badge ?? null,
    }, { type: 'user', userId: req.userId! });

    if (!created) {
      res.status(404).json({ error: 'List not found' });
      return;
    }

    wlog(`quick-add CREATE ✓ id=${created.task.id} list=${listId} staged suggestions=${suggestions.length}`);
    res.status(201).json({ task: sanitizeTask(created.task), suggestions });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    werr('quick-add create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/lists/:listId/quick-add/memory — what this board has learned.
// Read-only, surfaced in the board's settings so the toggle isn't a black box.
router.get('/:listId/quick-add/memory', async (req: Request, res: Response) => {
  try {
    const { listId } = req.params;
    const perm = await assertCanWriteList(listId, req);
    if (!perm.ok) { res.status(perm.status).json({ error: perm.error }); return; }

    const entryRes = await query<{ quick_add_kb_entry_id: string | null }>(
      `SELECT quick_add_kb_entry_id FROM lists WHERE id = $1`, [listId]
    );
    const stats = await getMemoryStats(listId);
    res.json({ ...stats, entryId: entryRes.rows[0]?.quick_add_kb_entry_id ?? null });
  } catch (err) {
    werr('quick-add memory error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/lists/:listId/progress
router.get('/:listId/progress', async (req: Request, res: Response) => {
  try {
    const { listId } = req.params;

    // FIND-01: Check list access before progress calculation
    const listCheck = await query<{ user_id: string; workspace_id: string | null; is_public: boolean }>(
      'SELECT user_id, workspace_id, is_public FROM lists WHERE id = $1',
      [listId]
    );
    if (listCheck.rows.length === 0) {
      res.status(404).json({ error: 'List not found' });
      return;
    }
    const listObj = listCheck.rows[0];
    const canAccess = await userCanViewListRow(listObj, req.userId!, req.user?.isAdmin === true);

    if (!canAccess) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    // Recursively collect all list IDs (this list + sublists)
    async function collectSublistIds(id: string): Promise<string[]> {
      const subResult = await query<{ id: string }>(
        `SELECT l.id FROM lists l
         JOIN tasks t ON l.parent_task_id = t.id
         WHERE t.list_id = $1 AND l.id != $1`,
        [id]
      );
      const ids = [id];
      for (const row of subResult.rows) {
        const nested = await collectSublistIds(row.id);
        ids.push(...nested);
      }
      return ids;
    }

    const allIds = await collectSublistIds(listId);
    const countRes = await query<{ total: string; completed: string }>(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE checked = true) AS completed
       FROM tasks t
       JOIN sections s ON t.section_id = s.id
       WHERE s.list_id = ANY($1::varchar[]) AND t.source = 'list'`,
      [allIds]
    );
    const total = parseInt(countRes.rows[0].total, 10);
    const completed = parseInt(countRes.rows[0].completed, 10);
    const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
    res.json({ total, completed, percent });
  } catch (err) {
    werr('list progress error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function mapChangeLogRow(r: {
  id: string; task_id: string; field: string; old_value: string | null; new_value: string | null;
  actor_type: string; actor_id: string | null; actor_name: string | null; changed_at: string;
}) {
  return {
    id: r.id,
    taskId: Number(r.task_id),
    field: r.field,
    oldValue: r.old_value,
    newValue: r.new_value,
    actorType: r.actor_type,
    actorId: r.actor_id,
    actorName: r.actor_name,
    changedAt: r.changed_at,
  };
}

// GET /api/lists/:listId/changelog — every tracked field change (title/note/
// deadline/priority/badge/section) across this list's tasks, newest first.
// Feeds the Timeline view's per-task change markers.
router.get('/:listId/changelog', async (req: Request, res: Response) => {
  try {
    const { listId } = req.params;

    const listCheck = await query<{ user_id: string; workspace_id: string | null; is_public: boolean }>(
      'SELECT user_id, workspace_id, is_public FROM lists WHERE id = $1',
      [listId]
    );
    if (listCheck.rows.length === 0) {
      res.status(404).json({ error: 'List not found' });
      return;
    }
    const listObj = listCheck.rows[0];
    const canAccess = await userCanViewListRow(listObj, req.userId!, req.user?.isAdmin === true);
    if (!canAccess) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    const rows = await query<{
      id: string; task_id: string; field: string; old_value: string | null; new_value: string | null;
      actor_type: string; actor_id: string | null; actor_name: string | null; changed_at: string;
    }>(
      `SELECT id, task_id, field, old_value, new_value, actor_type, actor_id, actor_name, changed_at
       FROM task_change_log WHERE list_id = $1 ORDER BY changed_at DESC LIMIT 1000`,
      [listId]
    );

    res.json({ entries: rows.rows.map(mapChangeLogRow) });
  } catch (err) {
    werr('list changelog error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/lists/:listId/tasks/:taskId/changelog — one task's full tracked-field
// change history, newest first. Feeds the "Change history" panel in TaskDialog.
router.get('/:listId/tasks/:taskId/changelog', async (req: Request, res: Response) => {
  try {
    const { listId, taskId } = req.params;

    const listCheck = await query<{ user_id: string; workspace_id: string | null; is_public: boolean }>(
      'SELECT user_id, workspace_id, is_public FROM lists WHERE id = $1',
      [listId]
    );
    if (listCheck.rows.length === 0) {
      res.status(404).json({ error: 'List not found' });
      return;
    }
    const listObj = listCheck.rows[0];
    const canAccess = await userCanViewListRow(listObj, req.userId!, req.user?.isAdmin === true);
    if (!canAccess) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    const rows = await query<{
      id: string; task_id: string; field: string; old_value: string | null; new_value: string | null;
      actor_type: string; actor_id: string | null; actor_name: string | null; changed_at: string;
    }>(
      `SELECT id, task_id, field, old_value, new_value, actor_type, actor_id, actor_name, changed_at
       FROM task_change_log WHERE list_id = $1 AND task_id = $2 ORDER BY changed_at DESC LIMIT 500`,
      [listId, taskId]
    );

    res.json({ entries: rows.rows.map(mapChangeLogRow) });
  } catch (err) {
    werr('task changelog error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/lists/:listId/sections/:sectionId/tasks/sublist
router.post('/:listId/sections/:sectionId/tasks/sublist', async (req: Request, res: Response) => {
  try {
    const { listId, sectionId } = req.params;
    const { title, sublistName, depth, workspaceId } = req.body as { title?: string; sublistName?: string; depth?: number; workspaceId?: string };

    if (!title || !sublistName) {
      res.status(400).json({ error: 'title and sublistName are required' });
      return;
    }

    wlog(`sublist CREATE → parentList=${listId} section=${sectionId} name="${sublistName}" user=${req.userId}`);

    const ownerCheck = await query<{ user_id: string; depth: number; workspace_id: string | null }>(
      `SELECT l.user_id, l.depth, l.workspace_id FROM sections s JOIN lists l ON s.list_id = l.id WHERE s.id = $1 AND l.id = $2`,
      [sectionId, listId]
    );
    if (ownerCheck.rows.length === 0) {
      werr(`sublist CREATE 404 — section ${sectionId} not in list ${listId} for user=${req.userId}`);
      res.status(404).json({ error: 'List or section not found' });
      return;
    }
    if (ownerCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin && !(await isItemSharedWith('list', listId, req.userId!))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    // The sublist (and its linking task) ALWAYS inherit the parent list's
    // workspace, so the whole nested tree stays in one workspace and never
    // gets orphaned. (workspaceId from the client is ignored on purpose.)
    const parentDepth = ownerCheck.rows[0].depth ?? 0;
    const newDepth = depth ?? parentDepth + 1;
    const finalWorkspaceId = ownerCheck.rows[0].workspace_id;

    const newListId = `list_${uuidv4()}`;
    const newSectionId = `section_${uuidv4()}`;
    const taskId = Date.now() * 1000 + crypto.randomInt(1000);

    // All four writes happen atomically: list + its section + the linking task
    // + the back-reference. A partial failure can no longer leave a sublist
    // without a task (or a task pointing at a half-created list).
    const { newList, newTask } = await withTransaction(async (client) => {
      const posResult = await client.query<{ max: string | null }>('SELECT MAX(position) AS max FROM lists WHERE user_id = $1', [req.userId]);
      const nextPos = posResult.rows[0].max !== null ? parseInt(posResult.rows[0].max, 10) + 1 : 0;

      const listRes = await client.query<ListRow>(
        `INSERT INTO lists (id, user_id, name, is_public, position, depth, workspace_id) VALUES ($1, $2, $3, false, $4, $5, $6) RETURNING *`,
        [newListId, req.userId, sublistName, nextPos, newDepth, finalWorkspaceId]
      );

      await client.query(
        `INSERT INTO sections (id, list_id, label, position) VALUES ($1, $2, 'Tasks', 0)`,
        [newSectionId, newListId]
      );

      const taskPosResult = await client.query<{ max: string | null }>('SELECT MAX(position) AS max FROM tasks WHERE section_id = $1', [sectionId]);
      const taskPos = taskPosResult.rows[0].max !== null ? parseInt(taskPosResult.rows[0].max, 10) + 1 : 0;

      const taskRes = await client.query<TaskRow>(
        `INSERT INTO tasks (id, user_id, title, source, list_id, section_id, position, linked_list_id, linked_list_type, workspace_id)
         VALUES ($1, $2, $3, 'list', $4, $5, $6, $7, 'sublist', $8) RETURNING *`,
        [taskId, req.userId, title, listId, sectionId, taskPos, newListId, finalWorkspaceId]
      );

      await client.query('UPDATE lists SET parent_task_id = $1 WHERE id = $2', [taskId, newListId]);
      listRes.rows[0].parent_task_id = String(taskId);

      return { newList: listRes.rows[0], newTask: taskRes.rows[0] };
    });

    wlog(`sublist CREATE ✓ list=${newListId} task=${taskId} depth=${newDepth} workspace=${finalWorkspaceId ?? 'null'}`);
    res.status(201).json({ task: sanitizeTask(newTask), list: sanitizeList(newList, []) });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    werr('sublist task POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/lists/:listId/sections/:sectionId/tasks/link
router.post('/:listId/sections/:sectionId/tasks/link', async (req: Request, res: Response) => {
  try {
    const { listId, sectionId } = req.params;
    const { title, linkedListId, workspaceId } = req.body as { title?: string; linkedListId?: string; workspaceId?: string };

    if (!title || !linkedListId) {
      res.status(400).json({ error: 'title and linkedListId are required' });
      return;
    }

    wlog(`link CREATE → list=${listId} section=${sectionId} target=${linkedListId} user=${req.userId}`);

    const ownerCheck = await query<{ user_id: string; workspace_id: string | null }>(
      `SELECT l.user_id, l.workspace_id FROM sections s JOIN lists l ON s.list_id = l.id WHERE s.id = $1 AND l.id = $2`,
      [sectionId, listId]
    );
    if (ownerCheck.rows.length === 0) {
      werr(`link CREATE 404 — section ${sectionId} not in list ${listId} for user=${req.userId}`);
      res.status(404).json({ error: 'List or section not found' });
      return;
    }
    if (ownerCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin && !(await isItemSharedWith('list', listId, req.userId!))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    // Verify target list belongs to user
    const targetCheck = await query('SELECT id FROM lists WHERE id = $1 AND user_id = $2', [linkedListId, req.userId]);
    if (targetCheck.rows.length === 0) {
      res.status(404).json({ error: 'Target list not found' });
      return;
    }

    const taskId = Date.now() * 1000 + crypto.randomInt(1000);
    const posResult = await query<{ max: string | null }>('SELECT MAX(position) AS max FROM tasks WHERE section_id = $1', [sectionId]);
    const taskPos = posResult.rows[0].max !== null ? parseInt(posResult.rows[0].max, 10) + 1 : 0;

    // The linking task inherits the parent list's workspace (authoritative).
    const finalWorkspaceId = ownerCheck.rows[0].workspace_id;

    const newTask = await query<TaskRow>(
      `INSERT INTO tasks (id, user_id, title, source, list_id, section_id, position, linked_list_id, linked_list_type, workspace_id)
       VALUES ($1, $2, $3, 'list', $4, $5, $6, $7, 'link', $8) RETURNING *`,
      [taskId, req.userId, title, listId, sectionId, taskPos, linkedListId, finalWorkspaceId]
    );

    wlog(`link CREATE ✓ task=${taskId} list=${listId} → target=${linkedListId} workspace=${finalWorkspaceId ?? 'null'}`);
    res.status(201).json({ task: sanitizeTask(newTask.rows[0]) });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    werr('link task POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
