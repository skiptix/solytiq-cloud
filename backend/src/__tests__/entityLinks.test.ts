import { describe, expect, it, vi } from 'vitest';
import {
  upsertLink, deleteLink, updateLink, deleteLinksBetween, getLinksBetween,
  getEntityLinks, getBacklinks, LinkError,
} from '../graph/links';
import { resolveLinkType, isSystemLinkType, getSystemLinkType, SYSTEM_LINK_TYPES } from '../graph/linkTypes';
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

const LINK_ROW = {
  id: 'lnk_1',
  workspace_id: 'ws_1',
  src_type: 'task',
  src_id: '123',
  dst_type: 'list',
  dst_id: 'list_1',
  link_type: 'links_to',
  origin: 'manual',
  source_block_id: null,
  props: {},
  weight: 1,
  is_cross_workspace: false,
  created_by: 'user-1',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

describe('upsertLink', () => {
  it('rejects a self-loop before ever touching the database', async () => {
    const { exec, calls } = makeExec();
    await expect(
      upsertLink(exec, { srcType: 'task', srcId: '1', dstType: 'task', dstId: '1', linkType: 'blocks' })
    ).rejects.toMatchObject({ code: 'self_loop' } as Partial<LinkError>);
    expect(calls).toHaveLength(0);
  });

  it('rejects when the source entity does not exist', async () => {
    const { exec } = makeExec([[]]);
    await expect(
      upsertLink(exec, { srcType: 'task', srcId: '1', dstType: 'list', dstId: 'list_1', linkType: 'links_to' })
    ).rejects.toMatchObject({ code: 'src_not_found' });
  });

  it('rejects when the destination entity does not exist', async () => {
    const { exec } = makeExec([[{ workspace_id: 'ws_1' }], []]);
    await expect(
      upsertLink(exec, { srcType: 'task', srcId: '1', dstType: 'list', dstId: 'list_1', linkType: 'links_to' })
    ).rejects.toMatchObject({ code: 'dst_not_found' });
  });

  it('rejects an unknown link type', async () => {
    const { exec } = makeExec([[{ workspace_id: 'ws_1' }], [{}]]);
    await expect(
      upsertLink(exec, { srcType: 'task', srcId: '1', dstType: 'list', dstId: 'list_1', linkType: 'not_a_real_type' })
    ).rejects.toMatchObject({ code: 'unknown_link_type' });
  });

  it('rejects a src entity type the link type does not allow', async () => {
    const { exec } = makeExec([[{ workspace_id: 'ws_1' }], [{}]]);
    // child_of only allows list/task as src, not 'meeting'
    await expect(
      upsertLink(exec, { srcType: 'meeting', srcId: 'm1', dstType: 'task', dstId: '1', linkType: 'child_of' })
    ).rejects.toMatchObject({ code: 'invalid_src_type' });
  });

  it('rejects a dst entity type the link type does not allow', async () => {
    const { exec } = makeExec([[{ workspace_id: 'ws_1' }], [{}]]);
    // links_to only allows 'list' as dst, not 'meeting'
    await expect(
      upsertLink(exec, { srcType: 'task', srcId: '1', dstType: 'meeting', dstId: 'm1', linkType: 'links_to' })
    ).rejects.toMatchObject({ code: 'invalid_dst_type' });
  });

  it('inserts with the SOURCE entity workspace denormalized, an upsert-on-conflict target, and system-safe param binding', async () => {
    const { exec, calls } = makeExec([[{ workspace_id: 'ws_src' }], [{}], [LINK_ROW]]);
    const link = await upsertLink(exec, {
      srcType: 'task', srcId: '123', dstType: 'list', dstId: 'list_1',
      linkType: 'links_to', createdBy: 'user-1',
    });
    expect(link.id).toBe('lnk_1');
    expect(link.linkType).toBe('links_to');

    const insertCall = calls[2];
    expect(insertCall.text).toContain('INSERT INTO entity_links');
    expect(insertCall.text).toContain('ON CONFLICT (src_type, src_id, dst_type, dst_id, link_type, COALESCE(source_block_id, \'\'))');
    expect(insertCall.text).toContain('DO UPDATE SET props = EXCLUDED.props, weight = EXCLUDED.weight');
    // workspace_id param (2nd) comes from the SOURCE lookup, not a caller-supplied value.
    expect(insertCall.params?.[1]).toBe('ws_src');
    expect(insertCall.params?.[7]).toBe('manual'); // default origin
  });

  it('defaults origin to "manual" and serializes props as a JSON string for the jsonb column', async () => {
    const { exec, calls } = makeExec([[{ workspace_id: 'ws_1' }], [{}], [LINK_ROW]]);
    await upsertLink(exec, {
      srcType: 'task', srcId: '1', dstType: 'list', dstId: 'list_1',
      linkType: 'links_to', props: { note: 'hi' },
    });
    const insertCall = calls[2];
    expect(insertCall.params?.[7]).toBe('manual');
    expect(insertCall.params?.[9]).toBe(JSON.stringify({ note: 'hi' }));
  });
});

describe('deleteLink / updateLink — system-origin protection', () => {
  it('deleteLink SQL excludes origin=system rows so they are never user-deletable', async () => {
    const { exec, calls } = makeExec([[]]);
    const result = await deleteLink(exec, 'lnk_system');
    expect(result).toBeNull();
    expect(calls[0].text).toContain("origin != 'system'");
  });

  it('updateLink SQL excludes origin=system rows', async () => {
    const { exec, calls } = makeExec([[]]);
    const result = await updateLink(exec, 'lnk_system', { weight: 5 });
    expect(result).toBeNull();
    expect(calls[0].text).toContain("origin != 'system'");
    expect(calls[0].text).toContain('weight = $1');
  });

  it('updateLink with no fields short-circuits to a plain lookup (no UPDATE issued)', async () => {
    const { exec, calls } = makeExec([[LINK_ROW]]);
    const result = await updateLink(exec, 'lnk_1', {});
    expect(result?.id).toBe('lnk_1');
    expect(calls[0].text).toContain('SELECT * FROM entity_links WHERE id = $1');
  });
});

describe('deleteLinksBetween', () => {
  it('scopes the delete to both endpoints and never touches system-origin links', async () => {
    const { exec, calls } = makeExec([[{}, {}]]);
    const count = await deleteLinksBetween(
      exec,
      { entityType: 'task', entityId: '1' },
      { entityType: 'list', entityId: 'list_1' }
    );
    expect(count).toBe(2);
    expect(calls[0].text).toContain("origin != 'system'");
    expect(calls[0].params).toEqual(['task', '1', 'list', 'list_1']);
  });

  it('optionally narrows to a single link type', async () => {
    const { exec, calls } = makeExec([[]]);
    await deleteLinksBetween(exec, { entityType: 'task', entityId: '1' }, { entityType: 'list', entityId: 'list_1' }, 'links_to');
    expect(calls[0].text).toContain('link_type = $5');
    expect(calls[0].params).toEqual(['task', '1', 'list', 'list_1', 'links_to']);
  });
});

describe('getLinksBetween', () => {
  it('queries the exact (src, dst) pair, not a broader scan', async () => {
    const { exec, calls } = makeExec([[LINK_ROW]]);
    const links = await getLinksBetween({ entityType: 'task', entityId: '123' }, { entityType: 'list', entityId: 'list_1' }, undefined, exec);
    expect(links).toHaveLength(1);
    expect(calls[0].params).toEqual(['task', '123', 'list', 'list_1']);
  });
});

describe('getEntityLinks / getBacklinks', () => {
  it('resolves both directions and marks a neighbor null when it is not visible to the user', async () => {
    const outRow = { ...LINK_ROW, id: 'lnk_out' };
    const inRow = { ...LINK_ROW, id: 'lnk_in', src_type: 'markdownList', src_id: 'md_1', dst_type: 'task', dst_id: '123' };
    // Call order: out-query, in-query, then resolveRefs (neighbors: list_1 visible, md_1 not).
    const { exec, calls } = makeExec([
      [outRow],
      [inRow],
      [{ entity_type: 'list', entity_id: 'list_1', workspace_id: 'ws_1', owner_id: 'user-1', title: 'Groceries', emoji: null, color: null, subtitle: null, status: null, is_archived: false, is_trashed: false, deep_link: '/list/list_1', entity_created_at: null, entity_updated_at: null }],
    ]);

    const resolved = await getEntityLinks('user-1', { entityType: 'task', entityId: '123' }, {}, exec);
    expect(resolved).toHaveLength(2);
    const out = resolved.find((r) => r.direction === 'out')!;
    const inn = resolved.find((r) => r.direction === 'in')!;
    expect(out.neighbor?.title).toBe('Groceries');
    expect(inn.neighbor).toBeNull(); // md_1 wasn't in the resolved batch — cross-workspace visibility miss

    expect(calls[0].text).toContain('src_type = $1 AND src_id = $2');
    expect(calls[1].text).toContain('dst_type = $1 AND dst_id = $2');
  });

  it('getBacklinks returns only the incoming half', async () => {
    const inRow = { ...LINK_ROW, id: 'lnk_in', src_type: 'markdownList', src_id: 'md_1', dst_type: 'task', dst_id: '123' };
    const { exec } = makeExec([[], [inRow], []]);
    const backlinks = await getBacklinks('user-1', { entityType: 'task', entityId: '123' }, exec);
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0].direction).toBe('in');
  });
});

