import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { query } from '../db';
import { authenticate } from '../middleware';
import { broadcastToUser } from '../sse';
import { resolveWorkspaceForUser, wlog, werr } from '../workspaceUtil';

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
  workspace_id: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  linked_list_id: string | null;
  linked_list_type: string | null;
  attachment_count?: string;
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
    workspaceId:    task.workspace_id ?? undefined,
    position:       task.position,
    createdAt:      task.created_at,
    updatedAt:      task.updated_at,
    _source:        task.source,
    _listId:        task.list_id,
    linkedListId:    task.linked_list_id ?? null,
    linkedListType:  task.linked_list_type ?? null,
    attachmentCount: Number(task.attachment_count ?? 0),
  };
}

// Build the dashboard task set (dash tasks + accessible list tasks), exactly as
// GET /api/tasks returns it. Reused by the sync bootstrap so the delta engine
// hydrates the same data the legacy loader did.
export async function buildTasksForUser(userId: string, workspaceId?: string) {
  const params: unknown[] = [userId];
  // Improved query to handle workspace context for both dashboard and list tasks.
  // If workspaceId is provided, we filter tasks that are explicitly in that workspace,
  // OR list tasks whose parent list belongs to that workspace.
  // OR tasks that have no workspace assigned (backward-compatibility/legacy).
  const wsClause = workspaceId
    ? `AND (t.workspace_id = $2 OR t.workspace_id IS NULL OR (t.source = 'list' AND (l.workspace_id = $2 OR l.workspace_id IS NULL)))`
    : '';
  if (workspaceId) params.push(workspaceId);

  const result = await query<TaskRow>(
    `SELECT t.*,
            (SELECT COUNT(*) FROM task_attachments ta WHERE ta.task_id = t.id) AS attachment_count
     FROM tasks t
     LEFT JOIN lists l ON t.list_id = l.id
     WHERE ((t.user_id = $1 AND t.source = 'dash')
        OR (t.source = 'list' AND (l.user_id = $1 OR l.is_public = true)))
     ${wsClause}
     ORDER BY t.position ASC, t.created_at ASC`,
    params
  );
  return result.rows.map(sanitizeTask);
}

/** A single dash task the user owns, sanitized, or null. For delta re-serialization. */
export async function getDashTaskForUser(userId: string, taskId: string) {
  const r = await query<TaskRow>(
    `SELECT t.*, (SELECT COUNT(*) FROM task_attachments ta WHERE ta.task_id = t.id) AS attachment_count
     FROM tasks t WHERE t.id = $1 AND t.user_id = $2 AND t.source = 'dash'`,
    [taskId, userId]
  );
  return r.rows[0] ? sanitizeTask(r.rows[0]) : null;
}

// GET /api/tasks
router.get('/', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    const tasks = await buildTasksForUser(req.userId!, workspaceId);
    wlog(`tasks GET user=${req.userId} workspace=${workspaceId ?? 'ALL'} → ${tasks.length} task(s)`);
    res.json({ tasks });
  } catch (err) {
    werr('tasks GET error:', err);
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

    const taskId = id ?? (Date.now() * 1000 + crypto.randomInt(1000));

    // Resolve to a workspace the user can access so the dashboard task always
    // has a real, visible home (never NULL / never a dangling id).
    const resolvedWs = await resolveWorkspaceForUser(req.userId!, workspaceId);

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
      [taskId, req.userId, title, note ?? null, deadline ?? null, time_val ?? null, priority ?? null, badge ?? null, nextPos, linked_list_id ?? null, linked_list_type ?? null, resolvedWs]
    );

    wlog(`dash task CREATE ✓ id=${result.rows[0].id} title="${title}" workspace=${resolvedWs} owner=${req.userId} (requested=${workspaceId ?? 'none'})`);
    res.status(201).json({ task: sanitizeTask(result.rows[0]) });
    broadcastToUser(req.userId!, 'tasks');
  } catch (err) {
    werr('tasks POST error:', err);
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
    werr('tasks reorder error:', err);
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

    wlog(`dash task UPDATE id=${taskId} userId=${req.userId}`);
    wlog(`dash task UPDATE body keys: ${Object.keys(req.body).join(', ')}`);
    wlog(`dash task UPDATE updateLinkedList=${updateLinkedList} linked_list_id=${linked_list_id} linked_list_type=${linked_list_type}`);

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
      wlog(`dash task UPDATE ✗ 404 — no task with id=${taskId}, userId=${req.userId}, source=dash`);
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    const saved = result.rows[0];
    wlog(`dash task UPDATE ✓ updated → linked_list_id=${saved.linked_list_id} linked_list_type=${saved.linked_list_type}`);
    res.json({ task: sanitizeTask(saved) });
    broadcastToUser(req.userId!, 'tasks');
  } catch (err) {
    werr('tasks PUT error:', err);
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
    werr('tasks DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
