// ---------------------------------------------------------------------------
// Knowledge Base AI/MCP tools — the full round trip an external agent takes:
// create the base, list terms, get an entry_id, revise the entry.
//
// Each of those three steps was independently broken: there was no tool that
// could create a base, no tool that returned an entry_id (so update/delete/link
// were unreachable), and no way to revise an entry's body. These tests pin all
// three, because each failure is invisible from the type system — every tool
// still compiled and still returned ok.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi, beforeEach } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn(async () => ({ rows: [], rowCount: 0 })));
vi.mock('../db', () => ({ query: (...args: unknown[]) => queryMock(...args), withTransaction: vi.fn() }));
vi.mock('../sse', () => ({ broadcastToUser: vi.fn() }));
vi.mock('../agent/runtime', () => ({ startAgentRun: vi.fn() }));

const enqueueEmbeddingMock = vi.hoisted(() => vi.fn());
vi.mock('../knowledge/queue', async () => {
  const actual = await vi.importActual<typeof import('../knowledge/queue')>('../knowledge/queue');
  return { ...actual, enqueueEmbedding: (...args: unknown[]) => enqueueEmbeddingMock(...args) };
});

const getBaseForWorkspaceMock = vi.hoisted(() => vi.fn());
const createBaseMock = vi.hoisted(() => vi.fn());
const createEntryMock = vi.hoisted(() => vi.fn());
const updateEntryMock = vi.hoisted(() => vi.fn());
const getEntryMock = vi.hoisted(() => vi.fn());
const getBaseByIdMock = vi.hoisted(() => vi.fn());
vi.mock('../knowledgeBase/entries', async () => {
  const actual = await vi.importActual<typeof import('../knowledgeBase/entries')>('../knowledgeBase/entries');
  return {
    ...actual,
    getBaseForWorkspace: (...args: unknown[]) => getBaseForWorkspaceMock(...args),
    createBase: (...args: unknown[]) => createBaseMock(...args),
    createEntry: (...args: unknown[]) => createEntryMock(...args),
    updateEntry: (...args: unknown[]) => updateEntryMock(...args),
    getEntry: (...args: unknown[]) => getEntryMock(...args),
    getBaseById: (...args: unknown[]) => getBaseByIdMock(...args),
  };
});

const lookupTermMock = vi.hoisted(() => vi.fn());
const listGlossaryMock = vi.hoisted(() => vi.fn());
vi.mock('../knowledgeBase/lookup', () => ({
  lookupTerm: (...args: unknown[]) => lookupTermMock(...args),
  listGlossary: (...args: unknown[]) => listGlossaryMock(...args),
}));

const mutateEntryBlocksMock = vi.hoisted(() => vi.fn());
vi.mock('../knowledgeBase/blocks', () => ({
  mutateEntryBlocks: (...args: unknown[]) => mutateEntryBlocksMock(...args),
}));

const userCanAccessWorkspaceMock = vi.hoisted(() => vi.fn());
vi.mock('../workspaceUtil', async () => {
  const actual = await vi.importActual<typeof import('../workspaceUtil')>('../workspaceUtil');
  return { ...actual, userCanAccessWorkspace: (...args: unknown[]) => userCanAccessWorkspaceMock(...args) };
});

import { executeAiTool, getOpenRouterToolDefs, getMcpToolDefs } from '../aiTools';

const BASE = { id: 'kb_1', workspace_id: 'ws1', user_id: 'u1', name: 'Knowledge' };
const ENTRY = { id: 'kbe_1', kb_id: 'kb_1', term: 'Q3 Rollout' };

/** Make the caller a member of the workspace (isWorkspaceMemberForTools hits `query` directly). */
function asMember(isMember: boolean) {
  queryMock.mockResolvedValue({ rows: isMember ? [{ '?column?': 1 }] : [], rowCount: isMember ? 1 : 0 });
}

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  enqueueEmbeddingMock.mockReset();
  getBaseForWorkspaceMock.mockReset();
  createBaseMock.mockReset();
  createEntryMock.mockReset();
  updateEntryMock.mockReset();
  getEntryMock.mockReset();
  getBaseByIdMock.mockReset();
  lookupTermMock.mockReset();
  listGlossaryMock.mockReset();
  mutateEntryBlocksMock.mockReset();
  userCanAccessWorkspaceMock.mockReset();
});

