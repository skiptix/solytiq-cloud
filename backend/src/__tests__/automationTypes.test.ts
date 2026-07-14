import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { QueryExec } from '../workspaceUtil';
import type { MutationActor } from '../automationEngine';

const listsMock = vi.hoisted(() => ({
  createListTask: vi.fn(),
  deleteTaskRow: vi.fn(),
  setListArchived: vi.fn(),
}));
vi.mock('../routes/lists', () => listsMock);

// vi.mock calls are hoisted above imports, so this static import already sees
// the mocked ../routes/lists module.
import { getActionDef, type ActionContext } from '../automationTypes';

function makeExec(rowsByCall: unknown[][] = []) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const exec = vi.fn(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    const rows = rowsByCall.shift() ?? [];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }) as unknown as QueryExec;
  return { exec, calls };
}

const actor: MutationActor = { type: 'automation', automationId: 'automation_1', runId: 'run_1' };

beforeEach(() => {
  vi.clearAllMocks();
});

function baseCtx(exec: QueryExec, overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    exec,
    workspaceId: 'ws_1',
    automationId: 'automation_1',
    automationOwnerId: 'owner_1',
    runId: 'run_1',
    actor,
    trigger: { workspaceId: 'ws_1' },
    ...overrides,
  };
}

describe('delete_task action', () => {
  it('deletes the trigger task', async () => {
    listsMock.deleteTaskRow.mockResolvedValueOnce(true);
    const { exec } = makeExec();
    const def = getActionDef('delete_task')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', task: { id: '42', title: 'Milk', listId: 'list_1', checked: true } } });
    const result = await def.execute(ctx, {});
    expect(result.ok).toBe(true);
    expect(listsMock.deleteTaskRow).toHaveBeenCalledWith(exec, 'list_1', '42');
  });

  it('fails cleanly when the trigger has no task (e.g. misconfigured graph)', async () => {
    const { exec } = makeExec();
    const def = getActionDef('delete_task')!;
    const result = await def.execute(baseCtx(exec), {});
    expect(result.ok).toBe(false);
    expect(listsMock.deleteTaskRow).not.toHaveBeenCalled();
  });
});

describe('archive_list action', () => {
  it('archives the trigger list', async () => {
    listsMock.setListArchived.mockResolvedValueOnce({ id: 'list_1', is_archived: true });
    const { exec } = makeExec();
    const def = getActionDef('archive_list')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', list: { id: 'list_1', name: 'Groceries' } } });
    const result = await def.execute(ctx, {});
    expect(result.ok).toBe(true);
    expect(listsMock.setListArchived).toHaveBeenCalledWith(exec, 'list_1', true);
  });
});

describe('move_task action — workspace IDOR guard', () => {
  it('rejects moving into a list that belongs to a different workspace', async () => {
    const { exec } = makeExec([[{ workspace_id: 'ws_OTHER' }]]); // target list lookup
    const def = getActionDef('move_task')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', task: { id: '1', title: 'x', listId: 'list_1', checked: false } } });
    const result = await def.execute(ctx, { targetListId: 'list_evil' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not in this automation's workspace/);
  });

  it('moves the task when the target list is in the same workspace', async () => {
    const { exec } = makeExec([
      [{ workspace_id: 'ws_1' }],  // assertListInWorkspace
      [{ id: 'sec_1' }],           // resolveTargetSection: first section
      [{ max: '3' }],              // position lookup
      [],                          // UPDATE tasks
    ]);
    const def = getActionDef('move_task')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', task: { id: '1', title: 'x', listId: 'list_1', checked: false } } });
    const result = await def.execute(ctx, { targetListId: 'list_2' });
    expect(result.ok).toBe(true);
  });
});

describe('create_task action — workspace IDOR guard', () => {
  it('rejects creating into a list from a different workspace', async () => {
    const { exec } = makeExec([[{ workspace_id: 'ws_OTHER' }]]);
    const def = getActionDef('create_task')!;
    const result = await def.execute(baseCtx(exec), { targetListId: 'list_evil', title: 'Follow up' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not in this automation's workspace/);
    expect(listsMock.createListTask).not.toHaveBeenCalled();
  });

  it('creates the task via the shared createListTask (so it inherits the same loop-prevention path)', async () => {
    listsMock.createListTask.mockResolvedValueOnce({ task: { id: '99' }, workspaceId: 'ws_1' });
    const { exec } = makeExec([[{ workspace_id: 'ws_1' }], [{ id: 'sec_1' }]]);
    const def = getActionDef('create_task')!;
    const result = await def.execute(baseCtx(exec), { targetListId: 'list_2', title: 'Follow up' });
    expect(result.ok).toBe(true);
    expect(listsMock.createListTask).toHaveBeenCalledWith(exec, 'list_2', 'sec_1', 'owner_1', { title: 'Follow up' }, actor);
  });
});

describe('notify action', () => {
  it('inserts a notification addressed to the automation\'s creator', async () => {
    const { exec, calls } = makeExec();
    const def = getActionDef('notify')!;
    const result = await def.execute(baseCtx(exec), { message: 'Done!' });
    expect(result.ok).toBe(true);
    expect(calls[0].text).toMatch(/INSERT INTO automation_notifications/);
    expect(calls[0].params).toEqual(expect.arrayContaining(['owner_1', 'automation_1', 'run_1', 'Done!']));
  });
});
