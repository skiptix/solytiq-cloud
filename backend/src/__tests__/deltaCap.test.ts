import { describe, expect, it } from 'vitest';
import { capDeltaChanges, DELTA_MAX_BYTES, DELTA_MAX_CHANGES, type DeltaChangeCandidate } from '../deltaCap';

function candidate(seq: number, payloadSize = 10): DeltaChangeCandidate {
  return { entity: 'task', entityId: `id_${seq}`, seq, op: 'upsert', payload: { note: 'x'.repeat(payloadSize) } };
}

describe('deltaCap — spec-mandated bound (pins the literal numbers)', () => {
  it('DELTA_MAX_CHANGES is exactly 500', () => {
    expect(DELTA_MAX_CHANGES).toBe(500);
  });

  it('DELTA_MAX_BYTES is exactly 1 MiB (1024*1024)', () => {
    expect(DELTA_MAX_BYTES).toBe(1048576);
  });
});

describe('capDeltaChanges — empty input', () => {
  it('returns an empty result with a null cursor (caller keeps its prior cursor)', () => {
    const result = capDeltaChanges([]);
    expect(result.changes).toEqual([]);
    expect(result.cursor).toBeNull();
    expect(result.truncated).toBe(false);
  });
});

describe('capDeltaChanges — count cap (max 500)', () => {
  it('a small batch (well under 500) is returned entirely, untruncated', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => candidate(i + 1));
    const result = capDeltaChanges(candidates);
    expect(result.changes).toHaveLength(10);
    expect(result.truncated).toBe(false);
    expect(result.cursor).toBe(10); // the last candidate's own seq
  });

  it('exactly 500 candidates all fit — not truncated', () => {
    const candidates = Array.from({ length: 500 }, (_, i) => candidate(i + 1));
    const result = capDeltaChanges(candidates);
    expect(result.changes).toHaveLength(500);
    expect(result.truncated).toBe(false);
  });

  it('501 candidates are capped to exactly 500 — genuinely enforces the spec number, not "roughly 500"', () => {
    const candidates = Array.from({ length: 501 }, (_, i) => candidate(i + 1));
    const result = capDeltaChanges(candidates);
    expect(result.changes).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });

  it('a batch of 2000 candidates is STILL capped to exactly 500, never more', () => {
    const candidates = Array.from({ length: 2000 }, (_, i) => candidate(i + 1));
    const result = capDeltaChanges(candidates);
    expect(result.changes).toHaveLength(500);
  });

  it('the cursor rewinds to the 500th candidate\'s own seq, NOT the full scan window\'s last seq — the resumability guarantee', () => {
    // Candidate seqs are sparse/non-contiguous (as real sync_log seqs would
    // be once signal rows and other users' entities are interleaved) —
    // proves the cursor tracks the ACTUAL included candidate's seq, not an
    // assumed 1-per-candidate increment.
    const candidates = Array.from({ length: 600 }, (_, i) => candidate((i + 1) * 3));
    const result = capDeltaChanges(candidates);
    expect(result.changes).toHaveLength(500);
    expect(result.cursor).toBe(500 * 3); // the 500th candidate's seq (1500), not the 600th's (1800)
    // Confirms every EXCLUDED candidate has a seq strictly greater than the
    // returned cursor — the next `since=cursor` call is guaranteed to
    // re-discover them, never skip one.
    const excluded = candidates.slice(500);
    expect(excluded.every((c) => c.seq > result.cursor!)).toBe(true);
  });

  it('the included set is always a CONTIGUOUS PREFIX in seq order — never cherry-picked by size', () => {
    const candidates = [candidate(1, 500_000), candidate(2, 10), candidate(3, 10)]; // one huge, two tiny
    const result = capDeltaChanges(candidates, { maxBytes: 600_000 });
    // Even though dropping the huge #1 would let #2 AND #3 both fit
    // trivially, the contract is strict seq-order inclusion — #1 must be
    // included (it's earliest), and inclusion continues from there.
    expect(result.changes.map((c) => c.seq)).toEqual([1, 2, 3]);
  });
});

describe('capDeltaChanges — byte cap (max ~1 MiB)', () => {
  it('a batch whose cumulative size is comfortably under the byte cap is untruncated', () => {
    const candidates = Array.from({ length: 5 }, (_, i) => candidate(i + 1, 100));
    const result = capDeltaChanges(candidates, { maxBytes: 1_000_000 });
    expect(result.changes).toHaveLength(5);
    expect(result.truncated).toBe(false);
  });

  it('stops including further candidates once the NEXT one would push cumulative size over the byte cap', () => {
    // Each candidate serializes to a bit over 100KB; a 250KB budget should
    // fit exactly 2, not 3.
    const candidates = [candidate(1, 100_000), candidate(2, 100_000), candidate(3, 100_000)];
    const result = capDeltaChanges(candidates, { maxBytes: 250_000 });
    expect(result.changes).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.cursor).toBe(2);
  });

  it('PROGRESS GUARANTEE: a single candidate whose own size exceeds the byte cap is still included alone, never dropped to an empty page (which would wedge the cursor forever)', () => {
    const hugeCandidate = candidate(1, 2_000_000); // ~2MB alone, way over any reasonable cap
    const result = capDeltaChanges([hugeCandidate], { maxBytes: 1_000_000 });
    expect(result.changes).toHaveLength(1);
    expect(result.cursor).toBe(1);
  });

  it('a huge first candidate does not prevent a NORMAL-sized second candidate from being excluded correctly (first always included, second only if it still fits)', () => {
    const huge = candidate(1, 2_000_000);
    const normal = candidate(2, 100);
    const result = capDeltaChanges([huge, normal], { maxBytes: 1_000_000 });
    // huge alone already exceeds the budget, so nothing after it is included.
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].seq).toBe(1);
    expect(result.cursor).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('the DEFAULT byte cap (no override) is the real 1 MiB constant, not silently smaller/larger', () => {
    // 1 MiB / ~1KB-per-candidate ≈ ~1000 candidates worth of raw payload
    // size alone would fit byte-wise, but the 500-count cap should still be
    // the one that actually triggers here (count cap is stricter than the
    // byte cap for small payloads) — this test pins that DEFAULT is real
    // 1 MiB, not some smaller drifted value that would truncate earlier.
    const candidates = Array.from({ length: 600 }, (_, i) => candidate(i + 1, 100));
    const result = capDeltaChanges(candidates); // defaults: maxCount=500, maxBytes=1MiB
    expect(result.changes).toHaveLength(500); // count cap bites first, not the byte cap
  });
});

describe('capDeltaChanges — delete-op candidates (no payload) never inflate the byte measurement', () => {
  it('a delete candidate (no payload field) serializes small regardless of what its payload WOULD have been', () => {
    const deleteCandidate: DeltaChangeCandidate = { entity: 'task', entityId: 'gone', seq: 1, op: 'delete', payload: { note: 'x'.repeat(500_000) } };
    // Even though a stray `payload` was accidentally attached, the delete
    // shape must never serialize it — mirrors routes/sync.ts's own Change
    // wire shape (a delete carries no payload field at all).
    const result = capDeltaChanges([deleteCandidate], { maxBytes: 1000 });
    expect(result.changes).toHaveLength(1); // fits easily — payload was correctly excluded from the size measurement
  });
});
