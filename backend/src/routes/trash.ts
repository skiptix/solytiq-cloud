import { Router, Request, Response } from 'express';
import { query, withTransaction } from '../db';
import { authenticate } from '../middleware';
import { broadcastToUser } from '../sse';
import { resolveWorkspaceForUser, wwarn } from '../workspaceUtil';

const router = Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// Restore helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the workspace a restored item should land in. The original workspace
 * is honoured when the user can still access it; otherwise the item falls back
 * to the user's Personal workspace so it can never be restored into a
 * workspace the user cannot see (which would make it invisible in every view).
 */
async function resolveRestoreWorkspace(userId: string, original: unknown): Promise<string> {
  const originalWs = typeof original === 'string' && original.length > 0 ? original : null;
  const resolved = await resolveWorkspaceForUser(userId, originalWs);
  if (originalWs && resolved !== originalWs) {
    wwarn(`restore: workspace ${originalWs} no longer accessible for user ${userId}; restoring into ${resolved}`);
  }
  return resolved;
}

/**
 * A restored item may only keep its folder if the folder still exists, belongs
 * to the user, and lives in the same workspace the item is being restored
 * into — otherwise the sidebar can't place the item and it becomes invisible.
 */
async function validateRestoreFolder(userId: string, workspaceId: string, folderId: unknown): Promise<string | null> {
  if (typeof folderId !== 'string' || folderId.length === 0) return null;
  const f = await query(
    `SELECT 1 FROM folders WHERE id = $1 AND user_id = $2 AND workspace_id = $3`,
    [folderId, userId, workspaceId]
  );
  return f.rows.length > 0 ? folderId : null;
}

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

interface TrashListRow {
  id: number;
  list_id: string;
  user_id: string;
  list_data: Record<string, unknown>;
  deleted_at: string;
  expires_at: string;
}

interface TrashFolderRow {
  id: number;
  folder_id: string;
  user_id: string;
  folder_data: Record<string, unknown>;
  deleted_at: string;
  expires_at: string;
}

interface TrashTimelineRow {
  id: number;
  timeline_id: string;
  user_id: string;
  timeline_data: Record<string, unknown>;
  deleted_at: string;
  expires_at: string;
}

interface TrashMilestoneRow {
  id: number;
  milestone_id: string;
  timeline_id: string;
  user_id: string;
  milestone_data: Record<string, unknown>;
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

function sanitizeTrashList(row: TrashListRow) {
  return {
    id:        row.id,
    listId:    row.list_id,
    userId:    row.user_id,
    listData:  row.list_data,
    deletedAt: row.deleted_at,
    expiresAt: row.expires_at,
  };
}

function sanitizeTrashFolder(row: TrashFolderRow) {
  return {
    id:         row.id,
    folderId:   row.folder_id,
    userId:     row.user_id,
    folderData: row.folder_data,
    deletedAt:  row.deleted_at,
    expiresAt:  row.expires_at,
  };
}

function sanitizeTrashTimeline(row: TrashTimelineRow) {
  return {
    id:           row.id,
    timelineId:   row.timeline_id,
    userId:       row.user_id,
    timelineData: row.timeline_data,
    deletedAt:    row.deleted_at,
    expiresAt:    row.expires_at,
  };
}

function sanitizeTrashMilestone(row: TrashMilestoneRow) {
  return {
    id:            row.id,
    milestoneId:   row.milestone_id,
    timelineId:    row.timeline_id,
    userId:        row.user_id,
    milestoneData: row.milestone_data,
    deletedAt:     row.deleted_at,
    expiresAt:     row.expires_at,
  };
}

// ---------------------------------------------------------------------------
// Task trash routes
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

