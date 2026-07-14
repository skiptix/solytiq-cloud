import { describe, expect, it, vi } from 'vitest';
import { normalizeAutomationGraph, assertGraphRefsInWorkspace, assertGraphWorkspaceRefsAccessible, type AutomationGraph, type AutomationNode } from '../automationGraph';
import type { QueryExec } from '../workspaceUtil';

function trigger(type: string, params: Record<string, unknown> = {}): AutomationNode {
  return { id: 't1', kind: 'trigger', type, position: { x: 0, y: 0 }, params };
}
function action(id: string, type: string, params: Record<string, unknown> = {}): AutomationNode {
  return { id, kind: 'action', type, position: { x: 0, y: 0 }, params };
}
function edge(id: string, source: string, target: string) {
  return { id, source, target };
}

function makeExec(rowsByCall: unknown[][] = []) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const exec = vi.fn(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    const rows = rowsByCall.shift() ?? [];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }) as unknown as QueryExec;
  return { exec, calls };
}

describe('normalizeAutomationGraph', () => {
  it('accepts a valid linear chain: trigger -> action -> action', () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [
        trigger('task_completed', { listId: 'list_1' }),
        action('a1', 'rename_list', { newName: 'x' }),
        action('a2', 'delete_task'),
      ],
      edges: [edge('e1', 't1', 'a1'), edge('e2', 'a1', 'a2')],
    };
    const result = normalizeAutomationGraph(graph);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.triggerType).toBe('task_completed');
      expect(result.value.orderedActionIds).toEqual(['a1', 'a2']);
    }
  });

  it('rejects a graph with zero trigger nodes', () => {
    const graph: AutomationGraph = { version: 1, nodes: [action('a1', 'rename_list', { newName: 'x' })], edges: [] };
    const result = normalizeAutomationGraph(graph);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/exactly one trigger/);
  });

  it('rejects a graph with two trigger nodes', () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [trigger('task_completed'), { ...trigger('task_created'), id: 't2' }, action('a1', 'rename_list', { newName: 'x' })],
      edges: [edge('e1', 't1', 'a1'), edge('e2', 't2', 'a1')],
    };
    const result = normalizeAutomationGraph(graph);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/exactly one trigger/);
  });

  it('rejects branching (an action feeding two downstream actions)', () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [
        trigger('task_completed', { listId: 'list_1' }),
        action('a1', 'rename_list', { newName: 'x' }),
        action('a2', 'delete_task'),
        action('a3', 'delete_task'),
      ],
      // a1 has two outgoing edges — a branch, not a chain
      edges: [edge('e1', 't1', 'a1'), edge('e2', 'a1', 'a2'), edge('e3', 'a1', 'a3')],
    };
    const result = normalizeAutomationGraph(graph);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/chain|outgoing/);
  });

  it('rejects a cycle', () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [trigger('task_completed', { listId: 'list_1' }), action('a1', 'rename_list', { newName: 'x' }), action('a2', 'delete_task')],
      // a1 -> a2 -> a1 forms a cycle; still nodes.length - 1 = 2 edges, so it
      // passes the edge-count check and must be caught by the chain walk.
      edges: [edge('e1', 't1', 'a1'), edge('e2', 'a2', 'a1')],
    };
    const result = normalizeAutomationGraph(graph);
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown trigger type', () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [trigger('not_a_real_trigger'), action('a1', 'rename_list', { newName: 'x' })],
      edges: [edge('e1', 't1', 'a1')],
    };
    const result = normalizeAutomationGraph(graph);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown trigger/);
  });

  it('rejects an unknown action type', () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [trigger('task_completed', { listId: 'list_1' }), action('a1', 'not_a_real_action')],
      edges: [edge('e1', 't1', 'a1')],
    };
    const result = normalizeAutomationGraph(graph);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown action/);
  });

  it('rejects an action that requires a task under a trigger that provides none (schedule -> delete_task)', () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [trigger('schedule', { freq: 'daily', time: '09:00' }), action('a1', 'delete_task')],
      edges: [edge('e1', 't1', 'a1')],
    };
    const result = normalizeAutomationGraph(graph);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/needs a task/);
  });

  it('rejects list_all_completed with no listId', () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [trigger('list_all_completed', {}), action('a1', 'archive_list')],
      edges: [edge('e1', 't1', 'a1')],
    };
    const result = normalizeAutomationGraph(graph);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/listId is required/);
  });

  it('rejects a malformed schedule trigger (bad time format)', () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [trigger('schedule', { freq: 'daily', time: '9am' }), action('a1', 'rename_list', { newName: 'x' })],
      edges: [edge('e1', 't1', 'a1')],
    };
    const result = normalizeAutomationGraph(graph);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/HH:MM/);
  });
});

