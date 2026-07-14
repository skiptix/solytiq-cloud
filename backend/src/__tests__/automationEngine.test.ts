import { describe, expect, it, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../db', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  withTransaction: vi.fn(),
}));

import { fireTrigger, scopeMatches, computeNextFireAt } from '../automationEngine';

describe('fireTrigger — loop prevention', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('is a complete no-op for an automation-originated actor: it never touches the database', async () => {
    await fireTrigger(
      'task_created',
      { workspaceId: 'ws_1', task: { id: '1', title: 'x', listId: 'list_1', checked: false }, list: { id: 'list_1', name: 'L' } },
      { type: 'automation', automationId: 'automation_x', runId: 'run_x' }
    );
    // The entire loop-prevention guarantee rests on this: no lookup, so no
    // automation can ever be re-triggered by another automation's own writes.
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('looks up matching enabled automations for a genuine user action', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await fireTrigger(
      'task_created',
      { workspaceId: 'ws_1', task: { id: '1', title: 'x', listId: 'list_1', checked: false }, list: { id: 'list_1', name: 'L' } },
      { type: 'user', userId: 'user_1' }
    );
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/FROM automations/);
    expect(params).toEqual(['ws_1', 'task_created']);
  });
});

describe('scopeMatches', () => {
  const ctxWithList = { workspaceId: 'ws_1', list: { id: 'list_1', name: 'L' } };
  const ctxNoList = { workspaceId: 'ws_1' };

  it('task_completed/task_created match any list when scope.listId is unset', () => {
    expect(scopeMatches('task_completed', {}, ctxWithList)).toBe(true);
    expect(scopeMatches('task_created', {}, ctxWithList)).toBe(true);
  });

  it('task_completed/task_created only match the scoped list when scope.listId is set', () => {
    expect(scopeMatches('task_completed', { listId: 'list_1' }, ctxWithList)).toBe(true);
    expect(scopeMatches('task_completed', { listId: 'list_OTHER' }, ctxWithList)).toBe(false);
  });

  it('list_all_completed requires an exact listId match (no "any list" case)', () => {
    expect(scopeMatches('list_all_completed', { listId: 'list_1' }, ctxWithList)).toBe(true);
    expect(scopeMatches('list_all_completed', { listId: 'list_OTHER' }, ctxWithList)).toBe(false);
    expect(scopeMatches('list_all_completed', {}, ctxWithList)).toBe(false);
  });

  it('never matches a trigger event whose context has no list', () => {
    expect(scopeMatches('list_all_completed', { listId: 'list_1' }, ctxNoList)).toBe(false);
  });

  it('schedule never matches via fireTrigger\'s lookup path (fired only by the sweep)', () => {
    expect(scopeMatches('schedule', {}, ctxWithList)).toBe(false);
  });
});

describe('computeNextFireAt', () => {
  it('schedules the same day when the time is still ahead (daily)', () => {
    const from = new Date('2026-07-14T08:00:00Z');
    const next = computeNextFireAt({ freq: 'daily', time: '09:00' }, from);
    expect(next.getUTCHours()).toBe(9);
    expect(next.getUTCDate()).toBe(from.getUTCDate());
  });

  it('rolls over to the next day when the time has already passed (daily)', () => {
    const from = new Date('2026-07-14T10:00:00Z');
    const next = computeNextFireAt({ freq: 'daily', time: '09:00' }, from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect(next.getUTCDate()).toBe(from.getUTCDate() + 1);
  });

  it('finds the next matching weekday for weekly schedules', () => {
    const from = new Date('2026-07-14T00:00:00Z'); // a Tuesday
    const next = computeNextFireAt({ freq: 'weekly', time: '09:00', dayOfWeek: 5 }, from); // next Friday
    expect(next.getDay()).toBe(5);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });
});