describe('tool surface', () => {
  it('exposes create_knowledge_base to BOTH Sol and MCP — an agent with no sidebar must be able to make one', () => {
    expect(getOpenRouterToolDefs().map((d) => d.function.name)).toContain('create_knowledge_base');
    expect(getMcpToolDefs().map((d) => d.name)).toContain('create_knowledge_base');
  });

  it('offers a body parameter on update_knowledge_entry, not just metadata fields', () => {
    const def = getMcpToolDefs().find((d) => d.name === 'update_knowledge_entry')!;
    expect(Object.keys(def.inputSchema.properties as Record<string, unknown>)).toContain('body');
  });
});

describe('create_knowledge_base', () => {
  it('creates the base for a workspace member', async () => {
    asMember(true);
    createBaseMock.mockResolvedValue({ base: BASE, created: true });
    const r = await executeAiTool('u1', 'create_knowledge_base', { workspace_id: 'ws1' });
    expect(r.ok).toBe(true);
    expect(r.result).toContain('Created');
    expect(createBaseMock).toHaveBeenCalled();
  });

  it('is idempotent — a second call reports the existing base instead of failing', async () => {
    asMember(true);
    createBaseMock.mockResolvedValue({ base: BASE, created: false });
    const r = await executeAiTool('u1', 'create_knowledge_base', { workspace_id: 'ws1' });
    expect(r.ok).toBe(true);
    expect(r.result).toContain('already has');
  });

  it('needs MEMBERSHIP, not mere access, and reports a non-member workspace as absent', async () => {
    asMember(false);
    const r = await executeAiTool('u1', 'create_knowledge_base', { workspace_id: 'ws_other' });
    expect(r.ok).toBe(false);
    expect(r.result).toContain('workspace not found');
    expect(createBaseMock).not.toHaveBeenCalled();
  });
});

describe('list_knowledge_terms', () => {
  it('distinguishes "no base" from "base with no terms" — the two have different fixes', async () => {
    userCanAccessWorkspaceMock.mockResolvedValue(true);
    getBaseForWorkspaceMock.mockResolvedValue(null);
    const noBase = await executeAiTool('u1', 'list_knowledge_terms', { workspace_id: 'ws1' });
    expect(noBase.result).toContain('create_knowledge_base');

    getBaseForWorkspaceMock.mockResolvedValue(BASE);
    listGlossaryMock.mockResolvedValue([]);
    const empty = await executeAiTool('u1', 'list_knowledge_terms', { workspace_id: 'ws1' });
    expect(empty.result).not.toContain('create_knowledge_base');
    expect(empty.result).toContain('no terms');
  });

  it('carries each entry_id — nothing else produces one, and update/delete/link all require it', async () => {
    userCanAccessWorkspaceMock.mockResolvedValue(true);
    getBaseForWorkspaceMock.mockResolvedValue(BASE);
    listGlossaryMock.mockResolvedValue([
      { id: 'kbe_1', term: 'Q3 Rollout', aliases: ['Q3'], entryType: 'project', summary: 'Launch programme.' },
    ]);
    const r = await executeAiTool('u1', 'list_knowledge_terms', { workspace_id: 'ws1' });
    expect(r.result).toContain('kbe_1');
    expect(r.result).toContain('Q3 Rollout');
  });
});

describe('lookup_knowledge', () => {
  it('includes the entry_id so a lookup can be followed straight by an edit', async () => {
    userCanAccessWorkspaceMock.mockResolvedValue(true);
    lookupTermMock.mockResolvedValue({
      found: true,
      matchedOn: 'term',
      body: 'Runs July to September.',
      entry: { id: 'kbe_1', term: 'Q3 Rollout', entryType: 'project', summary: 'Launch programme.', aliases: [], properties: {} },
    });
    const r = await executeAiTool('u1', 'lookup_knowledge', { workspace_id: 'ws1', term: 'Q3 Rollout' });
    expect(r.ok).toBe(true);
    expect(r.result).toContain('kbe_1');
  });
});