describe('assertGraphRefsInWorkspace', () => {
  it('passes when every referenced list belongs to the automation\'s workspace', async () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [trigger('task_completed', { listId: 'list_1' }), action('a1', 'move_task', { targetListId: 'list_2' })],
      edges: [edge('e1', 't1', 'a1')],
    };
    const { exec } = makeExec([[{ workspace_id: 'ws_1' }], [{ workspace_id: 'ws_1' }]]);
    const error = await assertGraphRefsInWorkspace(exec, graph, 'ws_1');
    expect(error).toBeNull();
  });

  it('rejects a list that belongs to a different workspace (IDOR guard)', async () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [trigger('task_completed', { listId: 'list_1' }), action('a1', 'move_task', { targetListId: 'list_evil' })],
      edges: [edge('e1', 't1', 'a1')],
    };
    const { exec } = makeExec([[{ workspace_id: 'ws_1' }], [{ workspace_id: 'ws_OTHER' }]]);
    const error = await assertGraphRefsInWorkspace(exec, graph, 'ws_1');
    expect(error).toMatch(/not in this automation's workspace/);
  });

  it('rejects a list that no longer exists', async () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [trigger('list_all_completed', { listId: 'list_gone' }), action('a1', 'archive_list')],
      edges: [edge('e1', 't1', 'a1')],
    };
    const { exec } = makeExec([[]]);
    const error = await assertGraphRefsInWorkspace(exec, graph, 'ws_1');
    expect(error).toMatch(/does not exist/);
  });

  it('rejects a targetFolderId belonging to a different workspace (IDOR guard)', async () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [trigger('task_completed', { listId: 'list_1' }), action('a1', 'move_list', { targetFolderId: 'folder_evil' })],
      edges: [edge('e1', 't1', 'a1')],
    };
    const { exec } = makeExec([[{ workspace_id: 'ws_1' }], [{ workspace_id: 'ws_OTHER' }]]);
    const error = await assertGraphRefsInWorkspace(exec, graph, 'ws_1');
    expect(error).toMatch(/Folder folder_evil is not in this automation's workspace/);
  });

  it('passes a valid targetFolderId in the same workspace', async () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [trigger('task_completed', { listId: 'list_1' }), action('a1', 'move_list', { targetFolderId: 'folder_1' })],
      edges: [edge('e1', 't1', 'a1')],
    };
    const { exec } = makeExec([[{ workspace_id: 'ws_1' }], [{ workspace_id: 'ws_1' }]]);
    const error = await assertGraphRefsInWorkspace(exec, graph, 'ws_1');
    expect(error).toBeNull();
  });
});

describe('assertGraphWorkspaceRefsAccessible', () => {
  it('passes when the creator can access the target workspace', async () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [trigger('task_completed', { listId: 'list_1' }), action('a1', 'move_list_to_workspace', { targetWorkspaceId: 'ws_2' })],
      edges: [edge('e1', 't1', 'a1')],
    };
    const canAccess = vi.fn().mockResolvedValue(true);
    const error = await assertGraphWorkspaceRefsAccessible(graph, 'user_1', canAccess);
    expect(error).toBeNull();
    expect(canAccess).toHaveBeenCalledWith('user_1', 'ws_2');
  });

  it('rejects a targetWorkspaceId the creator cannot access', async () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [trigger('task_completed', { listId: 'list_1' }), action('a1', 'move_list_to_workspace', { targetWorkspaceId: 'ws_evil' })],
      edges: [edge('e1', 't1', 'a1')],
    };
    const canAccess = vi.fn().mockResolvedValue(false);
    const error = await assertGraphWorkspaceRefsAccessible(graph, 'user_1', canAccess);
    expect(error).toMatch(/do not have access/);
  });
});
