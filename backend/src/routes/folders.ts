import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db';
import { authenticate } from '../middleware';
import { hashPassword } from '../auth';
import { broadcastToUser } from '../sse';
import { resolveWorkspaceForUser, userCanAccessWorkspace, wlog, werr } from '../workspaceUtil';
import { softDeleteFolderExec, collectDescendantListIds as collectDescendantListIdsShared } from '../trashUtil';
import {
  getPrivateAncestors, buildPromoteConflict, promoteAncestors,
  getPublicDescendants, buildRestrictConflict, restrictDescendants,
  type ConflictDescendant,
} from '../visibility';
import { decodeKeysetCursor, encodeKeysetCursor, parsePageLimit, paginateRows, type KeysetCursor } from '../pagination';

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
  share_token: string | null;
  share_enabled: boolean;
  share_password_hash: string | null;
  share_expires_at: string | null;
  share_include_all: boolean;
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
    shareEnabled:     f.share_enabled ?? false,
    shareToken:       f.share_token ?? null,
    shareHasPassword: f.share_password_hash != null,
    shareExpiresAt:   f.share_expires_at ?? null,
    shareIncludeAll:  f.share_include_all ?? false,
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

/**
 * B5: batch-hydrate MANY folders in ONE query instead of the N round-trips
 * `getFolderForUser` called in a loop would cost — used by
 * `/api/sync/delta`'s re-serialization of a batch of changed folder ids.
 * A requested id the caller can't see is simply absent from the returned Map
 * — same access boundary as `getFolderForUser`, just batched.
 */
export async function getFoldersForUserBatch(userId: string, folderIds: string[]): Promise<Map<string, ReturnType<typeof sanitizeFolder>>> {
  const map = new Map<string, ReturnType<typeof sanitizeFolder>>();
  if (folderIds.length === 0) return map;
  const r = await query<FolderRow>(
    `SELECT f.* FROM folders f
     LEFT JOIN workspace_members wm ON wm.workspace_id = f.workspace_id AND wm.user_id = $1
     WHERE f.id = ANY($2::varchar[]) AND ${FOLDER_ACCESS}`,
    [userId, folderIds]
  );
  for (const row of r.rows) map.set(row.id, sanitizeFolder(row));
  return map;
}

// B5 (Phase 2 follow-up): keyset-paginated variant of buildFoldersForUser —
// SAME access condition/filters, bounded + resumable via an opaque cursor.
// Folders are a flat row (no nested sections/tasks the way lists are), so
// this is the same simple shape as tasks.ts's/files.ts's own cursor
// pagination, no batch-hydration step needed.
export async function buildFoldersPageForUser(
  userId: string,
  workspaceId: string | undefined,
  opts: { cursor: KeysetCursor | null; limit: number }
): Promise<{ folders: ReturnType<typeof sanitizeFolder>[]; nextCursor: string | null }> {
  const params: unknown[] = [userId];
  const wsClause = workspaceId ? `AND (f.workspace_id = $2 OR f.workspace_id IS NULL)` : '';
  if (workspaceId) params.push(workspaceId);

  let cursorClause = '';
  if (opts.cursor) {
    params.push(opts.cursor.position, opts.cursor.createdAt, opts.cursor.id);
    const n = params.length;
    cursorClause = `AND (f.position, EXTRACT(EPOCH FROM f.created_at)::double precision, f.id) > ($${n - 2}, $${n - 1}::double precision, $${n})`;
  }

  params.push(opts.limit + 1);
  const limitParamIndex = params.length;

  const rows = await query<FolderRow & { created_at_epoch: number }>(
    `SELECT f.*, EXTRACT(EPOCH FROM f.created_at)::double precision AS created_at_epoch
     FROM folders f
     LEFT JOIN workspace_members wm ON wm.workspace_id = f.workspace_id AND wm.user_id = $1
     WHERE ${FOLDER_ACCESS}
     ${wsClause}
     ${cursorClause}
     ORDER BY f.position ASC, f.created_at ASC, f.id ASC
     LIMIT $${limitParamIndex}`,
    params
  );

  const { page, nextCursor } = paginateRows(rows.rows, opts.limit, (row) => ({
    position: row.position,
    createdAt: row.created_at_epoch,
    id: row.id,
  }), encodeKeysetCursor);
  return { folders: page.map(sanitizeFolder), nextCursor };
}

