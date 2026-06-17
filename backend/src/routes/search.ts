import { Router, Request, Response } from 'express';
import { query } from '../db';
import { authenticate } from '../middleware';

const router = Router();
router.use(authenticate);

export interface SearchResult {
  type: 'task' | 'list' | 'timeline' | 'milestone' | 'meeting' | 'workspace';
  id: string;
  label: string;
  sub?: string;
  path: string;
  icon?: string;
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const q = req.query.q as string;
    if (!q || q.length < 2) {
      res.json({ results: [] });
      return;
    }
    const term = `%${q}%`;
    const userId = req.userId!;

    const [tasksRes, listsRes, timelinesRes, milestonesRes, meetingsRes, workspacesRes] = await Promise.all([
      // 1. Tasks
      query<{ id: string; title: string; source: string; list_id: string | null }>(
        `SELECT id, title, source, list_id FROM tasks WHERE user_id = $1 AND (title ILIKE $2 OR note ILIKE $2) LIMIT 10`,
        [userId, term]
      ),
      // 2. Lists
      query<{ id: string; name: string }>(
        `SELECT id, name FROM lists WHERE user_id = $1 AND name ILIKE $2 LIMIT 5`,
        [userId, term]
      ),
      // 3. Timelines
      query<{ id: string; name: string }>(
        `SELECT id, name FROM timelines WHERE user_id = $1 AND name ILIKE $2 LIMIT 5`,
        [userId, term]
      ),
      // 4. Milestones
      query<{ id: string; title: string; timeline_id: string; t_name: string }>(
        `SELECT m.id, m.title, m.timeline_id, t.name as t_name 
         FROM milestones m 
         JOIN timelines t ON m.timeline_id = t.id 
         WHERE t.user_id = $1 AND m.title ILIKE $2 LIMIT 10`,
        [userId, term]
      ),
      // 5. Meetings
      query<{ id: string; title: string; meeting_date: string }>(
        `SELECT id, title, meeting_date FROM meetings WHERE user_id = $1 AND (title ILIKE $2 OR location ILIKE $2) LIMIT 5`,
        [userId, term]
      ),
      // 6. Workspaces
      query<{ id: string; name: string }>(
        `SELECT w.id, w.name FROM workspaces w
         JOIN workspace_members wm ON w.id = wm.workspace_id
         WHERE wm.user_id = $1 AND w.name ILIKE $2 LIMIT 5`,
        [userId, term]
      )
    ]);

    const results: SearchResult[] = [];

    for (const t of tasksRes.rows) {
      results.push({
        type: 'task',
        id: String(t.id),
        label: t.title,
        sub: t.source === 'list' && t.list_id ? `List` : 'Dashboard',
        path: t.source === 'list' && t.list_id ? `/list/${t.list_id}` : '/dashboard',
      });
    }

    for (const l of listsRes.rows) {
      results.push({ type: 'list', id: l.id, label: l.name, path: `/list/${l.id}` });
    }

    for (const tl of timelinesRes.rows) {
      results.push({ type: 'timeline', id: tl.id, label: tl.name, path: `/timeline/${tl.id}` });
    }

    for (const m of milestonesRes.rows) {
      results.push({ type: 'milestone', id: m.id, label: m.title, sub: `in ${m.t_name}`, path: `/timeline/${m.timeline_id}` });
    }

    for (const mt of meetingsRes.rows) {
      results.push({ type: 'meeting', id: mt.id, label: mt.title, sub: `On ${mt.meeting_date}`, path: '/calendar' });
    }

    for (const w of workspacesRes.rows) {
      results.push({ type: 'workspace', id: w.id, label: w.name, sub: 'Workspace', path: `/dashboard?workspace=${w.id}` });
    }

    res.json({ results });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
