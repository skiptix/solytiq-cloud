import { describe, expect, it, vi } from 'vitest';
import { rehomeUserContentToPersonal, type QueryExec } from '../workspaceUtil';
import { snapshotListToTrash, snapshotTimelineToTrash, snapshotFolderToTrash, collectDescendantListIds } from '../trashUtil';

function makeExec(rowsByCall: unknown[][] = []) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const exec = vi.fn(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    const rows = rowsByCall.shift() ?? [];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }) as unknown as QueryExec;
  return { exec, calls };
}

describe('rehomeUserContentToPersonal', () => {
  it('moves the user\'s own content out of a lost workspace, doubly scoped by workspace AND owner', async () => {
    const { exec, calls } = makeExec([
      [{ id: 'ws_personal' }], // ensurePersonalWorkspace: existing personal ws
      [],                      // ensureOwnedWorkspaceMemberships heal
      [{}, {}],                // UPDATE folders   → 2 rows
      [{}],                    // UPDATE lists     → 1 row
      [],                      // UPDATE timelines → 0 rows
      [],                      // detach cross-workspace folder refs (lists)
      [],                      // detach cross-workspace folder refs (timelines)
      [{}],                    // UPDATE dash tasks → 1 row
      [{}, {}, {}],            // re-sync list items → 3 rows
    ]);

    const counts = await rehomeUserContentToPersonal(exec, 'user-1', 'ws_lost');

    expect(counts).toEqual({ lists: 1, timelines: 0, folders: 2, tasks: 4 });

    // Every content move must be scoped by BOTH the source workspace and the
    // owning user — moving another user's rows would be an IDOR regression.
    const moves = calls.filter(c =>
      c.text.includes('SET workspace_id = $1') && c.text.includes('WHERE workspace_id = $2')
    );
    expect(moves.length).toBeGreaterThanOrEqual(3); // folders, lists, timelines (+ dash tasks)
    for (const call of moves) {
      expect(call.text).toContain('user_id = $3');
      expect(call.params).toContain('user-1');
      expect(call.params).toContain('ws_lost');
      expect(call.params).toContain('ws_personal');
    }

    // Cross-workspace folder references are detached so nothing dangles into
    // the sidebar's invisible zone.
    const detaches = calls.filter(c => c.text.includes('SET folder_id = NULL'));
    expect(detaches).toHaveLength(2);
    for (const call of detaches) {
      expect(call.text).toContain('IS DISTINCT FROM');
      expect(call.params).toEqual(['user-1']);
    }
  });

  it('is a no-op when the lost workspace IS the personal workspace', async () => {
    const { exec, calls } = makeExec([
      [{ id: 'ws_personal' }], // ensurePersonalWorkspace
      [],                      // membership heal
    ]);

    const counts = await rehomeUserContentToPersonal(exec, 'user-1', 'ws_personal');

    expect(counts).toEqual({ lists: 0, timelines: 0, folders: 0, tasks: 0 });
    expect(calls).toHaveLength(2); // no content UPDATEs issued
  });
});

