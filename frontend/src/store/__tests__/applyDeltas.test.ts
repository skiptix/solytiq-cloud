import { beforeEach, describe, expect, it, vi } from 'vitest';

// The app store uses zustand `persist`, which touches localStorage at import
// time. Provide a minimal in-memory polyfill so the store can load under the
// node test environment.
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

// Import AFTER the polyfill is in place.
const { default: useAppStore } = await import('../useAppStore');

type AnyTask = { id: number; title: string; _source?: string; _listId?: string | null };

function seedList(id: string, tasks: Array<{ id: number; title: string; checked?: boolean }>) {
  return {
    id,
    name: `List ${id}`,
    workspaceId: 'ws1',
    sections: [
      { id: `${id}-s1`, listId: id, label: 'Main', emoji: null, position: 0, tasks: tasks.map((t) => ({
        id: t.id, title: t.title, checked: !!t.checked, source: 'list', _source: 'list', _listId: id, listId: id,
      })) },
    ],
  };
}

describe('useAppStore delta reducers', () => {
  beforeEach(() => {
    useAppStore.setState({ dashTasks: [], lists: [], folders: [], timelines: [] });
  });

  it('hydrateFromSnapshot replaces slices and coerces task ids to numbers', () => {
    useAppStore.getState().hydrateFromSnapshot({
      tasks: [{ id: '1001' as unknown as number, title: 'A', _source: 'dash' } as AnyTask as never],
      lists: [seedList('l1', [{ id: 2002, title: 'nested' }]) as never],
      folders: [],
      timelines: [],
    });
    const s = useAppStore.getState();
    expect(s.dashTasks[0].id).toBe(1001);
    expect(typeof s.dashTasks[0].id).toBe('number');
    expect(s.lists[0].sections[0].tasks[0].id).toBe(2002);
  });

  it('applyDeltas upserts a dash task without touching siblings', () => {
    useAppStore.setState({ dashTasks: [{ id: 1, title: 'keep', _source: 'dash' } as never] });
    useAppStore.getState().applyDeltas([
      { entity: 'task', entityId: '2', op: 'upsert', payload: { id: 2, title: 'new', _source: 'dash' } },
    ]);
    const ids = useAppStore.getState().dashTasks.map((t) => t.id).sort();
    expect(ids).toEqual([1, 2]);
  });

  it('applyDeltas removes a dash task on delete', () => {
    useAppStore.setState({ dashTasks: [{ id: 1, title: 'a', _source: 'dash' } as never, { id: 2, title: 'b', _source: 'dash' } as never] });
    useAppStore.getState().applyDeltas([{ entity: 'task', entityId: '1', op: 'delete' }]);
    expect(useAppStore.getState().dashTasks.map((t) => t.id)).toEqual([2]);
  });

  it('applyDeltas upsert list reconciles its tasks into the flat dashTasks slice', () => {
    // A pre-existing dash task and a stale copy of the list's task.
    useAppStore.setState({
      dashTasks: [{ id: 9, title: 'dash', _source: 'dash', _listId: null } as never],
      lists: [],
    });
    useAppStore.getState().applyDeltas([
      { entity: 'list', entityId: 'l1', op: 'upsert', payload: seedList('l1', [{ id: 100, title: 'Eggs' }]) },
    ]);
    const s = useAppStore.getState();
    // List is in the lists slice…
    expect(s.lists.map((l) => l.id)).toEqual(['l1']);
    // …and its task is mirrored into dashTasks alongside the untouched dash task.
    const listTask = s.dashTasks.find((t) => t.id === 100);
    expect(listTask?._source).toBe('list');
    expect(listTask?._listId).toBe('l1');
    expect(s.dashTasks.find((t) => t.id === 9)).toBeTruthy();
  });

  it('applyDeltas delete list removes it and its list tasks from dashTasks', () => {
    useAppStore.setState({
      lists: [seedList('l1', [{ id: 100, title: 'Eggs' }]) as never],
      dashTasks: [
        { id: 100, title: 'Eggs', _source: 'list', _listId: 'l1' } as never,
        { id: 9, title: 'dash', _source: 'dash', _listId: null } as never,
      ],
    });
    useAppStore.getState().applyDeltas([{ entity: 'list', entityId: 'l1', op: 'delete' }]);
    const s = useAppStore.getState();
    expect(s.lists).toHaveLength(0);
    expect(s.dashTasks.map((t) => t.id)).toEqual([9]); // list task gone, dash task kept
  });

  it('applyDeltas ignores signal entities (meeting/file/workspace/trash)', () => {
    useAppStore.setState({ dashTasks: [{ id: 1, title: 'a', _source: 'dash' } as never] });
    useAppStore.getState().applyDeltas([
      { entity: 'meeting', entityId: '', op: 'upsert' },
      { entity: 'file', entityId: '', op: 'upsert' },
    ]);
    expect(useAppStore.getState().dashTasks).toHaveLength(1);
  });
});
