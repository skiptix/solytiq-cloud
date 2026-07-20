import { describe, expect, it } from 'vitest';
import type { QueryExec } from '../workspaceUtil';
import type { MutationActor } from '../automationEngine';
import { recordTaskChanges } from '../taskChangeLog';

function makeExec(rowsByCall: unknown[][]) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const exec = (async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    const rows = rowsByCall.shift() ?? [];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }) as unknown as QueryExec;
  return { exec, calls };
}

const userActor: MutationActor = { type: 'user', userId: 'user_1' };
const automationActor: MutationActor = { type: 'automation', automationId: 'auto_1', runId: 'run_1' };

describe('recordTaskChanges', () => {
  it('no-ops (no queries at all) when nothing tracked actually changed', async () => {
    const { exec, calls } = makeExec([]);
    await recordTaskChanges(
      exec, 'list_1', 't1',
      { title: 'Same', deadline: '2026-08-01', priority: 'Low', badge: null, section_id: 'sec_1' },
      { title: 'Same', deadline: '2026-08-01', priority: 'Low', badge: null, section_id: 'sec_1' },
      userActor
    );
    expect(calls.length).toBe(0);
  });

  it('logs a checked (done/not done) transition as boolean strings', async () => {
    const { exec, calls } = makeExec([
      [{ username: 'niels' }],
      [],
    ]);
    await recordTaskChanges(exec, 'list_1', 't1', { checked: false }, { checked: true }, userActor);

    expect(calls[1].text).toMatch(/INSERT INTO task_change_log/);
    expect(calls[1].params).toEqual(['t1', 'list_1', 'checked', 'false', 'true', 'user', 'user_1', 'niels']);
  });

  it('logs a single field change with a user actor name resolved from users.username', async () => {
    const { exec, calls } = makeExec([
      [{ username: 'niels' }], // actor name lookup
      [],                      // INSERT
    ]);
    await recordTaskChanges(exec, 'list_1', 't1', { priority: 'Low' }, { priority: 'High' }, userActor);

    expect(calls.length).toBe(2);
    expect(calls[0].text).toMatch(/SELECT username FROM users/);
    expect(calls[1].text).toMatch(/INSERT INTO task_change_log/);
    expect(calls[1].params).toEqual(['t1', 'list_1', 'priority', 'Low', 'High', 'user', 'user_1', 'niels']);
  });

  it('logs with an automation actor name resolved from automations.name', async () => {
    const { exec, calls } = makeExec([
      [{ name: 'Auto-triage' }],
      [],
    ]);
    await recordTaskChanges(exec, 'list_1', 't1', { badge: null }, { badge: 'urgent' }, automationActor);

    expect(calls[0].text).toMatch(/SELECT name FROM automations/);
    expect(calls[1].params).toEqual(['t1', 'list_1', 'badge', null, 'urgent', 'automation', 'auto_1', 'Auto-triage']);
  });

  it('resolves old/new section labels via one lookup and logs field "section"', async () => {
    const { exec, calls } = makeExec([
      [{ id: 'sec_old', label: 'Backlog' }, { id: 'sec_new', label: 'In Progress' }], // sections lookup
      [{ username: 'niels' }],
      [],
    ]);
    await recordTaskChanges(exec, 'list_1', 't1', { section_id: 'sec_old' }, { section_id: 'sec_new' }, userActor);

    expect(calls[0].text).toMatch(/SELECT id, label FROM sections/);
    expect(calls[0].params).toEqual([['sec_old', 'sec_new']]);
    expect(calls[2].params).toEqual(['t1', 'list_1', 'section', 'Backlog', 'In Progress', 'user', 'user_1', 'niels']);
  });

  it('only diffs fields present in BOTH snapshots (partial snapshot support for rename_task/move_task)', async () => {
    const { exec, calls } = makeExec([
      [{ id: 'sec_a', label: 'A' }, { id: 'sec_b', label: 'B' }],
      [{ username: 'niels' }],
      [],
    ]);
    // title omitted entirely on both sides -> must never be diffed even though it's "different" conceptually.
    await recordTaskChanges(exec, 'list_1', 't1', { section_id: 'sec_a' }, { section_id: 'sec_b' }, userActor);
    const inserted = calls.find((c) => c.text.includes('INSERT'));
    expect(inserted?.params?.[2]).toBe('section');
    expect(calls.filter((c) => c.text.includes('INSERT')).length).toBe(1);
  });

  it('truncates a long note into a preview rather than storing it verbatim', async () => {
    const longNote = 'x'.repeat(500);
    const { exec, calls } = makeExec([
      [{ username: 'niels' }],
      [],
    ]);
    await recordTaskChanges(exec, 'list_1', 't1', { note: null }, { note: longNote }, userActor);
    const insertParams = calls[1].params as unknown[];
    const newValue = insertParams[4] as string;
    expect(newValue.length).toBeLessThan(500);
    expect(newValue.endsWith('…')).toBe(true);
  });

  it('treats null and empty-string note as equivalent (no spurious diff)', async () => {
    const { exec, calls } = makeExec([]);
    await recordTaskChanges(exec, 'list_1', 't1', { note: null }, { note: '' }, userActor);
    expect(calls.length).toBe(0);
  });
});
