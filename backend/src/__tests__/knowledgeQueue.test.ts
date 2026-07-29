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

  it('never throws even when the underlying exec rejects (best-effort, matches mentions.ts/inlineLinks.ts convention)', async () => {
    const exec = vi.fn(async () => { throw new Error('db down'); }) as unknown as QueryExec;
    await expect(enqueueEmbedding('task', '123', null, exec)).resolves.toBeUndefined();
  });
});

describe('claimQueueBatch', () => {
  it('claims pending rows via FOR UPDATE SKIP LOCKED and marks them processing', async () => {
    const { exec, calls } = makeExec([[
      { id: 'eq_1', entity_type: 'task', entity_id: '1', workspace_id: 'ws_1', status: 'processing', attempts: 0 },
    ]]);
    const batch = await claimQueueBatch(5, exec);
    expect(batch).toEqual([{ id: 'eq_1', entityType: 'task', entityId: '1', workspaceId: 'ws_1', status: 'processing', attempts: 0 }]);
    expect(calls[0].text).toContain('FOR UPDATE SKIP LOCKED');
    expect(calls[0].text).toContain("status = 'pending'");
    expect(calls[0].params).toEqual([5]);
  });

  it('returns an empty array when nothing is pending', async () => {
    const { exec } = makeExec([[]]);
    expect(await claimQueueBatch(5, exec)).toEqual([]);
  });
});

describe('markQueueItem', () => {
  it('bumps attempts and records the status/error', async () => {
    const { exec, calls } = makeExec([[]]);
    await markQueueItem('eq_1', 'failed', 'boom', exec);
    expect(calls[0].text).toContain('attempts = attempts + 1');
    expect(calls[0].params).toEqual(['eq_1', 'failed', 'boom']);
  });
});

describe('getQueueStats', () => {
  it('aggregates counts per status, defaulting unseen statuses to zero', async () => {
    const { exec } = makeExec([[
      { status: 'pending', c: '3' },
      { status: 'done', c: '10' },
      { status: 'skipped_budget', c: '1' },
    ]]);
    const stats = await getQueueStats(exec);
    expect(stats).toEqual({ pending: 3, processing: 0, done: 10, failed: 0, skippedBudget: 1 });
  });
});
