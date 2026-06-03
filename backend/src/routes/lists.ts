import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db';
import { authenticate } from '../middleware';
import { broadcastToUser } from '../sse';

const router = Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface ListRow {
  id: string;
  user_id: string;
  name: string;
  emoji: string | null;
  color: string | null;
  color_bg: string | null;
  subtitle: string | null;
  is_public: boolean;
  folder_id: string | null;
  position: number;
  created_at: string;
  parent_task_id: string | null;
  depth: number;
  workspace_id: string | null;
}

interface SectionRow {
  id: string;
  list_id: string;
  label: string;
  emoji: string | null;
  position: number;
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
  linked_list_id: string | null;
  linked_list_type: string | null;
}

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------

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

function sanitizeSection(section: SectionRow, tasks: ReturnType<typeof sanitizeTask>[]) {
  return {
    id:       section.id,
    listId:   section.list_id,
    label:    section.label,
    emoji:    section.emoji,
    position: section.position,
    tasks,
  };
}

function sanitizeList(
  list: ListRow,
  sections: ReturnType<typeof sanitizeSection>[],
  linkedProgress?: { total: number; completed: number }
) {
  return {
    id:           list.id,
    userId:       list.user_id,
    name:         list.name,
    emoji:        list.emoji,
    color:        list.color,
    colorBg:      list.color_bg,
    subtitle:     list.subtitle,
    isPublic:     list.is_public,
    folderId:     list.folder_id  ?? undefined,
    workspaceId:  list.workspace_id ?? undefined,
    position:     list.position,
    createdAt:    list.created_at,
    parentTaskId: list.parent_task_id ?? null,
    depth:        list.depth ?? 0,
    sections,
    ...(linkedProgress !== undefined ? { linkedProgress } : {}),
  };
}

// ---------------------------------------------------------------------------
// Helper: build full list objects (lists → sections → tasks)
// ---------------------------------------------------------------------------

async function buildListsForUser(userId: string, workspaceId?: string) {
  // When workspaceId is provided: return lists in that workspace the user can access.
  // When omitted: return all lists the user owns or has access to (global view).
  const wsFilter = workspaceId
    ? `AND l.workspace_id = '${workspaceId.replace(/'/g, "''")}'`
    : '';

  const accessCondition = `(
    l.user_id = $1
    OR (l.is_public = true AND (
      wm.user_id = $1
      OR l.workspace_id IS NULL
      OR EXISTS (SELECT 1 FROM workspaces w WHERE w.id = l.workspace_id AND w.visibility = 'public')
    ))
  )`;

  const [listsResult, sectionsResult, tasksResult] = await Promise.all([
    query<ListRow>(
      `SELECT l.* FROM lists l
       LEFT JOIN workspace_members wm ON wm.workspace_id = l.workspace_id AND wm.user_id = $1
       WHERE ${accessCondition}
       ${wsFilter}
       ORDER BY l.position ASC, l.created_at ASC`,
      [userId]
    ),
    query<SectionRow>(
      `SELECT s.* FROM sections s
       JOIN lists l ON s.list_id = l.id
       LEFT JOIN workspace_members wm ON wm.workspace_id = l.workspace_id AND wm.user_id = $1
       WHERE ${accessCondition}
       ${wsFilter}
       ORDER BY s.position ASC`,
      [userId]
    ),
    query<TaskRow>(
      `SELECT t.* FROM tasks t
       JOIN lists l ON t.list_id = l.id
       LEFT JOIN workspace_members wm ON wm.workspace_id = l.workspace_id AND wm.user_id = $1
       WHERE ${accessCondition}
       AND t.source = 'list'
       ${wsFilter}
       ORDER BY t.position ASC, t.created_at ASC`,
      [userId]
    ),
  ]);

  const tasksBySection: Record<string, ReturnType<typeof sanitizeTask>[]> = {};
  for (const task of tasksResult.rows) {
    const key = task.section_id ?? '__none__';
    if (!tasksBySection[key]) tasksBySection[key] = [];
    tasksBySection[key].push(sanitizeTask(task));
  }

  const sectionsByList: Record<string, ReturnType<typeof sanitizeSection>[]> = {};
  for (const section of sectionsResult.rows) {
    if (!sectionsByList[section.list_id]) sectionsByList[section.list_id] = [];
    sectionsByList[section.list_id].push(
      sanitizeSection(section, tasksBySection[section.id] ?? [])
    );
  }

  // Build a map from list id → all direct task counts for linkedProgress
  const taskCountByList: Record<string, { total: number; completed: number }> = {};
  for (const task of tasksResult.rows) {
    if (!task.list_id) continue;
    if (!taskCountByList[task.list_id]) taskCountByList[task.list_id] = { total: 0, completed: 0 };
    taskCountByList[task.list_id].total++;
    if (task.checked) taskCountByList[task.list_id].completed++;
  }

  return listsResult.rows.map((list: ListRow) =>
    sanitizeList(list, sectionsByList[list.id] ?? [], taskCountByList[list.id] ?? { total: 0, completed: 0 })
  );
}

