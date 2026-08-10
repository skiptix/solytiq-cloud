import { describe, expect, it, vi } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import { releaseOwnedLeases, backoffWithJitterMs } from '../jobLease';

function mockExec(rowCount: number) {
  const fn = vi.fn(async (): Promise<QueryResult<QueryResultRow>> => ({
    rows: [], rowCount, command: 'UPDATE', oid: 0, fields: [],
  }));
  return fn;
}

describe('releaseOwnedLeases — B8 graceful-shutdown lease release', () => {
  it('with no excludeIds, releases every row for the given owner (no exclude clause in the SQL)', async () => {
    const exec = mockExec(3);
    const released = await releaseOwnedLeases('automations', 'worker_abc', [], exec);
    expect(released).toBe(3);
    expect(exec).toHaveBeenCalledTimes(1);
    const [sql, params] = exec.mock.calls[0];
    expect(sql).toMatch(/UPDATE automations SET lease_owner = NULL, lease_expires_at = NULL WHERE lease_owner = \$1/);
    expect(sql).not.toMatch(/!=/); // no exclude clause when excludeIds is empty
    expect(params).toEqual(['worker_abc']);
  });

  it('with excludeIds, adds the exclusion clause and passes the id array as the second parameter', async () => {
    const exec = mockExec(2);
    const released = await releaseOwnedLeases('embedding_queue', 'worker_abc', ['id_in_flight'], exec);
    expect(released).toBe(2);
    const [sql, params] = exec.mock.calls[0];
    expect(sql).toMatch(/AND id != ALL\(\$2::varchar\[\]\)/);
    expect(params).toEqual(['worker_abc', ['id_in_flight']]);
  });

  it('targets the table name passed in, not a hardcoded one — reusable across BOTH lease-holding tables', async () => {
    const execA = mockExec(0);
    await releaseOwnedLeases('automations', 'w1', [], execA);
    expect(execA.mock.calls[0][0]).toContain('UPDATE automations ');

    const execB = mockExec(0);
    await releaseOwnedLeases('embedding_queue', 'w1', [], execB);
    expect(execB.mock.calls[0][0]).toContain('UPDATE embedding_queue ');
  });

  it('returns 0 (not null/undefined) when rowCount is null (defensive — pg can return null rowCount)', async () => {
    const exec = vi.fn(async (): Promise<QueryResult<QueryResultRow>> => ({
      rows: [], rowCount: null, command: 'UPDATE', oid: 0, fields: [],
    }));
    const released = await releaseOwnedLeases('automations', 'w1', [], exec);
    expect(released).toBe(0);
  });

  it('a multi-id exclude list is passed through intact (the in-flight tracking is a single id today, but the primitive itself is not limited to one)', async () => {
    const exec = mockExec(5);
    await releaseOwnedLeases('automations', 'w1', ['a', 'b', 'c'], exec);
    const [, params] = exec.mock.calls[0];
    expect(params).toEqual(['w1', ['a', 'b', 'c']]);
  });
});

// Sanity check this file's own imports resolve correctly alongside the
// pre-existing pure function this module also exports (no dedicated test
// file previously existed for jobLease.ts as a whole).
describe('backoffWithJitterMs — sanity (already covered indirectly elsewhere, pinned here too)', () => {
  it('never exceeds the cap', () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const delay = backoffWithJitterMs(attempt, 100, 5000, () => 0.999999);
      expect(delay).toBeLessThanOrEqual(5000);
    }
  });
});
