import { describe, expect, it, vi } from 'vitest';
import { getEntityIndexEntry, resolveRefs } from '../graph/entityIndex';
import type { QueryExec } from '../workspaceUtil';

function makeExec(rowsByCall: unknown[][] = []) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const exec = vi.fn(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    const rows = rowsByCall.shift() ?? [];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }) as unknown as QueryExec;
  return { exec, calls };
}

const ROW = {
  entity_type: 'list',
  entity_id: 'list_1',
  workspace_id: 'ws_1',
  owner_id: 'user-1',
  title: 'Groceries',
  emoji: '🛒',
  color: '#5e4dbb',
  subtitle: null,
  status: null,
  is_archived: false,
  is_trashed: false,
  deep_link: '/list/list_1',
  entity_created_at: '2026-01-01T00:00:00.000Z',
  entity_updated_at: '2026-01-02T00:00:00.000Z',
};

describe('getEntityIndexEntry', () => {
  it('returns a fully-mapped entry (including its derived srn) when visible', async () => {
    const { exec, calls } = makeExec([[ROW]]);

    const entry = await getEntityIndexEntry('user-1', 'list', 'list_1', exec);

    expect(entry).toEqual({
      srn: 'srn:list:list_1',
      entityType: 'list',
      entityId: 'list_1',
      workspaceId: 'ws_1',
      ownerId: 'user-1',
      title: 'Groceries',
      emoji: '🛒',
      color: '#5e4dbb',
      subtitle: null,
      status: null,
      isArchived: false,
      isTrashed: false,
      deepLink: '/list/list_1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(calls[0].params).toEqual(['list', 'list_1', 'user-1']);
    // Every read must be scoped through the visibility boundary — never a bare id lookup.
    expect(calls[0].text).toContain('is_trashed = false');
    expect(calls[0].text).toContain('owner_id = $3');
  });

  it('returns null when the row does not exist or is not visible (existence-safe: same result either way)', async () => {
    const { exec } = makeExec([[]]);
    expect(await getEntityIndexEntry('user-2', 'list', 'list_1', exec)).toBeNull();
  });
});

describe('resolveRefs', () => {
  it('returns an empty map without querying when given no refs', async () => {
    const { exec, calls } = makeExec();
    const result = await resolveRefs('user-1', [], exec);
    expect(result.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('batch-resolves refs into a map keyed by "type:id", scoped to visibility', async () => {
    const otherRow = { ...ROW, entity_type: 'task', entity_id: '123', title: 'Buy milk', deep_link: null };
    const { exec, calls } = makeExec([[ROW, otherRow]]);

    const result = await resolveRefs(
      'user-1',
      [
        { entityType: 'list', entityId: 'list_1' },
        { entityType: 'task', entityId: '123' },
      ],
      exec
    );

    expect(result.size).toBe(2);
    expect(result.get('list:list_1')?.title).toBe('Groceries');
    expect(result.get('task:123')?.title).toBe('Buy milk');

    // Parallel arrays passed to unnest(), not a hand-built IN-list (injection-safe).
    expect(calls[0].text).toContain('unnest($1::text[], $2::text[])');
    expect(calls[0].params).toEqual([['list', 'task'], ['list_1', '123'], 'user-1']);
  });

  it('silently drops refs the user cannot see (no error, no entry — never leaks existence)', async () => {
    const { exec } = makeExec([[]]); // DB filters out the invisible row entirely
    const result = await resolveRefs('user-2', [{ entityType: 'list', entityId: 'list_1' }], exec);
    expect(result.size).toBe(0);
    expect(result.has('list:list_1')).toBe(false);
  });
});
