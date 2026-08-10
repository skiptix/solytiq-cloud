// ---------------------------------------------------------------------------
// B3 (Phase 2) — the shared claim/lease primitive.
//
// Before this, the two periodic sweeps that pick up "due" work each had
// their OWN, independently-invented (and independently incomplete) claim
// logic:
//   - automationEngine.ts's sweepScheduledAutomations() did a bare SELECT
//     with NO locking at all — two worker processes (or even two
//     overlapping sweep ticks) racing the same due `schedule`-trigger
//     automation could BOTH see it as due and BOTH fire it, a genuine
//     double-execution bug.
//   - knowledge/queue.ts's claimQueueBatch() DID use `FOR UPDATE SKIP
//     LOCKED` (so two workers can't claim the SAME row), but had no lease
//     EXPIRY — a row moved to 'processing' and then never explicitly
//     finished (the process crashed mid-embed, an OOM, a container
//     restart) stayed 'processing' forever; nothing ever reclaimed it.
//
// `claimDueRows()` is the ONE place either domain performs this claim from
// now on: `UPDATE <table> SET lease_owner=…, lease_expires_at=NOW()+lease
// WHERE id IN (SELECT … WHERE <due> AND (unleased OR lease expired) FOR
// UPDATE SKIP LOCKED) RETURNING *`. This is a single, atomic statement —
// the claim IS the lock acquisition, so there is no window between "decide
// it's due" and "mark it claimed" for a second worker to sneak in. A lease
// that's never explicitly released (a crash) is picked back up by ANY
// worker's next sweep once `lease_expires_at` passes — no manual
// intervention, no lost job.
//
// Deliberately NOT a generic "jobs" table — automations and embedding_queue
// keep their own domain-specific schemas/payloads (CLAUDE.md's own
// documented "ohne domänenspezifische Payloads zu vermischen" constraint);
// this module only unifies the CLAIM MECHANICS both now share.
// ---------------------------------------------------------------------------

import { query } from './db';
import type { QueryExec } from './workspaceUtil';

export interface ClaimDueRowsOptions {
  /** Trusted literal only — never client input. */
  table: string;
  /** Trusted literal SQL fragment describing "this row is due" — may
   *  reference `$1`, `$2`, … matching `dueParams`, in order. Combined with
   *  the lease-freshness check via AND — callers never need to repeat that
   *  part themselves. */
  dueWhereSql: string;
  dueParams: unknown[];
  /** How long a claim is held before another worker may reclaim it if this
   *  one never explicitly finishes (crash recovery window). */
  leaseDurationMs: number;
  /** Max rows to claim in one call. */
  limit: number;
  /** This process's stable identity (see workerId.ts). */
  leaseOwnerId: string;
  /** Extra trusted-literal `SET` clause(s) applied atomically in the SAME
   *  claim statement (e.g. `status = 'processing'`) — for a domain whose
   *  rows also carry their own status column alongside the lease. */
  extraSetSql?: string;
  orderBySql?: string;
  exec?: QueryExec;
}

/**
 * Atomically claims up to `limit` due-and-unleased-or-lease-expired rows
 * from `table`, stamping them with this process's lease, and returns them.
 * A second concurrent call (this process or another) against the SAME rows
 * is guaranteed to return a DISJOINT set — `FOR UPDATE SKIP LOCKED` means a
 * row already locked by an in-flight claim is invisible to the second
 * call's candidate set, not merely re-claimed and overwritten.
 */
export async function claimDueRows<T>(opts: ClaimDueRowsOptions): Promise<T[]> {
  const exec = opts.exec ?? query;
  const params: unknown[] = [...opts.dueParams];
  const leaseOwnerIdx = params.push(opts.leaseOwnerId);
  const leaseIntervalIdx = params.push(`${Math.max(1, Math.round(opts.leaseDurationMs))} milliseconds`);
  const limitIdx = params.push(opts.limit);

  const sql = `
    UPDATE ${opts.table} AS claimed
    SET lease_owner = $${leaseOwnerIdx},
        lease_expires_at = NOW() + $${leaseIntervalIdx}::interval
        ${opts.extraSetSql ? `, ${opts.extraSetSql}` : ''}
    WHERE claimed.id IN (
      SELECT id FROM ${opts.table}
      WHERE (${opts.dueWhereSql})
        AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
      ORDER BY ${opts.orderBySql ?? 'id'}
      LIMIT $${limitIdx}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING claimed.*`;
  const r = await exec(sql, params);
  return r.rows as T[];
}

/**
 * Releases a lease (sets lease_owner/lease_expires_at back to NULL) without
 * touching any other column — used after a claim finishes (success or
 * failure) so the row is immediately eligible for its NEXT natural due
 * time, rather than staying artificially unclaimable until the old lease
 * would have expired on its own.
 */
export async function releaseLease(table: string, id: string, exec: QueryExec = query): Promise<void> {
  await exec(`UPDATE ${table} SET lease_owner = NULL, lease_expires_at = NULL WHERE id = $1`, [id]);
}

/**
 * B8 — graceful-shutdown lease release: bulk-releases every row in `table`
 * currently leased by `leaseOwnerId` (this process's own `WORKER_ID`),
 * EXCEPT `excludeIds` — rows the caller is STILL actively executing right
 * now, which must never have their lease pulled out from under an in-flight
 * operation (that would let a second worker claim and start the SAME row
 * concurrently with this process's own still-running work, defeating the
 * entire point of leasing). This is specifically for the "claimed a whole
 * batch upfront, then processes it sequentially" shape both
 * `sweepScheduledAutomations()` and `sweepEmbeddingQueue()` share (see
 * jobLease.ts's module header): SIGTERM arriving mid-batch left every row
 * AFTER the currently-processing one sitting on a held lease for up to
 * their FULL lease duration (tens of seconds to minutes) before any other
 * worker could pick them back up — genuinely correct (nothing was ever
 * double-fired or lost) but needlessly slow. Immediately releasing the
 * not-yet-started remainder closes that latency gap without weakening the
 * in-flight-work safety guarantee at all — see shutdown.ts's wiring.
 *
 * Returns the number of rows released, purely for logging/testing
 * visibility.
 */
export async function releaseOwnedLeases(
  table: string,
  leaseOwnerId: string,
  excludeIds: string[] = [],
  exec: QueryExec = query
): Promise<number> {
  const params: unknown[] = [leaseOwnerId];
  let excludeClause = '';
  if (excludeIds.length > 0) {
    params.push(excludeIds);
    excludeClause = `AND id != ALL($2::varchar[])`;
  }
  const r = await exec(
    `UPDATE ${table} SET lease_owner = NULL, lease_expires_at = NULL WHERE lease_owner = $1 ${excludeClause}`,
    params
  );
  return r.rowCount ?? 0;
}

/**
 * Exponential backoff with full jitter (the AWS-recommended jitter
 * strategy — avoids every retrying worker/row synchronizing onto the same
 * retry instant): `random(0, min(capMs, baseMs * 2^attempt))`. Pure,
 * deterministic given an injected RNG — unit-testable without flakiness.
 */
export function backoffWithJitterMs(attempt: number, baseMs: number, capMs: number, rng: () => number = Math.random): number {
  const exp = Math.min(capMs, baseMs * Math.pow(2, Math.max(0, attempt)));
  return Math.floor(rng() * exp);
}