// ---------------------------------------------------------------------------
// Lists CRUD
// ---------------------------------------------------------------------------

// GET /api/lists
router.get('/', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    const lists = await buildListsForUser(req.userId!, workspaceId);
    res.json({ lists });
  } catch (err) {
    console.error('lists GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/lists
router.post('/', async (req: Request, res: Response) => {
  try {
    const { id, name, emoji, color, colorBg, subtitle, isPublic, folderId, parentTaskId, depth, workspaceId } = req.body as {
      id?: string;
      name?: string;
      emoji?: string;
      color?: string;
      colorBg?: string;
      subtitle?: string;
      isPublic?: boolean;
      folderId?: string;
      parentTaskId?: number;
      depth?: number;
      workspaceId?: string;
    };

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const listId = id ?? `list_${uuidv4()}`;

    const posResult = await query<{ max: string | null }>(
      'SELECT MAX(position) AS max FROM lists WHERE user_id = $1',
      [req.userId]
    );
    const nextPos = posResult.rows[0].max !== null
      ? parseInt(posResult.rows[0].max, 10) + 1
      : 0;

    const result = await query<ListRow>(
      `INSERT INTO lists (id, user_id, name, emoji, color, color_bg, subtitle, is_public, folder_id, position, parent_task_id, depth, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [listId, req.userId, name, emoji ?? null, color ?? null, colorBg ?? null, subtitle ?? null, isPublic ?? false, folderId ?? null, nextPos, parentTaskId ?? null, depth ?? 0, workspaceId ?? null]
    );

    res.status(201).json({ list: sanitizeList(result.rows[0], []) });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    console.error('lists POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/lists/:listId/reorder
router.put('/:listId/reorder', async (req: Request, res: Response) => {
  try {
    const { ids } = req.body as { ids?: string[] };

    if (!Array.isArray(ids)) {
      res.status(400).json({ error: 'ids must be an array' });
      return;
    }

    await Promise.all(
      ids.map((listId, index) =>
        query(
          'UPDATE lists SET position = $1 WHERE id = $2 AND user_id = $3',
          [index, listId, req.userId]
        )
      )
    );

    res.json({ success: true });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    console.error('lists reorder error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/lists/:listId
router.put('/:listId', async (req: Request, res: Response) => {
  try {
    const { listId } = req.params;
    const { name, emoji, color, colorBg, subtitle, position, isPublic, folderId } = req.body as {
      name?: string;
      emoji?: string;
      color?: string;
      colorBg?: string;
      subtitle?: string;
      position?: number;
      isPublic?: boolean;
      folderId?: string | null;
    };

    const existing = await query<ListRow>('SELECT user_id FROM lists WHERE id = $1', [listId]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'List not found' });
      return;
    }

    const isOwner = existing.rows[0].user_id === req.userId;
    const isAdmin = req.user?.isAdmin === true;

    if (!isOwner && !isAdmin) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    const updateFolderId = 'folderId' in req.body;

    const result = await query<ListRow>(
      `UPDATE lists
       SET name      = COALESCE($1, name),
           emoji     = COALESCE($2, emoji),
           color     = COALESCE($3, color),
           color_bg  = COALESCE($4, color_bg),
           subtitle  = COALESCE($5, subtitle),
           position  = COALESCE($6, position),
           is_public = COALESCE($7, is_public),
           folder_id = CASE WHEN $9 THEN $10 ELSE folder_id END
       WHERE id = $8
       RETURNING *`,
      [name ?? null, emoji ?? null, color ?? null, colorBg ?? null, subtitle ?? null, position ?? null, isPublic ?? null, listId,
       updateFolderId, folderId ?? null]
    );

    res.json({ list: sanitizeList(result.rows[0], []) });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    console.error('lists PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/lists/:listId
router.delete('/:listId', async (req: Request, res: Response) => {
  try {
    const { listId } = req.params;

    const existing = await query<ListRow>('SELECT * FROM lists WHERE id = $1', [listId]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'List not found' });
      return;
    }

    const isOwner = existing.rows[0].user_id === req.userId;
    const isAdmin = req.user?.isAdmin === true;

    if (!isOwner && !isAdmin) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    const listRow = existing.rows[0];

    // Snapshot sections and tasks before deletion for trash
    const sectionsRes = await query<SectionRow>(
      'SELECT * FROM sections WHERE list_id = $1 ORDER BY position ASC',
      [listId]
    );
    let tasksRows: TaskRow[] = [];
    if (sectionsRes.rows.length > 0) {
      const sectionIds = sectionsRes.rows.map(s => s.id);
      const tasksRes = await query<TaskRow>(
        'SELECT * FROM tasks WHERE section_id = ANY($1::varchar[]) ORDER BY position ASC',
        [sectionIds]
      );
      tasksRows = tasksRes.rows;
    }

    const tasksBySection: Record<string, ReturnType<typeof sanitizeTask>[]> = {};
    for (const task of tasksRows) {
      const key = task.section_id ?? '__none__';
      if (!tasksBySection[key]) tasksBySection[key] = [];
      tasksBySection[key].push(sanitizeTask(task));
    }
    const sections = sectionsRes.rows.map(s =>
      sanitizeSection(s, tasksBySection[s.id] ?? [])
    );
    const listData = sanitizeList(listRow, sections);

    await query(
      `INSERT INTO trash_lists (list_id, user_id, list_data) VALUES ($1, $2, $3)`,
      [listId, req.userId, JSON.stringify(listData)]
    );

    await query('DELETE FROM lists WHERE id = $1', [listId]);

    res.json({ success: true });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    console.error('lists DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

// POST /api/lists/:listId/sections
router.post('/:listId/sections', async (req: Request, res: Response) => {
  try {
    const { listId } = req.params;
    const { id, label, emoji } = req.body as {
      id?: string;
      label?: string;
      emoji?: string;
    };

    console.log(`[sections POST] listId=${listId} requestedId=${id} label=${label}`);

    if (!label) {
      res.status(400).json({ error: 'label is required' });
      return;
    }

    // Verify list belongs to user or is public
    const listCheck = await query(
      'SELECT id FROM lists WHERE id = $1 AND (user_id = $2 OR is_public = true)',
      [listId, req.userId]
    );
    if (listCheck.rows.length === 0) {
      console.log(`[sections POST] ✗ 404 — list ${listId} not found for userId=${req.userId}`);
      res.status(404).json({ error: 'List not found' });
      return;
    }

    const sectionId = id ?? `section_${uuidv4()}`;

    const posResult = await query<{ max: string | null }>(
      'SELECT MAX(position) AS max FROM sections WHERE list_id = $1',
      [listId]
    );
    const nextPos = posResult.rows[0].max !== null
      ? parseInt(posResult.rows[0].max, 10) + 1
      : 0;

    const result = await query<SectionRow>(
      `INSERT INTO sections (id, list_id, label, emoji, position)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [sectionId, listId, label, emoji ?? null, nextPos]
    );

    console.log(`[sections POST] ✓ created sectionId=${result.rows[0].id}`);
    res.status(201).json({ section: sanitizeSection(result.rows[0], []) });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    console.error('sections POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/lists/sections/:sectionId
router.put('/sections/:sectionId', async (req: Request, res: Response) => {
  try {
    const { sectionId } = req.params;
    const { label, emoji, position } = req.body as {
      label?: string;
      emoji?: string;
      position?: number;
    };

    // Verify section belongs to a list owned by this user or public
    const ownerCheck = await query(
      `SELECT s.id FROM sections s
       JOIN lists l ON s.list_id = l.id
       WHERE s.id = $1 AND (l.user_id = $2 OR l.is_public = true)`,
      [sectionId, req.userId]
    );
    if (ownerCheck.rows.length === 0) {
      res.status(404).json({ error: 'Section not found' });
      return;
    }

    const result = await query<SectionRow>(
      `UPDATE sections
       SET label    = COALESCE($1, label),
           emoji    = COALESCE($2, emoji),
           position = COALESCE($3, position)
       WHERE id = $4
       RETURNING *`,
      [label ?? null, emoji ?? null, position ?? null, sectionId]
    );

    res.json({ section: sanitizeSection(result.rows[0], []) });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    console.error('sections PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/lists/:listId/sections/reorder
router.put('/:listId/sections/reorder', async (req: Request, res: Response) => {
  try {
    const { listId } = req.params;
    const { section_ids } = req.body as { section_ids?: string[] };

    if (!Array.isArray(section_ids)) {
      res.status(400).json({ error: 'section_ids must be an array' });
      return;
    }

    const listCheck = await query<{ user_id: string }>(
      'SELECT user_id FROM lists WHERE id = $1',
      [listId]
    );
    if (listCheck.rows.length === 0 || listCheck.rows[0].user_id !== req.userId) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    await Promise.all(
      section_ids.map((sectionId, index) =>
        query('UPDATE sections SET position = $1 WHERE id = $2 AND list_id = $3', [index, sectionId, listId])
      )
    );

    res.json({ success: true });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    console.error('sections reorder error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/lists/:listId/sections/:sectionId/tasks/reorder
router.put('/:listId/sections/:sectionId/tasks/reorder', async (req: Request, res: Response) => {
  try {
    const { listId, sectionId } = req.params;
    const { task_ids } = req.body as { task_ids?: number[] };

    if (!Array.isArray(task_ids)) {
      res.status(400).json({ error: 'task_ids must be an array' });
      return;
    }

    const ownerCheck = await query(
      `SELECT s.id FROM sections s
       JOIN lists l ON s.list_id = l.id
       WHERE s.id = $1 AND l.id = $2 AND (l.user_id = $3 OR l.is_public = true)`,
      [sectionId, listId, req.userId]
    );
    if (ownerCheck.rows.length === 0) {
      res.status(404).json({ error: 'Section not found' });
      return;
    }

    await Promise.all(
      task_ids.map((taskId, index) =>
        query('UPDATE tasks SET position = $1 WHERE id = $2 AND section_id = $3', [index, taskId, sectionId])
      )
    );

    res.json({ success: true });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    console.error('tasks reorder error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/lists/sections/:sectionId
router.delete('/sections/:sectionId', async (req: Request, res: Response) => {
  try {
    const { sectionId } = req.params;

    // Verify ownership or public
    const ownerCheck = await query(
      `SELECT s.id FROM sections s
       JOIN lists l ON s.list_id = l.id
       WHERE s.id = $1 AND (l.user_id = $2 OR l.is_public = true)`,
      [sectionId, req.userId]
    );
    if (ownerCheck.rows.length === 0) {
      res.status(404).json({ error: 'Section not found' });
      return;
    }

    await query('DELETE FROM sections WHERE id = $1', [sectionId]);

    res.json({ success: true });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    console.error('sections DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// List Tasks
// ---------------------------------------------------------------------------

// POST /api/lists/:listId/sections/:sectionId/tasks
router.post('/:listId/sections/:sectionId/tasks', async (req: Request, res: Response) => {
  try {
    const { listId, sectionId } = req.params;
    console.log(`[list task POST] listId=${listId} sectionId=${sectionId} title=${req.body?.title}`);
    const { id, title, note, deadline, priority, badge, linked_list_id, linked_list_type } = req.body as {
      id?: number;
      title?: string;
      note?: string;
      deadline?: string;
      priority?: string;
      badge?: string;
      linked_list_id?: string;
      linked_list_type?: 'sublist' | 'link';
    };

    if (!title) {
      res.status(400).json({ error: 'title is required' });
      return;
    }

    // Verify list + section belong to user or public
    const ownerCheck = await query(
      `SELECT s.id FROM sections s
       JOIN lists l ON s.list_id = l.id
       WHERE s.id = $1 AND l.id = $2 AND (l.user_id = $3 OR l.is_public = true)`,
      [sectionId, listId, req.userId]
    );
    if (ownerCheck.rows.length === 0) {
      console.log(`[list task POST] ✗ 404 — section ${sectionId} not found in list ${listId} for userId=${req.userId}`);
      res.status(404).json({ error: 'List or section not found' });
      return;
    }

    const taskId = id ?? Date.now();

    const posResult = await query<{ max: string | null }>(
      `SELECT MAX(position) AS max FROM tasks WHERE section_id = $1`,
      [sectionId]
    );
    const nextPos = posResult.rows[0].max !== null
      ? parseInt(posResult.rows[0].max, 10) + 1
      : 0;

    const result = await query<TaskRow>(
      `INSERT INTO tasks
         (id, user_id, title, note, deadline, priority, badge, source, list_id, section_id, position, linked_list_id, linked_list_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'list', $8, $9, $10, $11, $12)
       RETURNING *`,
      [taskId, req.userId, title, note ?? null, deadline ?? null, priority ?? null, badge ?? null, listId, sectionId, nextPos, linked_list_id ?? null, linked_list_type ?? null]
    );

    console.log(`[list task POST] ✓ created taskId=${result.rows[0].id} in section=${sectionId}`);
    res.status(201).json({ task: sanitizeTask(result.rows[0]) });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    console.error('list task POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/lists/:listId/tasks/:taskId
router.put('/:listId/tasks/:taskId', async (req: Request, res: Response) => {
  try {
    const { listId, taskId } = req.params;
    const {
      title, note, checked, deadline, time_val, priority, badge, position, sectionId,
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
      sectionId?: string;
      linked_list_id?: string | null;
      linkedListId?: string | null;
      linked_list_type?: 'sublist' | 'link' | null;
      linkedListType?: 'sublist' | 'link' | null;
    };

    const linked_list_id = _ll_snake ?? _ll_camel;
    const linked_list_type = _llt_snake ?? _llt_camel;
    const updateLinkedList = 'linked_list_id' in req.body || 'linkedListId' in req.body;

    console.log(`[list task PUT] taskId=${taskId} listId=${listId} userId=${req.userId}`);
    console.log(`[list task PUT] body keys: ${Object.keys(req.body).join(', ')}`);
    console.log(`[list task PUT] updateLinkedList=${updateLinkedList} linked_list_id=${linked_list_id} linked_list_type=${linked_list_type}`);

    const result = await query<TaskRow>(
      `UPDATE tasks t
       SET title          = COALESCE($1, t.title),
           note           = COALESCE($2, t.note),
           checked        = COALESCE($3, t.checked),
           deadline       = COALESCE($4, t.deadline),
           time_val       = COALESCE($5, t.time_val),
           priority       = COALESCE($6, t.priority),
           badge          = COALESCE($7, t.badge),
           position       = COALESCE($8, t.position),
           section_id     = COALESCE($9, t.section_id),
           linked_list_id   = CASE WHEN $13 THEN $14 ELSE t.linked_list_id END,
           linked_list_type = CASE WHEN $13 THEN $15 ELSE t.linked_list_type END
       FROM lists l
       WHERE t.id = $10 AND t.list_id = $11 AND l.id = t.list_id AND (l.user_id = $12 OR l.is_public = true)
       RETURNING t.*`,
      [
        title     ?? null,
        note      ?? null,
        checked   ?? null,
        deadline  ?? null,
        time_val  ?? null,
        priority  ?? null,
        badge     ?? null,
        position  ?? null,
        sectionId ?? null,
        taskId,
        listId,
        req.userId,
        updateLinkedList,
        linked_list_id ?? null,
        linked_list_type ?? null,
      ]
    );

    if (result.rows.length === 0) {
      console.log(`[list task PUT] ✗ 404 — taskId=${taskId} not found in listId=${listId} for userId=${req.userId}`);
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    const saved = result.rows[0];
    console.log(`[list task PUT] ✓ updated → linked_list_id=${saved.linked_list_id} linked_list_type=${saved.linked_list_type}`);
    res.json({ task: sanitizeTask(saved) });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    console.error('list task PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/lists/:listId/tasks/:taskId
router.delete('/:listId/tasks/:taskId', async (req: Request, res: Response) => {
  try {
    const { listId, taskId } = req.params;

    const result = await query(
      `DELETE FROM tasks t
       USING lists l
       WHERE t.id = $1 AND t.list_id = $2 AND l.id = t.list_id AND (t.user_id = $3 OR l.is_public = true)`,
      [taskId, listId, req.userId]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    res.json({ success: true });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    console.error('list task DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/lists/:listId/progress
router.get('/:listId/progress', async (req: Request, res: Response) => {
  try {
    const { listId } = req.params;

    // Recursively collect all list IDs (this list + sublists)
    async function collectSublistIds(id: string): Promise<string[]> {
      const subResult = await query<{ id: string }>(
        `SELECT l.id FROM lists l
         JOIN tasks t ON l.parent_task_id = t.id
         WHERE t.list_id = $1 AND l.id != $1`,
        [id]
      );
      const ids = [id];
      for (const row of subResult.rows) {
        const nested = await collectSublistIds(row.id);
        ids.push(...nested);
      }
      return ids;
    }

    const allIds = await collectSublistIds(listId);
    const countRes = await query<{ total: string; completed: string }>(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE checked = true) AS completed
       FROM tasks t
       JOIN sections s ON t.section_id = s.id
       WHERE s.list_id = ANY($1::varchar[]) AND t.source = 'list'`,
      [allIds]
    );
    const total = parseInt(countRes.rows[0].total, 10);
    const completed = parseInt(countRes.rows[0].completed, 10);
    const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
    res.json({ total, completed, percent });
  } catch (err) {
    console.error('list progress error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/lists/:listId/sections/:sectionId/tasks/sublist
router.post('/:listId/sections/:sectionId/tasks/sublist', async (req: Request, res: Response) => {
  try {
    const { listId, sectionId } = req.params;
    const { title, sublistName, depth } = req.body as { title?: string; sublistName?: string; depth?: number };

    if (!title || !sublistName) {
      res.status(400).json({ error: 'title and sublistName are required' });
      return;
    }

    const ownerCheck = await query(
      `SELECT s.id FROM sections s JOIN lists l ON s.list_id = l.id
       WHERE s.id = $1 AND l.id = $2 AND (l.user_id = $3 OR l.is_public = true)`,
      [sectionId, listId, req.userId]
    );
    if (ownerCheck.rows.length === 0) {
      res.status(404).json({ error: 'List or section not found' });
      return;
    }

    // Get parent list depth for calculating new depth
    const parentListRes = await query<{ depth: number }>('SELECT depth FROM lists WHERE id = $1', [listId]);
    const parentDepth = parentListRes.rows[0]?.depth ?? 0;
    const newDepth = depth ?? parentDepth + 1;

    // 1. Create the new sublist
    const newListId = `list_${uuidv4()}`;
    const posResult = await query<{ max: string | null }>('SELECT MAX(position) AS max FROM lists WHERE user_id = $1', [req.userId]);
    const nextPos = posResult.rows[0].max !== null ? parseInt(posResult.rows[0].max, 10) + 1 : 0;

    const newList = await query<ListRow>(
      `INSERT INTO lists (id, user_id, name, is_public, position, depth) VALUES ($1, $2, $3, false, $4, $5) RETURNING *`,
      [newListId, req.userId, sublistName, nextPos, newDepth]
    );

    // 2. Create a default section in the new list
    const newSectionId = `section_${uuidv4()}`;
    await query(
      `INSERT INTO sections (id, list_id, label, position) VALUES ($1, $2, 'Tasks', 0)`,
      [newSectionId, newListId]
    );

    // 3. Create the task that links to the sublist
    const taskId = Date.now();
    const taskPosResult = await query<{ max: string | null }>('SELECT MAX(position) AS max FROM tasks WHERE section_id = $1', [sectionId]);
    const taskPos = taskPosResult.rows[0].max !== null ? parseInt(taskPosResult.rows[0].max, 10) + 1 : 0;

    const newTask = await query<TaskRow>(
      `INSERT INTO tasks (id, user_id, title, source, list_id, section_id, position, linked_list_id, linked_list_type)
       VALUES ($1, $2, $3, 'list', $4, $5, $6, $7, 'sublist') RETURNING *`,
      [taskId, req.userId, title, listId, sectionId, taskPos, newListId]
    );

    // 4. Update the sublist with the parent_task_id
    await query('UPDATE lists SET parent_task_id = $1 WHERE id = $2', [taskId, newListId]);
    newList.rows[0].parent_task_id = String(taskId);

    res.status(201).json({ task: sanitizeTask(newTask.rows[0]), list: sanitizeList(newList.rows[0], []) });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    console.error('sublist task POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/lists/:listId/sections/:sectionId/tasks/link
router.post('/:listId/sections/:sectionId/tasks/link', async (req: Request, res: Response) => {
  try {
    const { listId, sectionId } = req.params;
    const { title, linkedListId } = req.body as { title?: string; linkedListId?: string };

    if (!title || !linkedListId) {
      res.status(400).json({ error: 'title and linkedListId are required' });
      return;
    }

    const ownerCheck = await query(
      `SELECT s.id FROM sections s JOIN lists l ON s.list_id = l.id
       WHERE s.id = $1 AND l.id = $2 AND (l.user_id = $3 OR l.is_public = true)`,
      [sectionId, listId, req.userId]
    );
    if (ownerCheck.rows.length === 0) {
      res.status(404).json({ error: 'List or section not found' });
      return;
    }

    // Verify target list belongs to user
    const targetCheck = await query('SELECT id FROM lists WHERE id = $1 AND user_id = $2', [linkedListId, req.userId]);
    if (targetCheck.rows.length === 0) {
      res.status(404).json({ error: 'Target list not found' });
      return;
    }

    const taskId = Date.now();
    const posResult = await query<{ max: string | null }>('SELECT MAX(position) AS max FROM tasks WHERE section_id = $1', [sectionId]);
    const taskPos = posResult.rows[0].max !== null ? parseInt(posResult.rows[0].max, 10) + 1 : 0;

    const newTask = await query<TaskRow>(
      `INSERT INTO tasks (id, user_id, title, source, list_id, section_id, position, linked_list_id, linked_list_type)
       VALUES ($1, $2, $3, 'list', $4, $5, $6, $7, 'link') RETURNING *`,
      [taskId, req.userId, title, listId, sectionId, taskPos, linkedListId]
    );

    res.status(201).json({ task: sanitizeTask(newTask.rows[0]) });
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    console.error('link task POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
