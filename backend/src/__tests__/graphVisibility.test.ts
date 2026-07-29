import { describe, expect, it, vi } from 'vitest';
import { visibleCondition, isEntityVisible, canWriteEntity } from '../graph/visibility';
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

describe('visibleCondition', () => {
  it('covers owner, workspace membership, public workspace, and item_shares — every visibility path', () => {
    const sql = visibleCondition('e', 3);
    expect(sql).toContain('e.is_trashed = false');
    expect(sql).toContain('e.owner_id = $3');
    expect(sql).toContain('workspace_members wm');
    expect(sql).toContain("visibility = 'public'");
    expect(sql).toContain('item_shares s');
    expect(sql).toContain('$3');
  });
});

describe('isEntityVisible', () => {
  it('is true when the scoped SELECT returns a row', async () => {
    const { exec, calls } = makeExec([[{ '?column?': 1 }]]);
    expect(await isEntityVisible(exec, 'user-1', 'list', 'list_1')).toBe(true);
    expect(calls[0].params).toEqual(['list', 'list_1', 'user-1']);
  });

  it('is false (never throws) when nothing matches — same for "gone" and "not visible"', async () => {
    const { exec } = makeExec([[]]);
    expect(await isEntityVisible(exec, 'user-2', 'list', 'list_1')).toBe(false);
  });
});

describe('canWriteEntity', () => {
  it('admins can always write, without even querying entity_index', async () => {
    const { exec, calls } = makeExec();
    expect(await canWriteEntity('any-user', true, 'list', 'list_1', exec)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('the owner can write', async () => {
    const { exec } = makeExec([[{ owner_id: 'user-1' }]]);
    expect(await canWriteEntity('user-1', false, 'list', 'list_1', exec)).toBe(true);
  });

  it('a non-owner without an item_shares invite cannot write', async () => {
    const { exec } = makeExec([[{ owner_id: 'user-1' }], []]);
    expect(await canWriteEntity('user-2', false, 'list', 'list_1', exec)).toBe(false);
  });

  it('an item_shares collaborator can write to a list/timeline/markdownList', async () => {
    const { exec, calls } = makeExec([[{ owner_id: 'user-1' }], [{ '?column?': 1 }]]);
    expect(await canWriteEntity('user-2', false, 'list', 'list_1', exec)).toBe(true);
    expect(calls[1].text).toContain('item_shares');
    expect(calls[1].params).toEqual(['list', 'list_1', 'user-2']);
  });

  it('item_shares collaboration does NOT extend to single-owner entity types (task/milestone/meeting/file/gpsFile/section)', async () => {
    const { exec, calls } = makeExec([[{ owner_id: 'user-1' }]]);
    expect(await canWriteEntity('user-2', false, 'task', '123', exec)).toBe(false);
    // Only ONE query — never even checks item_shares for a non-shareable type.
    expect(calls).toHaveLength(1);
  });

  it('returns false for an entity that does not exist', async () => {
    const { exec } = makeExec([[]]);
    expect(await canWriteEntity('user-1', false, 'list', 'nope', exec)).toBe(false);
  });
});
