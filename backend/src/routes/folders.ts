import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db';
import { authenticate } from '../middleware';
import { broadcastToUser } from '../sse';
import { resolveWorkspaceForUser, userCanAccessWorkspace, wlog, werr } from '../workspaceUtil';
import { softDeleteFolderExec, collectDescendantListIds as collectDescendantListIdsShared } from '../trashUtil';
import {
  getPrivateAncestors, buildPromoteConflict, promoteAncestors,
  getPublicDescendants, buildRestrictConflict, restrictDescendants,
  type ConflictDescendant,
} from '../visibility';

const router = Router();
router.use(authenticate);

interface FolderRow {
  id: string;
  user_id: string;
  name: string;
  emoji: string | null;
  color: string | null;
  position: number;
  collapsed: boolean;
  is_public: boolean;
  created_at: string;
  workspace_id: string | null;
}

function summarizeFolderRows(rows: FolderRow[]): string {
  if (rows.length === 0) return 'none';
  return rows
    .slice(0, 25)
    .map((f) => `${f.id}{ws=${f.workspace_id ?? 'NULL'},owner=${f.user_id},public=${f.is_public},collapsed=${f.collapsed}}`)
    .join(', ') + (rows.length > 25 ? `, … +${rows.length - 25} more` : '');
}

function sanitizeFolder(f: FolderRow) {
  return {
    id:          f.id,
    userId:      f.user_id,
    name:        f.name,
    emoji:       f.emoji  ?? undefined,
    color:       f.color  ?? undefined,
    position:    f.position,
    collapsed:   f.collapsed,
    isPublic:    f.is_public,
    workspaceId: f.workspace_id ?? undefined,
  };
}

const FOLDER_ACCESS = `(f.user_id = $1 OR (f.is_public = true AND (wm.user_id = $1 OR f.workspace_id IS NULL OR EXISTS (SELECT 1 FROM workspaces w WHERE w.id = f.workspace_id AND w.visibility = 'public'))))`;

// Build the folders the user can see, exactly as GET /api/folders returns them.
// Reused by the sync bootstrap.
export async function buildFoldersForUser(userId: string, workspaceId?: string) {
  const params: unknown[] = [userId];
  const wsClause = workspaceId ? `AND (f.workspace_id = $2 OR f.workspace_id IS NULL)` : '';
  if (workspaceId) params.push(workspaceId);
  const rows = await query<FolderRow>(
    `SELECT f.* FROM folders f
     LEFT JOIN workspace_members wm ON wm.workspace_id = f.workspace_id AND wm.user_id = $1
     WHERE ${FOLDER_ACCESS}
     ${wsClause}
     ORDER BY f.position ASC, f.created_at ASC`,
    params
  );
  wlog(
    `folders BUILD user=${userId} requestedWorkspace=${workspaceId ?? 'ALL'} → ` +
    `${rows.rows.length} folder(s); folders=[${summarizeFolderRows(rows.rows)}]`
  );
  return rows.rows.map(sanitizeFolder);
}

/** A single folder the user can see, sanitized, or null. For delta re-serialization. */
export async function getFolderForUser(userId: string, folderId: string) {
  const r = await query<FolderRow>(
    `SELECT f.* FROM folders f
     LEFT JOIN workspace_members wm ON wm.workspace_id = f.workspace_id AND wm.user_id = $1
     WHERE f.id = $2 AND ${FOLDER_ACCESS}`,
    [userId, folderId]
  );
  return r.rows[0] ? sanitizeFolder(r.rows[0]) : null;
}

