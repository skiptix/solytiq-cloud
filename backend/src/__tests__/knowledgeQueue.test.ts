import { describe, expect, it, vi } from 'vitest';
import { enqueueEmbedding, claimQueueBatch, markQueueItem, getQueueStats } from '../knowledge/queue';
import type { QueryExec } from '../workspaceUtil';

function makeExec(rowsByCall: unknown[][] = []) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const exec = vi.fn(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    const rows = rowsByCall.shift() ?? [];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }) as unknown as QueryExec;
  return { exec, calls };
}

describe('enqueueEmbedding', () => {
  it('inserts a pending row with an ON CONFLICT upsert keyed on (entity_type, entity_id)', async () => {
    const { exec, calls } = makeExec([[]]);
    await enqueueEmbedding('task', '123', 'ws_1', exec);
    expect(calls[0].text).toContain('INSERT INTO embedding_queue');
    expect(calls[0].text).toContain('ON CONFLICT (entity_type, entity_id)');
    expect(calls[0].text).toContain("status = 'pending'");
    expect(calls[0].params).toEqual(['task', '123', 'ws_1']);
  });

  it('clears any stale lease/backoff state on re-enqueue (a fresh edit supersedes an old failed attempt\'s backoff)', async () => {
    const { exec, calls } = makeExec([[]]);
    await enqueueEmbedding('task', '123', 'ws_1', exec);
    expect(calls[0].text).toContain('next_attempt_at = NULL');
    expect(calls[0].text).toContain('lease_owner = NULL');
    expect(calls[0].text).toContain('lease_expires_at = NULL');
  });

  it('never throws even when the underlying exec rejects (best-effort, matches mentions.ts/inlineLinks.ts convention)', async () => {
    const exec = vi.fn(async () => { throw new Error('db down'); }) as unknown as QueryExec;
    await expect(enqueueEmbedding('task', '123', null, exec)).resolves.toBeUndefined();
  });
});

describe('claimQueueBatch (B3 — shared jobLease.ts claim primitive)', () => {
  it('claims due rows via FOR UPDATE SKIP LOCKED, stamps a lease, and marks them processing', async () => {
    const { exec, calls } = makeExec([[
      { id: 'eq_1', entity_type: 'task', entity_id: '1', workspace_id: 'ws_1', status: 'processing', attempts: 1 },
    ]]);
    const batch = await claimQueueBatch(5, exec);
    expect(batch).toEqual([{ id: 'eq_1', entityType: 'task', entityId: '1', workspaceId: 'ws_1', status: 'processing', attempts: 1 }]);
    expect(calls[0].text).toContain('FOR UPDATE SKIP LOCKED');
    expect(calls[0].text).toContain("status = 'pending'");
    // Also reclaims a stuck 'processing' row whose lease has expired — the
    // actual B3 fix (a crashed worker's claim used to be lost forever).
    expect(calls[0].text).toContain("status = 'processing'");
    expect(calls[0].text).toContain('lease_expires_at IS NULL OR lease_expires_at < NOW()');
    expect(calls[0].text).toContain('attempts = attempts + 1'); // incremented AT CLAIM time, not on completion
  });

  it('returns an empty array when nothing is due', async () => {
    const { exec } = makeExec([[]]);
    expect(await claimQueueBatch(5, exec)).toEqual([]);
  });
});

describe('markQueueItem — B3 retry-with-backoff + dead-letter', () => {
  it('a "done" outcome releases the lease and records no error', async () => {
    const { exec, calls } = makeExec([[]]);
    await markQueueItem('eq_1', 'done', null, exec);
    expect(calls[0].text).toContain("status = $2");
    expect(calls[0].text).toContain('lease_owner = NULL');
    expect(calls[0].params).toEqual(['eq_1', 'done', null]);
  });

  it('a "failed" outcome UNDER max_attempts returns to pending with an exponential-backoff next_attempt_at, not a terminal state', async () => {
    const { exec, calls } = makeExec([
      [{ attempts: 1, max_attempts: 5 }], // the SELECT markQueueItem does first
      [],
    ]);
    await markQueueItem('eq_1', 'failed', 'transient error', exec);
    expect(calls[0].text).toContain('SELECT attempts, max_attempts');
    expect(calls[1].text).toContain("status = 'pending'");
    expect(calls[1].text).toContain('next_attempt_at');
    expect(calls[1].params).toEqual(['eq_1', 'transient error', expect.any(Number)]);
  });

  it('a "failed" outcome AT OR OVER max_attempts moves to the terminal dead_letter state', async () => {
    const { exec, calls } = makeExec([
      [{ attempts: 5, max_attempts: 5 }],
      [],
    ]);
    await markQueueItem('eq_1', 'failed', 'permanent error', exec);
    expect(calls[1].text).toContain("status = 'dead_letter'");
    expect(calls[1].params).toEqual(['eq_1', 'permanent error']);
  });

  it('defaults to max_attempts=5 when the row lookup returns nothing (defensive, never throws)', async () => {
    const { exec, calls } = makeExec([[], []]);
    await expect(markQueueItem('eq_missing', 'failed', 'x', exec)).resolves.toBeUndefined();
    expect(calls[1].text).toContain("status = 'pending'"); // attempts defaults to 0, under the default max of 5
  });
});

describe('getQueueStats', () => {
  it('aggregates counts per status, defaulting unseen statuses (including dead_letter) to zero', async () => {
    const { exec } = makeExec([[
      { status: 'pending', c: '3' },
      { status: 'done', c: '10' },
      { status: 'skipped_budget', c: '1' },
    ]]);
    const stats = await getQueueStats(exec);
    expect(stats).toEqual({ pending: 3, processing: 0, done: 10, failed: 0, skippedBudget: 1, deadLetter: 0 });
  });

  it('surfaces a non-zero dead_letter count', async () => {
    const { exec } = makeExec([[{ status: 'dead_letter', c: '2' }]]);
    const stats = await getQueueStats(exec);
    expect(stats.deadLetter).toBe(2);
  });
});
