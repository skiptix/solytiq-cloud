import { describe, expect, it, vi, beforeEach } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn(async () => ({ rows: [], rowCount: 0 })));
vi.mock('../db', () => ({ query: (...args: unknown[]) => queryMock(...args), withTransaction: vi.fn() }));
vi.mock('../sse', () => ({ broadcastToUser: vi.fn() }));

const isEntityVisibleMock = vi.hoisted(() => vi.fn());
const canWriteEntityMock = vi.hoisted(() => vi.fn());
vi.mock('../graph/visibility', () => ({
  isEntityVisible: (...args: unknown[]) => isEntityVisibleMock(...args),
  canWriteEntity: (...args: unknown[]) => canWriteEntityMock(...args),
}));

const searchEntityIndexMock = vi.hoisted(() => vi.fn());
vi.mock('../graph/entityIndex', () => ({ searchEntityIndex: (...args: unknown[]) => searchEntityIndexMock(...args) }));

const upsertLinkMock = vi.hoisted(() => vi.fn());
const deleteLinkMock = vi.hoisted(() => vi.fn());
const getLinkByIdMock = vi.hoisted(() => vi.fn());
const getEntityLinksMock = vi.hoisted(() => vi.fn());
const getBacklinksMock = vi.hoisted(() => vi.fn());
const findUnlinkedMentionsMock = vi.hoisted(() => vi.fn());
vi.mock('../graph/links', async () => {
  const actual = await vi.importActual<typeof import('../graph/links')>('../graph/links');
  return {
    ...actual,
    upsertLink: (...args: unknown[]) => upsertLinkMock(...args),
    deleteLink: (...args: unknown[]) => deleteLinkMock(...args),
    getLinkById: (...args: unknown[]) => getLinkByIdMock(...args),
    getEntityLinks: (...args: unknown[]) => getEntityLinksMock(...args),
    getBacklinks: (...args: unknown[]) => getBacklinksMock(...args),
    findUnlinkedMentions: (...args: unknown[]) => findUnlinkedMentionsMock(...args),
  };
});

const userCanAccessWorkspaceMock = vi.hoisted(() => vi.fn());
vi.mock('../workspaceUtil', async () => {
  const actual = await vi.importActual<typeof import('../workspaceUtil')>('../workspaceUtil');
  return { ...actual, userCanAccessWorkspace: (...args: unknown[]) => userCanAccessWorkspaceMock(...args) };
});

const startAgentRunMock = vi.hoisted(() => vi.fn());
vi.mock('../agent/runtime', () => ({ startAgentRun: (...args: unknown[]) => startAgentRunMock(...args) }));

import { executeAiTool, getOpenRouterToolDefs, getMcpToolDefs } from '../aiTools';

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  isEntityVisibleMock.mockReset();
  canWriteEntityMock.mockReset();
  searchEntityIndexMock.mockReset();
  upsertLinkMock.mockReset();
  deleteLinkMock.mockReset();
  getLinkByIdMock.mockReset();
  getEntityLinksMock.mockReset();
  getBacklinksMock.mockReset();
  findUnlinkedMentionsMock.mockReset();
  userCanAccessWorkspaceMock.mockReset();
  startAgentRunMock.mockReset();
});

describe('mcpOnly tool filtering', () => {
  it('excludes every agent-runtime meta-tool from getOpenRouterToolDefs (Sol + the agent\'s own loop)', () => {
    const names = getOpenRouterToolDefs().map((d) => d.function.name);
    for (const n of ['start_agent_run', 'get_agent_run', 'list_agent_runs', 'list_agent_proposals', 'accept_agent_proposal', 'reject_agent_proposal']) {
      expect(names).not.toContain(n);
    }
  });

  it('includes them in getMcpToolDefs (external MCP clients only)', () => {
    const names = getMcpToolDefs().map((d) => d.name);
    for (const n of ['start_agent_run', 'get_agent_run', 'list_agent_runs', 'list_agent_proposals', 'accept_agent_proposal', 'reject_agent_proposal']) {
      expect(names).toContain(n);
    }
  });

  it('the new graph/knowledge tools are available to BOTH surfaces (no recursion risk)', () => {
    const orNames = getOpenRouterToolDefs().map((d) => d.function.name);
    const mcpNames = getMcpToolDefs().map((d) => d.name);
    for (const n of ['search_graph', 'get_entity_links', 'create_link', 'knowledge_search']) {
      expect(orNames).toContain(n);
      expect(mcpNames).toContain(n);
    }
  });
});

describe('search_graph', () => {
  it('rejects an unknown entity type before ever calling the database', async () => {
    const r = await executeAiTool('u1', 'search_graph', { query: 'q', entity_types: 'task,bogus' });
    expect(r.ok).toBe(false);
    expect(searchEntityIndexMock).not.toHaveBeenCalled();
  });

  it('formats matches with their SRN', async () => {
    searchEntityIndexMock.mockResolvedValue([{ entityType: 'task', entityId: '1', title: 'Buy milk', subtitle: null }]);
    const r = await executeAiTool('u1', 'search_graph', { query: 'milk' });
    expect(r.ok).toBe(true);
    expect(r.result).toContain('srn:task:1');
    expect(r.result).toContain('Buy milk');
  });
});

