import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MarkdownBlockLike } from '../routes/markdownLists';

// The markdown AI tools funnel every block edit through
// mutateMarkdownListBlocks (real DB + transaction). Mock that module so we can
// drive the pure block-transform closure each tool builds against a chosen
// starting block array and assert exactly what it would persist — no DB needed
// (same mock-QueryExec spirit as workspaceIntegrity.test.ts).

const mutateMock = vi.hoisted(() => vi.fn());
const createMdMock = vi.hoisted(() => vi.fn());
const deleteMdMock = vi.hoisted(() => vi.fn());
vi.mock('../routes/markdownLists', () => ({
  mutateMarkdownListBlocks: mutateMock,
  createMarkdownListForUser: createMdMock,
  deleteMarkdownListForUser: deleteMdMock,
}));

const queryMock = vi.hoisted(() => vi.fn(async () => ({ rows: [], rowCount: 0 })));
vi.mock('../db', () => ({ query: queryMock, withTransaction: vi.fn() }));
vi.mock('../sse', () => ({ broadcastToUser: vi.fn() }));

import { executeAiTool } from '../aiTools';

// Drive the tool's mutate closure with `current`, capturing what it produces.
let current: MarkdownBlockLike[] = [];
let produced: MarkdownBlockLike[] | null = null;
beforeEach(() => {
  produced = null;
  mutateMock.mockReset();
  createMdMock.mockReset();
  deleteMdMock.mockReset();
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  mutateMock.mockImplementation(async (_userId: string, _id: string, fn: (b: MarkdownBlockLike[]) => MarkdownBlockLike[] | { error: string }) => {
    const out = fn(current);
    if (Array.isArray(out)) { produced = out; return { ok: true, markdownList: { name: 'Doc' } }; }
    return { ok: false, error: out.error };
  });
});

describe('add_markdown_block', () => {
  it('rejects a heading without a level', async () => {
    current = [];
    const r = await executeAiTool('u1', 'add_markdown_block', { markdown_list_id: 'm1', type: 'heading' });
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/level/i);
  });

  it('rejects an image block (cannot be created by AI)', async () => {
    current = [];
    const r = await executeAiTool('u1', 'add_markdown_block', { markdown_list_id: 'm1', type: 'image' });
    expect(r.ok).toBe(false);
  });

  it('creates a divider with a 2-column layout when layout=columns', async () => {
    current = [{ id: 'a', type: 'paragraph', text: 'hi' }];
    const r = await executeAiTool('u1', 'add_markdown_block', { markdown_list_id: 'm1', type: 'divider', layout: 'columns' });
    expect(r.ok).toBe(true);
    expect(produced).toHaveLength(2);
    expect(produced![1]).toMatchObject({ type: 'divider', layout: 'columns' });
  });

  it('inserts after a given block id', async () => {
    current = [{ id: 'a', type: 'paragraph', text: '1' }, { id: 'b', type: 'paragraph', text: '2' }];
    const r = await executeAiTool('u1', 'add_markdown_block', { markdown_list_id: 'm1', type: 'paragraph', text: 'mid', position: 'after', after_block_id: 'a' });
    expect(r.ok).toBe(true);
    expect(produced!.map((b) => b.text)).toEqual(['1', 'mid', '2']);
  });
});