// GET /api/folders
router.get('/', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    const folders = await buildFoldersForUser(req.userId!, workspaceId);
    res.json({ folders });
  } catch (err) {
    werr('folders GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/folders
router.post('/', async (req: Request, res: Response) => {
  try {
    const { id, name, emoji, color, isPublic, workspaceId } = req.body as {
      id?: string;
      name?: string;
      emoji?: string;
      color?: string;
      isPublic?: boolean;
      workspaceId?: string;
    };
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const folderId = id ?? `folder_${uuidv4()}`;
    // Resolve to a workspace the user can access so the folder always has a
    // real, visible home (consistent with lists/items).
    const resolvedWs = await resolveWorkspaceForUser(req.userId!, workspaceId);
    const posRes = await query<{ max: string | null }>(
      'SELECT MAX(position) AS max FROM folders WHERE user_id = $1',
      [req.userId]
    );
    const nextPos = posRes.rows[0].max !== null ? parseInt(posRes.rows[0].max, 10) + 1 : 0;
    const result = await query<FolderRow>(
      `INSERT INTO folders (id, user_id, name, emoji, color, position, is_public, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [folderId, req.userId, name, emoji ?? null, color ?? null, nextPos, isPublic ?? false, resolvedWs]
    );
    wlog(`folder CREATE ✓ id=${folderId} name="${name}" workspace=${resolvedWs} owner=${req.userId} (requested=${workspaceId ?? 'none'})`);
    res.status(201).json({ folder: sanitizeFolder(result.rows[0]) });
    broadcastToUser(req.userId!, 'folders');
  } catch (err) {
    werr('folders POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/folders/:id
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, emoji, color, collapsed, position, isPublic, cascade } = req.body as {
      name?: string;
      emoji?: string;
      color?: string;
      collapsed?: boolean;
      position?: number;
      isPublic?: boolean;
      cascade?: boolean;
    };

    const existing = await query<FolderRow>('SELECT user_id, is_public, name, workspace_id FROM folders WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Folder not found' });
      return;
    }

    const folder = existing.rows[0];
    const isOwner = folder.user_id === req.userId;
    const isAdmin = req.user?.isAdmin === true;
    const canAccess = isOwner || isAdmin || folder.is_public === true;
    const wantsPrivacyChange = typeof isPublic === 'boolean';

    if (!canAccess) {
      res.status(404).json({ error: 'Folder not found' });
      return;
    }

    if (wantsPrivacyChange && !isOwner && !isAdmin) {
      res.status(403).json({ error: 'Only the owner or admin can change folder privacy' });
      return;
    }

    // Enforce the visibility hierarchy in both directions.
    let promote: Awaited<ReturnType<typeof getPrivateAncestors>> = [];
    let restrict: Awaited<ReturnType<typeof getPublicDescendants>> = [];
    if (isPublic === true) {
      // Going public: the workspace must be public too.
      const ancestors = await getPrivateAncestors(query, {
        workspaceId: folder.workspace_id, folderId: null, userId: req.userId!, isAdmin,
      });
      if (ancestors.length > 0) {
        const conflict = buildPromoteConflict('folder', folder.name, ancestors);
        if (!cascade) { res.status(409).json(conflict); return; }
        if (!conflict.canResolve) { res.status(403).json(conflict); return; }
        promote = ancestors;
      }
    } else if (isPublic === false) {
      // Going private: any public lists/timelines inside must be hidden too.
      const descendants = await getPublicDescendants(query, { type: 'folder', id });
      if (descendants.length > 0) {
        if (!cascade) { res.status(409).json(buildRestrictConflict('folder', folder.name, descendants)); return; }
        restrict = descendants;
      }
    }

    const updateSql =
      `UPDATE folders
       SET name      = COALESCE($2, name),
           emoji     = COALESCE($3, emoji),
           color     = COALESCE($4, color),
           collapsed = COALESCE($5, collapsed),
           position  = COALESCE($6, position),
           is_public = COALESCE($7, is_public)
       WHERE id = $1
       RETURNING *`;
    const updateParams = [
      id,
      name      ?? null,
      emoji     ?? null,
      color     ?? null,
      collapsed !== undefined ? collapsed : null,
      position  ?? null,
      isPublic  ?? null,
    ];

    let result;
    if (promote.length > 0 || restrict.length > 0) {
      result = await withTransaction(async (client) => {
        if (promote.length > 0) await promoteAncestors(client, promote);
        const r = await client.query<FolderRow>(updateSql, updateParams);
        if (restrict.length > 0) await restrictDescendants(client, { type: 'folder', id });
        return r;
      });
    } else {
      result = await query<FolderRow>(updateSql, updateParams);
    }

    res.json({ ok: true, folder: sanitizeFolder(result.rows[0]) });
    broadcastToUser(req.userId!, 'folders');
    if (promote.length > 0 || restrict.length > 0) { broadcastToUser(req.userId!, 'lists'); broadcastToUser(req.userId!, 'timelines'); broadcastToUser(req.userId!, 'workspaces'); }
  } catch (err) {
    werr('folders PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/folders/:id/workspace — move this folder and everything directly
// inside it (lists + their sublists, timelines) into a different workspace.
// A folder move always cascades to its contents — a folder never leaves lists
// behind, since a folder and its contents must share one workspace.
router.put('/:id/workspace', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { workspaceId, cascade } = req.body as { workspaceId?: string; cascade?: boolean };
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId is required' });
      return;
    }

    const existing = await query<FolderRow>('SELECT user_id, is_public, name, workspace_id FROM folders WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Folder not found' });
      return;
    }
    const folder = existing.rows[0];
    const isOwner = folder.user_id === req.userId;
    const isAdmin = req.user?.isAdmin === true;
    if (!isOwner && !isAdmin) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    if (folder.workspace_id === workspaceId) {
      res.json({ ok: true, folder: await getFolderForUser(req.userId!, id) });
      return;
    }

    const canAccess = await userCanAccessWorkspace(req.userId!, workspaceId);
    if (!canAccess) {
      res.status(403).json({ error: 'You do not have access to that workspace' });
      return;
    }

    const listRows = await query<{ id: string; is_public: boolean; name: string }>(
      'SELECT id, is_public, name FROM lists WHERE folder_id = $1', [id]
    );
    const timelineRows = await query<{ id: string; is_public: boolean; name: string }>(
      'SELECT id, is_public, name FROM timelines WHERE folder_id = $1', [id]
    );

    let allListIds: string[] = [];
    for (const l of listRows.rows) {
      const descendants = await collectDescendantListIdsShared(query, l.id);
      allListIds.push(l.id, ...descendants);
    }
    allListIds = Array.from(new Set(allListIds));
    const timelineIds = timelineRows.rows.map(t => t.id);

    const targetWs = await query<{ visibility: string }>('SELECT visibility FROM workspaces WHERE id = $1', [workspaceId]);
    const targetIsPrivate = targetWs.rows[0]?.visibility !== 'public';

    let forcePrivateListIds: string[] = [];
    let forcePrivateTimelineIds: string[] = [];
    let forceFolderPrivate = false;
    const conflictDescendants: ConflictDescendant[] = [];
    if (targetIsPrivate) {
      if (folder.is_public) { forceFolderPrivate = true; conflictDescendants.push({ type: 'folder', id, name: folder.name }); }
      if (allListIds.length > 0) {
        const publicLists = await query<{ id: string; name: string }>(
          `SELECT id, name FROM lists WHERE id = ANY($1::varchar[]) AND is_public = true`, [allListIds]
        );
        forcePrivateListIds = publicLists.rows.map(r => r.id);
        conflictDescendants.push(...publicLists.rows.map(r => ({ type: 'list' as const, id: r.id, name: r.name })));
      }
      const publicTimelines = timelineRows.rows.filter(t => t.is_public);
      forcePrivateTimelineIds = publicTimelines.map(t => t.id);
      conflictDescendants.push(...publicTimelines.map(t => ({ type: 'timeline' as const, id: t.id, name: t.name })));
    }

    if (conflictDescendants.length > 0) {
      const conflict = buildRestrictConflict('folder', folder.name, conflictDescendants);
      if (!cascade) { res.status(409).json(conflict); return; }
    }

    await withTransaction(async (client) => {
      if (forceFolderPrivate) {
        await client.query('UPDATE folders SET is_public = false WHERE id = $1', [id]);
      }
      if (forcePrivateListIds.length > 0) {
        await client.query('UPDATE lists SET is_public = false WHERE id = ANY($1::varchar[])', [forcePrivateListIds]);
      }
      if (forcePrivateTimelineIds.length > 0) {
        await client.query('UPDATE timelines SET is_public = false WHERE id = ANY($1::varchar[])', [forcePrivateTimelineIds]);
      }
      await client.query('UPDATE folders SET workspace_id = $1 WHERE id = $2', [workspaceId, id]);
      if (allListIds.length > 0) {
        await client.query('UPDATE lists SET workspace_id = $1 WHERE id = ANY($2::varchar[])', [workspaceId, allListIds]);
        await client.query('UPDATE tasks SET workspace_id = $1 WHERE list_id = ANY($2::varchar[])', [workspaceId, allListIds]);
      }
      if (timelineIds.length > 0) {
        await client.query('UPDATE timelines SET workspace_id = $1 WHERE id = ANY($2::varchar[])', [workspaceId, timelineIds]);
      }
    });

    wlog(`folder MOVE-WORKSPACE ✓ id=${id} (+${allListIds.length} list(s), +${timelineIds.length} timeline(s)) → workspace=${workspaceId} owner=${req.userId}`);
    res.json({ ok: true, folder: await getFolderForUser(req.userId!, id) });
    broadcastToUser(req.userId!, 'folders');
    broadcastToUser(req.userId!, 'lists');
    broadcastToUser(req.userId!, 'timelines');
    broadcastToUser(req.userId!, 'tasks');
    broadcastToUser(req.userId!, 'workspaces');
  } catch (err) {
    werr('folders PUT /workspace error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/folders/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const existing = await query<FolderRow>('SELECT * FROM folders WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Folder not found' });
      return;
    }

    const isOwner = existing.rows[0].user_id === req.userId;
    const isAdmin = req.user?.isAdmin === true;

    if (!isOwner && !isAdmin) {
      res.status(403).json({ error: 'Only the owner or admin can delete this folder' });
      return;
    }

    // Atomic: snapshot to trash, detach lists, delete folder — all or nothing.
    // (Shared helper — identical snapshot shape to the workspace cascade delete.)
    await withTransaction((client) => softDeleteFolderExec((text: string, params?: unknown[]) => client.query(text, params), id));

    wlog(`folder DELETE ✓ id=${id} → trashed by user ${req.userId}`);
    res.json({ ok: true });
    broadcastToUser(req.userId!, 'folders');
    broadcastToUser(req.userId!, 'lists');
    broadcastToUser(req.userId!, 'trash');
  } catch (err) {
    werr('folders DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
