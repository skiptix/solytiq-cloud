import { describe, it, expect } from 'vitest';
import type { Task, List, MarkdownList } from '../../types';
import {
  addDaysIso, isDueToday, isDueWithinNextDays, isOverdue,
  countTasks, pctComplete, resolveTaskSource, sortByDeadline, sortByNewest,
} from '../dashboard';

const task = (t: Partial<Task>): Task => ({ id: 1, title: 'T', checked: false, ...t });

describe('addDaysIso', () => {
  it('shifts whole days and crosses month boundaries', () => {
    expect(addDaysIso('2026-07-16', 0)).toBe('2026-07-16');
    expect(addDaysIso('2026-07-16', 7)).toBe('2026-07-23');
    expect(addDaysIso('2026-07-30', 3)).toBe('2026-08-02');
    expect(addDaysIso('2026-07-16', -1)).toBe('2026-07-15');
  });
});

describe('isDueToday', () => {
  const today = '2026-07-16';
  it('matches only the exact day, tolerating a datetime string', () => {
    expect(isDueToday('2026-07-16', today)).toBe(true);
    expect(isDueToday('2026-07-16T09:00:00Z', today)).toBe(true);
    expect(isDueToday('2026-07-17', today)).toBe(false);
    expect(isDueToday(undefined, today)).toBe(false);
    expect(isDueToday(null, today)).toBe(false);
  });
});

describe('isDueWithinNextDays', () => {
  const today = '2026-07-16';
  it('covers a 7-day window that includes today (today … today+6)', () => {
    expect(isDueWithinNextDays('2026-07-16', today, 7)).toBe(true);  // today
    expect(isDueWithinNextDays('2026-07-22', today, 7)).toBe(true);  // today+6, last day in window
    expect(isDueWithinNextDays('2026-07-23', today, 7)).toBe(false); // today+7, just outside
    expect(isDueWithinNextDays('2026-07-15', today, 7)).toBe(false); // yesterday
    expect(isDueWithinNextDays(undefined, today, 7)).toBe(false);
  });
});

describe('isOverdue', () => {
  const today = '2026-07-16';
  it('is true only for a past deadline on an open task', () => {
    expect(isOverdue({ deadline: '2026-07-15', checked: false }, today)).toBe(true);
    expect(isOverdue({ deadline: '2026-07-15', checked: true }, today)).toBe(false);  // completed
    expect(isOverdue({ deadline: '2026-07-16', checked: false }, today)).toBe(false); // due today ≠ overdue
    expect(isOverdue({ deadline: undefined, checked: false }, today)).toBe(false);
  });
});

describe('countTasks / pctComplete', () => {
  it('splits completed vs open and computes a whole-number percent', () => {
    const counts = countTasks([task({ checked: true }), task({ checked: false }), task({ checked: true })]);
    expect(counts).toEqual({ total: 3, completed: 2, open: 1 });
    expect(pctComplete(counts)).toBe(67);
    expect(pctComplete({ total: 0, completed: 0, open: 0 })).toBe(0);
  });
});

describe('resolveTaskSource', () => {
  const list: List = { id: 'l1', name: 'Groceries', emoji: '🛒', workspaceId: 'w1', sections: [] };
  const md: MarkdownList = {
    id: 'md1', name: 'Trip plan', emoji: '✈️', workspaceId: 'w2', todoListId: 'l2',
    content: { version: 1, blocks: [] }, createdAt: '', updatedAt: '',
  };
  const listById = new Map<string, List>([[list.id, list]]);
  const mdByTodoListId = new Map<string, MarkdownList>([['l2', md]]);

  it('labels a plain list task with its list name + workspace', () => {
    const src = resolveTaskSource(task({ _source: 'list', _listId: 'l1', workspaceId: 'w1' }), listById, mdByTodoListId);
    expect(src).toMatchObject({ kind: 'list', name: 'Groceries', workspaceId: 'w1' });
  });

  it("resolves a markdown page's todo list to the page name, not the generated list", () => {
    const src = resolveTaskSource(task({ _source: 'list', _listId: 'l2', workspaceId: 'w2' }), listById, mdByTodoListId);
    expect(src).toMatchObject({ kind: 'markdown', name: 'Trip plan', workspaceId: 'w2' });
  });

  it('labels a dashboard task as Dashboard', () => {
    const src = resolveTaskSource(task({ _source: 'dash', workspaceId: 'w1' }), listById, mdByTodoListId);
    expect(src).toMatchObject({ kind: 'dashboard', name: 'Dashboard', workspaceId: 'w1' });
  });

  it('falls back to the denormalized list name when the list is not loaded', () => {
    const src = resolveTaskSource(task({ _source: 'list', _listId: 'gone', _listName: 'Archived' }), listById, mdByTodoListId);
    expect(src).toMatchObject({ kind: 'list', name: 'Archived' });
  });
});

describe('sortByDeadline', () => {
  it('orders by deadline asc, undated last, then by time', () => {
    const out = sortByDeadline([
      task({ id: 1, deadline: undefined }),
      task({ id: 2, deadline: '2026-07-20', time: '09:00' }),
      task({ id: 3, deadline: '2026-07-18' }),
      task({ id: 4, deadline: '2026-07-20', time: '08:00' }),
    ]);
    expect(out.map(t => t.id)).toEqual([3, 4, 2, 1]);
  });
});

describe('sortByNewest', () => {
  it('orders most-recently-created first', () => {
    const out = sortByNewest([
      task({ id: 1, createdAt: '2026-07-10T10:00:00Z' }),
      task({ id: 2, createdAt: '2026-07-16T10:00:00Z' }),
      task({ id: 3, createdAt: '2026-07-12T10:00:00Z' }),
    ]);
    expect(out.map(t => t.id)).toEqual([2, 3, 1]);
  });
});
