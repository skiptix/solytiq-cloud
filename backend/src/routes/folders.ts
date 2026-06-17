import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db';
import { authenticate } from '../middleware';
import { broadcastToUser } from '../sse';
import { resolveWorkspaceForUser, wlog, werr } from '../workspaceUtil';
import { nextPosition } from '../nextPosition';
import {
  getPrivateAncestors, buildPromoteConflict, promoteAncestors,
  getPublicDescendants, buildRestrictConflict, restrictDescendants,
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

// GET /api/folders
router.get('/', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    const params: unknown[] = [req.userId];
    const wsClause = workspaceId ? `AND (f.workspace_id = $2 OR f.workspace_id IS NULL)` : '';
    if (workspaceId) params.push(workspaceId);
    const rows = await query<FolderRow>(
      `SELECT f.* FROM folders f
       LEFT JOIN workspace_members wm ON wm.workspace_id = f.workspace_id AND wm.user_id = $1
       WHERE (f.user_id = $1 OR (f.is_public = true AND (wm.user_id = $1 OR f.workspace_id IS NULL OR EXISTS (SELECT 1 FROM workspaces w WHERE w.id = f.workspace_id AND w.visibility = 'public'))))
       ${wsClause}
       ORDER BY f.position ASC, f.created_at ASC`,
      params
    );
    wlog(`folders GET user=${req.userId} workspace=${workspaceId ?? 'ALL'} → ${rows.rows.length} folder(s)`);
    res.json({ folders: rows.rows.map(sanitizeFolder) });
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
    const nextPos = await nextPosition('folders', 'user_id = $1', [req.userId]);
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

    const folderRow = existing.rows[0];

    // Snapshot the list IDs that belong to this folder
    const listsInFolder = await query<{ id: string }>(
      'SELECT id FROM lists WHERE folder_id = $1',
      [id]
    );
    const listIds = listsInFolder.rows.map(l => l.id);

    const folderData = { ...sanitizeFolder(folderRow), listIds };
    // Atomic: snapshot to trash, detach lists, delete folder — all or nothing.
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO trash_folders (folder_id, user_id, folder_data) VALUES ($1, $2, $3)`,
        [id, req.userId, JSON.stringify(folderData)]
      );
      await client.query('UPDATE lists SET folder_id = NULL WHERE folder_id = $1', [id]);
      await client.query('DELETE FROM folders WHERE id = $1', [id]);
    });

    wlog(`folder DELETE ✓ id=${id} (${listIds.length} list(s) detached) → trashed by user ${req.userId}`);
    res.json({ ok: true });
    broadcastToUser(req.userId!, 'folders');
  } catch (err) {
    werr('folders DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
