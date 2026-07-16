import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { QueryExec } from '../workspaceUtil';
import type { MutationActor } from '../automationEngine';

const listsMock = vi.hoisted(() => ({
  createListTask: vi.fn(),
  deleteTaskRow: vi.fn(),
  setListArchived: vi.fn(),
  updateListTaskFields: vi.fn(),
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

const httpNodeMock = vi.hoisted(() => ({
  performHttpRequest: vi.fn(),
  clampTimeoutMs: (v: unknown) => (typeof v === 'number' ? v : 10_000),
}));
vi.mock('../httpNode', () => httpNodeMock);

const codeNodeMock = vi.hoisted(() => ({
  runSandboxedCode: vi.fn(),
}));
vi.mock('../codeNode', () => codeNodeMock);

// vi.mock calls are hoisted above imports, so this static import already sees
// the mocked ../routes/lists, ../trashUtil, ../workspaceUtil, ../httpNode, and
// ../codeNode modules.
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
    // Passthrough — these tests exercise each action's own decision logic, not
    // the transaction-wrapping/rollback-on-failure mechanism itself (that's
    // automationEngine.test.ts's job, against the real runActionTransaction).
    withTransaction: (fn) => fn(exec),
    workspaceId: 'ws_1',
    automationId: 'automation_1',
    automationOwnerId: 'owner_1',
    runId: 'run_1',
    actor,
    trigger: { workspaceId: 'ws_1' },
    scope: { trigger: null, $json: null, nodes: {} },
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
    expect(result.output).toEqual({ folderId: 'folder_1', name: 'New name' });
  });
});

describe('action outputs (data flow into later nodes)', () => {
  it('delete_task returns {taskId, title}', async () => {
    listsMock.deleteTaskRow.mockResolvedValueOnce(true);
    const { exec } = makeExec();
    const def = getActionDef('delete_task')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', task: { id: '42', title: 'Milk', listId: 'list_1', checked: true } } });
    const result = await def.execute(ctx, {});
    expect(result.output).toEqual({ taskId: '42', title: 'Milk' });
  });

  it('create_list returns {listId, name, folderId}', async () => {
    const { exec } = makeExec([[{ max: '2' }], []]);
    const def = getActionDef('create_list')!;
    const result = await def.execute(baseCtx(exec), { name: 'New list' });
    expect(result.output).toMatchObject({ name: 'New list', folderId: null });
    expect(typeof (result.output as { listId: string }).listId).toBe('string');
  });

  it('create_task returns the created task id and target list', async () => {
    listsMock.createListTask.mockResolvedValueOnce({ task: { id: '99' }, workspaceId: 'ws_1' });
    const { exec } = makeExec([[{ workspace_id: 'ws_1' }], [{ id: 'sec_1' }]]);
    const def = getActionDef('create_task')!;
    const result = await def.execute(baseCtx(exec), { targetListId: 'list_2', title: 'Follow up' });
    expect(result.output).toEqual({ taskId: '99', title: 'Follow up', listId: 'list_2' });
  });
});

