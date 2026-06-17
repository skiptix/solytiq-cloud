import { query } from '../db';
import { createAttachmentRouter } from '../attachmentRouter';

async function ownsTask(taskId: string, userId: string): Promise<boolean> {
  const r = await query<{ id: string }>(
    `SELECT id FROM tasks WHERE id = $1 AND user_id = $2`,
    [taskId, userId]
  );
  return r.rows.length > 0;
}

async function canAccessTask(taskId: string, userId: string): Promise<boolean> {
  const r = await query<{ id: string }>(
    `SELECT t.id FROM tasks t
     LEFT JOIN lists l ON t.list_id = l.id
     WHERE t.id = $1
       AND (t.user_id = $2
            OR (t.source = 'list' AND (l.is_public = true OR l.user_id = $2)))`,
    [taskId, userId]
  );
  return r.rows.length > 0;
}

export default createAttachmentRouter({
  table: 'task_attachments',
  parentColumn: 'task_id',
  parentParam: 'taskId',
  parentIdJsonKey: 'taskId',
  filePrefix: 'ta',
  broadcastChannel: 'tasks',
  ownsParent: ownsTask,
  canAccessParent: canAccessTask,
});
