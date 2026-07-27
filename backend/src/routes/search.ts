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

    // Mirrors the access model used by buildListsForUser/buildTimelinesForUser:
    // owner always sees it; otherwise it's visible if it's public AND the user
    // is a workspace member (or the item/workspace has no membership barrier).
    // A plain `user_id = $1` filter (the old behavior) hid every shared/public
    // item a workspace member didn't happen to own — this is what "search
    // doesn't find everything I have access to" was reporting.
    const listAccess = `(
      l.user_id = $1
      OR (l.is_public = true AND (
        wm.user_id = $1
        OR l.workspace_id IS NULL
        OR EXISTS (SELECT 1 FROM workspaces w WHERE w.id = l.workspace_id AND w.visibility = 'public')
      ))
    )`;
    const timelineAccess = `(
      t.user_id = $1
      OR (t.is_public = true AND (
        wm.user_id = $1
        OR t.workspace_id IS NULL
        OR EXISTS (SELECT 1 FROM workspaces w WHERE w.id = t.workspace_id AND w.visibility = 'public')
      ))
    )`;

    const [dashTasksRes, listTasksRes, listsRes, timelinesRes, milestonesRes, meetingsRes, workspacesRes] = await Promise.all([
      // 1a. Dashboard tasks — owner-only; there's no list/timeline to inherit
      // sharing from.
      query<{ id: string; title: string }>(
        `SELECT id, title FROM tasks
         WHERE user_id = $1 AND source = 'dash' AND (title ILIKE $2 OR note ILIKE $2) LIMIT 10`,
        [userId, term]
      ),
      // 1b. List tasks — visible whenever their containing list is.
      query<{ id: string; title: string; list_id: string }>(
        `SELECT t.id, t.title, t.list_id
         FROM tasks t
         JOIN lists l ON t.list_id = l.id
         LEFT JOIN workspace_members wm ON wm.workspace_id = l.workspace_id AND wm.user_id = $1
         WHERE ${listAccess} AND t.source = 'list' AND (t.title ILIKE $2 OR t.note ILIKE $2)
         LIMIT 10`,
        [userId, term]
      ),
      // 2. Lists
      query<{ id: string; name: string }>(
        `SELECT l.id, l.name FROM lists l
         LEFT JOIN workspace_members wm ON wm.workspace_id = l.workspace_id AND wm.user_id = $1
         WHERE ${listAccess} AND l.name ILIKE $2 LIMIT 5`,
        [userId, term]
      ),
      // 3. Timelines
      query<{ id: string; name: string }>(
        `SELECT t.id, t.name FROM timelines t
         LEFT JOIN workspace_members wm ON wm.workspace_id = t.workspace_id AND wm.user_id = $1
         WHERE ${timelineAccess} AND t.name ILIKE $2 LIMIT 5`,
        [userId, term]
      ),
      // 4. Milestones — visible whenever their containing timeline is.
      query<{ id: string; title: string; timeline_id: string; t_name: string }>(
        `SELECT m.id, m.title, m.timeline_id, t.name as t_name
         FROM milestones m
         JOIN timelines t ON m.timeline_id = t.id
         LEFT JOIN workspace_members wm ON wm.workspace_id = t.workspace_id AND wm.user_id = $1
         WHERE ${timelineAccess} AND m.title ILIKE $2 LIMIT 10`,
        [userId, term]
      ),
      // 5. Meetings — standalone, always owner-only (no list/timeline/workspace).
      query<{ id: string; title: string; meeting_date: string }>(
        `SELECT id, title, meeting_date FROM meetings WHERE user_id = $1 AND (title ILIKE $2 OR location ILIKE $2) LIMIT 5`,
        [userId, term]
      ),
      // 6. Workspaces — member, owner, or publicly visible.
      query<{ id: string; name: string }>(
        `SELECT DISTINCT w.id, w.name FROM workspaces w
         LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = $1
         WHERE (wm.user_id = $1 OR w.owner_id = $1 OR w.visibility = 'public') AND w.name ILIKE $2
         LIMIT 5`,
        [userId, term]
      )
    ]);
    const tasksRes = { rows: [...dashTasksRes.rows.map(t => ({ ...t, source: 'dash', list_id: null as string | null })), ...listTasksRes.rows.map(t => ({ ...t, source: 'list' }))] };

    const results: SearchResult[] = [];

    for (const t of tasksRes.rows) {
      results.push({
        type: 'task',
        id: String(t.id),
        label: t.title,
        sub: t.source === 'list' && t.list_id ? `Board` : 'Dashboard',
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
