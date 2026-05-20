import { Router, Request, Response } from 'express';
import { query } from '../db';
import { authenticate } from '../middleware';

const router = Router();
router.use(authenticate);

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

function sanitizeTask(task: TaskRow) {
  return {
    id:        task.id,
    userId:    task.user_id,
    title:     task.title,
    note:      task.note,
    checked:   task.checked,
    deadline:  task.deadline,
    time:      task.time_val,
    priority:  task.priority,
    badge:     task.badge,
    source:    task.source,
    listId:    task.list_id,
    sectionId: task.section_id,
    position:  task.position,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}

// GET /api/tasks
router.get('/', async (req: Request, res: Response) => {
  try {
    const result = await query<TaskRow>(
      `SELECT * FROM tasks
       WHERE user_id = $1 AND source = 'dash'
       ORDER BY position ASC, created_at ASC`,
      [req.userId]
    );
    res.json({ tasks: result.rows.map(sanitizeTask) });
  } catch (err) {
    console.error('tasks GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/tasks
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      id,
      title,
      note,
      deadline,
      time_val,
      priority,
      badge,
    } = req.body as {
      id?: number;
      title?: string;
      note?: string;
      deadline?: string;
      time_val?: string;
      priority?: string;
      badge?: string;
    };

    if (!title) {
      res.status(400).json({ error: 'title is required' });
      return;
    }

    const taskId = id ?? Date.now();

    // Determine next position
    const posResult = await query<{ max: string | null }>(
      `SELECT MAX(position) AS max FROM tasks WHERE user_id = $1 AND source = 'dash'`,
      [req.userId]
    );
    const nextPos = posResult.rows[0].max !== null
      ? parseInt(posResult.rows[0].max, 10) + 1
      : 0;

    const result = await query<TaskRow>(
      `INSERT INTO tasks
         (id, user_id, title, note, deadline, time_val, priority, badge, source, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'dash', $9)
       RETURNING *`,
      [taskId, req.userId, title, note ?? null, deadline ?? null, time_val ?? null, priority ?? null, badge ?? null, nextPos]
    );

    res.status(201).json({ task: sanitizeTask(result.rows[0]) });
  } catch (err) {
    console.error('tasks POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/tasks/reorder  — must be before /:id
router.put('/reorder', async (req: Request, res: Response) => {
  try {
    const { ids } = req.body as { ids?: number[] };

    if (!Array.isArray(ids)) {
      res.status(400).json({ error: 'ids must be an array' });
      return;
    }

    await Promise.all(
      ids.map((taskId, index) =>
        query(
          `UPDATE tasks SET position = $1 WHERE id = $2 AND user_id = $3 AND source = 'dash'`,
          [index, taskId, req.userId]
        )
      )
    );

    res.json({ success: true });
  } catch (err) {
    console.error('tasks reorder error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/tasks/:id
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const taskId = req.params.id;
    const {
      title,
      note,
      checked,
      deadline,
      time_val,
      priority,
      badge,
      position,
    } = req.body as {
      title?: string;
      note?: string;
      checked?: boolean;
      deadline?: string;
      time_val?: string;
      priority?: string;
      badge?: string;
      position?: number;
    };

    const result = await query<TaskRow>(
      `UPDATE tasks
       SET title    = COALESCE($1, title),
           note     = COALESCE($2, note),
           checked  = COALESCE($3, checked),
           deadline = COALESCE($4, deadline),
           time_val = COALESCE($5, time_val),
           priority = COALESCE($6, priority),
           badge    = COALESCE($7, badge),
           position = COALESCE($8, position)
       WHERE id = $9 AND user_id = $10 AND source = 'dash'
       RETURNING *`,
      [
        title    ?? null,
        note     ?? null,
        checked  ?? null,
        deadline ?? null,
        time_val ?? null,
        priority ?? null,
        badge    ?? null,
        position ?? null,
        taskId,
        req.userId,
      ]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    res.json({ task: sanitizeTask(result.rows[0]) });
  } catch (err) {
    console.error('tasks PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/tasks/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const taskId = req.params.id;

    const result = await query(
      `DELETE FROM tasks WHERE id = $1 AND user_id = $2 AND source = 'dash'`,
      [taskId, req.userId]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('tasks DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