describe('link-type registry', () => {
  it('every system type declares a real inverse (or is explicitly symmetric)', () => {
    for (const def of Object.values(SYSTEM_LINK_TYPES)) {
      expect(def.inverseKey).toBeTruthy();
      if (def.symmetric) expect(def.inverseKey).toBe(def.key);
    }
  });

  it('resolveLinkType finds a system type regardless of workspace', async () => {
    expect(await resolveLinkType('blocks', null)).toMatchObject({ key: 'blocks', inverseKey: 'blocked_by' });
    expect(await resolveLinkType('blocks', 'ws_1')).toMatchObject({ key: 'blocks' });
  });

  it('resolveLinkType rejects a custom-looking key without a workspace to scope it', async () => {
    expect(await resolveLinkType('x_custom', null)).toBeNull();
  });

  it('resolveLinkType rejects a key that is neither a system type nor "x_"-prefixed', async () => {
    expect(await resolveLinkType('custom_thing', 'ws_1')).toBeNull();
  });

  it('isSystemLinkType / getSystemLinkType agree on the registry contents', () => {
    expect(isSystemLinkType('relates_to')).toBe(true);
    expect(getSystemLinkType('relates_to')?.symmetric).toBe(true);
    expect(isSystemLinkType('x_foo')).toBe(false);
    expect(getSystemLinkType('x_foo')).toBeNull();
  });
});
