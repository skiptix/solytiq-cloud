import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { QueryExec } from '../workspaceUtil';
import type { MutationActor } from '../automationEngine';

const fireTriggerMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../automationEngine', () => ({ fireTrigger: fireTriggerMock }));

// vi.mock is hoisted above imports, so this sees the mocked ../automationEngine
// (createListTask/updateListTaskFields dynamically `import('../automationEngine')`
// at call time — Vitest's mock interception applies regardless of static vs
// dynamic import syntax).
import { createListTask, updateListTaskFields } from '../routes/lists';

function makeExec(rowsByCall: unknown[][]) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const exec = vi.fn(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    const rows = rowsByCall.shift() ?? [];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }) as unknown as QueryExec;
  return { exec, calls };
}

const userActor: MutationActor = { type: 'user', userId: 'user_1' };

beforeEach(() => {
  fireTriggerMock.mockClear();
});

describe('createListTask — task_created trigger payload', () => {
  it('fires task_created with the full task record (id/title/note/deadline/priority/badge/... not just a sparse stand-in)', async () => {
    const { exec } = makeExec([
      [{ workspace_id: 'ws_1', name: 'Groceries' }], // section+list lookup
      [{ max: '2' }],                                 // position lookup
      [{
        id: 123456789, title: 'Buy milk', note: 'from the corner store', note_markdown: false, checked: false,
        deadline: '2026-08-01', time_val: null, priority: 'high', badge: 'urgent', source: 'list',
        list_id: 'list_1', section_id: 'sec_1', position: 3, created_at: '2026-07-14T00:00:00Z', updated_at: '2026-07-14T00:00:00Z',
        linked_list_id: null, linked_list_type: null,
      }], // INSERT ... RETURNING *
    ]);

    await createListTask(exec, 'list_1', 'sec_1', 'user_1', { title: 'Buy milk' }, userActor);

    expect(fireTriggerMock).toHaveBeenCalledTimes(1);
    const [type, ctx] = fireTriggerMock.mock.calls[0];
    expect(type).toBe('task_created');
    expect(ctx.task).toEqual({
      id: '123456789',
      title: 'Buy milk',
      listId: 'list_1',
      checked: false,
      note: 'from the corner store',
      noteMarkdown: false,
      deadline: '2026-08-01',
      time: null,
      priority: 'high',
      badge: 'urgent',
      sectionId: 'sec_1',
      position: 3,
      createdAt: '2026-07-14T00:00:00Z',
      updatedAt: '2026-07-14T00:00:00Z',
    });
  });
});

describe('updateListTaskFields — task_completed trigger payload', () => {
  it('fires task_completed with the full task record on a false -> true checked transition', async () => {
    const { exec } = makeExec([
      [{ checked: false }], // before-state
      [{
        id: 42, title: 'Buy milk', note: 'from the corner store', note_markdown: true, checked: true,
        deadline: '2026-08-01', time_val: '14:00', priority: 'low', badge: null, source: 'list',
        list_id: 'list_1', section_id: 'sec_1', position: 3, created_at: '2026-07-14T00:00:00Z', updated_at: '2026-07-14T01:00:00Z',
        linked_list_id: null, linked_list_type: null,
      }], // UPDATE ... RETURNING *
      [{ workspace_id: 'ws_1', name: 'Groceries' }], // list lookup for the trigger's workspace/name
      [{ n: 2 }], // remaining unchecked tasks (nonzero -> list_all_completed does NOT fire)
    ]);

    await updateListTaskFields(exec, 'list_1', '42', { checked: true, updateLinkedList: false }, userActor);

    expect(fireTriggerMock).toHaveBeenCalledTimes(1); // only task_completed, not list_all_completed
    const [type, ctx] = fireTriggerMock.mock.calls[0];
    expect(type).toBe('task_completed');
    expect(ctx.task).toEqual({
      id: '42',
      title: 'Buy milk',
      listId: 'list_1',
      checked: true,
      note: 'from the corner store',
      noteMarkdown: true,
      deadline: '2026-08-01',
      time: '14:00',
      priority: 'low',
      badge: null,
      sectionId: 'sec_1',
      position: 3,
      createdAt: '2026-07-14T00:00:00Z',
      updatedAt: '2026-07-14T01:00:00Z',
    });
  });

  it('does not fire any trigger when checked stays false', async () => {
    const { exec } = makeExec([
      [{ checked: false }],
      [{ id: 42, title: 'Buy milk', note: null, note_markdown: false, checked: false, deadline: null, time_val: null, priority: null, badge: null, source: 'list', list_id: 'list_1', section_id: 'sec_1', position: 3, created_at: 'x', updated_at: 'y', linked_list_id: null, linked_list_type: null }],
    ]);
    await updateListTaskFields(exec, 'list_1', '42', { title: 'Renamed', updateLinkedList: false }, userActor);
    expect(fireTriggerMock).not.toHaveBeenCalled();
  });
});
