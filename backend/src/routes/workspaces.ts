import { Router, Request, Response } from 'express';
import { query, withTransaction } from '../db';
import { authenticate } from '../middleware';
import { broadcastToUser } from '../sse';
import { ensureOwnedWorkspaceMemberships, ensurePersonalWorkspace, rehomeUserContentToPersonal, wlog, werr } from '../workspaceUtil';
import { createNotification } from '../notifications';
import { snapshotListToTrash, snapshotTimelineToTrash, snapshotFolderToTrash } from '../trashUtil';
import { getPublicDescendants, buildRestrictConflict, restrictDescendants } from '../visibility';

const router = Router();
router.use(authenticate);

interface WorkspaceRow {
  id: string;
  name: string;
  description: string | null;
  emoji: string | null;
  image: string | null;
  visibility: string;
  owner_id: string;
  created_at: string;
  role?: string;
  member_count?: string;
  agent_mode?: string;
  agent_policy?: unknown;
}

function sanitizeWorkspace(w: WorkspaceRow) {
  return {
    id:          w.id,
    name:        w.name,
    description: w.description ?? undefined,
    emoji:       w.emoji       ?? undefined,
    image:       w.image       ?? undefined,
    visibility:  w.visibility  as 'private' | 'public',
    ownerId:     w.owner_id,
    role:        (w.role ?? 'member') as 'owner' | 'member',
    createdAt:   w.created_at,
    memberCount: w.member_count !== undefined ? parseInt(w.member_count, 10) : undefined,
    agentMode:   (w.agent_mode ?? 'off') as 'off' | 'suggest' | 'assisted' | 'autonomous',
    agentPolicy: w.agent_policy ?? {},
  };
}

