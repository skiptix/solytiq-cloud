import { Router, Request, Response } from 'express';
import { query } from '../db';
import { authenticate } from '../middleware';
import { broadcastToUser } from '../sse';

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
  linked_list_id: string | null;
  linked_list_type: string | null;
}

function sanitizeTask(task: TaskRow) {
  return {
    id:             task.id,
    creatorId:      task.user_id,
    title:          task.title,
    note:           task.note,
    checked:        task.checked,
    deadline:       task.deadline,
    time:           task.time_val,
    priority:       task.priority,
    badge:          task.badge,
    source:         task.source,
    listId:         task.list_id,
    sectionId:      task.section_id,
    position:       task.position,
    createdAt:      task.created_at,
    updatedAt:      task.updated_at,
    _source:        task.source,
    _listId:        task.list_id,
    linkedListId:   task.linked_list_id ?? null,
    linkedListType: task.linked_list_type ?? null,
  };
}

// GET /api/tasks
router.get('/', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    const wsClause = workspaceId
      ? `AND t.workspace_id = '${workspaceId.replace(/'/g, "''")}'`
      : '';
    const result = await query<TaskRow>(
      `SELECT t.* FROM tasks t
       LEFT JOIN lists l ON t.list_id = l.id
       WHERE (t.user_id = $1 AND t.source = 'dash')
          OR (t.source = 'list' AND (l.user_id = $1 OR l.is_public = true))
       ${wsClause}
       ORDER BY t.position ASC, t.created_at ASC`,
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
      linked_list_id,
      linked_list_type,
      workspaceId,
    } = req.body as {
      id?: number;
      title?: string;
      note?: string;
      deadline?: string;
      time_val?: string;
      priority?: string;
      badge?: string;
      linked_list_id?: string;
      linked_list_type?: 'sublist' | 'link';
      workspaceId?: string;
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
         (id, user_id, title, note, deadline, time_val, priority, badge, source, position, linked_list_id, linked_list_type, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'dash', $9, $10, $11, $12)
       RETURNING *`,
      [taskId, req.userId, title, note ?? null, deadline ?? null, time_val ?? null, priority ?? null, badge ?? null, nextPos, linked_list_id ?? null, linked_list_type ?? null, workspaceId ?? null]
    );

    res.status(201).json({ task: sanitizeTask(result.rows[0]) });
    broadcastToUser(req.userId!, 'tasks');
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
    broadcastToUser(req.userId!, 'tasks');
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
      linked_list_id: _ll_snake,
      linkedListId: _ll_camel,
      linked_list_type: _llt_snake,
      linkedListType: _llt_camel,
    } = req.body as {
      title?: string;
      note?: string;
      checked?: boolean;
      deadline?: string;
      time_val?: string;
      priority?: string;
      badge?: string;
      position?: number;
      linked_list_id?: string | null;
      linkedListId?: string | null;
      linked_list_type?: 'sublist' | 'link' | null;
      linkedListType?: 'sublist' | 'link' | null;
    };

    const linked_list_id = _ll_snake ?? _ll_camel;
    const linked_list_type = _llt_snake ?? _llt_camel;
    const updateLinkedList = 'linked_list_id' in req.body || 'linkedListId' in req.body;

    console.log(`[tasks PUT] id=${taskId} userId=${req.userId}`);
    console.log(`[tasks PUT] body keys: ${Object.keys(req.body).join(', ')}`);
    console.log(`[tasks PUT] updateLinkedList=${updateLinkedList} linked_list_id=${linked_list_id} linked_list_type=${linked_list_type}`);

    const result = await query<TaskRow>(
      `UPDATE tasks
       SET title          = COALESCE($1, title),
           note           = COALESCE($2, note),
           checked        = COALESCE($3, checked),
           deadline       = COALESCE($4, deadline),
           time_val       = COALESCE($5, time_val),
           priority       = COALESCE($6, priority),
           badge          = COALESCE($7, badge),
           position       = COALESCE($8, position),
           linked_list_id   = CASE WHEN $11 THEN $12 ELSE linked_list_id END,
           linked_list_type = CASE WHEN $11 THEN $13 ELSE linked_list_type END
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
        updateLinkedList,
        linked_list_id ?? null,
        linked_list_type ?? null,
      ]
    );

    if (result.rows.length === 0) {
      console.log(`[tasks PUT] ✗ 404 — no task with id=${taskId}, userId=${req.userId}, source=dash`);
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    const saved = result.rows[0];
    console.log(`[tasks PUT] ✓ updated → linked_list_id=${saved.linked_list_id} linked_list_type=${saved.linked_list_type}`);
    res.json({ task: sanitizeTask(saved) });
    broadcastToUser(req.userId!, 'tasks');
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
    broadcastToUser(req.userId!, 'tasks');
  } catch (err) {
    console.error('tasks DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
