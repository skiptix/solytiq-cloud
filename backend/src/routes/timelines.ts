import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db';
import { authenticate } from '../middleware';
import { hashPassword } from '../auth';
import { broadcastToUser } from '../sse';
import { versionGuardSql, resolveVersionedUpdateFailure } from '../concurrency';
import { validateReorderIds, bulkSetPositions } from '../reorderUtil';
import { resolveWorkspaceForUser, userCanAccessWorkspace, wlog, werr } from '../workspaceUtil';
import { snapshotTimelineToTrash } from '../trashUtil';
import { getPrivateAncestors, buildPromoteConflict, promoteAncestors, buildRestrictConflict } from '../visibility';
import { notifyNewMentions } from '../mentions';
import { isItemSharedWith, deleteItemShares } from '../itemShares';
import { objectAccessCondition, workspaceMembersJoin } from '../objectPolicy';
import { syncInlineLinksForText } from '../graph/inlineLinks';
import { enqueueEmbedding } from '../knowledge/queue';
import { decodeKeysetCursor, encodeKeysetCursor, parsePageLimit, paginateRows, type KeysetCursor } from '../pagination';

const router = Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface TimelineRow {
  id: string;
  user_id: string;
  name: string;
  emoji: string | null;
  color: string | null;
  color_bg: string | null;
  subtitle: string | null;
  layout: string;
  is_public: boolean;
  folder_id: string | null;
  workspace_id: string | null;
  position: number;
  created_at: string;
  share_token: string | null;
  share_enabled: boolean;
  share_password_hash: string | null;
  share_expires_at: string | null;
  version?: number;
}

interface MilestoneRow {
  id: string;
  timeline_id: string;
  title: string;
  description: string | null;
  description_markdown: boolean;
  milestone_date: string | null;
  time_val: string | null;
  status: string;
  emoji: string | null;
  color: string | null;
  position: number;
  created_at: string;
  attachment_count?: string;
}

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------

function sanitizeMilestone(m: MilestoneRow) {
  return {
    id:          m.id,
    timelineId:  m.timeline_id,
    title:       m.title,
    description: m.description,
    descriptionMarkdown: m.description_markdown ?? false,
    date:        m.milestone_date,
    time:        m.time_val,
    status:      m.status,
    emoji:       m.emoji,
    color:       m.color,
    position:    m.position,
    createdAt:   m.created_at,
    attachmentCount: Number(m.attachment_count ?? 0),
  };
}

function sanitizeTimeline(t: TimelineRow, milestones: ReturnType<typeof sanitizeMilestone>[]) {
  return {
    id:          t.id,
    userId:      t.user_id,
    name:        t.name,
    emoji:       t.emoji,
    color:       t.color,
    colorBg:     t.color_bg,
    subtitle:    t.subtitle,
    layout:      t.layout,
    isPublic:    t.is_public,
    folderId:    t.folder_id ?? undefined,
    workspaceId: t.workspace_id ?? undefined,
    position:    t.position,
    createdAt:   t.created_at,
    shareEnabled:     t.share_enabled ?? false,
    shareToken:       t.share_token ?? null,
    shareHasPassword: t.share_password_hash != null,
    shareExpiresAt:   t.share_expires_at ?? null,
    version:     t.version ?? 1,
    milestones,
  };
}

// ---------------------------------------------------------------------------
// Helper: build full timeline objects (timelines → milestones)
// ---------------------------------------------------------------------------

function summarizeTimelineRows(rows: TimelineRow[]): string {
  if (rows.length === 0) return 'none';
  return rows
    .slice(0, 25)
    .map((t) => `${t.id}{ws=${t.workspace_id ?? 'NULL'},folder=${t.folder_id ?? 'root'},owner=${t.user_id},public=${t.is_public}}`)
    .join(', ') + (rows.length > 25 ? `, … +${rows.length - 25} more` : '');
}

export async function buildTimelinesForUser(userId: string, workspaceId?: string) {
  const params: unknown[] = [userId];
  const wsFilter = workspaceId
    ? `AND (t.workspace_id = $2 OR t.workspace_id IS NULL)`
    : '';
  if (workspaceId) params.push(workspaceId);

  // Mirrors the lists access model (see objectPolicy.ts): owner always; public
  // timelines visible to workspace members, to legacy NULL-workspace
  // timelines, or in public workspaces.
  const accessCondition = objectAccessCondition('t', 'timeline');
  const wmJoin = workspaceMembersJoin('t');

  const [timelinesResult, milestonesResult] = await Promise.all([
    query<TimelineRow>(
      `SELECT t.* FROM timelines t
       ${wmJoin}
       WHERE ${accessCondition}
       ${wsFilter}
       ORDER BY t.position ASC, t.created_at ASC`,
      params
    ),
    query<MilestoneRow>(
      `SELECT m.*, (SELECT COUNT(*) FROM milestone_attachments ma WHERE ma.milestone_id = m.id) AS attachment_count
       FROM milestones m
       JOIN timelines t ON m.timeline_id = t.id
       ${wmJoin}
       WHERE ${accessCondition}
       ${wsFilter}
       ORDER BY m.position ASC, m.milestone_date ASC NULLS LAST, m.created_at ASC`,
      params
    ),
  ]);

  const milestonesByTimeline: Record<string, ReturnType<typeof sanitizeMilestone>[]> = {};
  for (const m of milestonesResult.rows) {
    if (!milestonesByTimeline[m.timeline_id]) milestonesByTimeline[m.timeline_id] = [];
    milestonesByTimeline[m.timeline_id].push(sanitizeMilestone(m));
  }

  wlog(
    `timelines BUILD user=${userId} requestedWorkspace=${workspaceId ?? 'ALL'} → ` +
    `${timelinesResult.rows.length} timeline(s), ${milestonesResult.rows.length} milestone(s); ` +
    `timelines=[${summarizeTimelineRows(timelinesResult.rows)}]`
  );

  return timelinesResult.rows.map((t) =>
    sanitizeTimeline(t, milestonesByTimeline[t.id] ?? [])
  );
}