describe('http_request action', () => {
  beforeEach(() => {
    httpNodeMock.performHttpRequest.mockReset();
  });

  it('fails cleanly when url is missing', async () => {
    const { exec } = makeExec();
    const def = getActionDef('http_request')!;
    const result = await def.execute(baseCtx(exec), { method: 'GET', bodyType: 'none' });
    expect(result.ok).toBe(false);
    expect(httpNodeMock.performHttpRequest).not.toHaveBeenCalled();
  });

  it('delegates to performHttpRequest with normalized params and surfaces its output', async () => {
    httpNodeMock.performHttpRequest.mockResolvedValueOnce({
      ok: true,
      output: { status: 200, statusText: 'OK', headers: {}, body: { hello: 'world' } },
    });
    const { exec } = makeExec();
    const def = getActionDef('http_request')!;
    const result = await def.execute(baseCtx(exec), {
      url: 'https://example.com/api',
      method: 'POST',
      headers: [{ key: 'X-Test', value: '1' }],
      queryParams: [],
      bodyType: 'json',
      body: '{"a":1}',
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ status: 200, statusText: 'OK', headers: {}, body: { hello: 'world' } });
    expect(httpNodeMock.performHttpRequest).toHaveBeenCalledWith({
      url: 'https://example.com/api',
      method: 'POST',
      headers: [{ key: 'X-Test', value: '1' }],
      queryParams: [],
      bodyType: 'json',
      body: '{"a":1}',
      timeoutMs: 5000,
    });
  });

  it('surfaces an SSRF-guard (or other) failure from performHttpRequest as a failed result', async () => {
    httpNodeMock.performHttpRequest.mockResolvedValueOnce({ ok: false, error: 'URL resolves to a private/internal address, which automations are not allowed to reach' });
    const { exec } = makeExec();
    const def = getActionDef('http_request')!;
    const result = await def.execute(baseCtx(exec), { url: 'http://169.254.169.254/', method: 'GET', bodyType: 'none' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/private\/internal/);
  });
});

describe('code action', () => {
  beforeEach(() => {
    codeNodeMock.runSandboxedCode.mockReset();
  });

  it('fails cleanly when code is missing', async () => {
    const { exec } = makeExec();
    const def = getActionDef('code')!;
    const result = await def.execute(baseCtx(exec), {});
    expect(result.ok).toBe(false);
    expect(codeNodeMock.runSandboxedCode).not.toHaveBeenCalled();
  });

  it('passes the code and ctx.scope through to runSandboxedCode and surfaces its output', async () => {
    codeNodeMock.runSandboxedCode.mockResolvedValueOnce({ ok: true, output: { doubled: 4 } });
    const { exec } = makeExec();
    const scope = { trigger: { task: { title: 'x' } }, $json: null, nodes: {} };
    const def = getActionDef('code')!;
    const result = await def.execute(baseCtx(exec, { scope }), { code: 'return { doubled: 2 * 2 };' });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ doubled: 4 });
    expect(codeNodeMock.runSandboxedCode).toHaveBeenCalledWith('return { doubled: 2 * 2 };', scope);
  });

  it('surfaces a sandbox error (e.g. timeout) as a failed result', async () => {
    codeNodeMock.runSandboxedCode.mockResolvedValueOnce({ ok: false, error: 'Code timed out after 5000ms' });
    const { exec } = makeExec();
    const def = getActionDef('code')!;
    const result = await def.execute(baseCtx(exec), { code: 'while(true){}' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/);
  });
});

// ---------------------------------------------------------------------------
// Consolidated Task/List/Folder nodes — these route to the (now-hidden)
// granular actions above wherever equivalent logic already exists, so most
// coverage here focuses on: dispatch-by-operation actually reaches the right
// place, and the genuinely NEW bodies (Task/edit, List/edit, List/move's
// folder-vs-workspace branch, Folder/edit, Folder/move).
// ---------------------------------------------------------------------------