    const result = await query<TrashRow>(
      `INSERT INTO trash (task_id, user_id, task_data, meta)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [taskId, req.userId, JSON.stringify(taskData), meta ? JSON.stringify(meta) : null]
    );

    await query(
      'DELETE FROM tasks WHERE id = $1 AND user_id = $2',
      [taskId, req.userId]
    );

    res.status(201).json({ trash: sanitizeTrash(result.rows[0]) });
    broadcastToUser(req.userId!, 'trash');
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

    const source = (d.source ?? d._source ?? 'dash') as string;
    let listId = (d.list_id ?? d.listId ?? d._listId ?? null) as string | null;
    let sectionId = (d.section_id ?? d.sectionId ?? null) as string | null;
    let workspaceId: string | null;

    if (source === 'list' && listId) {
      // A list task must be restored into its list's workspace — and the list
      // (plus a valid section) must still exist to receive it.
      const listRes = await query<{ workspace_id: string | null }>(
        `SELECT workspace_id FROM lists WHERE id = $1 AND user_id = $2`,
        [listId, req.userId]
      );
      if (listRes.rows.length === 0) {
        res.status(409).json({ error: 'The list this task belonged to no longer exists. Restore the list instead.' });
        return;
      }
      workspaceId = listRes.rows[0].workspace_id;
      if (sectionId) {
        const secRes = await query(`SELECT 1 FROM sections WHERE id = $1 AND list_id = $2`, [sectionId, listId]);
        if (secRes.rows.length === 0) sectionId = null;
      }
      if (!sectionId) {
        const first = await query<{ id: string }>(
          `SELECT id FROM sections WHERE list_id = $1 ORDER BY position ASC LIMIT 1`,
          [listId]
        );
        if (first.rows.length === 0) {
          res.status(409).json({ error: 'The list this task belonged to has no sections to restore into.' });
          return;
        }
        sectionId = first.rows[0].id;
      }
    } else {
      listId = null;
      sectionId = null;
      workspaceId = await resolveRestoreWorkspace(req.userId!, d.workspaceId ?? d.workspace_id);
    }

    // Re-insert + trash-row delete must be atomic. The upsert also recaptures
    // legacy orphaned rows (tasks whose list was deleted before list deletion
    // hard-deleted its tasks) by re-pointing them at the restored location.
    const restored = await withTransaction(async (client) => {
      const taskResult = await client.query<TaskRow>(
        `INSERT INTO tasks
           (id, user_id, title, note, note_markdown, checked, deadline, time_val, priority, badge,
            source, list_id, section_id, position, workspace_id)
         VALUES ($1, $2, $3, $4, $15, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO UPDATE
           SET source = EXCLUDED.source,
               list_id = EXCLUDED.list_id,
               section_id = EXCLUDED.section_id,
               workspace_id = EXCLUDED.workspace_id
           WHERE tasks.user_id = EXCLUDED.user_id
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
          source,
          listId,
          sectionId,
          d.position    ?? 0,
          workspaceId,
          d.noteMarkdown === true,
        ]
      );
      await client.query('DELETE FROM trash WHERE id = $1', [trashId]);
      return taskResult.rows[0] ?? null;
    });

    res.json({ success: true, task: restored });
    broadcastToUser(req.userId!, 'trash');
    broadcastToUser(req.userId!, source === 'list' ? 'lists' : 'tasks');
  } catch (err) {
    console.error('trash restore error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/trash/empty  — must come before /:trashId to avoid route conflict
router.delete('/empty', async (req: Request, res: Response) => {
  try {
    await Promise.all([
      query('DELETE FROM trash WHERE user_id = $1', [req.userId]),
      query('DELETE FROM trash_lists WHERE user_id = $1', [req.userId]),
      query('DELETE FROM trash_folders WHERE user_id = $1', [req.userId]),
      query('DELETE FROM trash_timelines WHERE user_id = $1', [req.userId]),
      query('DELETE FROM trash_milestones WHERE user_id = $1', [req.userId]),
    ]);
    res.json({ success: true });
    broadcastToUser(req.userId!, 'trash');
  } catch (err) {
    console.error('trash empty error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/trash/:trashId  — permanently delete a single task trash item
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
    broadcastToUser(req.userId!, 'trash');
  } catch (err) {
    console.error('trash delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// List trash routes
// ---------------------------------------------------------------------------

// GET /api/trash/lists
router.get('/lists', async (req: Request, res: Response) => {
  try {
    const result = await query<TrashListRow>(
      `SELECT * FROM trash_lists WHERE user_id = $1 AND expires_at > NOW() ORDER BY deleted_at DESC`,
      [req.userId]
    );
    res.json({ trash: result.rows.map(sanitizeTrashList) });
  } catch (err) {
    console.error('trash lists GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/trash/lists/:trashId/restore
router.post('/lists/:trashId/restore', async (req: Request, res: Response) => {
  try {
    const trashId = parseInt(req.params.trashId, 10);
    if (isNaN(trashId)) {
      res.status(400).json({ error: 'Invalid trash id' });
      return;
    }

    const trashResult = await query<TrashListRow>(
      `SELECT * FROM trash_lists WHERE id = $1 AND user_id = $2 AND expires_at > NOW()`,
      [trashId, req.userId]
    );

    if (trashResult.rows.length === 0) {
      res.status(404).json({ error: 'Trash item not found or expired' });
      return;
    }

    const d = trashResult.rows[0].list_data as Record<string, unknown>;

    // Restore into the original workspace when still accessible, else Personal
    // — never NULL (a NULL workspace leaks into every view, then gets healed
    // into an arbitrary workspace on the next restart and "vanishes").
    const workspaceId = await resolveRestoreWorkspace(req.userId!, d.workspaceId);
    const folderId = await validateRestoreFolder(req.userId!, workspaceId, d.folderId);

    // Keep sublist linkage only if the parent task still exists and is ours;
    // otherwise restore as a top-level list instead of an unreachable orphan.
    let parentTaskId = d.parentTaskId != null ? String(d.parentTaskId) : null;
    let depth = Number(d.depth ?? 0) || 0;
    if (parentTaskId) {
      const p = await query(`SELECT 1 FROM tasks WHERE id = $1 AND user_id = $2`, [parentTaskId, req.userId]);
      if (p.rows.length === 0) {
        parentTaskId = null;
        depth = 0;
      }
    }

    const sections = (d.sections as Array<Record<string, unknown>>) ?? [];
    const sectionValues: unknown[] = [];
    const taskValues: unknown[] = [];

    // linked_list_id may only be restored when the target list still exists —
    // otherwise the insert would hit a foreign-key violation.
    const linkedIds = new Set<string>();
    for (const section of sections) {
      for (const task of (section.tasks as Array<Record<string, unknown>>) ?? []) {
        const linked = (task.linkedListId ?? task.linked_list_id) as string | null | undefined;
        if (typeof linked === 'string' && linked.length > 0) linkedIds.add(linked);
      }
    }
    const survivingLinked = new Set<string>();
    if (linkedIds.size > 0) {
      const linkedRes = await query<{ id: string }>(
        `SELECT id FROM lists WHERE id = ANY($1::varchar[]) AND user_id = $2`,
        [Array.from(linkedIds), req.userId]
      );
      for (const row of linkedRes.rows) survivingLinked.add(row.id);
    }

    const TASK_COLS = 16;
    for (const section of sections) {
      sectionValues.push(
        section.id, d.id, section.label, section.emoji ?? null, section.position ?? 0
      );

      const tasks = (section.tasks as Array<Record<string, unknown>>) ?? [];
      for (const task of tasks) {
        const linked = (task.linkedListId ?? task.linked_list_id) as string | null | undefined;
        const linkedOk = typeof linked === 'string' && survivingLinked.has(linked);
        taskValues.push(
          task.id, req.userId, task.title, task.note ?? null, task.noteMarkdown === true, task.checked ?? false,
          task.deadline ?? null, task.time ?? null, task.priority ?? null, task.badge ?? null,
          d.id, section.id, task.position ?? 0,
          linkedOk ? linked : null,
          linkedOk ? ((task.linkedListType ?? task.linked_list_type) ?? null) : null,
          workspaceId
        );
      }
    }

    // The whole restore (list + sections + tasks + trash-row delete) is atomic:
    // a mid-way failure must never leave a half-restored list or consume the
    // trash entry.
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO lists (id, user_id, name, emoji, color, color_bg, subtitle, is_public, folder_id, position, parent_task_id, depth, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO NOTHING`,
        [
          d.id, req.userId, d.name, d.emoji ?? null, d.color ?? null,
          d.colorBg ?? null, d.subtitle ?? null, d.isPublic ?? false,
          folderId, d.position ?? 0, parentTaskId, depth, workspaceId,
        ]
      );

      if (sectionValues.length > 0) {
        const rowCount = sectionValues.length / 5;
        const placeholders = Array.from({ length: rowCount }, (_, i) =>
          `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`
        ).join(', ');

        await client.query(
          `INSERT INTO sections (id, list_id, label, emoji, position)
           VALUES ${placeholders}
           ON CONFLICT (id) DO NOTHING`,
          sectionValues
        );
      }

      if (taskValues.length > 0) {
        const itemsPerRow = TASK_COLS;
        const tasksCount = taskValues.length / itemsPerRow;
        const chunkSize = 400; // max 400 tasks per batch (400 * 15 = 6000 params, well under 65535 limit)

        for (let i = 0; i < tasksCount; i += chunkSize) {
          const batchTasks = Math.min(chunkSize, tasksCount - i);
          const batchValues = taskValues.slice(i * itemsPerRow, (i + batchTasks) * itemsPerRow);

          const placeholders = Array.from({ length: batchTasks }, (_, idx) => {
            const offset = idx * itemsPerRow;
            return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, 'list', $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, $${offset + 16})`;
          }).join(', ');

          // Upsert: recapture legacy orphaned task rows (list deletion used to
          // SET NULL their list_id instead of deleting them) so a restored list
          // gets its items back instead of conflicting into an empty list.
          await client.query(
            `INSERT INTO tasks (id, user_id, title, note, note_markdown, checked, deadline, time_val, priority, badge, source, list_id, section_id, position, linked_list_id, linked_list_type, workspace_id)
             VALUES ${placeholders}
             ON CONFLICT (id) DO UPDATE
               SET source = EXCLUDED.source,
                   list_id = EXCLUDED.list_id,
                   section_id = EXCLUDED.section_id,
                   workspace_id = EXCLUDED.workspace_id
               WHERE tasks.user_id = EXCLUDED.user_id`,
            batchValues
          );
        }
      }

      // Heal sublist linkage in both directions (restores can happen in any
      // order): re-point the parent task at this restored sublist, and re-adopt
      // surviving sublists whose linking task was just restored.
      if (parentTaskId) {
        await client.query(
          `UPDATE tasks SET linked_list_id = $1, linked_list_type = COALESCE(linked_list_type, 'sublist')
           WHERE id = $2 AND user_id = $3 AND linked_list_id IS NULL`,
          [d.id, parentTaskId, req.userId]
        );
      }
      await client.query(
        `UPDATE lists l SET parent_task_id = t.id
         FROM tasks t
         WHERE t.list_id = $1 AND t.user_id = $2 AND t.linked_list_type = 'sublist'
           AND t.linked_list_id = l.id AND l.parent_task_id IS NULL`,
        [d.id, req.userId]
      );

      await client.query('DELETE FROM trash_lists WHERE id = $1', [trashId]);
    });

    res.json({ success: true });
    broadcastToUser(req.userId!, 'trash');
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    console.error('trash lists restore error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/trash/lists/:trashId
router.delete('/lists/:trashId', async (req: Request, res: Response) => {
  try {
    const trashId = parseInt(req.params.trashId, 10);
    if (isNaN(trashId)) {
      res.status(400).json({ error: 'Invalid trash id' });
      return;
    }

    const result = await query(
      'DELETE FROM trash_lists WHERE id = $1 AND user_id = $2',
      [trashId, req.userId]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Trash item not found' });
      return;
    }

    res.json({ success: true });
    broadcastToUser(req.userId!, 'trash');
  } catch (err) {
    console.error('trash lists delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Timeline trash routes
// ---------------------------------------------------------------------------

// GET /api/trash/timelines
router.get('/timelines', async (req: Request, res: Response) => {
  try {
    const result = await query<TrashTimelineRow>(
      `SELECT * FROM trash_timelines WHERE user_id = $1 AND expires_at > NOW() ORDER BY deleted_at DESC`,
      [req.userId]
    );
    res.json({ trash: result.rows.map(sanitizeTrashTimeline) });
  } catch (err) {
    console.error('trash timelines GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/trash/timelines/:trashId/restore
router.post('/timelines/:trashId/restore', async (req: Request, res: Response) => {
  try {
    const trashId = parseInt(req.params.trashId, 10);
    if (isNaN(trashId)) {
      res.status(400).json({ error: 'Invalid trash id' });
      return;
    }

    const trashResult = await query<TrashTimelineRow>(
      `SELECT * FROM trash_timelines WHERE id = $1 AND user_id = $2 AND expires_at > NOW()`,
      [trashId, req.userId]
    );
    if (trashResult.rows.length === 0) {
      res.status(404).json({ error: 'Trash item not found or expired' });
      return;
    }

    const d = trashResult.rows[0].timeline_data as Record<string, unknown>;
    const validLayout = ['vertical', 'compact', 'detailed'].includes(d.layout as string) ? d.layout : 'vertical';

    // Same workspace/folder validation as list restore: original workspace when
    // still accessible, else Personal; folder only if it lives in that workspace.
    const workspaceId = await resolveRestoreWorkspace(req.userId!, d.workspaceId);
    const folderId = await validateRestoreFolder(req.userId!, workspaceId, d.folderId);

    // Atomic: timeline + milestones + trash-row delete all-or-nothing.
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO timelines (id, user_id, name, emoji, color, color_bg, subtitle, layout, is_public, folder_id, position, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO NOTHING`,
        [
          d.id, req.userId, d.name, d.emoji ?? null, d.color ?? null,
          d.colorBg ?? null, d.subtitle ?? null, validLayout, d.isPublic ?? false,
          folderId, d.position ?? 0, workspaceId,
        ]
      );

      const milestones = (d.milestones as Array<Record<string, unknown>>) ?? [];
      for (const m of milestones) {
        const ms = ['upcoming', 'in-progress', 'done'].includes(m.status as string) ? m.status : 'upcoming';
        await client.query(
          `INSERT INTO milestones (id, timeline_id, title, description, description_markdown, milestone_date, time_val, status, emoji, color, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (id) DO NOTHING`,
          [
            m.id, d.id, m.title, m.description ?? null, m.descriptionMarkdown === true, m.date ?? null, m.time ?? null,
            ms, m.emoji ?? null, m.color ?? null, m.position ?? 0,
          ]
        );
      }

      await client.query('DELETE FROM trash_timelines WHERE id = $1', [trashId]);
    });

    res.json({ success: true });
    broadcastToUser(req.userId!, 'trash');
    broadcastToUser(req.userId!, 'timelines');
  } catch (err) {
    console.error('trash timelines restore error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/trash/timelines/:trashId
router.delete('/timelines/:trashId', async (req: Request, res: Response) => {
  try {
    const trashId = parseInt(req.params.trashId, 10);
    if (isNaN(trashId)) {
      res.status(400).json({ error: 'Invalid trash id' });
      return;
    }

    const result = await query(
      'DELETE FROM trash_timelines WHERE id = $1 AND user_id = $2',
      [trashId, req.userId]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Trash item not found' });
      return;
    }

    res.json({ success: true });
    broadcastToUser(req.userId!, 'trash');
  } catch (err) {
    console.error('trash timelines delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Folder trash routes
// ---------------------------------------------------------------------------

// GET /api/trash/folders
router.get('/folders', async (req: Request, res: Response) => {
  try {
    const result = await query<TrashFolderRow>(
      `SELECT * FROM trash_folders WHERE user_id = $1 AND expires_at > NOW() ORDER BY deleted_at DESC`,
      [req.userId]
    );
    res.json({ trash: result.rows.map(sanitizeTrashFolder) });
  } catch (err) {
    console.error('trash folders GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/trash/folders/:trashId/restore
router.post('/folders/:trashId/restore', async (req: Request, res: Response) => {
  try {
    const trashId = parseInt(req.params.trashId, 10);
    if (isNaN(trashId)) {
      res.status(400).json({ error: 'Invalid trash id' });
      return;
    }

    const trashResult = await query<TrashFolderRow>(
      `SELECT * FROM trash_folders WHERE id = $1 AND user_id = $2 AND expires_at > NOW()`,
      [trashId, req.userId]
    );

    if (trashResult.rows.length === 0) {
      res.status(404).json({ error: 'Trash item not found or expired' });
      return;
    }

    const d = trashResult.rows[0].folder_data as Record<string, unknown>;
    const listIds = (d.listIds as string[]) ?? [];

    // Restore into an accessible workspace (original when possible) so the
    // folder can never come back pointing at a workspace the user cannot open.
    const workspaceId = await resolveRestoreWorkspace(req.userId!, d.workspaceId);

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO folders (id, user_id, name, emoji, color, position, is_public, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          d.id, req.userId, d.name, d.emoji ?? null, d.color ?? null,
          d.position ?? 0, d.isPublic ?? true, workspaceId,
        ]
      );

      if (listIds.length > 0) {
        // Only re-attach lists that live in the folder's workspace — attaching
        // across workspaces would make them unplaceable in the sidebar.
        await client.query(
          `UPDATE lists SET folder_id = $1
           WHERE id = ANY($2::varchar[]) AND user_id = $3 AND workspace_id IS NOT DISTINCT FROM $4`,
          [d.id, listIds, req.userId, workspaceId]
        );
      }

      await client.query('DELETE FROM trash_folders WHERE id = $1', [trashId]);
    });

    res.json({ success: true });
    broadcastToUser(req.userId!, 'trash');
    broadcastToUser(req.userId!, 'folders');
    broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    console.error('trash folders restore error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/trash/folders/:trashId
router.delete('/folders/:trashId', async (req: Request, res: Response) => {
  try {
    const trashId = parseInt(req.params.trashId, 10);
    if (isNaN(trashId)) {
      res.status(400).json({ error: 'Invalid trash id' });
      return;
    }

    const result = await query(
      'DELETE FROM trash_folders WHERE id = $1 AND user_id = $2',
      [trashId, req.userId]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Trash item not found' });
      return;
    }

    res.json({ success: true });
    broadcastToUser(req.userId!, 'trash');
  } catch (err) {
    console.error('trash folders delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Milestone trash routes
// ---------------------------------------------------------------------------

// GET /api/trash/milestones
router.get('/milestones', async (req: Request, res: Response) => {
  try {
    const result = await query<TrashMilestoneRow>(
      `SELECT * FROM trash_milestones WHERE user_id = $1 AND expires_at > NOW() ORDER BY deleted_at DESC`,
      [req.userId]
    );
    res.json({ trash: result.rows.map(sanitizeTrashMilestone) });
  } catch (err) {
    console.error('trash milestones GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/trash/milestones/:trashId/restore
router.post('/milestones/:trashId/restore', async (req: Request, res: Response) => {
  try {
    const trashId = parseInt(req.params.trashId, 10);
    if (isNaN(trashId)) {
      res.status(400).json({ error: 'Invalid trash id' });
      return;
    }

    const trashResult = await query<TrashMilestoneRow>(
      `SELECT * FROM trash_milestones WHERE id = $1 AND user_id = $2 AND expires_at > NOW()`,
      [trashId, req.userId]
    );
    if (trashResult.rows.length === 0) {
      res.status(404).json({ error: 'Trash item not found or expired' });
      return;
    }

    const trashRow = trashResult.rows[0];
    const d = trashRow.milestone_data as Record<string, unknown>;

    // The parent timeline must still exist (and belong to the user) to restore into.
    const timelineCheck = await query<{ id: string }>(
      'SELECT id FROM timelines WHERE id = $1 AND user_id = $2',
      [trashRow.timeline_id, req.userId]
    );
    if (timelineCheck.rows.length === 0) {
      res.status(409).json({ error: 'The timeline this milestone belonged to no longer exists. Restore the timeline instead.' });
      return;
    }

    const ms = ['upcoming', 'in-progress', 'done'].includes(d.status as string) ? d.status : 'upcoming';
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO milestones (id, timeline_id, title, description, description_markdown, milestone_date, time_val, status, emoji, color, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO NOTHING`,
        [
          d.id ?? trashRow.milestone_id, trashRow.timeline_id, d.title ?? '', d.description ?? null,
          d.descriptionMarkdown === true, d.date ?? null, d.time ?? null, ms, d.emoji ?? null, d.color ?? null, d.position ?? 0,
        ]
      );
      await client.query('DELETE FROM trash_milestones WHERE id = $1', [trashId]);
    });
    res.json({ success: true });
    broadcastToUser(req.userId!, 'trash');
    broadcastToUser(req.userId!, 'timelines');
  } catch (err) {
    console.error('trash milestones restore error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/trash/milestones/:trashId
router.delete('/milestones/:trashId', async (req: Request, res: Response) => {
  try {
    const trashId = parseInt(req.params.trashId, 10);
    if (isNaN(trashId)) {
      res.status(400).json({ error: 'Invalid trash id' });
      return;
    }

    const result = await query(
      'DELETE FROM trash_milestones WHERE id = $1 AND user_id = $2',
      [trashId, req.userId]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Trash item not found' });
      return;
    }

    res.json({ success: true });
    broadcastToUser(req.userId!, 'trash');
  } catch (err) {
    console.error('trash milestones delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
