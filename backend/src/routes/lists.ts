import { Router, Request, Response } from 'express';
import { query } from '../db';
import { authenticate } from '../middleware';

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
  position: number;
  created_at: string;
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
}

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------

function sanitizeTask(task: TaskRow) {
  return {
    id:        task.id,
    creatorId: task.user_id,
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
  sections: ReturnType<typeof sanitizeSection>[]
) {
  return {
    id:        list.id,
    userId:    list.user_id,
    name:      list.name,
    emoji:     list.emoji,
    color:     list.color,
    colorBg:   list.color_bg,
    subtitle:  list.subtitle,
    isPublic:  list.is_public,
    position:  list.position,
    createdAt: list.created_at,
    sections,
  };
}

// ---------------------------------------------------------------------------
// Helper: build full list objects (lists → sections → tasks)
// ---------------------------------------------------------------------------

async function buildListsForUser(userId: string) {
  const [listsResult, sectionsResult, tasksResult] = await Promise.all([
    query<ListRow>(
      'SELECT * FROM lists WHERE user_id = $1 OR is_public = true ORDER BY position ASC, created_at ASC',
      [userId]
    ),
    query<SectionRow>(
      `SELECT s.* FROM sections s
       JOIN lists l ON s.list_id = l.id
       WHERE l.user_id = $1 OR l.is_public = true
       ORDER BY s.position ASC`,
      [userId]
    ),
    query<TaskRow>(
      `SELECT t.* FROM tasks t
       JOIN lists l ON t.list_id = l.id
       WHERE (t.user_id = $1 OR l.is_public = true) AND t.source = 'list'
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

  return listsResult.rows.map(list =>
    sanitizeList(list, sectionsByList[list.id] ?? [])
  );
}

// ---------------------------------------------------------------------------
// Lists CRUD
// ---------------------------------------------------------------------------

// GET /api/lists
router.get('/', async (req: Request, res: Response) => {
  try {
    const lists = await buildListsForUser(req.userId!);
    res.json({ lists });
  } catch (err) {
    console.error('lists GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/lists
router.post('/', async (req: Request, res: Response) => {
  try {
    const { id, name, emoji, color, colorBg, subtitle, isPublic } = req.body as {
      id?: string;
      name?: string;
      emoji?: string;
      color?: string;
      colorBg?: string;
      subtitle?: string;
      isPublic?: boolean;
    };

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const listId = id ?? `list_${Date.now()}`;

    const posResult = await query<{ max: string | null }>(
      'SELECT MAX(position) AS max FROM lists WHERE user_id = $1',
      [req.userId]
    );
    const nextPos = posResult.rows[0].max !== null
      ? parseInt(posResult.rows[0].max, 10) + 1
      : 0;

    const result = await query<ListRow>(
      `INSERT INTO lists (id, user_id, name, emoji, color, color_bg, subtitle, is_public, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [listId, req.userId, name, emoji ?? null, color ?? null, colorBg ?? null, subtitle ?? null, isPublic ?? false, nextPos]
    );

    res.status(201).json({ list: sanitizeList(result.rows[0], []) });
  } catch (err) {
    console.error('lists POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/lists/:listId/reorder  — before /:listId to avoid route conflict
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
  } catch (err) {
    console.error('lists reorder error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/lists/:listId
router.put('/:listId', async (req: Request, res: Response) => {
  try {
    const { listId } = req.params;
    const { name, emoji, color, colorBg, subtitle, position, isPublic } = req.body as {
      name?: string;
      emoji?: string;
      color?: string;
      colorBg?: string;
      subtitle?: string;
      position?: number;
      isPublic?: boolean;
    };

    const result = await query<ListRow>(
      `UPDATE lists
       SET name     = COALESCE($1, name),
           emoji    = COALESCE($2, emoji),
           color    = COALESCE($3, color),
           color_bg = COALESCE($4, color_bg),
           subtitle = COALESCE($5, subtitle),
           position = COALESCE($6, position),
           is_public = COALESCE($7, is_public)
       WHERE id = $8 AND (user_id = $9 OR is_public = true)
       RETURNING *`,
      [name ?? null, emoji ?? null, color ?? null, colorBg ?? null, subtitle ?? null, position ?? null, isPublic ?? null, listId, req.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'List not found' });
      return;
    }

    res.json({ list: sanitizeList(result.rows[0], []) });
  } catch (err) {
    console.error('lists PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/lists/:listId
router.delete('/:listId', async (req: Request, res: Response) => {
  try {
    const { listId } = req.params;

    const result = await query(
      'DELETE FROM lists WHERE id = $1 AND user_id = $2',
      [listId, req.userId]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: 'List not found' });
      return;
    }

    res.json({ success: true });
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
      res.status(404).json({ error: 'List not found' });
      return;
    }

    const sectionId = id ?? `section_${Date.now()}`;

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

    res.status(201).json({ section: sanitizeSection(result.rows[0], []) });
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
  } catch (err) {
    console.error('sections PUT error:', err);
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
    const { id, title, note, deadline, priority, badge } = req.body as {
      id?: number;
      title?: string;
      note?: string;
      deadline?: string;
      priority?: string;
      badge?: string;
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
         (id, user_id, title, note, deadline, priority, badge, source, list_id, section_id, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'list', $8, $9, $10)
       RETURNING *`,
      [taskId, req.userId, title, note ?? null, deadline ?? null, priority ?? null, badge ?? null, listId, sectionId, nextPos]
    );

    res.status(201).json({ task: sanitizeTask(result.rows[0]) });
  } catch (err) {
    console.error('list task POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/lists/:listId/tasks/:taskId
router.put('/:listId/tasks/:taskId', async (req: Request, res: Response) => {
  try {
    const { listId, taskId } = req.params;
    const { title, note, checked, deadline, time_val, priority, badge, position, sectionId } = req.body as {
      title?: string;
      note?: string;
      checked?: boolean;
      deadline?: string;
      time_val?: string;
      priority?: string;
      badge?: string;
      position?: number;
      sectionId?: string;
    };

    const result = await query<TaskRow>(
      `UPDATE tasks t
       SET title      = COALESCE($1, title),
           note       = COALESCE($2, note),
           checked    = COALESCE($3, checked),
           deadline   = COALESCE($4, deadline),
           time_val   = COALESCE($5, time_val),
           priority   = COALESCE($6, priority),
           badge      = COALESCE($7, badge),
           position   = COALESCE($8, position),
           section_id = COALESCE($9, section_id)
       FROM lists l
       WHERE t.id = $10 AND t.list_id = $11 AND l.id = t.list_id AND (t.user_id = $12 OR l.is_public = true)
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
      ]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    res.json({ task: sanitizeTask(result.rows[0]) });
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
  } catch (err) {
    console.error('list task DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