// B5 (Phase 2 follow-up): keyset-paginated variant of buildTimelinesForUser —
// same rationale as lists.ts's buildListsPageForUser: cursor-bound the
// TOP-LEVEL `timelines` rows first, then hydrate milestones scoped to ONLY
// that page's timeline ids, rather than the full access-condition scan.
export async function buildTimelinesPageForUser(
  userId: string,
  workspaceId: string | undefined,
  opts: { cursor: KeysetCursor | null; limit: number }
): Promise<{ timelines: ReturnType<typeof sanitizeTimeline>[]; nextCursor: string | null }> {
  const params: unknown[] = [userId];
  const wsClause = workspaceId ? `AND (t.workspace_id = $2 OR t.workspace_id IS NULL)` : '';
  if (workspaceId) params.push(workspaceId);

  let cursorClause = '';
  if (opts.cursor) {
    params.push(opts.cursor.position, opts.cursor.createdAt, opts.cursor.id);
    const n = params.length;
    cursorClause = `AND (t.position, EXTRACT(EPOCH FROM t.created_at)::double precision, t.id) > ($${n - 2}, $${n - 1}::double precision, $${n})`;
  }

  params.push(opts.limit + 1);
  const limitParamIndex = params.length;

  const timelinesResult = await query<TimelineRow & { created_at_epoch: number }>(
    `SELECT t.*, EXTRACT(EPOCH FROM t.created_at)::double precision AS created_at_epoch
     FROM timelines t
     ${workspaceMembersJoin('t')}
     WHERE ${objectAccessCondition('t', 'timeline')}
     ${wsClause}
     ${cursorClause}
     ORDER BY t.position ASC, t.created_at ASC, t.id ASC
     LIMIT $${limitParamIndex}`,
    params
  );

  const { page, nextCursor } = paginateRows(timelinesResult.rows, opts.limit, (row) => ({
    position: row.position,
    createdAt: row.created_at_epoch,
    id: row.id,
  }), encodeKeysetCursor);

  if (page.length === 0) return { timelines: [], nextCursor };

  const timelineIds = page.map((t) => t.id);
  const milestonesResult = await query<MilestoneRow>(
    `SELECT m.*, (SELECT COUNT(*) FROM milestone_attachments ma WHERE ma.milestone_id = m.id) AS attachment_count
     FROM milestones m WHERE m.timeline_id = ANY($1::varchar[])
     ORDER BY m.position ASC, m.milestone_date ASC NULLS LAST, m.created_at ASC`,
    [timelineIds]
  );
  const milestonesByTimeline: Record<string, ReturnType<typeof sanitizeMilestone>[]> = {};
  for (const m of milestonesResult.rows) {
    if (!milestonesByTimeline[m.timeline_id]) milestonesByTimeline[m.timeline_id] = [];
    milestonesByTimeline[m.timeline_id].push(sanitizeMilestone(m));
  }

  const timelines = page.map((t) => sanitizeTimeline(t, milestonesByTimeline[t.id] ?? []));
  return { timelines, nextCursor };
}

/**
 * A single fully-hydrated timeline (with milestones) if the user can see it,
 * else null. Same shape as one element of `buildTimelinesForUser`. For delta
 * re-serialization, scoped to the requesting user (IDOR-safe).
 */
export async function getTimelineForUser(userId: string, timelineId: string) {
  const accessCondition = objectAccessCondition('t', 'timeline');
  const tRes = await query<TimelineRow>(
    `SELECT t.* FROM timelines t
     ${workspaceMembersJoin('t')}
     WHERE t.id = $2 AND ${accessCondition}`,
    [userId, timelineId]
  );
  if (tRes.rows.length === 0) return null;
  const mRes = await query<MilestoneRow>(
    `SELECT m.*, (SELECT COUNT(*) FROM milestone_attachments ma WHERE ma.milestone_id = m.id) AS attachment_count
     FROM milestones m WHERE m.timeline_id = $1
     ORDER BY m.position ASC, m.milestone_date ASC NULLS LAST, m.created_at ASC`,
    [timelineId]
  );
  return sanitizeTimeline(tRes.rows[0], mRes.rows.map(sanitizeMilestone));
}

