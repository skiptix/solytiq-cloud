import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../db', () => ({ query: (...args: unknown[]) => queryMock(...args) }));

const executeAiToolMock = vi.fn();
vi.mock('../aiTools', () => ({
  executeAiTool: (...args: unknown[]) => executeAiToolMock(...args),
  getOpenRouterToolDefs: () => [
    { type: 'function', function: { name: 'create_dashboard_task', description: '', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'update_task', description: '', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'delete_task', description: '', parameters: { type: 'object', properties: {} } } },
  ],
}));

const createNotificationMock = vi.fn();
const createNotificationsMock = vi.fn();
vi.mock('../notifications', () => ({
  createNotification: (...args: unknown[]) => createNotificationMock(...args),
  createNotifications: (...args: unknown[]) => createNotificationsMock(...args),
}));

import { startAgentRun } from '../agent/runtime';

function rows(r: unknown[]) {
  return { rows: r, rowCount: r.length, command: '', oid: 0, fields: [] };
}

function mockChatResponse(message: unknown, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message }], usage }),
  } as Response;
}

describe('startAgentRun', () => {
  beforeEach(() => {
    queryMock.mockReset();
    executeAiToolMock.mockReset();
    createNotificationMock.mockReset();
    createNotificationsMock.mockReset();
    process.env.OPENROUTER_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('throws when the workspace is not found', async () => {
    queryMock.mockResolvedValueOnce(rows([])); // workspace lookup
    await expect(startAgentRun({ workspaceId: 'ws_x', userId: 'user-1', goal: 'do stuff', triggerType: 'manual' }))
      .rejects.toThrow('Workspace not found');
  });

  it('throws when the workspace agent is off', async () => {
    queryMock.mockResolvedValueOnce(rows([{ agent_mode: 'off', agent_policy: {} }]));
    await expect(startAgentRun({ workspaceId: 'ws_1', userId: 'user-1', goal: 'do stuff', triggerType: 'manual' }))
      .rejects.toThrow('turned off');
  });

  it('inserts a running agent_runs row and returns its id immediately, without waiting for the loop to finish', async () => {
    queryMock.mockResolvedValueOnce(rows([{ agent_mode: 'autonomous', agent_policy: {} }])); // workspace lookup
    queryMock.mockResolvedValueOnce(rows([])); // INSERT agent_runs
    // The background loop's own queries will keep resolving with empty rows from here on —
    // it runs detached (void ...catch()), so we don't need to await or assert on it for this test.
    queryMock.mockResolvedValue(rows([]));
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockChatResponse({ role: 'assistant', content: 'ok' }));

    const { runId, mode } = await startAgentRun({ workspaceId: 'ws_1', userId: 'user-1', goal: 'do stuff', triggerType: 'manual' });
    expect(runId).toMatch(/^agrun_/);
    expect(mode).toBe('autonomous');
    // The INSERT (2nd call) is guaranteed to have happened before startAgentRun resolves;
    // the background loop's own queries may or may not have started yet depending on
    // microtask interleaving — that race is intentional (fire-and-forget), not asserted here.
    const insertCall = queryMock.mock.calls[1];
    expect(insertCall[0]).toContain('INSERT INTO agent_runs');
    expect(insertCall[1]).toEqual(expect.arrayContaining([runId, 'ws_1', 'user-1', 'manual']));
  });

  it('a model reply with no tool_calls finishes the run as success on the very first turn', async () => {
    queryMock.mockResolvedValueOnce(rows([{ agent_mode: 'autonomous', agent_policy: {} }]));
    queryMock.mockResolvedValueOnce(rows([])); // INSERT agent_runs
    queryMock.mockResolvedValueOnce(rows([{ value: 'openai/gpt-4o-mini' }])); // ai_model setting
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockChatResponse({ role: 'assistant', content: 'All done, nothing to do.' }));

    await startAgentRun({ workspaceId: 'ws_1', userId: 'user-1', goal: 'do stuff', triggerType: 'manual' });
    // Let the detached background loop's microtasks flush.
    await new Promise((r) => setTimeout(r, 20));

    const updateCall = queryMock.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('UPDATE agent_runs SET status'));
    expect(updateCall).toBeTruthy();
    expect(updateCall![1]).toEqual(expect.arrayContaining(['success']));
    expect(createNotificationMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_run_complete' }));
  });

  it('a denied tool (not on the allow-list) is recorded as denied and never reaches executeAiTool', async () => {
    queryMock.mockResolvedValueOnce(rows([{ agent_mode: 'autonomous', agent_policy: { allowedTools: ['create_dashboard_task'] } }]));
    queryMock.mockResolvedValueOnce(rows([])); // INSERT
    queryMock.mockResolvedValueOnce(rows([])); // ai_model setting (none set)
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockChatResponse({
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'delete_task', arguments: '{"task_id":1}' } }],
      }))
      .mockResolvedValueOnce(mockChatResponse({ role: 'assistant', content: 'Could not delete — not permitted.' }));

    await startAgentRun({ workspaceId: 'ws_1', userId: 'user-1', goal: 'delete task 1', triggerType: 'manual' });
    await new Promise((r) => setTimeout(r, 20));

    expect(executeAiToolMock).not.toHaveBeenCalled();
    const updateCall = queryMock.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('UPDATE agent_runs SET status'));
    const steps = JSON.parse(updateCall![1][1]);
    expect(steps.some((s: { status: string }) => s.status === 'denied')).toBe(true);
  });

  it('a successful update_task mutation notifies the task owner and anyone tagged on it, not just whoever started the run', async () => {
    queryMock.mockResolvedValueOnce(rows([{ agent_mode: 'autonomous', agent_policy: {} }])); // workspace lookup
    queryMock.mockResolvedValueOnce(rows([])); // INSERT agent_runs
    queryMock.mockResolvedValueOnce(rows([{ value: 'openai/gpt-4o-mini' }])); // ai_model setting
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockChatResponse({
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'update_task', arguments: '{"task_id":1,"checked":true}' } }],
      }))
      .mockResolvedValueOnce(mockChatResponse({ role: 'assistant', content: 'Done.' }));

    queryMock.mockResolvedValueOnce(rows([{ id: '1', user_id: 'owner-1', title: 'Buy milk' }])); // snapshotBeforeToolCall
    queryMock.mockResolvedValueOnce(rows([{ user_id: 'tagged-1' }])); // task_tags captured before the mutation
    executeAiToolMock.mockResolvedValueOnce({ ok: true, result: 'Updated task "Buy milk"' });
    queryMock.mockResolvedValue(rows([])); // INSERT agent_mutations, final UPDATE agent_runs, everything after

    await startAgentRun({ workspaceId: 'ws_1', userId: 'user-1', goal: 'mark it done', triggerType: 'manual' });
    await new Promise((r) => setTimeout(r, 20));

    const changeCall = createNotificationsMock.mock.calls.find(
      (c: unknown[]) => (c[1] as { type: string }).type === 'agent_change'
    );
    expect(changeCall).toBeTruthy();
    const [recipients, input] = changeCall as [Set<string>, Record<string, unknown>];
    expect([...recipients].sort()).toEqual(['owner-1', 'tagged-1']);
    expect(input).toEqual(expect.objectContaining({
      type: 'agent_change', actorId: 'user-1', entityType: 'task', entityId: '1',
      title: expect.stringContaining('Buy milk'),
    }));
  });

  it('a successful delete_task mutation still notifies the (now-gone) task\'s owner and tagged users from the pre-captured state', async () => {
    // deleteAny defaults to requiring approval — relax it so the delete executes
    // directly and we can observe the post-mutation notification, not the proposal one.
    queryMock.mockResolvedValueOnce(rows([{ agent_mode: 'autonomous', agent_policy: { requireApprovalOver: { deleteAny: false } } }]));
    queryMock.mockResolvedValueOnce(rows([]));
    queryMock.mockResolvedValueOnce(rows([{ value: 'openai/gpt-4o-mini' }]));
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockChatResponse({
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'delete_task', arguments: '{"task_id":1}' } }],
      }))
      .mockResolvedValueOnce(mockChatResponse({ role: 'assistant', content: 'Done.' }));

    queryMock.mockResolvedValueOnce(rows([{ id: '1', user_id: 'owner-2', title: 'Stale task' }])); // snapshotBeforeToolCall
    queryMock.mockResolvedValueOnce(rows([{ user_id: 'tagged-2' }])); // task_tags captured before the delete cascades them away
    executeAiToolMock.mockResolvedValueOnce({ ok: true, result: 'Deleted task "Stale task"' });
    queryMock.mockResolvedValue(rows([]));

    await startAgentRun({ workspaceId: 'ws_1', userId: 'user-1', goal: 'clean up', triggerType: 'manual' });
    await new Promise((r) => setTimeout(r, 20));

    const changeCall = createNotificationsMock.mock.calls.find(
      (c: unknown[]) => (c[1] as { type: string }).type === 'agent_change'
    );
    expect(changeCall).toBeTruthy();
    const [recipients, input] = changeCall as [Set<string>, Record<string, unknown>];
    expect([...recipients].sort()).toEqual(['owner-2', 'tagged-2']);
    expect(input.title).toContain('Stale task');
  });
});
