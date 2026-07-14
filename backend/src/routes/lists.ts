import { Router, Request, Response } from 'express';
import crypto, { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db';
import { authenticate } from '../middleware';
import { hashPassword } from '../auth';
import { broadcastToUser } from '../sse';
import { checkVersionConflict } from '../concurrency';
import { resolveWorkspaceForUser, userCanAccessWorkspace, wlog, wwarn, werr, QueryExec } from '../workspaceUtil';
import { softDeleteListTree, collectDescendantListIds as collectDescendantListIdsShared } from '../trashUtil';
import { getPrivateAncestors, buildPromoteConflict, promoteAncestors, buildRestrictConflict } from '../visibility';
import type { MutationActor } from '../automationEngine';

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
  version?: number;
  view_mode: string;
  is_archived?: boolean;
  archived_at?: string | null;
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

function sanitizeList(
  list: ListRow,
  sections: ReturnType<typeof sanitizeSection>[],
  linkedProgress?: { total: number; completed: number }
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
    version:      list.version ?? 1,
    viewMode:     (list.view_mode === 'kanban' ? 'kanban' : 'list') as 'list' | 'kanban',
    isArchived:   list.is_archived ?? false,
    archivedAt:   list.archived_at ?? null,
    sections,
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

  const accessCondition = `(
    l.user_id = $1
    OR (l.is_public = true AND (
      wm.user_id = $1
      OR l.workspace_id IS NULL
      OR EXISTS (SELECT 1 FROM workspaces w WHERE w.id = l.workspace_id AND w.visibility = 'public')
    ))
  )`;
  // Archived lists are hidden from the normal workspace view (sidebar, dashboards,
  // etc.) — surfaced only via the dedicated Archived modal (GET /?archived=true).
  const archivedFilter = includeArchived ? 'AND l.is_archived = true' : 'AND l.is_archived = false';

  const [listsResult, sectionsResult, tasksResult] = await Promise.all([
    query<ListRow>(
      `SELECT l.* FROM lists l
       LEFT JOIN workspace_members wm ON wm.workspace_id = l.workspace_id AND wm.user_id = $1
       WHERE ${accessCondition}
       ${wsFilter}
       ${archivedFilter}
       ORDER BY l.position ASC, l.created_at ASC`,
      params
    ),
    query<SectionRow>(
      `SELECT s.* FROM sections s
       JOIN lists l ON s.list_id = l.id
       LEFT JOIN workspace_members wm ON wm.workspace_id = l.workspace_id AND wm.user_id = $1
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
       LEFT JOIN workspace_members wm ON wm.workspace_id = l.workspace_id AND wm.user_id = $1
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
    sanitizeList(list, sectionsByList[list.id] ?? [], taskCountByList[list.id] ?? { total: 0, completed: 0 })
  );
}

/**
 * Build a single fully-hydrated list (sections → tasks → progress) if the user
 * can see it, else null. Same shape as one element of `buildListsForUser`, so
 * the delta engine can re-serialize exactly what the app renders — scoped to the
 * requesting user, which is the real access boundary (IDOR-safe). Returns null
 * when the list is gone or no longer visible → the client removes it.
 */
export async function getListForUser(userId: string, listId: string) {
  const accessCondition = `(
    l.user_id = $1
    OR (l.is_public = true AND (
      wm.user_id = $1
      OR l.workspace_id IS NULL
      OR EXISTS (SELECT 1 FROM workspaces w WHERE w.id = l.workspace_id AND w.visibility = 'public')
    ))
  )`;
  const listRes = await query<ListRow>(
    `SELECT l.* FROM lists l
     LEFT JOIN workspace_members wm ON wm.workspace_id = l.workspace_id AND wm.user_id = $1
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
  return sanitizeList(list, sections, progress);
}

// ---------------------------------------------------------------------------
// Lists CRUD
// ---------------------------------------------------------------------------

// GET /api/lists
router.get('/', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    const includeArchived = req.query.archived === 'true';
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
    const initialViewMode = viewMode === 'kanban' ? 'kanban' : 'list';

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
router.put('/:listId/reorder', async (req: Request, res: Response) => {
  try {
    const { ids } = req.body as { ids?: string[] };

    if (!Array.isArray(ids)) {
      res.status(400).json({ error: 'ids must be an array' });
      return;
    }

    await Promise.all(
      ids.map((listId, index) =>
        query(
          'UPDATE lists SET position = $1 WHERE id = $2 AND user_id = $3',
          [index, listId, req.userId]
        )
      )
    );

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
// Body: { enabled?, password?: string|null, expiresAt?: string|null, subpages? }
//  - password/expiresAt: omit = unchanged, null = clear, value = set.
//  - subpages: when enabled together with sharing, cascades the share state
//    (token + password + expiry) onto every nested sublist so the public page
//    can deep-link to them; turning it off disables sharing on those sublists.
router.put('/:listId/share', async (req: Request, res: Response) => {
  try {
    const { listId } = req.params;
    const { enabled, password, expiresAt, subpages } = req.body as {
      enabled?: boolean;
      password?: string | null;
      expiresAt?: string | null;
      subpages?: boolean;
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
           share_subpages      = COALESCE($8, share_subpages)
       WHERE id = $1
       RETURNING *`,
      [listId, updateEnabled ? enabled : null, token, updatePw, pwHash, updateExp, expiresAt ?? null, updateSub ? subpages : null]
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
    const { name, emoji, color, colorBg, subtitle, position, isPublic, folderId, cascade, viewMode } = req.body as {
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
    };
    const validViewMode = viewMode === 'list' || viewMode === 'kanban' ? viewMode : null;

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

    // Optimistic concurrency: if the client sent the version it edited and the
    // row has since moved on, reject with 409 + the current list so the loser
    // reconciles to the winner instead of silently clobbering it.
    const conflict = await checkVersionConflict('lists', listId, (req.body as { expectedVersion?: number }).expectedVersion);
    if (conflict !== null) {
      res.status(409).json({ error: 'version_conflict', list: await getListForUser(req.userId!, listId) });
      return;
    }

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
           view_mode = COALESCE($11, view_mode)
       WHERE id = $8
       RETURNING *`;
    const updateParams = [name ?? null, emoji ?? null, color ?? null, colorBg ?? null, subtitle ?? null, position ?? null, isPublic ?? null, listId,
      updateFolderId, folderId ?? null, validViewMode];

    let result;
    if (promote.length > 0) {
      result = await withTransaction(async (client) => {
        await promoteAncestors(client, promote);
        return client.query<ListRow>(updateSql, updateParams);
      });
    } else {
      result = await query<ListRow>(updateSql, updateParams);
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
    const sublistCount = await softDeleteListTree(listId);

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
    if (listCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin) {
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

    // Only owner or admin can update sections
    const ownerCheck = await query<{ user_id: string }>(
      `SELECT l.user_id FROM sections s JOIN lists l ON s.list_id = l.id WHERE s.id = $1`,
      [sectionId]
    );
    if (ownerCheck.rows.length === 0) {
      res.status(404).json({ error: 'Section not found' });
      return;
    }
    if (ownerCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin) {
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
    const { section_ids } = req.body as { section_ids?: string[] };

    if (!Array.isArray(section_ids)) {
      res.status(400).json({ error: 'section_ids must be an array' });
      return;
    }

    const listCheck = await query<{ user_id: string }>(
      'SELECT user_id FROM lists WHERE id = $1',
      [listId]
    );
    if (listCheck.rows.length === 0) {
      res.status(404).json({ error: 'List not found' });
      return;
    }
    if (listCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    await Promise.all(
      section_ids.map((sectionId, index) =>
        query('UPDATE sections SET position = $1 WHERE id = $2 AND list_id = $3', [index, sectionId, listId])
      )
    );

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
    const { task_ids } = req.body as { task_ids?: number[] };

    if (!Array.isArray(task_ids)) {
      res.status(400).json({ error: 'task_ids must be an array' });
      return;
    }

    const ownerCheck = await query<{ user_id: string }>(
      `SELECT l.user_id FROM sections s JOIN lists l ON s.list_id = l.id WHERE s.id = $1 AND l.id = $2`,
      [sectionId, listId]
    );
    if (ownerCheck.rows.length === 0) {
      res.status(404).json({ error: 'Section not found' });
      return;
    }
    if (ownerCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    await Promise.all(
      task_ids.map((taskId, index) =>
        query('UPDATE tasks SET position = $1 WHERE id = $2 AND section_id = $3', [index, taskId, sectionId])
      )
    );

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

    // Only owner or admin can delete sections
    const ownerCheck = await query<{ user_id: string }>(
      `SELECT l.user_id FROM sections s JOIN lists l ON s.list_id = l.id WHERE s.id = $1`,
      [sectionId]
    );
    if (ownerCheck.rows.length === 0) {
      res.status(404).json({ error: 'Section not found' });
      return;
    }
    if (ownerCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin) {
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
  sectionId: string,
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
  const sectionInfo = await exec(
    `SELECT l.workspace_id, l.name FROM sections s JOIN lists l ON s.list_id = l.id WHERE s.id = $1 AND l.id = $2`,
    [sectionId, listId]
  );
  if (sectionInfo.rows.length === 0) return null;
  const itemWorkspaceId = (sectionInfo.rows[0] as { workspace_id: string | null }).workspace_id;
  const listName = (sectionInfo.rows[0] as { name: string }).name;

  const taskId = fields.id ?? (Date.now() * 1000 + crypto.randomInt(1000));

  const posResult = await exec(`SELECT MAX(position) AS max FROM tasks WHERE section_id = $1`, [sectionId]);
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

  if (itemWorkspaceId) {
    const { fireTrigger } = await import('../automationEngine');
    await fireTrigger('task_created', {
      workspaceId: itemWorkspaceId,
      task: { id: String(task.id), title: task.title, listId, checked: false },
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
    updateLinkedList: boolean;
    linkedListId?: string | null;
    linkedListType?: string | null;
  },
  actor: MutationActor
): Promise<TaskRow | null> {
  const before = await exec(`SELECT checked FROM tasks WHERE id = $1 AND list_id = $2`, [taskId, listId]);
  if (before.rows.length === 0) return null;
  const wasChecked = (before.rows[0] as { checked: boolean }).checked;

  const result = await exec(
    `UPDATE tasks
     SET title          = COALESCE($1, title),
         note           = COALESCE($2, note),
         note_markdown  = COALESCE($14, note_markdown),
         checked        = COALESCE($3, checked),
         deadline       = COALESCE($4, deadline),
         time_val       = COALESCE($5, time_val),
         priority       = COALESCE($6, priority),
         badge          = COALESCE($7, badge),
         position       = COALESCE($8, position),
         section_id     = COALESCE($9, section_id),
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
    ]
  );

  if (result.rows.length === 0) return null;
  const saved = result.rows[0] as unknown as TaskRow;

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
        task: { id: String(saved.id), title: saved.title, listId, checked: true },
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

export async function deleteTaskRow(exec: QueryExec, listId: string, taskId: string): Promise<boolean> {
  const result = await exec(`DELETE FROM tasks WHERE id = $1 AND list_id = $2`, [taskId, listId]);
  return (result.rowCount ?? 0) > 0;
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
    if (ownerCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin) {
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
      title, note, noteMarkdown, checked, deadline, time_val, priority, badge, position, sectionId,
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
    if (permCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin) {
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
    if (permCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    const deleted = await deleteTaskRow(query, listId, taskId);
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
    const isOwner = listObj.user_id === req.userId;
    const isAdmin = req.user?.isAdmin === true;

    // Check workspace membership if list belongs to a workspace
    let hasWorkspaceAccess = false;
    if (listObj.workspace_id) {
       const wsMemberCheck = await query('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [listObj.workspace_id, req.userId]);
       hasWorkspaceAccess = wsMemberCheck.rows.length > 0;
    }

    const canAccess = isOwner || isAdmin || listObj.is_public || hasWorkspaceAccess;

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
    if (ownerCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin) {
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
    if (ownerCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin) {
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