/**
 * B5: batch-hydrate MANY timelines (with their milestones) in a bounded,
 * fixed number of queries (2, regardless of how many timeline ids are
 * requested) instead of the N round-trips `getTimelineForUser` called in a
 * loop would cost — used by `/api/sync/delta`'s re-serialization of a batch
 * of changed timeline ids. Same per-row access boundary as
 * `getTimelineForUser`/`buildTimelinesForUser` — a requested id the caller
 * can't see is simply absent from the returned Map.
 */
export async function getTimelinesForUserBatch(userId: string, timelineIds: string[]): Promise<Map<string, ReturnType<typeof sanitizeTimeline>>> {
  const map = new Map<string, ReturnType<typeof sanitizeTimeline>>();
  if (timelineIds.length === 0) return map;

  const accessCondition = objectAccessCondition('t', 'timeline');
  const tRes = await query<TimelineRow>(
    `SELECT t.* FROM timelines t
     ${workspaceMembersJoin('t')}
     WHERE t.id = ANY($2::varchar[]) AND ${accessCondition}`,
    [userId, timelineIds]
  );
  if (tRes.rows.length === 0) return map;
  const visibleIds = tRes.rows.map((t) => t.id);

  const mRes = await query<MilestoneRow>(
    `SELECT m.*, (SELECT COUNT(*) FROM milestone_attachments ma WHERE ma.milestone_id = m.id) AS attachment_count
     FROM milestones m WHERE m.timeline_id = ANY($1::varchar[])
     ORDER BY m.position ASC, m.milestone_date ASC NULLS LAST, m.created_at ASC`,
    [visibleIds]
  );
  const milestonesByTimeline: Record<string, ReturnType<typeof sanitizeMilestone>[]> = {};
  for (const m of mRes.rows) {
    if (!milestonesByTimeline[m.timeline_id]) milestonesByTimeline[m.timeline_id] = [];
    milestonesByTimeline[m.timeline_id].push(sanitizeMilestone(m));
  }
  for (const t of tRes.rows) {
    map.set(t.id, sanitizeTimeline(t, milestonesByTimeline[t.id] ?? []));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Timelines CRUD
// ---------------------------------------------------------------------------

// GET /api/timelines
// Backward-compatible: no cursor/limit → identical unbounded {timelines}
// response as before. Either param → paginated {timelines, nextCursor} shape.
router.get('/', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    const wantsPage = req.query.cursor !== undefined || req.query.limit !== undefined;
    if (wantsPage) {
      const cursor = decodeKeysetCursor(req.query.cursor);
      const limit = parsePageLimit(req.query.limit);
      const { timelines, nextCursor } = await buildTimelinesPageForUser(req.userId!, workspaceId, { cursor, limit });
      wlog(`timelines GET(paged) user=${req.userId} workspace=${workspaceId ?? 'ALL'} limit=${limit} → ${timelines.length} timeline(s), nextCursor=${nextCursor ? 'yes' : 'no'}`);
      res.json({ timelines, nextCursor });
      return;
    }
    wlog(`timelines GET ⇢ user=${req.userId} requestedWorkspace=${workspaceId ?? 'ALL'} rawQuery=${JSON.stringify(req.query)}`);
    const timelines = await buildTimelinesForUser(req.userId!, workspaceId);
    wlog(`timelines GET ⇠ user=${req.userId} requestedWorkspace=${workspaceId ?? 'ALL'} returned=${timelines.length} ids=[${timelines.slice(0, 25).map(t => `${t.id}{ws=${t.workspaceId ?? 'NULL'},folder=${t.folderId ?? 'root'}}`).join(', ')}${timelines.length > 25 ? `, … +${timelines.length - 25} more` : ''}]`);
    res.json({ timelines });
  } catch (err) {
    werr('timelines GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/timelines/upcoming — the next N upcoming milestones across all
// accessible timelines, ordered by date. Optionally scoped to a single folder.
router.get('/upcoming', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    const folderId = req.query.folderId as string | undefined;
    const rawLimit = parseInt(String(req.query.limit ?? '3'), 10);
    const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 3 : rawLimit, 1), 20);

    const params: unknown[] = [req.userId];
    const accessCondition = objectAccessCondition('t', 'timeline');

    let wsFilter = '';
    if (workspaceId) {
      params.push(workspaceId);
      wsFilter = `AND (t.workspace_id = $${params.length} OR t.workspace_id IS NULL)`;
    }
    let folderFilter = '';
    if (folderId) {
      params.push(folderId);
      folderFilter = `AND t.folder_id = $${params.length}`;
    }
    params.push(limit);
    const limitIdx = params.length;

    const result = await query<
      MilestoneRow & { timeline_name: string; timeline_emoji: string | null; timeline_color: string | null }
    >(
      `SELECT m.id, m.timeline_id, m.title, m.description, m.description_markdown, m.milestone_date, m.time_val, m.status, m.emoji, m.color, m.position, m.created_at,
              t.name AS timeline_name, t.emoji AS timeline_emoji, t.color AS timeline_color
       FROM milestones m
       JOIN timelines t ON m.timeline_id = t.id
       LEFT JOIN workspace_members wm ON wm.workspace_id = t.workspace_id AND wm.user_id = $1
       WHERE ${accessCondition}
         ${wsFilter}
         ${folderFilter}
         AND m.milestone_date IS NOT NULL
         AND m.milestone_date >= CURRENT_DATE
         AND m.status <> 'done'
       ORDER BY m.milestone_date ASC, m.time_val ASC NULLS LAST, m.position ASC
       LIMIT $${limitIdx}`,
      params
    );

    const milestones = result.rows.map((m) => ({
      ...sanitizeMilestone(m),
      timelineName: m.timeline_name,
      timelineEmoji: m.timeline_emoji,
      timelineColor: m.timeline_color,
    }));

    res.json({ milestones });
  } catch (err) {
    werr('timelines upcoming error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/timelines
router.post('/', async (req: Request, res: Response) => {
  try {
    const { id, name, emoji, color, colorBg, subtitle, layout, isPublic, folderId, workspaceId } = req.body as {
      id?: string;
      name?: string;
      emoji?: string;
      color?: string;
      colorBg?: string;
      subtitle?: string;
      layout?: string;
      isPublic?: boolean;
      folderId?: string;
      workspaceId?: string;
    };

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const validLayout = ['vertical', 'compact', 'detailed'].includes(layout ?? '') ? layout : 'vertical';
    const timelineId = id ?? `timeline_${uuidv4()}`;

    const resolvedWs = await resolveWorkspaceForUser(req.userId!, workspaceId);

    const posResult = await query<{ max: string | null }>(
      'SELECT MAX(position) AS max FROM timelines WHERE user_id = $1',
      [req.userId]
    );
    const nextPos = posResult.rows[0].max !== null ? parseInt(posResult.rows[0].max, 10) + 1 : 0;

    const result = await query<TimelineRow>(
      `INSERT INTO timelines (id, user_id, name, emoji, color, color_bg, subtitle, layout, is_public, folder_id, position, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [timelineId, req.userId, name, emoji ?? null, color ?? null, colorBg ?? null, subtitle ?? null, validLayout, isPublic ?? false, folderId ?? null, nextPos, resolvedWs]
    );

    wlog(`timeline CREATE ✓ id=${result.rows[0].id} name="${name}" workspace=${result.rows[0].workspace_id} owner=${req.userId}`);
    res.status(201).json({ timeline: sanitizeTimeline(result.rows[0], []) });
    broadcastToUser(req.userId!, 'timelines');
  } catch (err) {
    werr('timelines POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/timelines/reorder — persist the order of the caller's own
// top-level timelines by id. Declared before the `/:timelineId` routes so
// "reorder" isn't captured as an id.
async function reorderTimelinesHandler(req: Request, res: Response): Promise<void> {
  try {
    const validation = validateReorderIds((req.body as { ids?: unknown }).ids, 'string');
    if (!validation.ok) { res.status(validation.status).json({ error: validation.error }); return; }
    const ids = validation.ids as string[];
    if (ids.length === 0) { res.json({ success: true }); return; }

    const owned = await query<{ id: string }>(
      `SELECT id FROM timelines WHERE id = ANY($1::varchar[]) AND user_id = $2`,
      [ids, req.userId]
    );
    if (owned.rows.length !== ids.length) {
      res.status(400).json({ error: 'One or more ids do not belong to a timeline you own' });
      return;
    }

    // ONE bulk statement — atomically all-or-nothing (B4).
    await bulkSetPositions('timelines', 'varchar', ids, 't.user_id = $3', [req.userId]);

    res.json({ success: true });
    broadcastToUser(req.userId!, 'timelines');
  } catch (err) {
    werr('timelines reorder error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
router.put('/reorder', reorderTimelinesHandler);
// PUT /api/timelines/:timelineId/reorder — kept as an alias of the route
// above (the `:timelineId` param is unused; this mirrors the pre-existing
// duplicate-route shape verbatim, not a B4 change) so no existing client
// contract breaks.
router.put('/:timelineId/reorder', reorderTimelinesHandler);

// PUT /api/timelines/:timelineId/share — manage the public read-only share link.
router.put('/:timelineId/share', async (req: Request, res: Response) => {
  try {
    const { timelineId } = req.params;
    const { enabled, password, expiresAt } = req.body as {
      enabled?: boolean;
      password?: string | null;
      expiresAt?: string | null;
    };

    const existing = await query<TimelineRow>('SELECT * FROM timelines WHERE id = $1', [timelineId]);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'Timeline not found' }); return; }

    const isOwner = existing.rows[0].user_id === req.userId;
    const isAdmin = req.user?.isAdmin === true;
    if (!isOwner && !isAdmin) { res.status(403).json({ error: 'Permission denied' }); return; }

    const row = existing.rows[0];
    const updatePw  = 'password'  in req.body;
    const updateExp = 'expiresAt' in req.body;
    const updateEnabled = 'enabled' in req.body;

    const willBeEnabled = updateEnabled ? Boolean(enabled) : row.share_enabled;
    let token = row.share_token;
    if (willBeEnabled && !token) token = randomBytes(24).toString('hex');

    let pwHash: string | null = null;
    if (updatePw && typeof password === 'string' && password.length > 0) {
      pwHash = await hashPassword(password);
    }

    const result = await query<TimelineRow>(
      `UPDATE timelines
       SET share_enabled       = COALESCE($2, share_enabled),
           share_token         = $3,
           share_password_hash = CASE WHEN $4 THEN $5 ELSE share_password_hash END,
           share_expires_at    = CASE WHEN $6 THEN $7 ELSE share_expires_at END
       WHERE id = $1
       RETURNING *`,
      [timelineId, updateEnabled ? enabled : null, token, updatePw, pwHash, updateExp, expiresAt ?? null]
    );

    const saved = result.rows[0];
    res.json({
      share: {
        enabled: saved.share_enabled,
        token: saved.share_token,
        hasPassword: saved.share_password_hash != null,
        expiresAt: saved.share_expires_at ?? null,
      },
    });
    broadcastToUser(req.userId!, 'timelines');
  } catch (err) {
    werr('timelines share PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/timelines/:timelineId
router.put('/:timelineId', async (req: Request, res: Response) => {
  try {
    const { timelineId } = req.params;
    const { name, emoji, color, colorBg, subtitle, layout, position, isPublic, folderId, cascade } = req.body as {
      name?: string;
      emoji?: string;
      color?: string;
      colorBg?: string;
      subtitle?: string;
      layout?: string;
      position?: number;
      isPublic?: boolean;
      folderId?: string | null;
      cascade?: boolean;
    };

    const existing = await query<TimelineRow>('SELECT user_id, workspace_id, folder_id, name FROM timelines WHERE id = $1', [timelineId]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Timeline not found' });
      return;
    }

    const isOwner = existing.rows[0].user_id === req.userId;
    const isAdmin = req.user?.isAdmin === true;
    if (!isOwner && !isAdmin) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    // Optimistic concurrency (B4): folded directly into the UPDATE's WHERE
    // clause below (versionGuardSql) — see concurrency.ts and lists.ts's
    // identical pattern for why a standalone pre-check SELECT is a race.
    const expectedVersion = (req.body as { expectedVersion?: number }).expectedVersion;

    const validLayout = layout !== undefined && ['vertical', 'compact', 'detailed'].includes(layout) ? layout : null;
    const updateFolderId = 'folderId' in req.body;

    // Enforce the visibility hierarchy (folder + workspace must be public before
    // a timeline can be). Conflicts return a 409 unless the client cascades.
    let promote: Awaited<ReturnType<typeof getPrivateAncestors>> = [];
    if (isPublic === true) {
      const targetFolderId = updateFolderId ? (folderId ?? null) : existing.rows[0].folder_id;
      const ancestors = await getPrivateAncestors(query, {
        workspaceId: existing.rows[0].workspace_id, folderId: targetFolderId, userId: req.userId!, isAdmin,
      });
      if (ancestors.length > 0) {
        const conflict = buildPromoteConflict('timeline', existing.rows[0].name, ancestors);
        if (!cascade) { res.status(409).json(conflict); return; }
        if (!conflict.canResolve) { res.status(403).json(conflict); return; }
        promote = ancestors;
      }
    }

    const updateParams: unknown[] = [name ?? null, emoji ?? null, color ?? null, colorBg ?? null, subtitle ?? null, validLayout, position ?? null, isPublic ?? null, timelineId,
      updateFolderId, folderId ?? null];
    const versionClause = versionGuardSql(updateParams, expectedVersion);
    const updateSql =
      `UPDATE timelines
       SET name      = COALESCE($1, name),
           emoji     = COALESCE($2, emoji),
           color     = COALESCE($3, color),
           color_bg  = COALESCE($4, color_bg),
           subtitle  = COALESCE($5, subtitle),
           layout    = COALESCE($6, layout),
           position  = COALESCE($7, position),
           is_public = COALESCE($8, is_public),
           folder_id = CASE WHEN $10 THEN $11 ELSE folder_id END
       WHERE id = $9${versionClause}
       RETURNING *`;

    let result;
    if (promote.length > 0) {
      result = await withTransaction(async (client) => {
        await promoteAncestors(client, promote);
        return client.query<TimelineRow>(updateSql, updateParams);
      });
    } else {
      result = await query<TimelineRow>(updateSql, updateParams);
    }

    if (result.rows.length === 0) {
      const failure = await resolveVersionedUpdateFailure('timelines', timelineId);
      if (failure.notFound) { res.status(404).json({ error: 'Timeline not found' }); return; }
      res.status(409).json({ error: 'version_conflict', currentVersion: failure.currentVersion, timeline: await getTimelineForUser(req.userId!, timelineId) });
      return;
    }

    // Re-attach milestones so the client gets a complete object back.
    const milestonesRes = await query<MilestoneRow>(
      'SELECT * FROM milestones WHERE timeline_id = $1 ORDER BY position ASC',
      [timelineId]
    );
    res.json({ timeline: sanitizeTimeline(result.rows[0], milestonesRes.rows.map(sanitizeMilestone)) });
    broadcastToUser(req.userId!, 'timelines');
    if (promote.length > 0) { broadcastToUser(req.userId!, 'folders'); broadcastToUser(req.userId!, 'workspaces'); broadcastToUser(req.userId!, 'lists'); }
  } catch (err) {
    werr('timelines PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/timelines/:timelineId/workspace — move this timeline into a
// different workspace the user has access to. Mirrors the lists.ts endpoint
// of the same shape (see comment there for the visibility-conflict rationale).
router.put('/:timelineId/workspace', async (req: Request, res: Response) => {
  try {
    const { timelineId } = req.params;
    const { workspaceId, cascade } = req.body as { workspaceId?: string; cascade?: boolean };
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId is required' });
      return;
    }

    const existing = await query<TimelineRow>('SELECT user_id, workspace_id, folder_id, is_public, name FROM timelines WHERE id = $1', [timelineId]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Timeline not found' });
      return;
    }
    const timeline = existing.rows[0];
    const isOwner = timeline.user_id === req.userId;
    const isAdmin = req.user?.isAdmin === true;
    if (!isOwner && !isAdmin) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    if (timeline.workspace_id === workspaceId) {
      res.json({ timeline: await getTimelineForUser(req.userId!, timelineId) });
      return;
    }

    const canAccess = await userCanAccessWorkspace(req.userId!, workspaceId);
    if (!canAccess) {
      res.status(403).json({ error: 'You do not have access to that workspace' });
      return;
    }

    const targetWs = await query<{ visibility: string }>('SELECT visibility FROM workspaces WHERE id = $1', [workspaceId]);
    const targetIsPrivate = targetWs.rows[0]?.visibility !== 'public';
    const willForcePrivate = targetIsPrivate && timeline.is_public;

    if (willForcePrivate) {
      const conflict = buildRestrictConflict('timeline', timeline.name, [{ type: 'timeline', id: timelineId, name: timeline.name }]);
      if (!cascade) { res.status(409).json(conflict); return; }
    }

    let detachFolder = false;
    if (timeline.folder_id) {
      const f = await query<{ workspace_id: string | null }>('SELECT workspace_id FROM folders WHERE id = $1', [timeline.folder_id]);
      if (f.rows[0]?.workspace_id !== workspaceId) detachFolder = true;
    }

    await query(
      `UPDATE timelines
       SET workspace_id = $1,
           is_public = CASE WHEN $3 THEN false ELSE is_public END
           ${detachFolder ? ', folder_id = NULL' : ''}
       WHERE id = $2`,
      [workspaceId, timelineId, willForcePrivate]
    );

    wlog(`timeline MOVE-WORKSPACE ✓ id=${timelineId} → workspace=${workspaceId} owner=${req.userId}`);
    res.json({ timeline: await getTimelineForUser(req.userId!, timelineId) });
    broadcastToUser(req.userId!, 'timelines');
    broadcastToUser(req.userId!, 'workspaces');
  } catch (err) {
    werr('timelines PUT /workspace error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/timelines/:timelineId  — soft delete to trash
router.delete('/:timelineId', async (req: Request, res: Response) => {
  try {
    const { timelineId } = req.params;

    const existing = await query<TimelineRow>('SELECT * FROM timelines WHERE id = $1', [timelineId]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Timeline not found' });
      return;
    }

    const isOwner = existing.rows[0].user_id === req.userId;
    const isAdmin = req.user?.isAdmin === true;
    if (!isOwner && !isAdmin) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    // Snapshot-to-trash and delete must be atomic (shared helper — the same
    // snapshot shape is written by the workspace cascade and the AI tools).
    await withTransaction(async (client) => {
      const exec = (text: string, params?: unknown[]) => client.query(text, params);
      await snapshotTimelineToTrash(exec, timelineId);
      await client.query('DELETE FROM timelines WHERE id = $1', [timelineId]);
      await deleteItemShares(exec, 'timeline', timelineId);
    });

    wlog(`timeline DELETE ✓ id=${timelineId} → trashed by user ${req.userId}`);
    res.json({ success: true });
    broadcastToUser(req.userId!, 'timelines');
    broadcastToUser(req.userId!, 'trash');
  } catch (err) {
    werr('timelines DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

async function assertTimelineOwner(timelineId: string, req: Request): Promise<'ok' | 404 | 403> {
  const check = await query<{ user_id: string }>('SELECT user_id FROM timelines WHERE id = $1', [timelineId]);
  if (check.rows.length === 0) return 404;
  if (check.rows[0].user_id !== req.userId && !req.user?.isAdmin && !(await isItemSharedWith('timeline', timelineId, req.userId!))) return 403;
  return 'ok';
}

// POST /api/timelines/:timelineId/milestones
router.post('/:timelineId/milestones', async (req: Request, res: Response) => {
  try {
    const { timelineId } = req.params;
    const { id, title, description, descriptionMarkdown, date, time, status, emoji, color } = req.body as {
      id?: string;
      title?: string;
      description?: string;
      descriptionMarkdown?: boolean;
      date?: string;
      time?: string;
      status?: string;
      emoji?: string;
      color?: string;
    };

    if (!title) {
      res.status(400).json({ error: 'title is required' });
      return;
    }

    const perm = await assertTimelineOwner(timelineId, req);
    if (perm === 404) { res.status(404).json({ error: 'Timeline not found' }); return; }
    if (perm === 403) { res.status(403).json({ error: 'Permission denied' }); return; }

    const validStatus = ['upcoming', 'in-progress', 'done'].includes(status ?? '') ? status : 'upcoming';
    const milestoneId = id ?? `milestone_${uuidv4()}`;

    const posResult = await query<{ max: string | null }>(
      'SELECT MAX(position) AS max FROM milestones WHERE timeline_id = $1',
      [timelineId]
    );
    const nextPos = posResult.rows[0].max !== null ? parseInt(posResult.rows[0].max, 10) + 1 : 0;

    const result = await query<MilestoneRow>(
      `INSERT INTO milestones (id, timeline_id, title, description, description_markdown, milestone_date, time_val, status, emoji, color, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [milestoneId, timelineId, title, description ?? null, descriptionMarkdown === true, date ?? null, time ?? null, validStatus, emoji ?? null, color ?? null, nextPos]
    );

    res.status(201).json({ milestone: sanitizeMilestone(result.rows[0]) });
    broadcastToUser(req.userId!, 'timelines');
  } catch (err) {
    werr('milestones POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/timelines/milestones/:milestoneId
router.put('/milestones/:milestoneId', async (req: Request, res: Response) => {
  try {
    const { milestoneId } = req.params;
    const { title, description, descriptionMarkdown, date, time, status, emoji, color, position, timelineId } = req.body as {
      title?: string;
      description?: string;
      descriptionMarkdown?: boolean;
      date?: string | null;
      time?: string | null;
      status?: string;
      emoji?: string | null;
      color?: string | null;
      position?: number;
      timelineId?: string;
    };

    const ownerCheck = await query<{ user_id: string; timeline_id: string; workspace_id: string | null; before_description: string | null }>(
      `SELECT t.user_id, m.timeline_id, t.workspace_id, m.description AS before_description
         FROM milestones m JOIN timelines t ON m.timeline_id = t.id WHERE m.id = $1`,
      [milestoneId]
    );
    if (ownerCheck.rows.length === 0) {
      res.status(404).json({ error: 'Milestone not found' });
      return;
    }
    if (ownerCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin && !(await isItemSharedWith('timeline', ownerCheck.rows[0].timeline_id, req.userId!))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    // Moving to another timeline: the caller must own (or admin) the target
    // timeline too, and the milestone is appended to the end of it.
    let targetTimelineId: string | null = null;
    let targetPosition: number | null = null;
    if (timelineId && timelineId !== ownerCheck.rows[0].timeline_id) {
      const targetOwner = await query<{ user_id: string }>('SELECT user_id FROM timelines WHERE id = $1', [timelineId]);
      if (targetOwner.rows.length === 0) {
        res.status(404).json({ error: 'Target timeline not found' });
        return;
      }
      if (targetOwner.rows[0].user_id !== req.userId && !req.user?.isAdmin && !(await isItemSharedWith('timeline', timelineId, req.userId!))) {
        res.status(403).json({ error: 'Permission denied for target timeline' });
        return;
      }
      targetTimelineId = timelineId;
      const posRes = await query<{ max: string | null }>('SELECT MAX(position) AS max FROM milestones WHERE timeline_id = $1', [timelineId]);
      targetPosition = posRes.rows[0].max !== null ? parseInt(posRes.rows[0].max, 10) + 1 : 0;
    }

    const validStatus = status !== undefined && ['upcoming', 'in-progress', 'done'].includes(status) ? status : null;
    // Allow explicitly clearing description/date/time/emoji/color when the key is present.
    const updateDescription = 'description' in req.body;
    const updateDate = 'date' in req.body;
    const updateTime = 'time' in req.body;
    const updateEmoji = 'emoji' in req.body;
    const updateColor = 'color' in req.body;
    const finalPosition = targetTimelineId !== null ? targetPosition : (position ?? null);

    const result = await query<MilestoneRow>(
      `UPDATE milestones
       SET title          = COALESCE($1, title),
           description     = CASE WHEN $2 THEN $3 ELSE description END,
           description_markdown = COALESCE($15, description_markdown),
           milestone_date  = CASE WHEN $4 THEN $5 ELSE milestone_date END,
           time_val        = CASE WHEN $6 THEN $7 ELSE time_val END,
           status          = COALESCE($8, status),
           emoji           = CASE WHEN $9 THEN $10 ELSE emoji END,
           color           = CASE WHEN $11 THEN $12 ELSE color END,
           position        = COALESCE($13, position),
           timeline_id     = COALESCE($16, timeline_id)
       WHERE id = $14
       RETURNING *`,
      [
        title ?? null,
        updateDescription, description ?? null,
        updateDate, date ?? null,
        updateTime, time ?? null,
        validStatus,
        updateEmoji, emoji ?? null,
        updateColor, color ?? null,
        finalPosition,
        milestoneId,
        typeof descriptionMarkdown === 'boolean' ? descriptionMarkdown : null,
        targetTimelineId,
      ]
    );

    if (targetTimelineId) {
      wlog(`milestone MOVE ✓ id=${milestoneId} ${ownerCheck.rows[0].timeline_id} → ${targetTimelineId} owner=${req.userId}`);
    }
    const savedMilestone = result.rows[0];
    res.json({ milestone: sanitizeMilestone(savedMilestone) });
    broadcastToUser(req.userId!, 'timelines');

    // @-mention notifications for a changed milestone note (description).
    if (updateDescription && savedMilestone.description !== ownerCheck.rows[0].before_description) {
      await notifyNewMentions({
        beforeText: ownerCheck.rows[0].before_description,
        afterText: savedMilestone.description,
        workspaceId: ownerCheck.rows[0].workspace_id,
        actorId: req.userId!,
        title: `mentioned you in "${savedMilestone.title}"`,
        entityType: 'milestone',
        entityId: milestoneId,
        data: { timelineId: savedMilestone.timeline_id },
        shareItem: { itemType: 'timeline', itemId: savedMilestone.timeline_id },
      });
      await syncInlineLinksForText({ entityType: 'milestone', entityId: milestoneId }, savedMilestone.description, req.userId!);
      await enqueueEmbedding('milestone', milestoneId, ownerCheck.rows[0].workspace_id);
    }
  } catch (err) {
    werr('milestones PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/timelines/:timelineId/milestones/reorder
router.put('/:timelineId/milestones/reorder', async (req: Request, res: Response) => {
  try {
    const { timelineId } = req.params;
    const validation = validateReorderIds((req.body as { milestone_ids?: unknown }).milestone_ids, 'string');
    if (!validation.ok) { res.status(validation.status).json({ error: validation.error.replace('ids', 'milestone_ids') }); return; }
    const milestone_ids = validation.ids as string[];

    const perm = await assertTimelineOwner(timelineId, req);
    if (perm === 404) { res.status(404).json({ error: 'Timeline not found' }); return; }
    if (perm === 403) { res.status(403).json({ error: 'Permission denied' }); return; }

    if (milestone_ids.length > 0) {
      const owned = await query<{ id: string }>(
        `SELECT id FROM milestones WHERE id = ANY($1::varchar[]) AND timeline_id = $2`,
        [milestone_ids, timelineId]
      );
      if (owned.rows.length !== milestone_ids.length) {
        res.status(400).json({ error: 'One or more milestone_ids do not belong to this timeline' });
        return;
      }
      // ONE bulk statement — atomically all-or-nothing (B4).
      await bulkSetPositions('milestones', 'varchar', milestone_ids, 't.timeline_id = $3', [timelineId]);
    }

    res.json({ success: true });
    broadcastToUser(req.userId!, 'timelines');
  } catch (err) {
    werr('milestones reorder error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/timelines/milestones/:milestoneId  — soft delete to trash
router.delete('/milestones/:milestoneId', async (req: Request, res: Response) => {
  try {
    const { milestoneId } = req.params;

    const existing = await query<MilestoneRow & { user_id: string }>(
      `SELECT m.*, t.user_id FROM milestones m JOIN timelines t ON m.timeline_id = t.id WHERE m.id = $1`,
      [milestoneId]
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Milestone not found' });
      return;
    }
    const row = existing.rows[0];
    if (row.user_id !== req.userId && !req.user?.isAdmin && !(await isItemSharedWith('timeline', row.timeline_id, req.userId!))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    // Snapshot the milestone into trash, then remove it — atomically.
    const milestoneData = sanitizeMilestone(row);
    await withTransaction(async (c) => {
      await c.query(
        `INSERT INTO trash_milestones (milestone_id, timeline_id, user_id, milestone_data)
         VALUES ($1, $2, $3, $4)`,
        [milestoneId, row.timeline_id, row.user_id, JSON.stringify(milestoneData)]
      );
      await c.query('DELETE FROM milestones WHERE id = $1', [milestoneId]);
    });

    res.json({ success: true });
    broadcastToUser(row.user_id, 'timelines');
    broadcastToUser(row.user_id, 'trash');
  } catch (err) {
    werr('milestones DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
