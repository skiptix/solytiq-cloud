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
    expect(calls[0].text).toContain("DO UPDATE SET role = 'owner'");
    expect(calls[0].params).toEqual(['user-1']);
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
