// ---------------------------------------------------------------------------
// Delta-sync read endpoints.
//
//   GET /api/sync/bootstrap?workspaceId  → full current state for the workspace
//                                          + the cursor (one request).
//   GET /api/sync/delta?since&workspaceId → only what changed after the cursor.
//
// Both re-use the SAME loaders/serializers as the classic list/task/folder/
// timeline GET endpoints, so a bootstrap is byte-for-byte the data the app
// already renders, and a delta re-serializes the exact same shape — no drift.
//
// Security: every read is scoped to the verified req.userId and re-checks
// workspace access (userCanAccessWorkspace). The sync_log push audience only
// decides who gets *nudged*; THIS is the real access boundary — a user who lost
// access gets 403 / empty deltas even if a stale nudge reached them.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from 'express';
import { query } from '../db';
import { authenticate } from '../middleware';
import { userCanAccessWorkspace, werr } from '../workspaceUtil';
import { buildTasksForUser, getDashTaskForUser } from './tasks';
import { buildListsForUser, getListForUser } from './lists';
import { buildFoldersForUser, getFolderForUser } from './folders';
import { buildTimelinesForUser, getTimelineForUser } from './timelines';

const router = Router();
router.use(authenticate);

// These endpoints are safe to conditionally revalidate (their ETag encodes the
// cursor), so undo the blanket no-store the global /api middleware sets. Each
// handler then sets `Cache-Control: private, no-cache` + an ETag.
router.use((_req, res, next) => {
  res.removeHeader('Pragma');
  res.removeHeader('Expires');
  res.removeHeader('Surrogate-Control');
  next();
});

const DELTA_SCAN_LIMIT = 1000;
// Entities the app store patches from full payloads.
const CORE_ENTITIES = new Set(['task', 'list', 'folder', 'timeline']);
// Entities the client reacts to by refetching (screens/stores own their data).
const SIGNAL_ENTITIES = new Set(['meeting', 'file', 'workspace', 'trash', 'template', 'automation', 'markdownList', 'notification']);

interface Change {
  entity: string;
  entityId: string;
  op: 'upsert' | 'delete';
  payload?: unknown;
}

/**
 * The highest seq visible in this view (workspace rows + the user's own
 * user-global rows). Used as both the delta baseline cursor and the ETag, so
 * an unchanged view revalidates to 304 for free.
 */
async function viewCursor(userId: string, workspaceId?: string): Promise<number> {
  if (workspaceId) {
    const r = await query<{ m: string }>(
      `SELECT COALESCE(MAX(seq), 0) AS m FROM sync_log
       WHERE workspace_id = $1 OR (workspace_id IS NULL AND owner_id = $2)`,
      [workspaceId, userId]
    );
    return Number(r.rows[0].m);
  }
  const r = await query<{ m: string }>(`SELECT COALESCE(MAX(seq), 0) AS m FROM sync_log`);
  return Number(r.rows[0].m);
}

// GET /api/sync/bootstrap
router.get('/bootstrap', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const workspaceId = req.query.workspaceId as string | undefined;
    if (workspaceId && !(await userCanAccessWorkspace(userId, workspaceId))) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    // Read the cursor BEFORE the data so a write that lands mid-read is caught by
    // the next delta (at-least-once), never silently missed.
    const cursor = await viewCursor(userId, workspaceId);
    const etag = `"ws:${workspaceId ?? 'all'}:${cursor}"`;
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    const [tasks, lists, folders, timelines] = await Promise.all([
      buildTasksForUser(userId, workspaceId),
      buildListsForUser(userId, workspaceId),
      buildFoldersForUser(userId, workspaceId),
      buildTimelinesForUser(userId, workspaceId),
    ]);

    res.json({ cursor, workspaceId: workspaceId ?? null, tasks, lists, folders, timelines });
  } catch (err) {
    werr('sync bootstrap error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/sync/delta
router.get('/delta', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const workspaceId = req.query.workspaceId as string | undefined;
    const since = Math.max(0, Math.floor(Number(req.query.since)) || 0);

    if (workspaceId && !(await userCanAccessWorkspace(userId, workspaceId))) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    res.setHeader('Cache-Control', 'private, no-cache');

    // Retention floor: a cursor older than the oldest kept row means the client
    // may have missed pruned events → tell it to re-bootstrap.
    const floor = await query<{ min: string | null }>(`SELECT MIN(seq) AS min FROM sync_log`);
    const minSeq = floor.rows[0].min != null ? Number(floor.rows[0].min) : 0;
    if (since > 0 && minSeq > 0 && since < minSeq) {
      res.json({ cursor: since, changes: [], reset: true });
      return;
    }

    const params: unknown[] = [since];
    let filter: string;
    if (workspaceId) {
      params.push(workspaceId, userId);
      filter = `(workspace_id = $2 OR (workspace_id IS NULL AND owner_id = $3))`;
    } else {
      params.push(userId);
      filter = `(workspace_id IS NULL AND owner_id = $2)`;
    }

    const rows = await query<{ seq: string; entity: string; entity_id: string; op: string }>(
      `SELECT seq, entity, entity_id, op FROM sync_log
       WHERE seq > $1 AND ${filter}
       ORDER BY seq ASC LIMIT ${DELTA_SCAN_LIMIT}`,
      params
    );

    if (rows.rows.length === 0) {
      res.json({ cursor: since, changes: [], reset: false });
      return;
    }
    const cursor = Number(rows.rows[rows.rows.length - 1].seq);

    // Coalesce churn: one entry per changed core entity (its net effect), plus a
    // deduped refetch signal per signal-entity kind.
    const latest = new Map<string, { entity: string; entityId: string; seq: number }>();
    const signals = new Set<string>();
    for (const r of rows.rows) {
      if (SIGNAL_ENTITIES.has(r.entity)) { signals.add(r.entity); continue; }
      if (CORE_ENTITIES.has(r.entity)) {
        latest.set(`${r.entity}:${r.entity_id}`, { entity: r.entity, entityId: r.entity_id, seq: Number(r.seq) });
      }
    }

    const changes: Change[] = [];
    for (const c of [...latest.values()].sort((a, b) => a.seq - b.seq)) {
      let payload: unknown = null;
      switch (c.entity) {
        case 'task':     payload = await getDashTaskForUser(userId, c.entityId); break;
        case 'list':     payload = await getListForUser(userId, c.entityId); break;
        case 'folder':   payload = await getFolderForUser(userId, c.entityId); break;
        case 'timeline': payload = await getTimelineForUser(userId, c.entityId); break;
      }
      // Re-serialization is the access boundary: null ⇒ gone or no longer visible
      // to this user ⇒ instruct the client to remove it.
      if (payload) changes.push({ entity: c.entity, entityId: c.entityId, op: 'upsert', payload });
      else changes.push({ entity: c.entity, entityId: c.entityId, op: 'delete' });
    }
    for (const entity of signals) changes.push({ entity, entityId: '', op: 'upsert' });

    res.json({ cursor, changes, reset: false });
  } catch (err) {
    werr('sync delta error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