describe('create_knowledge_entry', () => {
  it('points at create_knowledge_base when the workspace has none — never at the sidebar', async () => {
    asMember(true);
    getBaseForWorkspaceMock.mockResolvedValue(null);
    const r = await executeAiTool('u1', 'create_knowledge_entry', { workspace_id: 'ws1', term: 'X' });
    expect(r.ok).toBe(false);
    expect(r.result).toContain('create_knowledge_base');
    expect(r.result).not.toContain('sidebar');
  });

  it('returns the new entry_id so the caller can immediately revise or link it', async () => {
    asMember(true);
    getBaseForWorkspaceMock.mockResolvedValue(BASE);
    createEntryMock.mockResolvedValue({ ok: true, entry: ENTRY });
    const r = await executeAiTool('u1', 'create_knowledge_entry', { workspace_id: 'ws1', term: 'Q3 Rollout' });
    expect(r.ok).toBe(true);
    expect(r.result).toContain('kbe_1');
  });

  it('splits a body into one paragraph block per blank-line-separated chunk', async () => {
    asMember(true);
    getBaseForWorkspaceMock.mockResolvedValue(BASE);
    createEntryMock.mockResolvedValue({ ok: true, entry: ENTRY });
    await executeAiTool('u1', 'create_knowledge_entry', {
      workspace_id: 'ws1', term: 'Q3 Rollout', body: 'First para.\n\nSecond para.',
    });
    const content = createEntryMock.mock.calls[0][2].content as { blocks: Array<{ type: string; text: string }> };
    expect(content.blocks).toHaveLength(2);
    expect(content.blocks[1]).toMatchObject({ type: 'paragraph', text: 'Second para.' });
  });
});

describe('update_knowledge_entry', () => {
  beforeEach(() => {
    getEntryMock.mockResolvedValue(ENTRY);
    getBaseByIdMock.mockResolvedValue(BASE);
    asMember(true);
    updateEntryMock.mockResolvedValue({ ok: true, entry: ENTRY });
    mutateEntryBlocksMock.mockResolvedValue({ ok: true, entry: ENTRY });
  });

  it('rewrites the body through mutateEntryBlocks, so an AI edit runs the same pipeline a human edit does', async () => {
    const r = await executeAiTool('u1', 'update_knowledge_entry', {
      entry_id: 'kbe_1', body: 'Revised definition.\n\nWith a second paragraph.',
    });
    expect(r.ok).toBe(true);
    expect(mutateEntryBlocksMock).toHaveBeenCalledTimes(1);
    const mutate = mutateEntryBlocksMock.mock.calls[0][3] as (b: unknown[]) => Array<{ type: string; text: string }>;
    const blocks = mutate([]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'paragraph', text: 'Revised definition.' });
  });

  it('treats an empty body as an explicit clear, not as "field omitted"', async () => {
    const r = await executeAiTool('u1', 'update_knowledge_entry', { entry_id: 'kbe_1', body: '' });
    expect(r.ok).toBe(true);
    expect(r.result).toContain('cleared');
    const mutate = mutateEntryBlocksMock.mock.calls[0][3] as (b: unknown[]) => unknown[];
    expect(mutate([])).toHaveLength(0);
  });

  it('leaves the body untouched when the field is omitted', async () => {
    const r = await executeAiTool('u1', 'update_knowledge_entry', { entry_id: 'kbe_1', summary: 'New summary.' });
    expect(r.ok).toBe(true);
    expect(mutateEntryBlocksMock).not.toHaveBeenCalled();
  });

  it('surfaces a body-write failure instead of reporting a partial success', async () => {
    mutateEntryBlocksMock.mockResolvedValue({ ok: false, error: 'Entry not found' });
    const r = await executeAiTool('u1', 'update_knowledge_entry', { entry_id: 'kbe_1', body: 'x' });
    expect(r.ok).toBe(false);
    expect(r.result).toContain('Entry not found');
  });

  it('reports an entry in an unreachable workspace as absent, never as forbidden', async () => {
    asMember(false);
    const r = await executeAiTool('u1', 'update_knowledge_entry', { entry_id: 'kbe_1', summary: 'x' });
    expect(r.ok).toBe(false);
    expect(r.result).toContain('entry not found');
    expect(updateEntryMock).not.toHaveBeenCalled();
  });
});
