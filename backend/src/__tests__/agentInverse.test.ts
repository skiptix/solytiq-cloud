import { describe, expect, it, vi } from 'vitest';
import { snapshotBeforeToolCall, buildMutationRecord, revertMutation, REVERTIBLE_TOOL_NAMES } from '../agent/inverse';
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

describe('REVERTIBLE_TOOL_NAMES', () => {
  it('covers the curated subset this module actually implements', () => {
    expect([...REVERTIBLE_TOOL_NAMES].sort()).toEqual(['create_dashboard_task', 'create_task_in_list', 'delete_task', 'update_task']);
  });
});

describe('snapshotBeforeToolCall', () => {
  it('returns null for a non-revertible tool without touching the database', async () => {
    const { exec, calls } = makeExec();
    const before = await snapshotBeforeToolCall('list_tasks', {}, 'user-1', exec);
    expect(before).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null for create_dashboard_task (nothing exists yet to snapshot)', async () => {
    const { exec } = makeExec();
    expect(await snapshotBeforeToolCall('create_dashboard_task', { title: 'New' }, 'user-1', exec)).toBeNull();
  });

  it('snapshots the full row before an update_task, scoped to the acting user', async () => {
    const { exec, calls } = makeExec([[{ id: '1', title: 'Old title' }]]);
    const before = await snapshotBeforeToolCall('update_task', { task_id: 1 }, 'user-1', exec);
    expect(before).toEqual({ id: '1', title: 'Old title' });
    expect(calls[0].params).toEqual([1, 'user-1']);
  });

  it('returns null when the snapshot query itself throws (best-effort, never propagates)', async () => {
    const exec = vi.fn(async () => { throw new Error('db down'); }) as unknown as QueryExec;
    expect(await snapshotBeforeToolCall('update_task', { task_id: 1 }, 'user-1', exec)).toBeNull();
  });
});

describe('buildMutationRecord', () => {
  it('resolves create_dashboard_task by looking up the newest matching row for this user', async () => {
    const { exec, calls } = makeExec([[{ id: '999' }]]);
    const mutation = await buildMutationRecord('create_dashboard_task', { title: 'Buy milk' }, null, 'user-1', exec);
    expect(mutation).toEqual({ toolName: 'create_dashboard_task', entityType: 'task', entityId: '999', beforeState: null });
    expect(calls[0].text).toContain('ORDER BY id DESC LIMIT 1');
    expect(calls[0].params).toEqual(['user-1', 'Buy milk']);
  });

  it('returns null for create_dashboard_task when the title arg is missing (nothing to look up)', async () => {
    const { exec } = makeExec();
    expect(await buildMutationRecord('create_dashboard_task', {}, null, 'user-1', exec)).toBeNull();
  });

  it('create_task_in_list shares the same handler as create_dashboard_task', async () => {
    const { exec, calls } = makeExec([[{ id: '888' }]]);
    const mutation = await buildMutationRecord('create_task_in_list', { title: 'Ship it' }, null, 'user-1', exec);
    expect(mutation).toEqual({ toolName: 'create_task_in_list', entityType: 'task', entityId: '888', beforeState: null });
    expect(calls[0].params).toEqual(['user-1', 'Ship it']);
  });

  it('carries the pre-captured before-state through for update_task', async () => {
    const before = { id: '1', title: 'Old' };
    const mutation = await buildMutationRecord('update_task', { task_id: 1 }, before, 'user-1', {} as QueryExec);
    expect(mutation).toEqual({ toolName: 'update_task', entityType: 'task', entityId: '1', beforeState: before });
  });

  it('returns null for update_task when no before-state was captured (task was already gone)', async () => {
    expect(await buildMutationRecord('update_task', { task_id: 1 }, null, 'user-1', {} as QueryExec)).toBeNull();
  });

  it('returns null for an unregistered tool', async () => {
    expect(await buildMutationRecord('list_tasks', {}, null, 'user-1', {} as QueryExec)).toBeNull();
  });
});

describe('revertMutation', () => {
  it('create_dashboard_task reverts by deleting the created row, scoped to the acting user', async () => {
    const { exec, calls } = makeExec([[]]);
    await revertMutation({ toolName: 'create_dashboard_task', entityType: 'task', entityId: '999', beforeState: null }, 'user-1', exec);
    expect(calls[0].text).toContain('DELETE FROM tasks');
    expect(calls[0].params).toEqual(['999', 'user-1']);
  });

  it('update_task reverts by restoring the captured field values', async () => {
    const { exec, calls } = makeExec([[]]);
    const before = { title: 'Old', note: 'n', checked: false, deadline: null, priority: 'High', badge: null };
    await revertMutation({ toolName: 'update_task', entityType: 'task', entityId: '1', beforeState: before }, 'user-1', exec);
    expect(calls[0].text).toContain('UPDATE tasks SET');
    expect(calls[0].params).toEqual(['Old', 'n', false, null, 'High', null, '1', 'user-1']);
  });

  it('delete_task reverts by re-inserting the full captured row', async () => {
    const { exec, calls } = makeExec([[]]);
    const before = { id: '1', user_id: 'user-1', title: 'Restored' };
    await revertMutation({ toolName: 'delete_task', entityType: 'task', entityId: '1', beforeState: before }, 'user-1', exec);
    expect(calls[0].text).toContain('INSERT INTO tasks');
    expect(calls[0].text).toContain('ON CONFLICT (id) DO NOTHING');
    expect(calls[0].params).toEqual(['1', 'user-1', 'Restored']);
  });

  it('a delete/update revert with no beforeState is a safe no-op (nothing captured to restore)', async () => {
    const { exec, calls } = makeExec();
    await revertMutation({ toolName: 'update_task', entityType: 'task', entityId: '1', beforeState: null }, 'user-1', exec);
    expect(calls).toHaveLength(0);
  });

  it('throws for a tool with no registered revert handler', async () => {
    const { exec } = makeExec();
    await expect(
      revertMutation({ toolName: 'list_tasks', entityType: 'task', entityId: '1', beforeState: null }, 'user-1', exec)
    ).rejects.toThrow('not revertible');
  });
});
