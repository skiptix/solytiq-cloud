import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../db';
import { authenticateAdminApiKey } from '../adminApiKey';

const router = Router();

async function requireAdminApiKey(req: Request, res: Response, next: NextFunction) {
  const auth = req.header('authorization') ?? '';
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  const key = bearer || req.header('x-api-key');
  const result = key ? await authenticateAdminApiKey(key) : null;
  if (!result) {
    res.status(401).json({ error: 'Invalid or missing admin API key' });
    return;
  }
  (req as any).adminApiKeyId = result.keyId;
  next();
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

router.use(requireAdminApiKey);

// GET /api/admin-read/export?workspaceId=...&userId=...
router.get('/export', async (req, res) => {
  try {
    const workspaceId = optionalText(req.query.workspaceId);
    const userId = optionalText(req.query.userId);
    const filters: string[] = [];
    const values: string[] = [];
    if (workspaceId) { values.push(workspaceId); filters.push(`w.id = $${values.length}`); }
    if (userId) { values.push(userId); filters.push(`(w.owner_id = $${values.length} OR EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = $${values.length}))`); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const result = await query(
      `WITH scoped_workspaces AS (
         SELECT w.* FROM workspaces w ${where}
       )
       SELECT jsonb_build_object(
         'generatedAt', NOW(),
         'filters', jsonb_build_object('workspaceId', $${values.length + 1}::text, 'userId', $${values.length + 2}::text),
         'users', COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'id', u.id, 'username', u.username, 'email', u.email, 'fullName', u.full_name,
             'profileImage', u.profile_image, 'isAdmin', u.is_admin, 'lastOnline', u.last_online, 'createdAt', u.created_at
           ) ORDER BY u.created_at)
           FROM users u
           WHERE ($${values.length + 2}::text IS NULL OR u.id::text = $${values.length + 2})
         ), '[]'::jsonb),
         'workspaces', COALESCE((SELECT jsonb_agg(to_jsonb(sw) ORDER BY sw.created_at) FROM scoped_workspaces sw), '[]'::jsonb),
         'workspaceMembers', COALESCE((SELECT jsonb_agg(to_jsonb(wm) ORDER BY wm.joined_at) FROM workspace_members wm JOIN scoped_workspaces sw ON sw.id = wm.workspace_id), '[]'::jsonb),
         'folders', COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.position, f.created_at) FROM folders f JOIN scoped_workspaces sw ON sw.id = f.workspace_id), '[]'::jsonb),
         'sharedFiles', COALESCE((SELECT jsonb_agg(to_jsonb(sf) - 'file_path' - 'password_hash' ORDER BY sf.created_at) FROM shared_files sf WHERE ($${values.length + 2}::text IS NULL OR sf.user_id::text = $${values.length + 2})), '[]'::jsonb),
         'lists', COALESCE((SELECT jsonb_agg(to_jsonb(l) - 'share_password_hash' ORDER BY l.position, l.created_at) FROM lists l JOIN scoped_workspaces sw ON sw.id = l.workspace_id), '[]'::jsonb),
         'sections', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.position) FROM sections s JOIN lists l ON l.id = s.list_id JOIN scoped_workspaces sw ON sw.id = l.workspace_id), '[]'::jsonb),
         'items', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.position, t.created_at) FROM tasks t JOIN scoped_workspaces sw ON sw.id = t.workspace_id), '[]'::jsonb),
         'itemDetails', COALESCE((SELECT jsonb_agg(jsonb_build_object('itemId', t.id, 'note', t.note, 'deadline', t.deadline, 'time', t.time_val, 'priority', t.priority, 'badge', t.badge, 'linkedListId', t.linked_list_id, 'linkedListType', t.linked_list_type, 'updatedAt', t.updated_at) ORDER BY t.updated_at DESC) FROM tasks t JOIN scoped_workspaces sw ON sw.id = t.workspace_id), '[]'::jsonb),
         'timelines', COALESCE((SELECT jsonb_agg(to_jsonb(tl) - 'share_password_hash' ORDER BY tl.position, tl.created_at) FROM timelines tl JOIN scoped_workspaces sw ON sw.id = tl.workspace_id), '[]'::jsonb),
         'milestones', COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.position, m.milestone_date) FROM milestones m JOIN timelines tl ON tl.id = m.timeline_id JOIN scoped_workspaces sw ON sw.id = tl.workspace_id), '[]'::jsonb),
         'milestoneDetails', COALESCE((SELECT jsonb_agg(jsonb_build_object('milestoneId', m.id, 'description', m.description, 'date', m.milestone_date, 'time', m.time_val, 'status', m.status, 'emoji', m.emoji, 'color', m.color, 'createdAt', m.created_at) ORDER BY m.created_at DESC) FROM milestones m JOIN timelines tl ON tl.id = m.timeline_id JOIN scoped_workspaces sw ON sw.id = tl.workspace_id), '[]'::jsonb),
         'meetings', COALESCE((SELECT jsonb_agg(to_jsonb(mt) ORDER BY mt.meeting_date, mt.start_time) FROM meetings mt WHERE ($${values.length + 2}::text IS NULL OR mt.user_id::text = $${values.length + 2})), '[]'::jsonb),
         'timings', COALESCE((SELECT jsonb_agg(entry ORDER BY entry->>'date', entry->>'time') FROM (
           SELECT jsonb_build_object('type', 'item', 'id', t.id, 'workspaceId', t.workspace_id, 'date', t.deadline, 'time', t.time_val, 'title', t.title) entry FROM tasks t JOIN scoped_workspaces sw ON sw.id = t.workspace_id WHERE t.deadline IS NOT NULL OR t.time_val IS NOT NULL
           UNION ALL
           SELECT jsonb_build_object('type', 'milestone', 'id', m.id, 'workspaceId', tl.workspace_id, 'date', m.milestone_date, 'time', m.time_val, 'title', m.title) entry FROM milestones m JOIN timelines tl ON tl.id = m.timeline_id JOIN scoped_workspaces sw ON sw.id = tl.workspace_id WHERE m.milestone_date IS NOT NULL OR m.time_val IS NOT NULL
           UNION ALL
           SELECT jsonb_build_object('type', 'meeting', 'id', mt.id, 'workspaceId', null, 'date', mt.meeting_date, 'time', mt.start_time, 'title', mt.title) entry FROM meetings mt WHERE ($${values.length + 2}::text IS NULL OR mt.user_id::text = $${values.length + 2})
         ) x), '[]'::jsonb),
         'itemAttachments', COALESCE((SELECT jsonb_agg(to_jsonb(a) - 'file_path' ORDER BY a.created_at) FROM task_attachments a JOIN tasks t ON t.id = a.task_id JOIN scoped_workspaces sw ON sw.id = t.workspace_id), '[]'::jsonb),
         'milestoneAttachments', COALESCE((SELECT jsonb_agg(to_jsonb(a) - 'file_path' ORDER BY a.created_at) FROM milestone_attachments a JOIN milestones m ON m.id = a.milestone_id JOIN timelines tl ON tl.id = m.timeline_id JOIN scoped_workspaces sw ON sw.id = tl.workspace_id), '[]'::jsonb)
       ) AS data`,
      [...values, workspaceId, userId]
    );

    res.json(result.rows[0]?.data ?? {});
  } catch (err) {
    console.error('admin-read/export error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
