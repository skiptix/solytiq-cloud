// ---------------------------------------------------------------------------
// /api/canvases — curated, editable graph layouts (React Flow canvas mode).
// `layout` stores positions/groups/notes only; edges always come from
// entity_links (POST /api/links) — see CLAUDE.md's Graph Layer section.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db';
import { authenticate } from '../middleware';
import { userCanAccessWorkspace, werr } from '../workspaceUtil';

const router = Router();
router.use(authenticate);

interface CanvasRow {
  id: string; workspace_id: string; user_id: string; name: string; emoji: string | null;
  layout: unknown; is_public: boolean; version: number; created_at: string; updated_at: string;
}
function toJson(row: CanvasRow) {
  return {
    id: row.id, workspaceId: row.workspace_id, userId: row.user_id, name: row.name, emoji: row.emoji,
    layout: row.layout, isPublic: row.is_public, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// GET /api/canvases?workspaceId=
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
    if (!workspaceId) { res.status(400).json({ error: 'workspaceId is required' }); return; }
    if (!(await userCanAccessWorkspace(userId, workspaceId))) { res.status(403).json({ error: 'Forbidden' }); return; }
    const r = await query<CanvasRow>(
      `SELECT * FROM graph_canvases WHERE workspace_id = $1 AND (is_public = true OR user_id = $2) ORDER BY updated_at DESC`,
      [workspaceId, userId]
    );
    res.json({ canvases: r.rows.map(toJson) });
  } catch (err) {
    werr('canvases GET / error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/canvases/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const r = await query<CanvasRow>(`SELECT * FROM graph_canvases WHERE id = $1`, [req.params.id]);
    const row = r.rows[0];
    if (!row) { res.status(404).json({ error: 'Canvas not found' }); return; }
    if (!row.is_public && row.user_id !== userId && !(await userCanAccessWorkspace(userId, row.workspace_id))) {
      res.status(404).json({ error: 'Canvas not found' });
      return;
    }
    res.json({ canvas: toJson(row) });
  } catch (err) {
    werr('canvases GET /:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/canvases
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const body = req.body as { workspaceId?: string; name?: string; emoji?: string };
    if (!body.workspaceId || !body.name?.trim()) { res.status(400).json({ error: 'workspaceId and name are required' }); return; }
    if (!(await userCanAccessWorkspace(userId, body.workspaceId))) { res.status(403).json({ error: 'Forbidden' }); return; }

    const id = `canvas_${uuidv4()}`;
    const r = await query<CanvasRow>(
      `INSERT INTO graph_canvases (id, workspace_id, user_id, name, emoji) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, body.workspaceId, userId, body.name.trim(), body.emoji ?? null]
    );
    res.status(201).json({ canvas: toJson(r.rows[0]) });
  } catch (err) {
    werr('canvases POST / error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/canvases/:id — owner or admin only; optimistic concurrency via `version`
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const isAdmin = req.user?.isAdmin === true;
    const existing = await query<CanvasRow>(`SELECT * FROM graph_canvases WHERE id = $1`, [req.params.id]);
    const row = existing.rows[0];
    if (!row) { res.status(404).json({ error: 'Canvas not found' }); return; }
    if (row.user_id !== userId && !isAdmin) { res.status(403).json({ error: 'Only the canvas owner can edit it' }); return; }

    const body = req.body as { name?: string; emoji?: string; layout?: unknown; isPublic?: boolean; version: number };
    if (typeof body.version !== 'number') { res.status(400).json({ error: 'version is required' }); return; }
    if (body.version !== row.version) {
      res.status(409).json({ error: 'This canvas was changed elsewhere — reload and retry.', currentVersion: row.version });
      return;
    }

    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    if (body.name !== undefined) { params.push(body.name); sets.push(`name = $${params.length}`); }
    if (body.emoji !== undefined) { params.push(body.emoji); sets.push(`emoji = $${params.length}`); }
    if (body.layout !== undefined) { params.push(JSON.stringify(body.layout)); sets.push(`layout = $${params.length}`); }
    if (body.isPublic !== undefined) { params.push(body.isPublic); sets.push(`is_public = $${params.length}`); }
    params.push(req.params.id);
    const r = await query<CanvasRow>(
      `UPDATE graph_canvases SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    res.json({ canvas: toJson(r.rows[0]) });
  } catch (err) {
    werr('canvases PUT /:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/canvases/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const isAdmin = req.user?.isAdmin === true;
    const existing = await query<CanvasRow>(`SELECT user_id FROM graph_canvases WHERE id = $1`, [req.params.id]);
    const row = existing.rows[0];
    if (!row) { res.status(404).json({ error: 'Canvas not found' }); return; }
    if (row.user_id !== userId && !isAdmin) { res.status(403).json({ error: 'Only the canvas owner can delete it' }); return; }
    await query(`DELETE FROM graph_canvases WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) {
    werr('canvases DELETE /:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