// GET /api/workspaces
router.get('/', async (req: Request, res: Response) => {
  try {
    // Self-heal: guarantee the caller always has a Personal workspace, even if
    // they were registered/created after the startup seed ran. This is the
    // fix for lists/items "disappearing" — without an owned workspace the
    // frontend had no stable context to load items into.
    const personalWsId = await ensurePersonalWorkspace(query, req.userId!);
    await ensureOwnedWorkspaceMemberships(query, req.userId!);

    const rows = await query<WorkspaceRow>(
      `SELECT w.*, wm.role,
              (SELECT COUNT(*) FROM workspace_members wm2 WHERE wm2.workspace_id = w.id) AS member_count
       FROM workspaces w
       LEFT JOIN workspace_members wm ON w.id = wm.workspace_id AND wm.user_id = $1
       WHERE wm.user_id = $1 OR w.owner_id = $1 OR w.visibility = 'public'
       ORDER BY w.created_at ASC`,
      [req.userId]
    );
    wlog(`workspaces GET user=${req.userId} → ${rows.rows.length} workspace(s), personal=${personalWsId}`);
    res.json({ workspaces: rows.rows.map(sanitizeWorkspace) });
  } catch (err) {
    werr('workspaces GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/workspaces
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, description, emoji, image, visibility } = req.body as {
      name?: string; description?: string; emoji?: string; image?: string; visibility?: string;
    };
    if (!name?.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const id = `ws_${Date.now()}`;
    const result = await query<WorkspaceRow>(
      `INSERT INTO workspaces (id, name, description, emoji, image, visibility, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, name.trim(), description ?? null, emoji ?? null, image ?? null, visibility ?? 'private', req.userId]
    );
    await query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [id, req.userId]
    );
    res.status(201).json({ workspace: { ...sanitizeWorkspace(result.rows[0]), role: 'owner' } });
    broadcastToUser(req.userId!, 'workspaces');
  } catch (err) {
    console.error('workspaces POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/workspaces/:id
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, emoji, image, visibility, cascade } = req.body as {
      name?: string; description?: string; emoji?: string | null; image?: string | null; visibility?: string; cascade?: boolean;
    };

    const existing = await query<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [id]);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'Workspace not found' }); return; }
    if (existing.rows[0].owner_id !== req.userId && !req.user?.isAdmin) {
      res.status(403).json({ error: 'Only the owner can edit this workspace' }); return;
    }

    // Going private: any public folders/lists/timelines inside must be hidden
    // too. Warn (409) with the affected items unless the client cascades.
    const goingPrivate = visibility === 'private' && existing.rows[0].visibility !== 'private';
    let restrict: Awaited<ReturnType<typeof getPublicDescendants>> = [];
    if (goingPrivate) {
      const descendants = await getPublicDescendants(query, { type: 'workspace', id });
      if (descendants.length > 0) {
        if (!cascade) { res.status(409).json(buildRestrictConflict('workspace', existing.rows[0].name, descendants)); return; }
        restrict = descendants;
      }
    }

    // Going private also cuts off non-member contributors (a public workspace
    // accepts content from any user). Their own items must follow them home,
    // or they'd be stranded in a workspace those users can no longer open.
    let strandedUserIds: string[] = [];
    if (goingPrivate) {
      const stranded = await query<{ user_id: string }>(
        `SELECT DISTINCT user_id FROM (
           SELECT user_id FROM lists     WHERE workspace_id = $1
           UNION SELECT user_id FROM timelines WHERE workspace_id = $1
           UNION SELECT user_id FROM folders   WHERE workspace_id = $1
           UNION SELECT user_id FROM tasks     WHERE workspace_id = $1
         ) c
         WHERE c.user_id <> $2
           AND NOT EXISTS (
             SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = $1 AND wm.user_id = c.user_id
           )`,
        [id, existing.rows[0].owner_id]
      );
      strandedUserIds = stranded.rows.map((r) => r.user_id);
    }

    const updateSql =
      `UPDATE workspaces
       SET name        = COALESCE($2, name),
           description = CASE WHEN $3::boolean THEN $4 ELSE description END,
           emoji       = CASE WHEN $5::boolean THEN $6 ELSE emoji END,
           image       = CASE WHEN $7::boolean THEN $8 ELSE image END,
           visibility  = COALESCE($9, visibility)
       WHERE id = $1 RETURNING *`;
    const updateParams = [
      id,
      name ?? null,
      'description' in req.body, description ?? null,
      'emoji'       in req.body, emoji       ?? null,
      'image'       in req.body, image       ?? null,
      visibility ?? null,
    ];

    let result;
    if (restrict.length > 0 || strandedUserIds.length > 0) {
      result = await withTransaction(async (client) => {
        const r = await client.query<WorkspaceRow>(updateSql, updateParams);
        if (restrict.length > 0) {
          await restrictDescendants(client, { type: 'workspace', id });
        }
        const exec = (text: string, params?: unknown[]) => client.query(text, params);
        for (const strandedId of strandedUserIds) {
          await rehomeUserContentToPersonal(exec, strandedId, id);
        }
        return r;
      });
    } else {
      result = await query<WorkspaceRow>(updateSql, updateParams);
    }
    res.json({ workspace: sanitizeWorkspace(result.rows[0]) });
    broadcastToUser(req.userId!, 'workspaces');
    if (restrict.length > 0) { broadcastToUser(req.userId!, 'folders'); broadcastToUser(req.userId!, 'lists'); broadcastToUser(req.userId!, 'timelines'); }
    if (strandedUserIds.length > 0) {
      // The stranded users' content just left this workspace — they AND the
      // remaining members all see a different workspace now.
      const members = await query<{ user_id: string }>(
        `SELECT user_id FROM workspace_members WHERE workspace_id = $1`, [id]
      );
      const notify = new Set<string>([...strandedUserIds, ...members.rows.map((m) => m.user_id)]);
      for (const uid of notify) {
        broadcastToUser(uid, 'workspaces');
        broadcastToUser(uid, 'lists');
        broadcastToUser(uid, 'timelines');
        broadcastToUser(uid, 'folders');
        broadcastToUser(uid, 'tasks');
      }
    }
  } catch (err) {
    console.error('workspaces PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/workspaces/:id/agent — Agent Runtime autonomy settings. Owner/admin
// only, same bar as PUT /:id: this hands an AI agent write access to the
// workspace's own data, so it isn't a plain-member setting.
router.patch('/:id/agent', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { agentMode, agentPolicy } = req.body as { agentMode?: string; agentPolicy?: Record<string, unknown> };
    const existing = await query<WorkspaceRow>('SELECT owner_id FROM workspaces WHERE id = $1', [id]);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'Workspace not found' }); return; }
    if (existing.rows[0].owner_id !== req.userId && !req.user?.isAdmin) {
      res.status(403).json({ error: 'Only the owner can change agent settings' }); return;
    }
    if (agentMode !== undefined && !['off', 'suggest', 'assisted', 'autonomous'].includes(agentMode)) {
      res.status(400).json({ error: 'agentMode must be off, suggest, assisted, or autonomous' }); return;
    }
    const r = await query<{ agent_mode: string; agent_policy: unknown }>(
      `UPDATE workspaces
       SET agent_mode = COALESCE($1, agent_mode),
           agent_policy = CASE WHEN $2::boolean THEN $3::jsonb ELSE agent_policy END
       WHERE id = $4
       RETURNING agent_mode, agent_policy`,
      [agentMode ?? null, agentPolicy !== undefined, JSON.stringify(agentPolicy ?? {}), id]
    );
    res.json({ agentMode: r.rows[0].agent_mode, agentPolicy: r.rows[0].agent_policy });
  } catch (err) {
    console.error('workspaces PATCH /:id/agent error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/workspaces/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const existing = await query<WorkspaceRow>('SELECT owner_id FROM workspaces WHERE id = $1', [id]);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'Workspace not found' }); return; }
    if (existing.rows[0].owner_id !== req.userId && !req.user?.isAdmin) {
      res.status(403).json({ error: 'Only the owner can delete this workspace' }); return;
    }

    // Everyone whose data/view is affected gets notified afterwards — members
    // AND non-member contributors (a public workspace accepts content from any
    // user; their items land in their own trash and they must hear about it).
    const memberRows = await query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1
       UNION
       SELECT user_id FROM (
         SELECT user_id FROM lists     WHERE workspace_id = $1
         UNION SELECT user_id FROM timelines WHERE workspace_id = $1
         UNION SELECT user_id FROM folders   WHERE workspace_id = $1
         UNION SELECT user_id FROM tasks     WHERE workspace_id = $1
       ) contributors`,
      [id]
    );

    // Cascade-delete workspace contents atomically: either everything goes or
    // nothing does, so we never strand lists/tasks/timelines pointing at a dead
    // workspace. Every list, timeline, and folder is snapshotted into its
    // OWNER's trash first — deleting a workspace is a soft delete for its
    // contents, same as deleting the items one by one. (Timelines used to be
    // skipped entirely here: the FK set their workspace_id to NULL, leaking
    // them into every workspace view until a restart healed them into an
    // arbitrary one.)
    const counts = await withTransaction(async (client) => {
      const exec = (text: string, params?: unknown[]) => client.query(text, params);

      const listIds = (await client.query<{ id: string }>(
        `SELECT id FROM lists WHERE workspace_id = $1`, [id]
      )).rows.map((r) => r.id);
      const timelineIds = (await client.query<{ id: string }>(
        `SELECT id FROM timelines WHERE workspace_id = $1`, [id]
      )).rows.map((r) => r.id);
      const folderIds = (await client.query<{ id: string }>(
        `SELECT id FROM folders WHERE workspace_id = $1`, [id]
      )).rows.map((r) => r.id);

      for (const listId of listIds) await snapshotListToTrash(exec, listId);
      for (const timelineId of timelineIds) await snapshotTimelineToTrash(exec, timelineId);
      for (const folderId of folderIds) await snapshotFolderToTrash(exec, folderId);

      await client.query(
        `DELETE FROM milestones WHERE timeline_id IN (SELECT id FROM timelines WHERE workspace_id = $1)`,
        [id]
      );
      await client.query(`DELETE FROM tasks WHERE workspace_id = $1`, [id]);
      // Legacy rows whose workspace_id drifted from their list's must go too.
      await client.query(
        `DELETE FROM tasks WHERE list_id IN (SELECT id FROM lists WHERE workspace_id = $1)`,
        [id]
      );
      await client.query(`DELETE FROM timelines WHERE workspace_id = $1`, [id]);
      await client.query(`DELETE FROM lists     WHERE workspace_id = $1`, [id]);
      await client.query(`DELETE FROM folders   WHERE workspace_id = $1`, [id]);
      await client.query(`DELETE FROM workspaces WHERE id = $1`, [id]);

      return { lists: listIds.length, timelines: timelineIds.length, folders: folderIds.length };
    });

    wlog(
      `workspace ${id} deleted by user ${req.userId} — trashed ${counts.lists} list(s), ` +
      `${counts.timelines} timeline(s), ${counts.folders} folder(s)`
    );
    res.json({ ok: true });

    const affected = new Set<string>([req.userId!, ...memberRows.rows.map((m) => m.user_id)]);
    for (const uid of affected) {
      broadcastToUser(uid, 'workspaces');
      broadcastToUser(uid, 'lists');
      broadcastToUser(uid, 'timelines');
      broadcastToUser(uid, 'folders');
      broadcastToUser(uid, 'trash');
    }
  } catch (err) {
    werr('workspaces DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/workspaces/:id/members
router.get('/:id/members', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const access = await query(
      `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2
       UNION SELECT 1 FROM workspaces WHERE id = $1 AND owner_id = $2
       UNION SELECT 1 FROM workspaces WHERE id = $1 AND visibility = 'public'`,
      [id, req.userId]
    );
    if (access.rows.length === 0) { res.status(404).json({ error: 'Workspace not found' }); return; }

    const members = await query<{ user_id: string; username: string; full_name: string | null; profile_image: string | null; role: string }>(
      `SELECT u.id AS user_id, u.username, u.full_name, u.profile_image, wm.role
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = $1 ORDER BY wm.joined_at ASC`,
      [id]
    );
    res.json({
      members: members.rows.map((m: { user_id: string; username: string; full_name: string | null; profile_image: string | null; role: string }) => ({
        userId:       m.user_id,
        username:     m.username,
        fullName:     m.full_name     ?? undefined,
        profileImage: m.profile_image ?? undefined,
        role:         m.role,
      }))
    });
  } catch (err) {
    console.error('workspace members GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/workspaces/:id/members
router.post('/:id/members', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { username } = req.body as { username?: string };
    if (!username) { res.status(400).json({ error: 'username is required' }); return; }

    const existing = await query<WorkspaceRow>('SELECT owner_id, name FROM workspaces WHERE id = $1', [id]);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'Workspace not found' }); return; }
    if (existing.rows[0].owner_id !== req.userId) {
      res.status(403).json({ error: 'Only the owner can add members' }); return;
    }

    const userResult = await query<{ id: string; username: string; full_name: string | null; profile_image: string | null }>(
      'SELECT id, username, full_name, profile_image FROM users WHERE username = $1',
      [username]
    );
    if (userResult.rows.length === 0) { res.status(404).json({ error: 'User not found' }); return; }
    const user = userResult.rows[0];

    const added = await query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [id, user.id]
    );
    // Notify the added user — only on a genuinely new membership, not a re-add.
    if ((added.rowCount ?? 0) > 0) {
      await createNotification({
        userId: user.id,
        type: 'workspace_added',
        actorId: req.userId!,
        title: `added you to "${existing.rows[0].name}"`,
        body: null,
        entityType: 'workspace',
        entityId: id,
        workspaceId: id,
        data: { workspaceName: existing.rows[0].name },
      });
    }
    res.status(201).json({
      member: {
        userId:       user.id,
        username:     user.username,
        fullName:     user.full_name     ?? undefined,
        profileImage: user.profile_image ?? undefined,
        role:         'member',
      }
    });
    broadcastToUser(user.id, 'workspaces');
  } catch (err) {
    console.error('workspace members POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/workspaces/:id/members/:userId
router.delete('/:id/members/:userId', async (req: Request, res: Response) => {
  try {
    const { id, userId } = req.params;
    const existing = await query<WorkspaceRow>('SELECT owner_id, visibility FROM workspaces WHERE id = $1', [id]);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'Workspace not found' }); return; }

    const isOwner = existing.rows[0].owner_id === req.userId;
    const isSelf  = userId === req.userId;
    if (!isOwner && !isSelf) { res.status(403).json({ error: 'Not authorized' }); return; }
    if (userId === existing.rows[0].owner_id) {
      res.status(400).json({ error: 'Cannot remove the workspace owner' }); return;
    }

    // The removed member keeps their own content: move it to their Personal
    // workspace atomically with the removal. Leaving it behind in a workspace
    // they can no longer open would strand it (invisible everywhere, not in
    // trash, yet still visible to the user-scoped AI tools).
    const wsStillVisibleToUser = existing.rows[0].visibility === 'public';
    const remainingMembers = await query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND user_id <> $2`,
      [id, userId]
    );
    await withTransaction(async (client) => {
      const exec = (text: string, params?: unknown[]) => client.query(text, params);
      if (!wsStillVisibleToUser) {
        await rehomeUserContentToPersonal(exec, userId, id);
      }
      await client.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [id, userId]);
    });
    res.json({ ok: true });

    // Notify the removed member AND the remaining members — the member's
    // shared content just left this workspace, so everyone's view changed.
    const notify = new Set<string>([userId, ...remainingMembers.rows.map((m) => m.user_id)]);
    for (const uid of notify) {
      broadcastToUser(uid, 'workspaces');
      broadcastToUser(uid, 'lists');
      broadcastToUser(uid, 'timelines');
      broadcastToUser(uid, 'folders');
      broadcastToUser(uid, 'tasks');
    }
  } catch (err) {
    console.error('workspace members DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