describe('snapshotListToTrash', () => {
  it('writes a restorable snapshot that preserves workspace, folder, and sublist linkage', async () => {
    const listRow = {
      id: 'list_1', user_id: 'owner-9', name: 'Groceries', emoji: '🛒', color: '#5e4dbb',
      color_bg: '#f0edff', subtitle: null, is_public: false, folder_id: 'folder_7',
      position: 3, created_at: '2026-01-01', parent_task_id: '1234', depth: 1,
      workspace_id: 'ws_team',
    };
    const sectionRow = { id: 'sec_1', list_id: 'list_1', label: 'Tasks', emoji: null, position: 0 };
    const taskRow = {
      id: '999', user_id: 'owner-9', title: 'Milk', note: null, checked: false,
      deadline: '2026-07-04', time_val: '09:00', priority: 'High', badge: null,
      source: 'list', list_id: 'list_1', section_id: 'sec_1', position: 0,
      created_at: '2026-01-02', linked_list_id: 'list_sub', linked_list_type: 'sublist',
    };
    const { exec, calls } = makeExec([
      [listRow],     // SELECT list
      [sectionRow],  // SELECT sections
      [taskRow],     // SELECT tasks
      [],            // INSERT trash_lists
    ]);

    const okResult = await snapshotListToTrash(exec, 'list_1');

    expect(okResult).toBe(true);
    const insert = calls[calls.length - 1];
    expect(insert.text).toContain('INSERT INTO trash_lists');
    // Attributed to the list's OWNER, not whoever triggered the cascade.
    expect(insert.params?.[0]).toBe('list_1');
    expect(insert.params?.[1]).toBe('owner-9');

    const data = JSON.parse(insert.params?.[2] as string);
    // These fields are exactly what the restore endpoint reads — dropping any
    // of them recreates the "restored list vanishes into NULL workspace" bug.
    expect(data.workspaceId).toBe('ws_team');
    expect(data.folderId).toBe('folder_7');
    expect(data.parentTaskId).toBe('1234');
    expect(data.depth).toBe(1);
    expect(data.sections).toHaveLength(1);
    const task = data.sections[0].tasks[0];
    expect(task.time).toBe('09:00');
    expect(task.linkedListId).toBe('list_sub');
    expect(task.linkedListType).toBe('sublist');
  });

  it('returns false when the list no longer exists', async () => {
    const { exec, calls } = makeExec([[]]);
    expect(await snapshotListToTrash(exec, 'list_gone')).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe('snapshotTimelineToTrash', () => {
  it('preserves workspace linkage and the milestone field names the restore reads', async () => {
    const tlRow = {
      id: 'timeline_1', user_id: 'owner-2', name: 'Launch', emoji: '🚀', color: null,
      color_bg: null, subtitle: null, layout: 'vertical', is_public: true,
      folder_id: null, workspace_id: 'ws_x', position: 0, created_at: '2026-02-01',
    };
    const msRow = {
      id: 'milestone_1', timeline_id: 'timeline_1', title: 'Beta', description: null,
      milestone_date: '2026-08-01', time_val: '10:00', status: 'upcoming',
      emoji: null, color: null, position: 0, created_at: '2026-02-02',
    };
    const { exec, calls } = makeExec([[tlRow], [msRow], []]);

    expect(await snapshotTimelineToTrash(exec, 'timeline_1')).toBe(true);

    const insert = calls[calls.length - 1];
    expect(insert.text).toContain('INSERT INTO trash_timelines');
    expect(insert.params?.[1]).toBe('owner-2');
    const data = JSON.parse(insert.params?.[2] as string);
    expect(data.workspaceId).toBe('ws_x');
    expect(data.milestones[0].date).toBe('2026-08-01');
    expect(data.milestones[0].time).toBe('10:00');
  });
});

describe('snapshotFolderToTrash', () => {
  it('records the contained list ids and the folder\'s workspace', async () => {
    const folderRow = {
      id: 'folder_1', user_id: 'owner-3', name: 'Work', emoji: null, color: null,
      position: 0, is_public: true, collapsed: false, workspace_id: 'ws_y',
    };
    const { exec, calls } = makeExec([[folderRow], [{ id: 'list_a' }, { id: 'list_b' }], []]);

    expect(await snapshotFolderToTrash(exec, 'folder_1')).toBe(true);

    const insert = calls[calls.length - 1];
    expect(insert.text).toContain('INSERT INTO trash_folders');
    const data = JSON.parse(insert.params?.[2] as string);
    expect(data.workspaceId).toBe('ws_y');
    expect(data.listIds).toEqual(['list_a', 'list_b']);
  });
});

describe('collectDescendantListIds', () => {
  it('walks nested sublists recursively and de-duplicates', async () => {
    const { exec } = makeExec([
      [{ id: 'sub_1' }], // children of root
      [{ id: 'sub_2' }], // children of sub_1
      [],                // children of sub_2
    ]);

    const ids = await collectDescendantListIds(exec, 'root');
    expect(ids).toEqual(['sub_1', 'sub_2']);
  });
});
