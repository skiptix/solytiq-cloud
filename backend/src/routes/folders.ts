import { Router, Request, Response } from 'express';
import { query } from '../db';
import { authenticate } from '../middleware';

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
  created_at: string;
}

function sanitizeFolder(f: FolderRow) {
  return {
    id:        f.id,
    name:      f.name,
    emoji:     f.emoji  ?? undefined,
    color:     f.color  ?? undefined,
    position:  f.position,
    collapsed: f.collapsed,
  };
}

// GET /api/folders
router.get('/', async (req: Request, res: Response) => {
  try {
    const rows = await query<FolderRow>(
      'SELECT * FROM folders WHERE user_id = $1 ORDER BY position ASC, created_at ASC',
      [req.userId]
    );
    res.json({ folders: rows.rows.map(sanitizeFolder) });
  } catch (err) {
    console.error('folders GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/folders
router.post('/', async (req: Request, res: Response) => {
  try {
    const { id, name, emoji, color } = req.body as {
      id?: string;
      name?: string;
      emoji?: string;
      color?: string;
    };
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const folderId = id ?? `folder_${Date.now()}`;
    const posRes = await query<{ max: string | null }>(
      'SELECT MAX(position) AS max FROM folders WHERE user_id = $1',
      [req.userId]
    );
    const nextPos = posRes.rows[0].max !== null ? parseInt(posRes.rows[0].max, 10) + 1 : 0;
    const result = await query<FolderRow>(
      `INSERT INTO folders (id, user_id, name, emoji, color, position)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [folderId, req.userId, name, emoji ?? null, color ?? null, nextPos]
    );
    res.status(201).json({ folder: sanitizeFolder(result.rows[0]) });
  } catch (err) {
    console.error('folders POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/folders/:id
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { name, emoji, color, collapsed, position } = req.body as {
      name?: string;
      emoji?: string;
      color?: string;
      collapsed?: boolean;
      position?: number;
    };
    await query(
      `UPDATE folders
       SET name      = COALESCE($2, name),
           emoji     = COALESCE($3, emoji),
           color     = COALESCE($4, color),
           collapsed = COALESCE($5, collapsed),
           position  = COALESCE($6, position)
       WHERE id = $1 AND user_id = $7`,
      [
        req.params.id,
        name      ?? null,
        emoji     ?? null,
        color     ?? null,
        collapsed !== undefined ? collapsed : null,
        position  ?? null,
        req.userId,
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('folders PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/folders/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await query(
      'UPDATE lists SET folder_id = NULL WHERE folder_id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    await query(
      'DELETE FROM folders WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('folders DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
