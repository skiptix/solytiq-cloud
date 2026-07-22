// ---------------------------------------------------------------------------
// /api/tasks/:taskId/tags — tagged users on an item (task).
//
// The item dialog's "Tag" row lists the users tagged on a task. The item's
// creator is always shown implicitly (the owner chip) and is not stored here;
// this table only holds the ADDITIONAL users tagged onto the item.
//
// Access model (members-only, notify-only — see CLAUDE.md):
//   • Read tags: anyone who can SEE the task.
//   • Add/remove tags: only the task owner (or an admin) — mirrors who may edit
//     the task itself.
//   • A user can only be tagged if they are a member of the task's workspace,
//     so tagging never exposes the item to anyone who couldn't already see it.
// A newly tagged user always gets a notification.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from 'express';
import { query } from '../db';
import { authenticate } from '../middleware';
import { broadcastToUser } from '../sse';
import { werr } from '../workspaceUtil';
import { createNotification } from '../notifications';

const router = Router({ mergeParams: true });
router.use(authenticate);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TaskInfo {
  id: string;
  user_id: string;
  source: string;
  list_id: string | null;
  workspace_id: string | null;
  title: string;
}

async function getTask(taskId: string): Promise<TaskInfo | null> {
  // Task ids are BIGINT; reject anything non-numeric before it reaches the cast.
  if (!/^\d+$/.test(taskId)) return null;
  const r = await query<TaskInfo>(
    `SELECT id, user_id, source, list_id, workspace_id, title FROM tasks WHERE id = $1`,
    [taskId]
  );
  return r.rows[0] ?? null;
}

/** True if this user may SEE the task (owner, or a list they can access). */
async function canViewTask(task: TaskInfo, userId: string): Promise<boolean> {
  if (task.user_id === userId) return true;
  if (task.source === 'list' && task.list_id) {
    const r = await query(
      `SELECT 1 FROM lists l
         LEFT JOIN workspace_members wm ON wm.workspace_id = l.workspace_id AND wm.user_id = $2
        WHERE l.id = $1
          AND (l.user_id = $2
               OR (l.is_public = true AND (
                     wm.user_id = $2
                     OR l.workspace_id IS NULL
                     OR EXISTS (SELECT 1 FROM workspaces w WHERE w.id = l.workspace_id AND w.visibility = 'public')
                  )))`,
      [task.list_id, userId]
    );
    return r.rows.length > 0;
  }
  return false;
}


interface TaggedRow {
  user_id: string;
  username: string;
  full_name: string | null;
  has_image: boolean;
  tagged_by: string | null;
  created_at: string;
}

function sanitizeTagged(r: TaggedRow) {
  return {
    userId:    r.user_id,
    username:  r.username,
    fullName:  r.full_name ?? null,
    hasImage:  r.has_image,
    taggedBy:  r.tagged_by ?? null,
    createdAt: r.created_at,
  };
}

async function loadTags(taskId: string) {
  const r = await query<TaggedRow>(
    `SELECT tt.user_id, u.username, u.full_name, (u.profile_image IS NOT NULL) AS has_image, tt.tagged_by, tt.created_at
       FROM task_tags tt JOIN users u ON u.id = tt.user_id
      WHERE tt.task_id = $1
      ORDER BY tt.created_at ASC`,
    [taskId]
  );
  return r.rows.map(sanitizeTagged);
}

// GET /api/tasks/:taskId/tags
router.get('/', async (req: Request, res: Response) => {
  try {
    const taskId = (req.params as { taskId: string }).taskId;
    const task = await getTask(taskId);
    if (!task) { res.status(404).json({ error: 'Task not found' }); return; }
    if (!(await canViewTask(task, req.userId!)) && !req.user?.isAdmin) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json({ tags: await loadTags(taskId) });
  } catch (err) {
    werr('task tags GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/tasks/:taskId/tags  { userId }
router.post('/', async (req: Request, res: Response) => {
  try {
    const taskId = (req.params as { taskId: string }).taskId;
    const { userId } = req.body as { userId?: string };
    if (!userId || !UUID_RE.test(userId)) { res.status(400).json({ error: 'A valid userId is required' }); return; }

    const task = await getTask(taskId);
    if (!task) { res.status(404).json({ error: 'Task not found' }); return; }
    // Only the task owner (or admin) may change tags.
    if (task.user_id !== req.userId && !req.user?.isAdmin) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }
    // Members-only, notify-only: the tagged user must ALREADY be able to see
    // this item (a workspace member whose list/timeline is workspace-visible).
    // Gating on actual visibility — not just workspace membership — means a tag
    // never discloses a private item's title and the notification's deep-link
    // always resolves. (Tagging yourself is a no-op the owner check already
    // permits; it's harmless and never notifies — see createNotification.)
    if (userId !== task.user_id && !(await canViewTask(task, userId))) {
      res.status(400).json({ error: "This user can't see this item — make its list visible to the workspace first" });
      return;
    }

    const inserted = await query(
      `INSERT INTO task_tags (task_id, user_id, tagged_by) VALUES ($1, $2, $3)
       ON CONFLICT (task_id, user_id) DO NOTHING`,
      [taskId, userId, req.userId]
    );

    // Notify only on a genuinely new tag (not a duplicate re-add).
    if ((inserted.rowCount ?? 0) > 0) {
      await createNotification({
        userId,
        type: 'item_tagged',
        actorId: req.userId!,
        title: `tagged you on "${task.title}"`,
        body: null,
        entityType: 'task',
        entityId: taskId,
        workspaceId: task.workspace_id,
        data: { listId: task.list_id, source: task.source, taskTitle: task.title },
      });
    }

    // Nudge the task owner's other devices to refresh the dialog's tag row.
    broadcastToUser(req.userId!, 'lists');
    res.status(201).json({ tags: await loadTags(taskId) });
  } catch (err) {
    werr('task tags POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/tasks/:taskId/tags/:userId
router.delete('/:userId', async (req: Request, res: Response) => {
  try {
    const taskId = (req.params as { taskId: string; userId: string }).taskId;
    const userId = (req.params as { taskId: string; userId: string }).userId;
    // Guard the UUID cast — a malformed :userId would otherwise 500 on the
    // `user_id = $2` comparison instead of cleanly no-opping.
    if (!UUID_RE.test(userId)) { res.status(400).json({ error: 'Invalid userId' }); return; }
    const task = await getTask(taskId);
    if (!task) { res.status(404).json({ error: 'Task not found' }); return; }
    if (task.user_id !== req.userId && !req.user?.isAdmin) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }
    await query(`DELETE FROM task_tags WHERE task_id = $1 AND user_id = $2`, [taskId, userId]);
    broadcastToUser(req.userId!, 'lists');
    res.json({ tags: await loadTags(taskId) });
  } catch (err) {
    werr('task tags DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
