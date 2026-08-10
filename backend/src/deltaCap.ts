// ---------------------------------------------------------------------------
// B5 (Phase 2) — enforces the sync-delta spec's two explicit caps:
//
//   "höchstens 500 Änderungen und höchstens 1 MiB unkomprimiert pro Seite"
//   (at most 500 changes, and at most 1 MiB uncompressed, per page)
//
// Pure, dependency-free (no DB, no HTTP) — takes an already deduped,
// seq-ordered (ascending), fully-hydrated list of candidate changes and
// trims it to fit BOTH caps, returning a rewound cursor a caller can resume
// from correctly. `routes/sync.ts`'s `/delta` handler is the one caller;
// this module exists separately so the truncation logic itself is
// unit-testable with plain in-memory fixtures, no live Postgres needed.
// ---------------------------------------------------------------------------

export const DELTA_MAX_CHANGES = 500;
export const DELTA_MAX_BYTES = 1024 * 1024; // 1 MiB, uncompressed (matches the spec's literal wording — measured on the actual JSON payload, not gzip'd size)

export interface DeltaChangeCandidate {
  entity: string;
  entityId: string;
  /** The sync_log seq this candidate was (most recently) observed at —
   *  used both for ordering and as the rewind point if this candidate ends
   *  up excluded by either cap. */
  seq: number;
  op: 'upsert' | 'delete';
  payload?: unknown;
}

export interface CapDeltaChangesResult {
  /** The candidates that fit under BOTH caps, in the same (ascending seq)
   *  order they were given. */
  changes: DeltaChangeCandidate[];
  /**
   * The seq to hand back to the client as the new cursor. `null` only when
   * `sortedCandidates` was empty (the caller should keep its PRIOR cursor
   * in that case — there is nothing new to advance past). Otherwise this is
   * ALWAYS the seq of the last candidate actually included in `changes` —
   * never the seq of an excluded candidate — so a client's next call with
   * `since = cursor` is guaranteed to re-discover every candidate this page
   * had to leave out, never skip one.
   */
  cursor: number | null;
  /** True if either cap forced at least one candidate to be excluded — lets
   *  a caller/test assert "this page was genuinely capped" explicitly. */
  truncated: boolean;
}

/**
 * Byte size of a single candidate's OWN JSON representation, as it will
 * actually be serialized in the response's `changes` array — measured
 * directly (`Buffer.byteLength(JSON.stringify(...), 'utf8')`), not
 * estimated, so the 1 MiB bound this enforces is exact.
 */
function candidateByteSize(c: DeltaChangeCandidate): number {
  const wire: { entity: string; entityId: string; op: string; payload?: unknown } =
    c.op === 'upsert' ? { entity: c.entity, entityId: c.entityId, op: c.op, payload: c.payload } : { entity: c.entity, entityId: c.entityId, op: c.op };
  return Buffer.byteLength(JSON.stringify(wire), 'utf8');
}

/**
 * Trims `sortedCandidates` (MUST already be sorted by `seq` ascending — this
 * function trusts that ordering, it doesn't re-sort) down to at most
 * `maxCount` entries AND at most `maxBytes` of cumulative JSON size,
 * whichever limit is hit first, walking in seq order so the included set is
 * always a CONTIGUOUS prefix (never "the smallest 500", which would be
 * cheaper but would let a client permanently starve on a workspace whose
 * early changes happen to be large — a contiguous prefix guarantees forward
 * progress: whatever didn't fit this time is exactly what the next call,
 * resuming from the rewound cursor, picks up).
 *
 * Progress guarantee: even a single candidate whose OWN size exceeds
 * `maxBytes` is still included alone (never dropped to zero) — otherwise a
 * pathologically large single entity could wedge the cursor forever, never
 * able to advance past it. This mirrors the same "always make progress"
 * principle `jobLease.ts`'s lease/backoff logic already applies elsewhere in
 * this codebase.
 */
export function capDeltaChanges(
  sortedCandidates: DeltaChangeCandidate[],
  opts: { maxCount?: number; maxBytes?: number } = {}
): CapDeltaChangesResult {
  const maxCount = opts.maxCount ?? DELTA_MAX_CHANGES;
  const maxBytes = opts.maxBytes ?? DELTA_MAX_BYTES;

  if (sortedCandidates.length === 0) {
    return { changes: [], cursor: null, truncated: false };
  }

  const changes: DeltaChangeCandidate[] = [];
  let cumulativeBytes = 0;
  for (const candidate of sortedCandidates) {
    if (changes.length >= maxCount) break;
    const size = candidateByteSize(candidate);
    if (changes.length > 0 && cumulativeBytes + size > maxBytes) break; // never let a LATER item push the FIRST one out — the first is always included (progress guarantee)
    changes.push(candidate);
    cumulativeBytes += size;
  }

  const truncated = changes.length < sortedCandidates.length;
  const cursor = changes[changes.length - 1].seq;
  return { changes, cursor, truncated };
}
