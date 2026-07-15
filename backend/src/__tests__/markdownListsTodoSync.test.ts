import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { QueryExec } from '../workspaceUtil';

// createListTask/updateListTaskFields (used internally by reconcileTodoBlocks)
// dynamically `import('../automationEngine')` to fire triggers — mock it the
// same way listsTaskMutations.test.ts does so no real DB/engine work happens.
const fireTriggerMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../automationEngine', () => ({ fireTrigger: fireTriggerMock }));

import { reconcileTodoBlocks, type MarkdownBlockLike } from '../routes/markdownLists';

function makeExec(rowsByCall: unknown[][]) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const exec = vi.fn(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    const rows = rowsByCall.shift() ?? [];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }) as unknown as QueryExec;
  return { exec, calls };
}

beforeEach(() => {
  fireTriggerMock.mockClear();
});

describe('reconcileTodoBlocks', () => {
  it('lazily creates a Todo list on the first /todo block and stamps the new task id back onto the block', async () => {
    const { exec, calls } = makeExec([
      [{ max: null }],                                    // MAX(position) FROM lists
      [],                                                  // INSERT INTO lists
      [],                                                  // INSERT INTO sections
      [{ id: 'section_todos' }],                           // SELECT default section
      [],                                                  // existing tasks in todo list (none yet)
      [{ workspace_id: 'ws_1', name: 'My Notes — Todos' }], // createListTask: section+list lookup
      [{ max: null }],                                     // createListTask: position lookup
      [{
        id: 999, title: 'Buy milk', note: null, note_markdown: false, checked: false,
        deadline: null, time_val: null, priority: null, badge: null, source: 'list',
        list_id: 'list_generated', section_id: 'section_todos', position: 0,
        created_at: 'x', updated_at: 'y', linked_list_id: null, linked_list_type: null,
      }], // createListTask: INSERT ... RETURNING *
    ]);

    const blocks: MarkdownBlockLike[] = [
      { id: 'blk_1', type: 'todo', text: 'Buy milk', checked: false, taskId: null },
    ];

    const result = await reconcileTodoBlocks(
      exec, 'user_1',
      { id: 'mdlist_1', name: 'My Notes', workspaceId: 'ws_1', todoListId: null },
      blocks,
    );

    expect(result.todoListId).not.toBeNull();
    expect(result.blocks).toEqual([{ id: 'blk_1', type: 'todo', text: 'Buy milk', checked: false, taskId: '999' }]);

    // A brand-new Todo list is created (not reused from thin air).
    expect(calls.some(c => c.text.includes('INSERT INTO lists'))).toBe(true);
    expect(calls.some(c => c.text.includes('INSERT INTO sections'))).toBe(true);
  });

  it('reuses an existing Todo list, updates a kept block, creates a new one, and deletes the task for a removed block', async () => {
    const { exec, calls } = makeExec([
      [{ id: 'section_todos' }],                                        // default section lookup
      [{ id: '1' }, { id: '2' }],                                       // existing tasks in todo list (1=kept, 2=to be removed)
      // block 1 (kept, taskId '1') -> updateListTaskFields
      [{ id: 1, title: 'Buy milk', checked: false }],                   // updateListTaskFields: before-state (checked read)
      [{
        id: 1, title: 'Buy milk (2%)', note: null, note_markdown: false, checked: true,
        deadline: null, time_val: null, priority: null, badge: null, source: 'list',
        list_id: 'list_existing', section_id: 'section_todos', position: 0,
        created_at: 'x', updated_at: 'y', linked_list_id: null, linked_list_type: null,
      }], // updateListTaskFields: UPDATE ... RETURNING *
      // list_all_completed check path is only entered on a false->true transition;
      // updateListTaskFields queries the list + remaining-unchecked count.
      [{ workspace_id: 'ws_1', name: 'My Notes — Todos' }],
      [{ n: 1 }],
      // new block (no taskId) -> createListTask
      [{ workspace_id: 'ws_1', name: 'My Notes — Todos' }],
      [{ max: '0' }],
      [{
        id: 3, title: 'Book flights', note: null, note_markdown: false, checked: false,
        deadline: null, time_val: null, priority: null, badge: null, source: 'list',
        list_id: 'list_existing', section_id: 'section_todos', position: 1,
        created_at: 'x', updated_at: 'y', linked_list_id: null, linked_list_type: null,
      }],
      // task '2' (no longer present as a block) -> deleteTaskRow
      [],
    ]);

    const blocks: MarkdownBlockLike[] = [
      { id: 'blk_1', type: 'todo', text: 'Buy milk (2%)', checked: true, taskId: '1' },
      { id: 'blk_3', type: 'todo', text: 'Book flights', checked: false, taskId: null },
    ];

    const result = await reconcileTodoBlocks(
      exec, 'user_1',
      { id: 'mdlist_1', name: 'My Notes', workspaceId: 'ws_1', todoListId: 'list_existing' },
      blocks,
    );

    expect(result.todoListId).toBe('list_existing');
    expect(result.blocks).toEqual([
      { id: 'blk_1', type: 'todo', text: 'Buy milk (2%)', checked: true, taskId: '1' },
      { id: 'blk_3', type: 'todo', text: 'Book flights', checked: false, taskId: '3' },
    ]);
    // No new Todo list is created when one already exists.
    expect(calls.some(c => c.text.includes('INSERT INTO lists'))).toBe(false);
    // The orphaned task (id 2) is deleted.
    expect(calls.some(c => c.text.includes('DELETE FROM tasks') && c.params?.includes('2'))).toBe(true);
  });

  it('clears every task from the Todo list once no /todo blocks remain, but keeps the list itself', async () => {
    const { exec, calls } = makeExec([
      [{ id: '1' }, { id: '2' }], // existing tasks in the todo list
      [], // DELETE task 1
      [], // DELETE task 2
    ]);

    const blocks: MarkdownBlockLike[] = [
      { id: 'blk_h', type: 'heading', level: 1, text: 'Just a heading now' },
    ];

    const result = await reconcileTodoBlocks(
      exec, 'user_1',
      { id: 'mdlist_1', name: 'My Notes', workspaceId: 'ws_1', todoListId: 'list_existing' },
      blocks,
    );

    expect(result.todoListId).toBe('list_existing'); // list reference is preserved, not nulled out
    expect(result.blocks).toEqual(blocks);
    const deletes = calls.filter(c => c.text.includes('DELETE FROM tasks'));
    expect(deletes).toHaveLength(2);
  });
});
