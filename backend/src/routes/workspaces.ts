import { Router, Request, Response } from 'express';
import { query, withTransaction } from '../db';
import { authenticate } from '../middleware';
import { broadcastToUser } from '../sse';
import { ensurePersonalWorkspace, wlog, werr } from '../workspaceUtil';

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

    const rows = await query<WorkspaceRow>(
      `SELECT w.*, wm.role,
              (SELECT COUNT(*) FROM workspace_members wm2 WHERE wm2.workspace_id = w.id) AS member_count
       FROM workspaces w
       LEFT JOIN workspace_members wm ON w.id = wm.workspace_id AND wm.user_id = $1
       WHERE wm.user_id = $1 OR w.visibility = 'public'
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
    const { name, description, emoji, image, visibility } = req.body as {
      name?: string; description?: string; emoji?: string | null; image?: string | null; visibility?: string;
    };

    const existing = await query<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [id]);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'Workspace not found' }); return; }
    if (existing.rows[0].owner_id !== req.userId && !req.user?.isAdmin) {
      res.status(403).json({ error: 'Only the owner can edit this workspace' }); return;
    }

    const result = await query<WorkspaceRow>(
      `UPDATE workspaces
       SET name        = COALESCE($2, name),
           description = CASE WHEN $3::boolean THEN $4 ELSE description END,
           emoji       = CASE WHEN $5::boolean THEN $6 ELSE emoji END,
           image       = CASE WHEN $7::boolean THEN $8 ELSE image END,
           visibility  = COALESCE($9, visibility)
       WHERE id = $1 RETURNING *`,
      [
        id,
        name ?? null,
        'description' in req.body, description ?? null,
        'emoji'       in req.body, emoji       ?? null,
        'image'       in req.body, image       ?? null,
        visibility ?? null,
      ]
    );
    res.json({ workspace: sanitizeWorkspace(result.rows[0]) });
    broadcastToUser(req.userId!, 'workspaces');
  } catch (err) {
    console.error('workspaces PUT error:', err);
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
    // Cascade-delete workspace contents atomically: either everything goes or
    // nothing does, so we never strand lists/tasks pointing at a dead workspace.
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM tasks   WHERE workspace_id = $1`, [id]);
      await client.query(`DELETE FROM lists   WHERE workspace_id = $1`, [id]);
      await client.query(`DELETE FROM folders WHERE workspace_id = $1`, [id]);
      await client.query(`DELETE FROM workspaces WHERE id = $1`, [id]);
    });
    wlog(`workspace ${id} deleted (with all lists/tasks/folders) by user ${req.userId}`);
    res.json({ ok: true });
    broadcastToUser(req.userId!, 'workspaces');
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

    const existing = await query<WorkspaceRow>('SELECT owner_id FROM workspaces WHERE id = $1', [id]);
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

    await query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [id, user.id]
    );
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
    const existing = await query<WorkspaceRow>('SELECT owner_id FROM workspaces WHERE id = $1', [id]);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'Workspace not found' }); return; }

    const isOwner = existing.rows[0].owner_id === req.userId;
    const isSelf  = userId === req.userId;
    if (!isOwner && !isSelf) { res.status(403).json({ error: 'Not authorized' }); return; }
    if (userId === existing.rows[0].owner_id) {
      res.status(400).json({ error: 'Cannot remove the workspace owner' }); return;
    }

    await query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [id, userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('workspace members DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
