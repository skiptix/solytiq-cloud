import { describe, expect, it, vi } from 'vitest';
import {
  extractInlineLinks, extractFromBlocks, replaceInlineLinks,
  syncInlineLinksForText, syncInlineLinksForBlocks,
} from '../graph/inlineLinks';
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

describe('extractInlineLinks', () => {
  it('parses a plain type:id token', () => {
    const hits = extractInlineLinks('see [[list:list_7f3a9c21]] for details');
    expect(hits).toEqual([{ entityType: 'list', entityId: 'list_7f3a9c21', blockId: undefined, displayText: undefined }]);
  });

  it('parses blockId and pipe display text together', () => {
    const hits = extractInlineLinks('[[markdownList:md_a91c#blk_h2_intro|Training Notes]]');
    expect(hits).toEqual([{ entityType: 'markdownList', entityId: 'md_a91c', blockId: 'blk_h2_intro', displayText: 'Training Notes' }]);
  });

  it('extracts multiple tokens from one string', () => {
    const hits = extractInlineLinks('[[task:1]] and [[list:list_1]]');
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.entityType)).toEqual(['task', 'list']);
  });

  it('silently drops a token with an unrecognized entity type', () => {
    const hits = extractInlineLinks('[[workspace:ws_1]] [[task:1]]');
    expect(hits).toHaveLength(1);
    expect(hits[0].entityType).toBe('task');
  });

  it('returns an empty array for null/undefined/plain text', () => {
    expect(extractInlineLinks(null)).toEqual([]);
    expect(extractInlineLinks(undefined)).toEqual([]);
    expect(extractInlineLinks('no tokens here')).toEqual([]);
  });

  it('is stateless across repeated calls (no lastIndex leakage from the shared regex)', () => {
    extractInlineLinks('[[task:1]]');
    const second = extractInlineLinks('[[task:2]]');
    expect(second).toHaveLength(1);
    expect(second[0].entityId).toBe('2');
  });
});

describe('extractFromBlocks', () => {
  it('collects hits from text/content/caption fields and tags each with its block id', () => {
    const hits = extractFromBlocks([
      { id: 'blk_1', type: 'paragraph', text: '[[task:1]]' },
      { id: 'blk_2', type: 'image', caption: '[[list:list_1]]' },
    ]);
    expect(hits).toEqual([
      { entityType: 'task', entityId: '1', blockId: 'blk_1', displayText: undefined },
      { entityType: 'list', entityId: 'list_1', blockId: 'blk_2', displayText: undefined },
    ]);
  });

  it('scans table row cells', () => {
    const hits = extractFromBlocks([
      { id: 'blk_table', type: 'table', rows: [['[[task:1]]', 'plain'], ['[[list:list_1]]', 'plain']] },
    ]);
    expect(hits.map((h) => h.entityType)).toEqual(['task', 'list']);
    expect(hits.every((h) => h.blockId === 'blk_table')).toBe(true);
  });

  it('ignores blocks with no text-bearing fields', () => {
    expect(extractFromBlocks([{ id: 'blk_1', type: 'divider' }])).toEqual([]);
  });
});

