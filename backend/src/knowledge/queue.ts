// ---------------------------------------------------------------------------
// embedding_queue — a small work queue fed from the same content-save call
// sites as graph/inlineLinks.ts's syncInlineLinksForText/Blocks (see
// routes/lists.ts, markdownLists.ts, timelines.ts, meetings.ts, tasks.ts).
// Best-effort, fire-and-forget, never throws into the caller's save — same
// contract as mentions.ts/inlineLinks.ts.
//
// B3 (Phase 2): claiming now goes through the shared jobLease.ts primitive —
// see that module's own header for the crash-recovery gap this closes (a
// 'processing' row used to stay claimed forever if the worker died mid-embed;
// it's now reclaimable once its lease expires). Failure handling gained
// exponential-backoff retry + a genuine dead_letter terminal state — before
// this, a 'failed' row just sat forever with no automatic retry at all.
// ---------------------------------------------------------------------------

import { query } from '../db';
import type { QueryExec } from '../workspaceUtil';
import { claimDueRows, backoffWithJitterMs } from '../jobLease';
import { WORKER_ID } from '../workerId';

export type QueueStatus = 'pending' | 'processing' | 'done' | 'failed' | 'skipped_budget' | 'dead_letter';

export interface EmbeddingQueueRow {
  id: string;
  entityType: string;
  entityId: string;
  workspaceId: string | null;
  status: QueueStatus;
  attempts: number;
}

interface EmbeddingQueueDbRow {
  id: string;
  entity_type: string;
  entity_id: string;
  workspace_id: string | null;
  status: QueueStatus;
  attempts: number;
}

function toRow(r: EmbeddingQueueDbRow): EmbeddingQueueRow {
  return { id: r.id, entityType: r.entity_type, entityId: r.entity_id, workspaceId: r.workspace_id, status: r.status, attempts: r.attempts };
}

/** How long a claimed row's lease is held before another worker may reclaim
 *  it if this one never explicitly finishes (crash recovery window). Well
 *  above a realistic single-item embed-call duration. */
const LEASE_DURATION_MS = 5 * 60 * 1000;

/** Base/cap for exponential backoff with jitter between retry attempts —
 *  see jobLease.ts's backoffWithJitterMs. */
const RETRY_BASE_MS = 10_000;
const RETRY_CAP_MS = 30 * 60 * 1000;

/** Enqueue (or re-flag) an entity for (re-)embedding. Collapses a burst of edits into one pending row via ON CONFLICT. */
export async function enqueueEmbedding(
  entityType: string,
  entityId: string,
  workspaceId: string | null,
  exec: QueryExec = query
): Promise<void> {
  try {
    await exec(
      `INSERT INTO embedding_queue (id, entity_type, entity_id, workspace_id, status, attempts, created_at, updated_at)
       VALUES ('eq_' || gen_random_uuid(), $1, $2, $3, 'pending', 0, NOW(), NOW())
       ON CONFLICT (entity_type, entity_id) DO UPDATE SET
         status = 'pending', workspace_id = EXCLUDED.workspace_id, updated_at = NOW(),
         -- A fresh edit supersedes any pending backoff/lease from a prior
         -- failed attempt — the content changed, so re-try immediately
         -- rather than waiting out an old attempt's backoff window.
         next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL`,
      [entityType, entityId, workspaceId]
    );
  } catch (err) {
    console.error('📚 ✗ enqueueEmbedding failed', entityType, entityId, err);
  }
}

/**
 * Claim up to `limit` due rows for processing — B3: a single atomic
 * `FOR UPDATE SKIP LOCKED` claim (via jobLease.ts) that ALSO reclaims any
 * 'processing' row whose lease has expired (the worker that claimed it
 * crashed before finishing), not just fresh 'pending' rows. `attempts` is
 * incremented as PART OF the claim, not on completion — an "attempt" means
 * "a worker picked this up", which is true even if that worker then
 * crashes before ever reporting success or failure.
 */
export async function claimQueueBatch(limit: number, exec: QueryExec = query): Promise<EmbeddingQueueRow[]> {
  const rows = await claimDueRows<EmbeddingQueueDbRow>({
    table: 'embedding_queue',
    dueWhereSql: `(status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())) OR status = 'processing'`,
    dueParams: [],
    leaseDurationMs: LEASE_DURATION_MS,
    limit,
    leaseOwnerId: WORKER_ID,
    extraSetSql: `status = 'processing', attempts = attempts + 1`,
    orderBySql: 'updated_at ASC',
    exec,
  });
  return rows.map(toRow);
}

/**
 * Records a claimed row's outcome and releases its lease. A 'failed'
 * outcome does NOT go straight to a terminal state: if this item's attempts
 * are still under its `max_attempts`, it's returned to 'pending' with an
 * exponential-backoff `next_attempt_at` (B3's retry-with-backoff gate);
 * once attempts are exhausted, it moves to the genuine 'dead_letter'
 * terminal state (distinct from an ordinary in-progress failure) instead of
 * silently sitting as 'failed' forever, which was this module's actual
 * prior behavior.
 */
export async function markQueueItem(
  id: string,
  status: QueueStatus,
  error: string | null,
  exec: QueryExec = query
): Promise<void> {
  if (status === 'failed') {
    const current = await exec(`SELECT attempts, max_attempts FROM embedding_queue WHERE id = $1`, [id]);
    const row = current.rows[0] as { attempts: number; max_attempts: number } | undefined;
    const attempts = row?.attempts ?? 0;
    const maxAttempts = row?.max_attempts ?? 5;
    if (attempts >= maxAttempts) {
      await exec(
        `UPDATE embedding_queue SET status = 'dead_letter', last_error = $2, lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW() WHERE id = $1`,
        [id, error]
      );
      return;
    }
    const delayMs = backoffWithJitterMs(attempts, RETRY_BASE_MS, RETRY_CAP_MS);
    await exec(
      `UPDATE embedding_queue
       SET status = 'pending', last_error = $2, lease_owner = NULL, lease_expires_at = NULL,
           next_attempt_at = NOW() + ($3 || ' milliseconds')::interval, updated_at = NOW()
       WHERE id = $1`,
      [id, error, delayMs]
    );
    return;
  }
  // Terminal, non-retryable outcomes (done / skipped_budget) — release the
  // lease so the row is inert until the content changes again.
  await exec(
    `UPDATE embedding_queue SET status = $2, last_error = $3, lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW() WHERE id = $1`,
    [id, status, error]
  );
}

export interface QueueStats {
  pending: number;
  processing: number;
  done: number;
  failed: number;
  skippedBudget: number;
  deadLetter: number;
}

export async function getQueueStats(exec: QueryExec = query): Promise<QueueStats> {
  const r = await exec(`SELECT status, COUNT(*) AS c FROM embedding_queue GROUP BY status`);
  const rows = r.rows as Array<{ status: QueueStatus; c: string }>;
  const stats: QueueStats = { pending: 0, processing: 0, done: 0, failed: 0, skippedBudget: 0, deadLetter: 0 };
  for (const row of rows) {
    const n = Number(row.c);
    if (row.status === 'pending') stats.pending = n;
    else if (row.status === 'processing') stats.processing = n;
    else if (row.status === 'done') stats.done = n;
    else if (row.status === 'failed') stats.failed = n;
    else if (row.status === 'skipped_budget') stats.skippedBudget = n;
    else if (row.status === 'dead_letter') stats.deadLetter = n;
  }
  return stats;
}
