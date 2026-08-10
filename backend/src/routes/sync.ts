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
import { buildTasksForUser, buildTasksPageForUser, getDashTasksForUserBatch } from './tasks';
import { buildListsForUser, buildListsPageForUser, getListsForUserBatch } from './lists';
import { buildFoldersForUser, buildFoldersPageForUser, getFoldersForUserBatch } from './folders';
import { buildTimelinesForUser, buildTimelinesPageForUser, getTimelinesForUserBatch } from './timelines';
import { BOOTSTRAP_MAX_ROWS_PER_ENTITY } from '../pagination';
import { capDeltaChanges, DELTA_MAX_CHANGES, type DeltaChangeCandidate } from '../deltaCap';

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
const SIGNAL_ENTITIES = new Set(['meeting', 'file', 'workspace', 'trash', 'template', 'automation', 'markdownList', 'notification', 'link', 'knowledgeBase']);

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

    // B5 — bounded bootstrap for every entity type sync ships in one response.
    // Below each cap this returns byte-for-byte the same set the unbounded
    // `buildXForUser` loaders would (nextCursor stays null) — the common
    // case, and every existing pre-Phase-2 workspace, is unaffected. Only a
    // workspace that legitimately exceeds BOOTSTRAP_MAX_ROWS_PER_ENTITY of a
    // given entity gets a truncated first page + `<entity>NextCursor`, which
    // a client can resume from via that entity's own `GET .../?cursor=&limit=`
    // route. `tasks` was bounded first (B6's 100k-row seed proved it's the
    // entity type that genuinely reaches unbounded scale in a busy
    // workspace) — `lists`/`folders`/`timelines` are structurally smaller in
    // practice (bounded by how many boards/pages a team creates, not by how
    // many items are inside them), but are bounded here too now that all
    // three have real cursor-paginated loaders (see lists.ts/folders.ts/
    // timelines.ts's buildXPageForUser) — satisfies the B5 Invariante
    // ("Jede Liste besitzt ein serverseitiges Maximum") uniformly rather than
    // leaving it evidence-gated per entity.
    const [
      { tasks, nextCursor: tasksNextCursor },
      { lists, nextCursor: listsNextCursor },
      { folders, nextCursor: foldersNextCursor },
      { timelines, nextCursor: timelinesNextCursor },
    ] = await Promise.all([
      buildTasksPageForUser(userId, workspaceId, { cursor: null, limit: BOOTSTRAP_MAX_ROWS_PER_ENTITY }),
      buildListsPageForUser(userId, workspaceId, { cursor: null, limit: BOOTSTRAP_MAX_ROWS_PER_ENTITY }),
      buildFoldersPageForUser(userId, workspaceId, { cursor: null, limit: BOOTSTRAP_MAX_ROWS_PER_ENTITY }),
      buildTimelinesPageForUser(userId, workspaceId, { cursor: null, limit: BOOTSTRAP_MAX_ROWS_PER_ENTITY }),
    ]);

    res.json({
      cursor,
      workspaceId: workspaceId ?? null,
      tasks,
      lists,
      folders,
      timelines,
      // Additive fields — a client that doesn't know about them (every
      // existing caller) simply ignores them and keeps working exactly as
      // before; this is what makes the cap backward-compatible rather than
      // a breaking contract change.
      tasksTruncated: tasksNextCursor !== null,
      tasksNextCursor,
      listsTruncated: listsNextCursor !== null,
      listsNextCursor,
      foldersTruncated: foldersNextCursor !== null,
      foldersNextCursor,
      timelinesTruncated: timelinesNextCursor !== null,
      timelinesNextCursor,
    });
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
    // The full raw-scan window's own last seq — used as the cursor ONLY in
    // the (rare) edge case where nothing in this window collapsed into a
    // core change or a signal (e.g. an entity type this endpoint doesn't
    // track), so the client still advances past the whole scanned window
    // instead of being stuck re-scanning the same untracked rows forever.
    // Whenever there IS at least one candidate, `capDeltaChanges`'s own
    // rewound cursor (below) is authoritative instead — see its doc comment
    // for why that's the one that actually guarantees resumability under
    // the spec's caps.
    const rawScanCursor = Number(rows.rows[rows.rows.length - 1].seq);

    // Coalesce churn: one entry per changed core entity (its net effect),
    // plus one entry per signal-entity KIND, tagged with the highest seq it
    // was observed at within this scan window (needed so a later cap-
    // triggered cursor rewind can correctly tell which signals actually fall
    // inside the [since, newCursor] window being returned vs. which don't).
    const latest = new Map<string, { entity: string; entityId: string; seq: number }>();
    const signalSeqs = new Map<string, number>();
    for (const r of rows.rows) {
      const seq = Number(r.seq);
      if (SIGNAL_ENTITIES.has(r.entity)) {
        const prev = signalSeqs.get(r.entity);
        if (prev === undefined || seq > prev) signalSeqs.set(r.entity, seq);
        continue;
      }
      if (CORE_ENTITIES.has(r.entity)) {
        latest.set(`${r.entity}:${r.entity_id}`, { entity: r.entity, entityId: r.entity_id, seq });
      }
    }

    // B5 spec caps ("höchstens 500 Änderungen und höchstens 1 MiB
    // unkomprimiert pro Seite" — see deltaCap.ts): combine core-entity
    // changes AND signal entries into ONE seq-ordered candidate list (both
    // count toward the SAME `changes` array in the response, so both count
    // toward the SAME 500/1-MiB budget), then pre-trim to at most
    // DELTA_MAX_CHANGES BEFORE hydration — a pure ordering optimization
    // (capDeltaChanges's own count cap would produce this exact prefix
    // anyway; pre-trimming here just avoids the DB round trips for entities
    // we'd discard regardless).
    type PreHydrateCandidate = { entity: string; entityId: string; seq: number; isSignal: boolean };
    const combined: PreHydrateCandidate[] = [
      ...[...latest.values()].map((c) => ({ ...c, isSignal: false })),
      ...[...signalSeqs.entries()].map(([entity, seq]) => ({ entity, entityId: '', seq, isSignal: true })),
    ].sort((a, b) => a.seq - b.seq);
    const preTrimmed = combined.slice(0, DELTA_MAX_CHANGES);

    // B5 — batch hydration: re-fetch each changed entity TYPE in one query
    // rather than one query PER changed row. Before this, a delta batch with
    // (say) 400 changed tasks meant 400 sequential round trips to
    // `getDashTaskForUser` alone; now it's exactly one `= ANY(...)` query per
    // entity type present in the batch (at most 4, for task/list/folder/
    // timeline), regardless of how many rows of each type changed. Ordering
    // (the client applies changes in seq order) and the access boundary
    // (re-serialization decides upsert-vs-delete, exactly as before — a batch
    // fetch never widens visibility, `getXForUserBatch` enforces the SAME
    // per-row condition as the singular `getXForUser` it replaces here) are
    // both unchanged; only the fetch STRATEGY changed.
    const idsByEntity: Record<string, string[]> = { task: [], list: [], folder: [], timeline: [] };
    for (const c of preTrimmed) {
      if (!c.isSignal && idsByEntity[c.entity]) idsByEntity[c.entity].push(c.entityId);
    }
    const [taskMap, listMap, folderMap, timelineMap] = await Promise.all([
      getDashTasksForUserBatch(userId, idsByEntity.task),
      getListsForUserBatch(userId, idsByEntity.list),
      getFoldersForUserBatch(userId, idsByEntity.folder),
      getTimelinesForUserBatch(userId, idsByEntity.timeline),
    ]);
    const mapByEntity: Record<string, Map<string, unknown> | undefined> = {
      task: taskMap, list: listMap, folder: folderMap, timeline: timelineMap,
    };

    const candidates: DeltaChangeCandidate[] = preTrimmed.map((c) => {
      if (c.isSignal) return { entity: c.entity, entityId: '', seq: c.seq, op: 'upsert' };
      // Re-serialization is the access boundary: absent from the batch's Map
      // ⇒ gone or no longer visible to this user ⇒ instruct the client to
      // remove it (identical semantics to the old per-row null check).
      const payload = mapByEntity[c.entity]?.get(c.entityId) ?? null;
      return payload
        ? { entity: c.entity, entityId: c.entityId, seq: c.seq, op: 'upsert', payload }
        : { entity: c.entity, entityId: c.entityId, seq: c.seq, op: 'delete' };
    });

    // The real enforcement: caps against the ACTUAL hydrated payload sizes
    // (measured, not estimated) AND the candidate count. With the
    // pre-trim above already at <= DELTA_MAX_CHANGES, this call's count cap
    // is a no-op in practice — it stays here as the single source of truth
    // (defense in depth) rather than trusting the pre-trim alone.
    const capResult = capDeltaChanges(candidates);
    const cursor = capResult.cursor ?? rawScanCursor;
    const changes: Change[] = capResult.changes.map((c) =>
      c.op === 'upsert'
        ? { entity: c.entity, entityId: c.entityId, op: 'upsert', payload: c.payload }
        : { entity: c.entity, entityId: c.entityId, op: 'delete' }
    );

    res.json({
      cursor,
      changes,
      reset: false,
      // Additive field (a client that doesn't know about it just ignores
      // it, same convention as bootstrap's `tasksTruncated`): true when
      // either the pre-hydration count trim OR the post-hydration byte/
      // count cap had to leave candidates out of this page — the client
      // should immediately re-poll `since=cursor` rather than waiting for
      // its normal interval, since there is known-pending work already
      // queued up right behind this page.
      truncated: capResult.truncated || preTrimmed.length < combined.length,
    });
  } catch (err) {
    werr('sync delta error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