describe('create_link', () => {
  it('rejects a self-referential-looking pair the same way upsertLink itself would (propagates the error)', async () => {
    isEntityVisibleMock.mockResolvedValue(true);
    canWriteEntityMock.mockResolvedValue(true);
    upsertLinkMock.mockRejectedValue(Object.assign(new Error('self loop'), { name: 'LinkError' }));
    const r = await executeAiTool('u1', 'create_link', { src_srn: 'srn:task:1', dst_srn: 'srn:task:1', link_type: 'blocks' });
    expect(r.ok).toBe(false);
  });

  it('requires write access to the SOURCE (not just visibility)', async () => {
    isEntityVisibleMock.mockResolvedValue(true);
    canWriteEntityMock.mockResolvedValue(false);
    const r = await executeAiTool('u1', 'create_link', { src_srn: 'srn:task:1', dst_srn: 'srn:list:list_1', link_type: 'links_to' });
    expect(r.ok).toBe(false);
    expect(upsertLinkMock).not.toHaveBeenCalled();
  });

  it('creates the link when the caller can write the source and see the destination', async () => {
    isEntityVisibleMock.mockResolvedValue(true);
    canWriteEntityMock.mockResolvedValue(true);
    upsertLinkMock.mockResolvedValue({ id: 'lnk_1' });
    const r = await executeAiTool('u1', 'create_link', { src_srn: 'srn:task:1', dst_srn: 'srn:list:list_1', link_type: 'links_to' });
    expect(r.ok).toBe(true);
    expect(r.result).toContain('lnk_1');
  });
});

describe('delete_link', () => {
  it('refuses to delete a system-managed link', async () => {
    getLinkByIdMock.mockResolvedValue({ id: 'lnk_1', origin: 'system', srcType: 'list', srcId: 'l1', dstType: 'task', dstId: '1' });
    const r = await executeAiTool('u1', 'delete_link', { link_id: 'lnk_1' });
    expect(r.ok).toBe(false);
    expect(deleteLinkMock).not.toHaveBeenCalled();
  });

  it('requires write access to at least one endpoint', async () => {
    getLinkByIdMock.mockResolvedValue({ id: 'lnk_1', origin: 'manual', srcType: 'task', srcId: '1', dstType: 'list', dstId: 'l1' });
    canWriteEntityMock.mockResolvedValue(false);
    const r = await executeAiTool('u1', 'delete_link', { link_id: 'lnk_1' });
    expect(r.ok).toBe(false);
    expect(deleteLinkMock).not.toHaveBeenCalled();
  });
});

describe('start_agent_run (mcpOnly)', () => {
  it('rejects a workspace the caller cannot access, without ever starting a run', async () => {
    userCanAccessWorkspaceMock.mockResolvedValue(false);
    const r = await executeAiTool('u1', 'start_agent_run', { workspace_id: 'ws_1', goal: 'do stuff' });
    expect(r.ok).toBe(false);
    expect(startAgentRunMock).not.toHaveBeenCalled();
  });

  it('starts a run and reports its id + mode', async () => {
    userCanAccessWorkspaceMock.mockResolvedValue(true);
    startAgentRunMock.mockResolvedValue({ runId: 'agrun_1', mode: 'suggest' });
    const r = await executeAiTool('u1', 'start_agent_run', { workspace_id: 'ws_1', goal: 'do stuff' });
    expect(r.ok).toBe(true);
    expect(r.result).toContain('agrun_1');
    expect(r.result).toContain('suggest');
  });

  it('surfaces a "turned off" error from startAgentRun as a failed ToolResult, not a thrown exception', async () => {
    userCanAccessWorkspaceMock.mockResolvedValue(true);
    startAgentRunMock.mockRejectedValue(new Error('The agent is turned off for this workspace'));
    const r = await executeAiTool('u1', 'start_agent_run', { workspace_id: 'ws_1', goal: 'do stuff' });
    expect(r.ok).toBe(false);
    expect(r.result).toContain('turned off');
  });
});

describe('accept_agent_proposal (mcpOnly)', () => {
  it('rejects a proposal in a workspace the caller cannot access', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ workspace_id: 'ws_1', run_id: 'agrun_1', tool_name: 'create_task', tool_args: {}, status: 'pending' }] });
    userCanAccessWorkspaceMock.mockResolvedValue(false);
    const r = await executeAiTool('u1', 'accept_agent_proposal', { proposal_id: 'agprop_1' });
    expect(r.ok).toBe(false);
  });

  it('rejects a proposal that already has a decision', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ workspace_id: 'ws_1', run_id: 'agrun_1', tool_name: 'create_task', tool_args: {}, status: 'rejected' }] });
    userCanAccessWorkspaceMock.mockResolvedValue(true);
    const r = await executeAiTool('u1', 'accept_agent_proposal', { proposal_id: 'agprop_1' });
    expect(r.ok).toBe(false);
    expect(r.result).toContain('rejected');
  });
});
