// ---------------------------------------------------------------------------
// embedding_queue — a small work queue fed from the same content-save call
// sites as graph/inlineLinks.ts's syncInlineLinksForText/Blocks (see
// routes/lists.ts, markdownLists.ts, timelines.ts, meetings.ts, tasks.ts).
// Best-effort, fire-and-forget, never throws into the caller's save — same
// contract as mentions.ts/inlineLinks.ts.
// ---------------------------------------------------------------------------

import { query } from '../db';
import type { QueryExec } from '../workspaceUtil';

export type QueueStatus = 'pending' | 'processing' | 'done' | 'failed' | 'skipped_budget';

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
       ON CONFLICT (entity_type, entity_id) DO UPDATE SET status = 'pending', workspace_id = EXCLUDED.workspace_id, updated_at = NOW()`,
      [entityType, entityId, workspaceId]
    );
  } catch (err) {
    console.error('📚 ✗ enqueueEmbedding failed', entityType, entityId, err);
  }
}

/** Claim up to `limit` pending rows for processing (marks them 'processing' so a slow worker restart never double-claims). */
export async function claimQueueBatch(limit: number, exec: QueryExec = query): Promise<EmbeddingQueueRow[]> {
  const r = await exec(
    `UPDATE embedding_queue SET status = 'processing', updated_at = NOW()
     WHERE id IN (
       SELECT id FROM embedding_queue WHERE status = 'pending' ORDER BY updated_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     RETURNING id, entity_type, entity_id, workspace_id, status, attempts`,
    [limit]
  );
  return (r.rows as EmbeddingQueueDbRow[]).map(toRow);
}

export async function markQueueItem(
  id: string,
  status: QueueStatus,
  error: string | null,
  exec: QueryExec = query
): Promise<void> {
  await exec(
    `UPDATE embedding_queue SET status = $2, last_error = $3, attempts = attempts + 1, updated_at = NOW() WHERE id = $1`,
    [id, status, error]
  );
}

export interface QueueStats {
  pending: number;
  processing: number;
  done: number;
  failed: number;
  skippedBudget: number;
}

export async function getQueueStats(exec: QueryExec = query): Promise<QueueStats> {
  const r = await exec(`SELECT status, COUNT(*) AS c FROM embedding_queue GROUP BY status`);
  const rows = r.rows as Array<{ status: QueueStatus; c: string }>;
  const stats: QueueStats = { pending: 0, processing: 0, done: 0, failed: 0, skippedBudget: 0 };
  for (const row of rows) {
    const n = Number(row.c);
    if (row.status === 'pending') stats.pending = n;
    else if (row.status === 'processing') stats.processing = n;
    else if (row.status === 'done') stats.done = n;
    else if (row.status === 'failed') stats.failed = n;
    else if (row.status === 'skipped_budget') stats.skippedBudget = n;
  }
  return stats;
}