describe('replaceInlineLinks', () => {
  const SRC = { entityType: 'markdownList' as const, entityId: 'md_1' };

  it('creates a new edge for a visible hit and reports it as added', async () => {
    const { exec, calls } = makeExec([
      [],                                   // 1. existing inline links (none)
      [{ workspace_id: 'ws_1' }],           // 2. isEntityVisible check
      [{ workspace_id: 'ws_1' }],           // 3. upsertLink: srcMeta
      [{}],                                 // 4. upsertLink: dstMeta
      [{ id: 'lnk_1' }],                    // 5. upsertLink: insert
    ]);
    const diff = await replaceInlineLinks(exec, SRC, [{ entityType: 'list', entityId: 'list_1' }], 'user-1');
    expect(diff).toEqual({ added: 1, removed: 0, unchanged: 0 });
    expect(calls[1].text).toContain('entity_index');
    expect(calls[4].text).toContain('INSERT INTO entity_links');
    expect(calls[4].params?.[6]).toBe('references'); // link_type
    expect(calls[4].params?.[7]).toBe('inline');      // origin
  });

  it('drops a hit that resolves to an entity the actor cannot see, without ever calling upsertLink', async () => {
    const { exec, calls } = makeExec([
      [],  // existing (none)
      [],  // isEntityVisible → not visible
    ]);
    const diff = await replaceInlineLinks(exec, SRC, [{ entityType: 'list', entityId: 'list_hidden' }], 'user-1');
    expect(diff).toEqual({ added: 0, removed: 0, unchanged: 0 });
    expect(calls).toHaveLength(2); // no INSERT ever attempted
  });

  it('never creates a self-loop edge, and never even checks visibility for one', async () => {
    const { exec, calls } = makeExec([[]]); // only the existing-links lookup
    const diff = await replaceInlineLinks(exec, SRC, [{ entityType: 'markdownList', entityId: 'md_1' }], 'user-1');
    expect(diff).toEqual({ added: 0, removed: 0, unchanged: 0 });
    expect(calls).toHaveLength(1);
  });

  it('removes a stale inline edge no longer present in the parsed text', async () => {
    const { exec, calls } = makeExec([
      [{ id: 'lnk_old', dst_type: 'list', dst_id: 'list_gone', source_block_id: null }], // existing
    ]);
    const diff = await replaceInlineLinks(exec, SRC, [], 'user-1');
    expect(diff).toEqual({ added: 0, removed: 1, unchanged: 0 });
    expect(calls[1].text).toContain('DELETE FROM entity_links WHERE id = $1');
    expect(calls[1].params).toEqual(['lnk_old']);
  });

  it('leaves an unchanged edge alone (no DELETE, no re-INSERT) when the hit is re-parsed identically', async () => {
    const { exec, calls } = makeExec([
      [{ id: 'lnk_1', dst_type: 'list', dst_id: 'list_1', source_block_id: null }],
    ]);
    const diff = await replaceInlineLinks(exec, SRC, [{ entityType: 'list', entityId: 'list_1' }], 'user-1');
    expect(diff).toEqual({ added: 0, removed: 0, unchanged: 1 });
    expect(calls).toHaveLength(1); // only the initial SELECT — nothing else touched
  });

  it('a duplicate origin=manual edge from the same source is never touched by the diff (only origin=inline rows are read)', async () => {
    const { exec, calls } = makeExec([[]]);
    await replaceInlineLinks(exec, SRC, [], 'user-1');
    expect(calls[0].text).toContain("origin = 'inline'");
  });
});

describe('syncInlineLinksForText / syncInlineLinksForBlocks — best-effort wrappers', () => {
  it('syncInlineLinksForText never throws even when the underlying exec rejects', async () => {
    const exec = vi.fn(async () => { throw new Error('db down'); }) as unknown as QueryExec;
    await expect(
      syncInlineLinksForText({ entityType: 'task', entityId: '1' }, '[[list:list_1]]', 'user-1', exec)
    ).resolves.toBeUndefined();
  });

  it('syncInlineLinksForBlocks never throws even when the underlying exec rejects', async () => {
    const exec = vi.fn(async () => { throw new Error('db down'); }) as unknown as QueryExec;
    await expect(
      syncInlineLinksForBlocks({ entityType: 'markdownList', entityId: 'md_1' }, [{ id: 'blk_1', type: 'paragraph', text: '[[task:1]]' }], 'user-1', exec)
    ).resolves.toBeUndefined();
  });

  it('syncInlineLinksForText is a no-op (single SELECT, zero mutations) when the text has no tokens', async () => {
    const { exec, calls } = makeExec([[]]);
    await syncInlineLinksForText({ entityType: 'task', entityId: '1' }, 'plain text, no tokens', 'user-1', exec);
    expect(calls).toHaveLength(1);
  });
});
