import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
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
  is_public: boolean;
  created_at: string;
}

function sanitizeFolder(f: FolderRow) {
  return {
    id:        f.id,
    userId:    f.user_id,
    name:      f.name,
    emoji:     f.emoji  ?? undefined,
    color:     f.color  ?? undefined,
    position:  f.position,
    collapsed: f.collapsed,
    isPublic:  f.is_public,
  };
}

// GET /api/folders
router.get('/', async (req: Request, res: Response) => {
  try {
    const rows = await query<FolderRow>(
      'SELECT * FROM folders WHERE user_id = $1 OR is_public = true ORDER BY position ASC, created_at ASC',
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
    const { id, name, emoji, color, isPublic } = req.body as {
      id?: string;
      name?: string;
      emoji?: string;
      color?: string;
      isPublic?: boolean;
    };
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const folderId = id ?? `folder_${uuidv4()}`;
    const posRes = await query<{ max: string | null }>(
      'SELECT MAX(position) AS max FROM folders'
    );
    const nextPos = posRes.rows[0].max !== null ? parseInt(posRes.rows[0].max, 10) + 1 : 0;
    const result = await query<FolderRow>(
      `INSERT INTO folders (id, user_id, name, emoji, color, position, is_public)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [folderId, req.userId, name, emoji ?? null, color ?? null, nextPos, isPublic ?? true]
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
    const { id } = req.params;
    const { name, emoji, color, collapsed, position, isPublic } = req.body as {
      name?: string;
      emoji?: string;
      color?: string;
      collapsed?: boolean;
      position?: number;
      isPublic?: boolean;
    };

    const existing = await query<FolderRow>('SELECT user_id, is_public FROM folders WHERE id = $1', [id]);
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

    const result = await query<FolderRow>(
      `UPDATE folders
       SET name      = COALESCE($2, name),
           emoji     = COALESCE($3, emoji),
           color     = COALESCE($4, color),
           collapsed = COALESCE($5, collapsed),
           position  = COALESCE($6, position),
           is_public = COALESCE($7, is_public)
       WHERE id = $1
       RETURNING *`,
      [
        id,
        name      ?? null,
        emoji     ?? null,
        color     ?? null,
        collapsed !== undefined ? collapsed : null,
        position  ?? null,
        isPublic  ?? null,
      ]
    );
    res.json({ ok: true, folder: sanitizeFolder(result.rows[0]) });
  } catch (err) {
    console.error('folders PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/folders/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const existing = await query<FolderRow>('SELECT user_id FROM folders WHERE id = $1', [id]);
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

    await query(
      'UPDATE lists SET folder_id = NULL WHERE folder_id = $1',
      [id]
    );
    await query(
      'DELETE FROM folders WHERE id = $1',
      [id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('folders DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
