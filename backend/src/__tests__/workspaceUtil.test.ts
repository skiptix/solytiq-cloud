import { describe, expect, it, vi } from 'vitest';
import { ensureOwnedWorkspaceMemberships, ensurePersonalWorkspace, type QueryExec } from '../workspaceUtil';

function makeExec(rowsByCall: unknown[][] = []) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const exec = vi.fn(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    const rows = rowsByCall.shift() ?? [];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }) as unknown as QueryExec;
  return { exec, calls };
}

describe('workspace membership healing', () => {
  it('repairs owner membership rows for every workspace owned by a user', async () => {
    const { exec, calls } = makeExec();

    await ensureOwnedWorkspaceMemberships(exec, 'user-1');

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('INSERT INTO workspace_members');
    expect(calls[0].text).toContain('SELECT w.id, w.owner_id');
    expect(calls[0].text).toContain("SET role = 'owner'");
    expect(calls[0].params).toEqual(['user-1']);
  });

  // Regression test: this function is called on EVERY `GET /api/workspaces`
  // (see routes/workspaces.ts). An `ON CONFLICT DO UPDATE` with no WHERE guard
  // performs an actual row UPDATE even when the value is unchanged, which
  // fires the workspace_members sync_log trigger on every single request —
  // and since the sync engine reacts to a `workspace` change by reloading the
  // workspace list (which calls this function again), that becomes a
  // self-sustaining loop that floods the client and trips the rate limiter.
  // The UPDATE must be conditioned so a no-op call performs no write at all.
  it('guards the DO UPDATE so a no-op call fires no write (prevents a sync_log storm)', async () => {
    const { exec, calls } = makeExec();

    await ensureOwnedWorkspaceMemberships(exec, 'user-1');

    expect(calls[0].text).toMatch(/DO UPDATE\s+SET role = 'owner'\s+WHERE workspace_members\.role IS DISTINCT FROM 'owner'/);
  });

  it('heals owned workspace memberships when a personal workspace already exists', async () => {
    const { exec, calls } = makeExec([[{ id: 'ws_existing' }], []]);

    const wsId = await ensurePersonalWorkspace(exec, 'user-1');

    expect(wsId).toBe('ws_existing');
    expect(calls).toHaveLength(2);
    expect(calls[1].text).toContain('INSERT INTO workspace_members');
    expect(calls[1].params).toEqual(['user-1']);
  });
});