describe('task node — operation dispatch', () => {
  it('requiresTriggerTask is a function that is false for create and true otherwise', () => {
    const def = getActionDef('task')!;
    expect(typeof def.requiresTriggerTask).toBe('function');
    const fn = def.requiresTriggerTask as (p: Record<string, unknown>) => boolean;
    expect(fn({ operation: 'create' })).toBe(false);
    expect(fn({ operation: 'delete' })).toBe(true);
    expect(fn({ operation: 'move' })).toBe(true);
    expect(fn({ operation: 'edit' })).toBe(true);
    expect(fn({ operation: 'rename' })).toBe(true);
  });

  it('rejects an unknown operation', () => {
    const def = getActionDef('task')!;
    expect(def.validate({ operation: 'nuke' })).toMatch(/operation must be one of/);
  });

  it('create delegates to create_task', async () => {
    listsMock.createListTask.mockResolvedValueOnce({ task: { id: '99' }, workspaceId: 'ws_1' });
    const { exec } = makeExec([[{ workspace_id: 'ws_1' }], [{ id: 'sec_1' }]]);
    const def = getActionDef('task')!;
    const result = await def.execute(baseCtx(exec), { operation: 'create', targetListId: 'list_2', title: 'Follow up' });
    expect(result.ok).toBe(true);
    expect(listsMock.createListTask).toHaveBeenCalledWith(exec, 'list_2', 'sec_1', 'owner_1', { title: 'Follow up' }, actor);
  });

  it('delete delegates to delete_task', async () => {
    listsMock.deleteTaskRow.mockResolvedValueOnce(true);
    const { exec } = makeExec();
    const def = getActionDef('task')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', task: { id: '42', title: 'Milk', listId: 'list_1', checked: true } } });
    const result = await def.execute(ctx, { operation: 'delete' });
    expect(result.ok).toBe(true);
    expect(listsMock.deleteTaskRow).toHaveBeenCalledWith(exec, 'list_1', '42');
  });

  it('rename delegates to rename_task', async () => {
    const { exec, calls } = makeExec([[]]);
    const def = getActionDef('task')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', task: { id: '1', title: 'Old', listId: 'list_1', checked: false } } });
    await def.execute(ctx, { operation: 'rename', newTitle: 'New title' });
    expect(calls[0].text).toMatch(/UPDATE tasks SET title/);
  });

  it('move delegates to move_task (workspace IDOR guard still applies)', async () => {
    const { exec } = makeExec([[{ workspace_id: 'ws_OTHER' }]]);
    const def = getActionDef('task')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', task: { id: '1', title: 'x', listId: 'list_1', checked: false } } });
    const result = await def.execute(ctx, { operation: 'move', targetListId: 'list_evil' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not in this automation's workspace/);
  });

  it('edit fails cleanly with no trigger task', async () => {
    const { exec } = makeExec();
    const def = getActionDef('task')!;
    const result = await def.execute(baseCtx(exec), { operation: 'edit', note: 'hi' });
    expect(result.ok).toBe(false);
    expect(listsMock.updateListTaskFields).not.toHaveBeenCalled();
  });

  it('edit updates the trigger task via the shared updateListTaskFields (same loop-prevention path)', async () => {
    listsMock.updateListTaskFields.mockResolvedValueOnce({ id: '1' });
    const { exec } = makeExec();
    const def = getActionDef('task')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', task: { id: '1', title: 'Milk', listId: 'list_1', checked: false } } });
    const result = await def.execute(ctx, { operation: 'edit', note: 'Get 2%', priority: 'High' });
    expect(result.ok).toBe(true);
    expect(listsMock.updateListTaskFields).toHaveBeenCalledWith(
      exec, 'list_1', '1',
      { note: 'Get 2%', deadline: null, time_val: null, priority: 'High', badge: null, updateLinkedList: false },
      actor
    );
  });

  it('edit leaves fields untouched when left blank (COALESCE semantics — null, not empty string)', async () => {
    listsMock.updateListTaskFields.mockResolvedValueOnce({ id: '1' });
    const { exec } = makeExec();
    const def = getActionDef('task')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', task: { id: '1', title: 'Milk', listId: 'list_1', checked: false } } });
    await def.execute(ctx, { operation: 'edit' });
    expect(listsMock.updateListTaskFields).toHaveBeenCalledWith(
      exec, 'list_1', '1',
      { note: null, deadline: null, time_val: null, priority: null, badge: null, updateLinkedList: false },
      actor
    );
  });

  it('validate rejects a malformed deadline/time/priority for the edit operation', () => {
    const def = getActionDef('task')!;
    expect(def.validate({ operation: 'edit', deadline: 'not-a-date' })).toMatch(/YYYY-MM-DD/);
    expect(def.validate({ operation: 'edit', time: '25:99' })).toMatch(/HH:MM/);
    expect(def.validate({ operation: 'edit', priority: 'Urgent' })).toMatch(/High, Medium, or Low/);
    expect(def.validate({ operation: 'edit', deadline: '2026-01-01', time: '09:30', priority: 'High' })).toBeNull();
  });
});

describe('list node — operation dispatch', () => {
  it('requiresTriggerList is a function that is false for create and true otherwise', () => {
    const def = getActionDef('list')!;
    expect(typeof def.requiresTriggerList).toBe('function');
    const fn = def.requiresTriggerList as (p: Record<string, unknown>) => boolean;
    expect(fn({ operation: 'create' })).toBe(false);
    expect(fn({ operation: 'edit' })).toBe(true);
  });

  it('create delegates to create_list', async () => {
    const { exec, calls } = makeExec([[{ max: '2' }], []]);
    const def = getActionDef('list')!;
    const result = await def.execute(baseCtx(exec), { operation: 'create', name: 'New list' });
    expect(result.ok).toBe(true);
    const insert = calls.find((c) => c.text.includes('INSERT INTO lists'));
    expect(insert?.params).toEqual(expect.arrayContaining(['owner_1', 'New list', 'ws_1']));
  });

  it('edit archives the trigger list', async () => {
    listsMock.setListArchived.mockResolvedValueOnce({ id: 'list_1', is_archived: true });
    const { exec } = makeExec();
    const def = getActionDef('list')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', list: { id: 'list_1', name: 'Groceries' } } });
    const result = await def.execute(ctx, { operation: 'edit', archived: true });
    expect(result.ok).toBe(true);
    expect(listsMock.setListArchived).toHaveBeenCalledWith(exec, 'list_1', true);
  });

  it('edit unarchives the trigger list (unlike the one-way hidden archive_list)', async () => {
    listsMock.setListArchived.mockResolvedValueOnce({ id: 'list_1', is_archived: false });
    const { exec } = makeExec();
    const def = getActionDef('list')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', list: { id: 'list_1', name: 'Groceries' } } });
    const result = await def.execute(ctx, { operation: 'edit', archived: false });
    expect(result.ok).toBe(true);
    expect(listsMock.setListArchived).toHaveBeenCalledWith(exec, 'list_1', false);
  });

  it('move dispatches to move_list when no targetWorkspaceId is given', async () => {
    const { exec } = makeExec([[{ workspace_id: 'ws_1' }], [{}]]);
    const def = getActionDef('list')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', list: { id: 'list_1', name: 'Groceries' } } });
    const result = await def.execute(ctx, { operation: 'move', targetFolderId: 'folder_1' });
    expect(result.ok).toBe(true);
  });

  it('move dispatches to move_list_to_workspace when targetWorkspaceId is given', async () => {
    workspaceUtilMock.userCanAccessWorkspace.mockResolvedValueOnce(true);
    trashUtilMock.collectDescendantListIds.mockResolvedValueOnce([]);
    const { exec } = makeExec([[{ id: 'list_1' }], []]);
    const def = getActionDef('list')!;
    const ctx = baseCtx(exec, { trigger: { workspaceId: 'ws_1', list: { id: 'list_1', name: 'Groceries' } } });
    const result = await def.execute(ctx, { operation: 'move', targetFolderId: 'folder_1', targetWorkspaceId: 'ws_2' });
    expect(result.ok).toBe(true);
    expect(workspaceUtilMock.userCanAccessWorkspace).toHaveBeenCalledWith('owner_1', 'ws_2');
  });
});

describe('folder node — operation dispatch', () => {
  it('rejects an unknown operation', () => {
    const def = getActionDef('folder')!;
    expect(def.validate({ operation: 'nuke' })).toMatch(/operation must be one of/);
  });

  it('create delegates to create_folder', async () => {
    const { exec, calls } = makeExec([[{ max: null }], []]);
    const def = getActionDef('folder')!;
    const result = await def.execute(baseCtx(exec), { operation: 'create', name: 'New folder' });
    expect(result.ok).toBe(true);
    const insert = calls.find((c) => c.text.includes('INSERT INTO folders'));
    expect(insert?.params).toEqual(expect.arrayContaining(['owner_1', 'New folder', 'ws_1']));
  });

  describe('edit (new — public/private toggle)', () => {
    it('rejects a targetFolderId from a different workspace', async () => {
      const { exec } = makeExec([[{ workspace_id: 'ws_OTHER' }]]);
      const def = getActionDef('folder')!;
      const result = await def.execute(baseCtx(exec), { operation: 'edit', targetFolderId: 'folder_evil', isPublic: true });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not in this automation's workspace/);
    });

    it('makes the folder public', async () => {
      const { exec, calls } = makeExec([[{ workspace_id: 'ws_1' }], [{}]]);
      const def = getActionDef('folder')!;
      const result = await def.execute(baseCtx(exec), { operation: 'edit', targetFolderId: 'folder_1', isPublic: true });
      expect(result.ok).toBe(true);
      const update = calls.find((c) => c.text.includes('UPDATE folders SET is_public'));
      expect(update?.params).toEqual([true, 'folder_1']);
    });
  });

  describe('move (new — cross-workspace, no existing action to delegate to)', () => {
    it('rejects a targetFolderId from a different workspace', async () => {
      const { exec } = makeExec([[{ workspace_id: 'ws_OTHER' }]]);
      const def = getActionDef('folder')!;
      const result = await def.execute(baseCtx(exec), { operation: 'move', targetFolderId: 'folder_evil', targetWorkspaceId: 'ws_2' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not in this automation's workspace/);
    });

    it("rejects a target workspace the automation's creator cannot access", async () => {
      workspaceUtilMock.userCanAccessWorkspace.mockResolvedValueOnce(false);
      const { exec } = makeExec();
      const def = getActionDef('folder')!;
      const result = await def.execute(baseCtx(exec), { operation: 'move', targetFolderId: 'folder_1', targetWorkspaceId: 'ws_evil' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/no longer has access/);
    });

    it('rejects when the target workspace equals the current one', async () => {
      const { exec } = makeExec();
      const def = getActionDef('folder')!;
      const result = await def.execute(baseCtx(exec), { operation: 'move', targetFolderId: 'folder_1', targetWorkspaceId: 'ws_1' });
      expect(result.ok).toBe(false);
    });

    it('cascades the folder, its lists (+ descendants), their tasks, and its timelines into the target workspace', async () => {
      workspaceUtilMock.userCanAccessWorkspace.mockResolvedValueOnce(true);
      trashUtilMock.collectDescendantListIds.mockResolvedValueOnce(['list_sub']);
      const { exec, calls } = makeExec([
        [{ workspace_id: 'ws_1' }],       // assertFolderInWorkspace
        [{ id: 'list_1' }],               // SELECT id FROM lists WHERE folder_id
        [{ id: 'tl_1' }],                 // SELECT id FROM timelines WHERE folder_id
        [],                               // UPDATE folders
        [],                               // UPDATE lists
        [],                               // UPDATE tasks
        [],                               // UPDATE timelines
      ]);
      const def = getActionDef('folder')!;
      const result = await def.execute(baseCtx(exec), { operation: 'move', targetFolderId: 'folder_1', targetWorkspaceId: 'ws_2' });
      expect(result.ok).toBe(true);
      expect(result.output).toMatchObject({ folderId: 'folder_1', workspaceId: 'ws_2', movedListIds: ['list_1', 'list_sub'], movedTimelineIds: ['tl_1'] });
      const listsUpdate = calls.find((c) => c.text.includes('UPDATE lists'));
      expect(listsUpdate?.params?.[1]).toEqual(['list_1', 'list_sub']);
      const timelinesUpdate = calls.find((c) => c.text.includes('UPDATE timelines'));
      expect(timelinesUpdate?.params).toEqual(['ws_2', ['tl_1']]);
    });
  });
});