describe('add_markdown_blocks', () => {
  it('inserts several blocks in order at the end', async () => {
    current = [{ id: 'a', type: 'paragraph', text: 'x' }];
    const r = await executeAiTool('u1', 'add_markdown_blocks', {
      markdown_list_id: 'm1',
      blocks: [
        { type: 'heading', level: 2, text: 'Section' },
        { type: 'bulleted-list-item', text: 'one' },
        { type: 'bulleted-list-item', text: 'two' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(produced!.map((b) => b.type)).toEqual(['paragraph', 'heading', 'bulleted-list-item', 'bulleted-list-item']);
  });

  it('fails the whole batch if any block is invalid (no partial insert)', async () => {
    current = [];
    const r = await executeAiTool('u1', 'add_markdown_blocks', {
      markdown_list_id: 'm1',
      blocks: [{ type: 'paragraph', text: 'ok' }, { type: 'link' /* missing url */ }],
    });
    expect(r.ok).toBe(false);
    expect(produced).toBeNull();
  });
});

describe('reorder_markdown_blocks', () => {
  it('reorders when block_ids is an exact permutation', async () => {
    current = [{ id: 'a', type: 'paragraph', text: '1' }, { id: 'b', type: 'paragraph', text: '2' }, { id: 'c', type: 'paragraph', text: '3' }];
    const r = await executeAiTool('u1', 'reorder_markdown_blocks', { markdown_list_id: 'm1', block_ids: ['c', 'a', 'b'] });
    expect(r.ok).toBe(true);
    expect(produced!.map((b) => b.id)).toEqual(['c', 'a', 'b']);
  });

  it('rejects a block_ids list that adds or drops ids', async () => {
    current = [{ id: 'a', type: 'paragraph', text: '1' }, { id: 'b', type: 'paragraph', text: '2' }];
    const r = await executeAiTool('u1', 'reorder_markdown_blocks', { markdown_list_id: 'm1', block_ids: ['a'] });
    expect(r.ok).toBe(false);
    expect(produced).toBeNull();
  });
});

describe('set_markdown_content', () => {
  it('replaces everything, preserving an image by image_id and a todo mirror by block id', async () => {
    current = [
      { id: 'img1', type: 'image', imageId: 'mdimg_1', caption: 'old' },
      { id: 'todo1', type: 'todo', text: 'Buy milk', checked: false, taskId: '555' },
      { id: 'p1', type: 'paragraph', text: 'gone' },
    ];
    const r = await executeAiTool('u1', 'set_markdown_content', {
      markdown_list_id: 'm1',
      blocks: [
        { type: 'heading', level: 1, text: 'Title' },
        { type: 'todo', id: 'todo1', text: 'Buy milk', checked: true },
        { type: 'image', image_id: 'mdimg_1', caption: 'new' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(produced!.map((b) => b.type)).toEqual(['heading', 'todo', 'image']);
    // Todo keeps its mirror task link, and the new checked state applies.
    expect(produced![1]).toMatchObject({ type: 'todo', taskId: '555', checked: true });
    // Image is preserved via its image_id, with the updated caption.
    expect(produced![2]).toMatchObject({ type: 'image', imageId: 'mdimg_1', caption: 'new' });
  });

  it('rejects an image referencing an id that is not on the page', async () => {
    current = [{ id: 'p1', type: 'paragraph', text: 'x' }];
    const r = await executeAiTool('u1', 'set_markdown_content', {
      markdown_list_id: 'm1',
      blocks: [{ type: 'image', image_id: 'mdimg_ghost' }],
    });
    expect(r.ok).toBe(false);
    expect(produced).toBeNull();
  });

  it('clears to a single empty paragraph when given an empty array', async () => {
    current = [{ id: 'p1', type: 'paragraph', text: 'x' }];
    const r = await executeAiTool('u1', 'set_markdown_content', { markdown_list_id: 'm1', blocks: [] });
    expect(r.ok).toBe(true);
    expect(produced).toHaveLength(1);
    expect(produced![0]).toMatchObject({ type: 'paragraph', text: '' });
  });
});

describe('create_markdown_list', () => {
  it('validates seed blocks BEFORE creating the page (no page left behind on a bad block)', async () => {
    const r = await executeAiTool('u1', 'create_markdown_list', {
      name: 'Plan',
      blocks: [{ type: 'heading' /* missing level */ }],
    });
    expect(r.ok).toBe(false);
    expect(createMdMock).not.toHaveBeenCalled();
  });

  it('creates the page and seeds initial blocks when valid', async () => {
    createMdMock.mockResolvedValue({ id: 'mdlist_new', name: 'Plan' });
    const r = await executeAiTool('u1', 'create_markdown_list', {
      name: 'Plan',
      blocks: [{ type: 'paragraph', text: 'intro' }],
    });
    expect(r.ok).toBe(true);
    expect(createMdMock).toHaveBeenCalledOnce();
    // The seed blocks are pushed through mutateMarkdownListBlocks.
    expect(mutateMock).toHaveBeenCalledWith('u1', 'mdlist_new', expect.any(Function));
  });
});

describe('delete_markdown_list', () => {
  it('delegates to the shared soft-delete helper', async () => {
    deleteMdMock.mockResolvedValue({ ok: true, name: 'Plan' });
    const r = await executeAiTool('u1', 'delete_markdown_list', { markdown_list_id: 'm1' });
    expect(r.ok).toBe(true);
    expect(deleteMdMock).toHaveBeenCalledWith('u1', 'm1');
    expect(r.result).toMatch(/trash/i);
  });
});

describe('update_markdown_list', () => {
  it('updates page settings for the owner', async () => {
    // 1st query = owner check, 2nd = the UPDATE ... RETURNING name
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'Old' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ name: 'New' }], rowCount: 1 });
    const r = await executeAiTool('u1', 'update_markdown_list', { markdown_list_id: 'm1', name: 'New', emoji: '📓' });
    expect(r.ok).toBe(true);
    expect(r.result).toMatch(/New/);
  });

  it('fails when the page is not owned by the user', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // owner check fails
    const r = await executeAiTool('u1', 'update_markdown_list', { markdown_list_id: 'm1', name: 'New' });
    expect(r.ok).toBe(false);
  });
});
