import { query } from '../db';
import { createAttachmentRouter } from '../attachmentRouter';

async function ownsMilestone(milestoneId: string, userId: string): Promise<boolean> {
  const r = await query<{ id: string }>(
    `SELECT m.id FROM milestones m JOIN timelines t ON m.timeline_id = t.id
     WHERE m.id = $1 AND t.user_id = $2`,
    [milestoneId, userId]
  );
  return r.rows.length > 0;
}

async function canAccessMilestone(milestoneId: string, userId: string): Promise<boolean> {
  const r = await query<{ id: string }>(
    `SELECT m.id FROM milestones m JOIN timelines t ON m.timeline_id = t.id
     WHERE m.id = $1 AND (t.user_id = $2 OR t.is_public = true)`,
    [milestoneId, userId]
  );
  return r.rows.length > 0;
}

export default createAttachmentRouter({
  table: 'milestone_attachments',
  parentColumn: 'milestone_id',
  parentParam: 'milestoneId',
  parentIdJsonKey: 'milestoneId',
  filePrefix: 'ma',
  broadcastChannel: 'timelines',
  ownsParent: ownsMilestone,
  canAccessParent: canAccessMilestone,
});
