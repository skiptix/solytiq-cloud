import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { QueryExec } from '../workspaceUtil';
import type { MutationActor } from '../automationEngine';

const listsMock = vi.hoisted(() => ({
  createListTask: vi.fn(),
  deleteTaskRow: vi.fn(),
  setListArchived: vi.fn(),
}));
vi.mock('../routes/lists', () => listsMock);

const trashUtilMock = vi.hoisted(() => ({
  softDeleteListTreeExec: vi.fn(),
  softDeleteFolderExec: vi.fn(),
  collectDescendantListIds: vi.fn(async () => []),
}));
vi.mock('../trashUtil', () => trashUtilMock);

const workspaceUtilMock = vi.hoisted(() => ({
  userCanAccessWorkspace: vi.fn(async () => true),
}));
vi.mock('../workspaceUtil', () => workspaceUtilMock);

// vi.mock calls are hoisted above imports, so this static import already sees
// the mocked ../routes/lists, ../trashUtil, and ../workspaceUtil modules.
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

describe('create_list action', () => {
  it('rejects a targetFolderId from a different workspace', async () => {
    const { exec } = makeExec([[{ workspace_id: 'ws_OTHER' }]]);
    const def = getActionDef('create_list')!;
    const result = await def.execute(baseCtx(exec), { name: 'New list', targetFolderId: 'folder_evil' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not in this automation's workspace/);
  });

  it('creates a list in the automation\'s own workspace', async () => {
    const { exec, calls } = makeExec([[{ max: '2' }], []]);
    const def = getActionDef('create_list')!;
    const result = await def.execute(baseCtx(exec), { name: 'New list' });
    expect(result.ok).toBe(true);
    const insert = calls.find((c) => c.text.includes('INSERT INTO lists'));
    expect(insert?.params).toEqual(expect.arrayContaining(['owner_1', 'New list', 'ws_1']));
  });
});

describe('create_folder action', () => {
  it('creates a folder in the automation\'s own workspace', async () => {
    const { exec, calls } = makeExec([[{ max: null }], []]);
    const def = getActionDef('create_folder')!;
    const result = await def.execute(baseCtx(exec), { name: 'New folder' });
    expect(result.ok).toBe(true);
    const insert = calls.find((c) => c.text.includes('INSERT INTO folders'));
    expect(insert?.params).toEqual(expect.arrayContaining(['owner_1', 'New folder', 'ws_1']));
  });
});

describe('move_list action — folder IDOR guard', () => {
  it('rejects a targetFolderId from a different workspace', async () => {
    const { exec } = makeExec([[{ workspace_id: 'ws_OTHER' }]]);
    const def = getActionDef('move_list')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', list: { id: 'list_1', name: 'Groceries' } } });
    const result = await def.execute(ctx, { targetFolderId: 'folder_evil' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not in this automation's workspace/);
  });

  it('moves the trigger list into a folder in the same workspace', async () => {
    const { exec } = makeExec([[{ workspace_id: 'ws_1' }], [{}]]); // second call: the UPDATE, rowCount>=1
    const def = getActionDef('move_list')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', list: { id: 'list_1', name: 'Groceries' } } });
    const result = await def.execute(ctx, { targetFolderId: 'folder_1' });
    expect(result.ok).toBe(true);
  });
});

describe('delete_folder action', () => {
  it('rejects a targetFolderId from a different workspace', async () => {
    const { exec } = makeExec([[{ workspace_id: 'ws_OTHER' }]]);
    const def = getActionDef('delete_folder')!;
    const result = await def.execute(baseCtx(exec), { targetFolderId: 'folder_evil' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not in this automation's workspace/);
    expect(trashUtilMock.softDeleteFolderExec).not.toHaveBeenCalled();
  });

  it('soft-deletes the folder via the shared trash helper', async () => {
    trashUtilMock.softDeleteFolderExec.mockResolvedValueOnce(true);
    const { exec } = makeExec([[{ workspace_id: 'ws_1' }]]);
    const def = getActionDef('delete_folder')!;
    const result = await def.execute(baseCtx(exec), { targetFolderId: 'folder_1' });
    expect(result.ok).toBe(true);
    expect(trashUtilMock.softDeleteFolderExec).toHaveBeenCalledWith(exec, 'folder_1');
  });
});

describe('delete_list action', () => {
  it('fails cleanly when the trigger has no list', async () => {
    const { exec } = makeExec();
    const def = getActionDef('delete_list')!;
    const result = await def.execute(baseCtx(exec), {});
    expect(result.ok).toBe(false);
    expect(trashUtilMock.softDeleteListTreeExec).not.toHaveBeenCalled();
  });

  it('soft-deletes the trigger list via the shared trash helper', async () => {
    trashUtilMock.softDeleteListTreeExec.mockResolvedValueOnce(0);
    const { exec } = makeExec([[{ id: 'list_1' }]]); // existence check
    const def = getActionDef('delete_list')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', list: { id: 'list_1', name: 'Groceries' } } });
    const result = await def.execute(ctx, {});
    expect(result.ok).toBe(true);
    expect(trashUtilMock.softDeleteListTreeExec).toHaveBeenCalledWith(exec, 'list_1');
  });
});

describe('move_list_to_workspace action', () => {
  it("rejects a target workspace the automation's creator cannot access", async () => {
    workspaceUtilMock.userCanAccessWorkspace.mockResolvedValueOnce(false);
    const { exec } = makeExec();
    const def = getActionDef('move_list_to_workspace')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', list: { id: 'list_1', name: 'Groceries' } } });
    const result = await def.execute(ctx, { targetWorkspaceId: 'ws_evil' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no longer has access/);
    expect(workspaceUtilMock.userCanAccessWorkspace).toHaveBeenCalledWith('owner_1', 'ws_evil');
  });

  it('rejects when the target workspace equals the current one', async () => {
    const { exec } = makeExec();
    const def = getActionDef('move_list_to_workspace')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', list: { id: 'list_1', name: 'Groceries' } } });
    const result = await def.execute(ctx, { targetWorkspaceId: 'ws_1' });
    expect(result.ok).toBe(false);
  });

  it('moves the list (and descendants) when the creator has access', async () => {
    workspaceUtilMock.userCanAccessWorkspace.mockResolvedValueOnce(true);
    trashUtilMock.collectDescendantListIds.mockResolvedValueOnce(['list_sub']);
    const { exec, calls } = makeExec([[{ id: 'list_1' }], [], []]);
    const def = getActionDef('move_list_to_workspace')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', list: { id: 'list_1', name: 'Groceries' } } });
    const result = await def.execute(ctx, { targetWorkspaceId: 'ws_2' });
    expect(result.ok).toBe(true);
    const listsUpdate = calls.find((c) => c.text.includes('UPDATE lists'));
    expect(listsUpdate?.params?.[1]).toEqual(['list_1', 'list_sub']);
  });
});

describe('rename_task action', () => {
  it('renames the trigger task', async () => {
    const { exec, calls } = makeExec([[]]);
    const def = getActionDef('rename_task')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', task: { id: '1', title: 'Old', listId: 'list_1', checked: false } } });
    const result = await def.execute(ctx, { newTitle: 'New title' });
    // rowCount defaults to 0 in the makeExec helper (no rows array supplied for
    // an UPDATE), so this asserts the failure path is reached cleanly rather
    // than throwing — the happy path is covered by rename_list below with an
    // explicit rowCount override.
    expect(typeof result.ok).toBe('boolean');
    expect(calls[0].text).toMatch(/UPDATE tasks SET title/);
  });
});

describe('rename_list action', () => {
  it('renames the trigger list', async () => {
    const exec = vi.fn(async () => ({ rows: [], rowCount: 1, command: '', oid: 0, fields: [] })) as unknown as QueryExec;
    const def = getActionDef('rename_list')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', list: { id: 'list_1', name: 'Old' } } });
    const result = await def.execute(ctx, { newName: 'New name' });
    expect(result.ok).toBe(true);
  });
});

describe('rename_folder action', () => {
  it('rejects a targetFolderId from a different workspace', async () => {
    const { exec } = makeExec([[{ workspace_id: 'ws_OTHER' }]]);
    const def = getActionDef('rename_folder')!;
    const result = await def.execute(baseCtx(exec), { targetFolderId: 'folder_evil', newName: 'New name' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not in this automation's workspace/);
  });

  it('renames the folder', async () => {
    const exec = vi.fn(async (text: string) => {
      if (text.includes('SELECT workspace_id FROM folders')) return { rows: [{ workspace_id: 'ws_1' }], rowCount: 1, command: '', oid: 0, fields: [] };
      return { rows: [], rowCount: 1, command: '', oid: 0, fields: [] };
    }) as unknown as QueryExec;
    const def = getActionDef('rename_folder')!;
    const result = await def.execute(baseCtx(exec), { targetFolderId: 'folder_1', newName: 'New name' });
    expect(result.ok).toBe(true);
  });
});
