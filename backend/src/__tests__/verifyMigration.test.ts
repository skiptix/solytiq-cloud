import { describe, expect, it, vi } from 'vitest';
import { checkDrift, isFullyConsistent, sweepMigrationVerification } from '../graph/verifyMigration';
import type { QueryExec } from '../workspaceUtil';

function makeExec(countsByCall: number[]) {
  const calls: string[] = [];
  const exec = vi.fn(async (text: string) => {
    calls.push(text);
    const c = countsByCall.shift() ?? 0;
    return { rows: [{ c: String(c) }], rowCount: 1, command: '', oid: 0, fields: [] };
  }) as unknown as QueryExec;
  return { exec, calls };
}

// checkDrift issues, per mechanism, in order: sublists (2 queries: task-side
// missing + list-side missing, then 1 orphaned query), links (1 missing + 1
// orphaned), markdown (1 missing + 1 orphaned), task attachments (1 missing
// only — orphaned is a constant 0), milestone attachments (1 missing only).
// Total DB calls: 3 + 2 + 2 + 1 + 1 = 9.
const ALL_CLEAN = [0, 0, 0, 0, 0, 0, 0, 0, 0];

describe('checkDrift', () => {
  it('reports 5 mechanisms', async () => {
    const { exec } = makeExec([...ALL_CLEAN]);
    const results = await checkDrift(exec);
    expect(results).toHaveLength(5);
    expect(results.map((r) => r.mechanism)).toEqual([
      'sublists (list--[child_of]-->task)',
      'task->list links (task--[links_to]-->list)',
      'markdown page Todo sync (markdownList--[tracks]-->list)',
      'task attachments (file--[attached_to]-->task)',
      'milestone attachments (file--[attached_to]-->milestone)',
    ]);
  });

  it('a fully clean database reports zero missing/orphaned everywhere', async () => {
    const { exec } = makeExec([...ALL_CLEAN]);
    const results = await checkDrift(exec);
    expect(results.every((r) => r.missing === 0 && r.orphaned === 0)).toBe(true);
  });

  it('sums the task-side and list-side missing counts for the sublinks mechanism', async () => {
    // [task-missing=2, list-missing=3, orphaned=0, ...rest clean]
    const { exec } = makeExec([2, 3, 0, 0, 0, 0, 0, 0, 0]);
    const results = await checkDrift(exec);
    expect(results[0].missing).toBe(5);
  });

  it('surfaces an orphaned system edge for the links mechanism', async () => {
    const { exec } = makeExec([0, 0, 0, 0, 5, 0, 0, 0, 0]);
    const results = await checkDrift(exec);
    expect(results[1].orphaned).toBe(5);
  });
});

describe('isFullyConsistent', () => {
  it('true when every mechanism is clean', async () => {
    const { exec } = makeExec([...ALL_CLEAN]);
    expect(await isFullyConsistent(exec)).toBe(true);
  });

  it('false when any single mechanism has drift', async () => {
    const { exec } = makeExec([0, 0, 0, 0, 0, 0, 1, 0, 0]);
    expect(await isFullyConsistent(exec)).toBe(false);
  });
});

describe('sweepMigrationVerification', () => {
  it('resets the clean-day streak to 0 on any drift', async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const exec = vi.fn(async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      if (text.includes('SELECT COUNT(*)')) return { rows: [{ c: '1' }], rowCount: 1 }; // one mechanism drifting
      return { rows: [], rowCount: 0 };
    }) as unknown as QueryExec;

    await sweepMigrationVerification(exec);
    const streakWrite = calls.find((c) => c.text.includes('INSERT INTO app_settings') && c.params?.[0] === 'graph_migration_clean_days');
    expect(streakWrite?.params?.[1]).toBe('0');
  });

  it('increments the streak on a clean day and never writes graph_migration_verified before day 7', async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const exec = vi.fn(async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      if (text.includes('SELECT COUNT(*)')) return { rows: [{ c: '0' }], rowCount: 1 };
      if (text.includes('SELECT value FROM app_settings')) return { rows: [{ value: '3' }], rowCount: 1 }; // prior streak = 3
      return { rows: [], rowCount: 0 };
    }) as unknown as QueryExec;

    await sweepMigrationVerification(exec);
    const streakWrite = calls.find((c) => c.text.includes('INSERT INTO app_settings') && c.params?.[0] === 'graph_migration_clean_days');
    expect(streakWrite?.params?.[1]).toBe('4');
    expect(calls.some((c) => c.text.includes('INSERT INTO app_settings') && c.params?.[0] === 'graph_migration_verified')).toBe(false);
  });

  it('flips graph_migration_verified to true once the streak reaches 7', async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const exec = vi.fn(async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      if (text.includes('SELECT COUNT(*)')) return { rows: [{ c: '0' }], rowCount: 1 };
      if (text.includes('SELECT value FROM app_settings')) return { rows: [{ value: '6' }], rowCount: 1 }; // prior streak = 6 -> becomes 7
      return { rows: [], rowCount: 0 };
    }) as unknown as QueryExec;

    await sweepMigrationVerification(exec);
    const verifiedWrite = calls.find((c) => c.text.includes('INSERT INTO app_settings') && c.params?.[0] === 'graph_migration_verified');
    expect(verifiedWrite?.params?.[1]).toBe('true');
  });

  it('never throws, even when the underlying exec rejects', async () => {
    const exec = vi.fn(async () => { throw new Error('db down'); }) as unknown as QueryExec;
    await expect(sweepMigrationVerification(exec)).resolves.toBeUndefined();
  });
});
