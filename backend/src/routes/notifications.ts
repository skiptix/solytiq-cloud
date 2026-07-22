// ---------------------------------------------------------------------------
// /api/notifications — the read/manage side of the user notification system.
//
//   GET    /api/notifications?limit&before  → recent notifications + unreadCount
//   GET    /api/notifications/unread-count   → just the badge number (cheap)
//   POST   /api/notifications/:id/read       → mark one read
//   POST   /api/notifications/read-all       → mark every unread read
//   DELETE /api/notifications/:id            → dismiss one
//   DELETE /api/notifications                → clear all
//
// Every row is hard-scoped to the verified req.userId — a notification only
// ever belongs to exactly one recipient, so there is no cross-user read path.
// Actor identity is joined in read-only (username/fullName/hasImage), matching
// what /members/basic already exposes to any authenticated user.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from 'express';
import { query } from '../db';
import { authenticate } from '../middleware';
import { werr } from '../workspaceUtil';

const router = Router();
router.use(authenticate);

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 30;

interface NotificationRow {
  id: string;
  type: string;
  actor_id: string | null;
  actor_username: string | null;
  actor_full_name: string | null;
  actor_has_image: boolean | null;
  title: string;
  body: string | null;
  entity_type: string | null;
  entity_id: string | null;
  workspace_id: string | null;
  data: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

function sanitize(row: NotificationRow) {
  return {
    id:          row.id,
    type:        row.type,
    actorId:     row.actor_id,
    actor: row.actor_id
      ? {
          id:       row.actor_id,
          username: row.actor_username,
          fullName: row.actor_full_name,
          hasImage: row.actor_has_image ?? false,
        }
      : null,
    title:       row.title,
    body:        row.body,
    entityType:  row.entity_type,
    entityId:    row.entity_id,
    workspaceId: row.workspace_id,
    data:        row.data ?? {},
    read:        row.read_at != null,
    createdAt:   row.created_at,
  };
}

const SELECT_COLS = `
  n.id, n.type, n.actor_id,
  au.username   AS actor_username,
  au.full_name  AS actor_full_name,
  (au.profile_image IS NOT NULL) AS actor_has_image,
  n.title, n.body, n.entity_type, n.entity_id, n.workspace_id, n.data, n.read_at, n.created_at
`;

// GET /api/notifications
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
    const before = typeof req.query.before === 'string' ? req.query.before : null;

    const params: unknown[] = [req.userId];
    let cursor = '';
    if (before) {
      params.push(before);
      cursor = `AND n.created_at < $${params.length}`;
    }
    params.push(limit);

    const rows = await query<NotificationRow>(
      `SELECT ${SELECT_COLS}
         FROM notifications n
         LEFT JOIN users au ON au.id = n.actor_id
        WHERE n.user_id = $1 ${cursor}
        ORDER BY n.created_at DESC
        LIMIT $${params.length}`,
      params
    );

    const unread = await query<{ c: string }>(
      `SELECT COUNT(*)::int AS c FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
      [req.userId]
    );

    res.json({
      notifications: rows.rows.map(sanitize),
      unreadCount: Number(unread.rows[0]?.c ?? 0),
      hasMore: rows.rows.length === limit,
    });
  } catch (err) {
    werr('notifications GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/notifications/unread-count
router.get('/unread-count', async (req: Request, res: Response) => {
  try {
    const unread = await query<{ c: string }>(
      `SELECT COUNT(*)::int AS c FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
      [req.userId]
    );
    res.json({ unreadCount: Number(unread.rows[0]?.c ?? 0) });
  } catch (err) {
    werr('notifications unread-count error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/notifications/read-all  (must precede /:id/read pattern-wise it's fine, but keep explicit)
router.post('/read-all', async (req: Request, res: Response) => {
  try {
    await query(
      `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
      [req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    werr('notifications read-all error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/notifications/:id/read
router.post('/:id/read', async (req: Request, res: Response) => {
  try {
    const result = await query(
      `UPDATE notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (result.rowCount === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ ok: true });
  } catch (err) {
    werr('notifications read error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/notifications  — clear all for this user
router.delete('/', async (req: Request, res: Response) => {
  try {
    await query(`DELETE FROM notifications WHERE user_id = $1`, [req.userId]);
    res.json({ ok: true });
  } catch (err) {
    werr('notifications clear-all error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/notifications/:id  — dismiss one
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const result = await query(`DELETE FROM notifications WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
    if (result.rowCount === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ ok: true });
  } catch (err) {
    werr('notifications delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
