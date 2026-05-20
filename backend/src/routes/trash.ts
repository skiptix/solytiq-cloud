import { Router, Request, Response } from 'express';
import { query } from '../db';
import { authenticate } from '../middleware';

const router = Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface TrashRow {
  id: number;
  task_id: string;
  user_id: string;
  task_data: Record<string, unknown>;
  meta: Record<string, unknown> | null;
  deleted_at: string;
  expires_at: string;
}

interface TaskRow {
  id: string;
  user_id: string;
  title: string;
  note: string | null;
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
}

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------

function sanitizeTrash(row: TrashRow) {
  return {
    id:        row.id,
    taskId:    row.task_id,
    userId:    row.user_id,
    taskData:  row.task_data,
    meta:      row.meta,
    deletedAt: row.deleted_at,
    expiresAt: row.expires_at,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /api/trash
router.get('/', async (req: Request, res: Response) => {
  try {
    const result = await query<TrashRow>(
      `SELECT * FROM trash
       WHERE user_id = $1 AND expires_at > NOW()
       ORDER BY deleted_at DESC`,
      [req.userId]
    );
    res.json({ trash: result.rows.map(sanitizeTrash) });
  } catch (err) {
    console.error('trash GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/trash/add  — move a task into the trash table and remove from tasks
router.post('/add', async (req: Request, res: Response) => {
  try {
    const { taskId, taskData, meta } = req.body as {
      taskId?: string | number;
      taskData?: Record<string, unknown>;
      meta?: Record<string, unknown>;
    };

    if (taskId === undefined || taskId === null) {
      res.status(400).json({ error: 'taskId is required' });
      return;
    }
    if (!taskData || typeof taskData !== 'object') {
      res.status(400).json({ error: 'taskData is required' });
      return;
    }

    // Insert into trash
    const result = await query<TrashRow>(
      `INSERT INTO trash (task_id, user_id, task_data, meta)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [taskId, req.userId, JSON.stringify(taskData), meta ? JSON.stringify(meta) : null]
    );

    // Remove from tasks (best-effort — task may already be deleted)
    await query(
      'DELETE FROM tasks WHERE id = $1 AND user_id = $2',
      [taskId, req.userId]
    );

    res.status(201).json({ trash: sanitizeTrash(result.rows[0]) });
  } catch (err) {
    console.error('trash add error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/trash/:trashId/restore  — re-insert task, remove from trash
router.post('/:trashId/restore', async (req: Request, res: Response) => {
  try {
    const trashId = parseInt(req.params.trashId, 10);
    if (isNaN(trashId)) {
      res.status(400).json({ error: 'Invalid trash id' });
      return;
    }

    // Fetch trash record
    const trashResult = await query<TrashRow>(
      `SELECT * FROM trash WHERE id = $1 AND user_id = $2 AND expires_at > NOW()`,
      [trashId, req.userId]
    );

    if (trashResult.rows.length === 0) {
      res.status(404).json({ error: 'Trash item not found or expired' });
      return;
    }

    const trashRow = trashResult.rows[0];
    const d = trashRow.task_data as Record<string, unknown>;

    // Re-insert the task using stored task_data fields
    const taskResult = await query<TaskRow>(
      `INSERT INTO tasks
         (id, user_id, title, note, checked, deadline, time_val, priority, badge,
          source, list_id, section_id, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [
        d.id          ?? trashRow.task_id,
        req.userId,
        d.title       ?? '',
        d.note        ?? null,
        d.checked     ?? false,
        d.deadline    ?? null,
        d.time_val    ?? d.time ?? null,
        d.priority    ?? null,
        d.badge       ?? null,
        d.source      ?? 'dash',
        d.list_id     ?? d.listId    ?? null,
        d.section_id  ?? d.sectionId ?? null,
        d.position    ?? 0,
      ]
    );

    // Remove from trash
    await query('DELETE FROM trash WHERE id = $1', [trashId]);

    const restored = taskResult.rows[0] ?? null;
    res.json({ success: true, task: restored });
  } catch (err) {
    console.error('trash restore error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/trash/empty  — must come before /:trashId to avoid route conflict
router.delete('/empty', async (req: Request, res: Response) => {
  try {
    await query('DELETE FROM trash WHERE user_id = $1', [req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('trash empty error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/trash/:trashId  — permanently delete a single item
router.delete('/:trashId', async (req: Request, res: Response) => {
  try {
    const trashId = parseInt(req.params.trashId, 10);
    if (isNaN(trashId)) {
      res.status(400).json({ error: 'Invalid trash id' });
      return;
    }

    const result = await query(
      'DELETE FROM trash WHERE id = $1 AND user_id = $2',
      [trashId, req.userId]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Trash item not found' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('trash delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