// GET /api/folders
// Backward-compatible: no cursor/limit → identical unbounded {folders}
// response as before. Either param → paginated {folders, nextCursor} shape.
router.get('/', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    const wantsPage = req.query.cursor !== undefined || req.query.limit !== undefined;
    if (wantsPage) {
      const cursor = decodeKeysetCursor(req.query.cursor);
      const limit = parsePageLimit(req.query.limit);
      const { folders, nextCursor } = await buildFoldersPageForUser(req.userId!, workspaceId, { cursor, limit });
      wlog(`folders GET(paged) user=${req.userId} workspace=${workspaceId ?? 'ALL'} limit=${limit} → ${folders.length} folder(s), nextCursor=${nextCursor ? 'yes' : 'no'}`);
      res.json({ folders, nextCursor });
      return;
    }
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
    // WRITE access to a folder's own metadata (name/emoji/color/position/
    // collapsed/privacy) requires ownership or admin, same as every other
    // object's write endpoint in this codebase (see canvases.ts's PUT/DELETE,
    // lists.ts's PUT/rename/etc.) — `is_public` is a READ-visibility grant to
    // workspace members ONLY (see objectPolicy.ts's header comment and
    // CLAUDE.md's "Two distinct notions of public"), never a write grant, and
    // never a grant to every signed-in instance user regardless of workspace
    // membership. The previous `|| folder.is_public === true` here let any
    // authenticated user rename/recolor/move any public folder instance-wide,
    // including one inside another user's private workspace.
    const canAccess = isOwner || isAdmin;

    if (!canAccess) {
      res.status(404).json({ error: 'Folder not found' });
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
    // Markdown pages can also live in a folder — they (and their auto-managed
    // Todo mirror lists) must ride along so the folder-vs-contents workspace
    // invariant holds.
    const markdownRows = await query<{ id: string; is_public: boolean; name: string; todo_list_id: string | null }>(
      'SELECT id, is_public, name, todo_list_id FROM markdown_lists WHERE folder_id = $1', [id]
    );

    let allListIds: string[] = [];
    for (const l of listRows.rows) {
      const descendants = await collectDescendantListIdsShared(query, l.id);
      allListIds.push(l.id, ...descendants);
    }
    allListIds = Array.from(new Set(allListIds));
    const timelineIds = timelineRows.rows.map(t => t.id);
    const markdownIds = markdownRows.rows.map(m => m.id);
    const markdownTodoListIds = markdownRows.rows.map(m => m.todo_list_id).filter((x): x is string => !!x);

    const targetWs = await query<{ visibility: string }>('SELECT visibility FROM workspaces WHERE id = $1', [workspaceId]);
    const targetIsPrivate = targetWs.rows[0]?.visibility !== 'public';

    let forcePrivateListIds: string[] = [];
    let forcePrivateTimelineIds: string[] = [];
    let forcePrivateMarkdownIds: string[] = [];
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
      // Markdown pages aren't a distinct visibility-hierarchy type, so surface
      // them as plain "list" descendants in the confirmation.
      const publicMarkdown = markdownRows.rows.filter(m => m.is_public);
      forcePrivateMarkdownIds = publicMarkdown.map(m => m.id);
      conflictDescendants.push(...publicMarkdown.map(m => ({ type: 'list' as const, id: m.id, name: m.name })));
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
      if (forcePrivateMarkdownIds.length > 0) {
        await client.query('UPDATE markdown_lists SET is_public = false WHERE id = ANY($1::varchar[])', [forcePrivateMarkdownIds]);
      }
      await client.query('UPDATE folders SET workspace_id = $1 WHERE id = $2', [workspaceId, id]);
      if (allListIds.length > 0) {
        await client.query('UPDATE lists SET workspace_id = $1 WHERE id = ANY($2::varchar[])', [workspaceId, allListIds]);
        await client.query('UPDATE tasks SET workspace_id = $1 WHERE list_id = ANY($2::varchar[])', [workspaceId, allListIds]);
      }
      if (timelineIds.length > 0) {
        await client.query('UPDATE timelines SET workspace_id = $1 WHERE id = ANY($2::varchar[])', [workspaceId, timelineIds]);
      }
      if (markdownIds.length > 0) {
        await client.query('UPDATE markdown_lists SET workspace_id = $1 WHERE id = ANY($2::varchar[])', [workspaceId, markdownIds]);
      }
      // The markdown pages' auto-managed Todo mirror lists (and their tasks)
      // aren't in the folder themselves, so move them by id explicitly.
      if (markdownTodoListIds.length > 0) {
        await client.query('UPDATE lists SET workspace_id = $1 WHERE id = ANY($2::varchar[])', [workspaceId, markdownTodoListIds]);
        await client.query('UPDATE tasks SET workspace_id = $1 WHERE list_id = ANY($2::varchar[])', [workspaceId, markdownTodoListIds]);
      }
    });

    wlog(`folder MOVE-WORKSPACE ✓ id=${id} (+${allListIds.length} list(s), +${timelineIds.length} timeline(s), +${markdownIds.length} markdown page(s)) → workspace=${workspaceId} owner=${req.userId}`);
    res.json({ ok: true, folder: await getFolderForUser(req.userId!, id) });
    broadcastToUser(req.userId!, 'folders');
    broadcastToUser(req.userId!, 'lists');
    broadcastToUser(req.userId!, 'timelines');
    broadcastToUser(req.userId!, 'markdownLists');
    broadcastToUser(req.userId!, 'tasks');
    broadcastToUser(req.userId!, 'workspaces');
  } catch (err) {
    werr('folders PUT /workspace error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/folders/:id/share — manage the public "navigator" share link.
// Body: { enabled?, password?: string|null, expiresAt?: string|null, includeAll? }
//  - password/expiresAt: omit = unchanged, null = clear, value = set.
//  - includeAll: the dialog choice. When true AND the link is enabled, sharing
//    cascades to every list/timeline/markdown page in the folder — each gets its
//    own live share link (token minted where missing) inheriting the folder's
//    password + expiry, so one password unlocks the whole set. When false, only
//    items the owner already shared individually surface in the navigator.
router.put('/:id/share', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { enabled, password, expiresAt, includeAll } = req.body as {
      enabled?: boolean; password?: string | null; expiresAt?: string | null; includeAll?: boolean;
    };

    const existing = await query<FolderRow>('SELECT * FROM folders WHERE id = $1', [id]);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'Folder not found' }); return; }
    const row = existing.rows[0];
    const isOwner = row.user_id === req.userId;
    const isAdmin = req.user?.isAdmin === true;
    if (!isOwner && !isAdmin) { res.status(403).json({ error: 'Permission denied' }); return; }

    const updatePw = 'password' in req.body;
    const updateExp = 'expiresAt' in req.body;
    const updateEnabled = 'enabled' in req.body;
    const updateIncludeAll = 'includeAll' in req.body;

    const willBeEnabled = updateEnabled ? Boolean(enabled) : row.share_enabled;
    let token = row.share_token;
    if (willBeEnabled && !token) token = randomBytes(24).toString('hex');

    let pwHash: string | null = null;
    if (updatePw && typeof password === 'string' && password.length > 0) {
      pwHash = await hashPassword(password);
    }

    const result = await query<FolderRow>(
      `UPDATE folders
       SET share_enabled       = COALESCE($2, share_enabled),
           share_token         = $3,
           share_password_hash = CASE WHEN $4 THEN $5 ELSE share_password_hash END,
           share_expires_at    = CASE WHEN $6 THEN $7 ELSE share_expires_at END,
           share_include_all   = COALESCE($8, share_include_all)
       WHERE id = $1
       RETURNING *`,
      [id, updateEnabled ? enabled : null, token, updatePw, pwHash, updateExp, expiresAt ?? null, updateIncludeAll ? includeAll : null]
    );
    const saved = result.rows[0];

    // Cascade: when "share all" is on and the folder link is live, publish every
    // item in the folder with the folder's own password + expiry so the navigator
    // links all resolve. Turning "share all" off does NOT auto-unshare items — a
    // page the owner shared stays shared; they can revoke each one individually.
    if (saved.share_enabled && saved.share_include_all) {
      const cascade = async (table: 'lists' | 'timelines' | 'markdown_lists') => {
        const missing = await query<{ id: string }>(
          `SELECT id FROM ${table} WHERE folder_id = $1 AND (share_token IS NULL)`, [id]
        );
        for (const r of missing.rows) {
          await query(`UPDATE ${table} SET share_token = $2 WHERE id = $1 AND share_token IS NULL`, [r.id, randomBytes(24).toString('hex')]);
        }
        await query(
          `UPDATE ${table}
           SET share_enabled = true,
               share_password_hash = $2,
               share_expires_at = $3
           WHERE folder_id = $1`,
          [id, saved.share_password_hash, saved.share_expires_at]
        );
      };
      await cascade('lists');
      await cascade('timelines');
      await cascade('markdown_lists');
    }

    res.json({
      share: {
        enabled: saved.share_enabled,
        token: saved.share_token,
        hasPassword: saved.share_password_hash != null,
        expiresAt: saved.share_expires_at ?? null,
        includeAll: saved.share_include_all,
      },
    });
    broadcastToUser(req.userId!, 'folders');
    if (saved.share_enabled && saved.share_include_all) {
      broadcastToUser(req.userId!, 'lists');
      broadcastToUser(req.userId!, 'timelines');
      broadcastToUser(req.userId!, 'markdownLists');
    }
  } catch (err) {
    werr('folders PUT /share error:', err);
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
