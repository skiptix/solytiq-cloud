import { describe, expect, it, vi, beforeEach } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('../db', () => ({ query: (...args: unknown[]) => queryMock(...args) }));

const userCanAccessWorkspaceMock = vi.hoisted(() => vi.fn());
vi.mock('../workspaceUtil', () => ({ userCanAccessWorkspace: (...args: unknown[]) => userCanAccessWorkspaceMock(...args) }));

const getEntityIndexEntryMock = vi.hoisted(() => vi.fn());
vi.mock('../graph/entityIndex', () => ({ getEntityIndexEntry: (...args: unknown[]) => getEntityIndexEntryMock(...args) }));

vi.mock('../graph/visibility', () => ({ visibleCondition: (alias: string, idx: number) => `${alias}.visible_stub_${idx}` }));

const getQueueStatsMock = vi.hoisted(() => vi.fn());
vi.mock('../knowledge/queue', () => ({ getQueueStats: () => getQueueStatsMock() }));

let pgvectorAvailable = false;
vi.mock('../knowledge/state', () => ({ isPgvectorAvailable: () => pgvectorAvailable }));

const getEmbeddingConfigMock = vi.hoisted(() => vi.fn());
vi.mock('../knowledge/embedProvider', () => ({ getEmbeddingConfig: (...args: unknown[]) => getEmbeddingConfigMock(...args) }));

import { readMcpResource, MCP_STATIC_RESOURCES, MCP_RESOURCE_TEMPLATES } from '../mcpResources';

function rows(r: unknown[]) {
  return { rows: r, rowCount: r.length };
}

describe('MCP_STATIC_RESOURCES / MCP_RESOURCE_TEMPLATES', () => {
  it('every static resource and template has a unique URI/URI-template', () => {
    expect(new Set(MCP_STATIC_RESOURCES.map((r) => r.uri)).size).toBe(MCP_STATIC_RESOURCES.length);
    expect(new Set(MCP_RESOURCE_TEMPLATES.map((r) => r.uriTemplate)).size).toBe(MCP_RESOURCE_TEMPLATES.length);
  });
});

describe('readMcpResource', () => {
  beforeEach(() => {
    queryMock.mockReset();
    userCanAccessWorkspaceMock.mockReset();
    getEntityIndexEntryMock.mockReset();
    getQueueStatsMock.mockReset();
    getEmbeddingConfigMock.mockReset();
    pgvectorAvailable = false;
  });

  it('returns null for a completely unrecognized URI', async () => {
    expect(await readMcpResource('user-1', 'solytiq://not-a-thing')).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('solytiq://workspaces returns the caller\'s own workspace list as JSON', async () => {
    queryMock.mockResolvedValueOnce(rows([{ id: 'ws_1', name: 'Personal', visibility: 'private', owner_id: 'user-1', agent_mode: 'off' }]));
    const res = await readMcpResource('user-1', 'solytiq://workspaces');
    expect(res?.mimeType).toBe('application/json');
    expect(JSON.parse(res!.text)).toEqual([{ id: 'ws_1', name: 'Personal', visibility: 'private', isOwner: true, agentMode: 'off' }]);
  });

  it('solytiq://knowledge/status reports pgvector/provider/queue state', async () => {
    pgvectorAvailable = true;
    queryMock.mockResolvedValueOnce(rows([{ key: 'knowledge_search_enabled', value: 'true' }]));
    getEmbeddingConfigMock.mockReturnValue({ baseUrl: 'x', apiKey: 'x', model: 'x' });
    getQueueStatsMock.mockResolvedValue({ pending: 1, processing: 0, done: 5, failed: 0, skippedBudget: 0 });
    const res = await readMcpResource('user-1', 'solytiq://knowledge/status');
    const parsed = JSON.parse(res!.text);
    expect(parsed).toEqual({ pgvectorAvailable: true, providerConfigured: true, searchEnabled: true, queue: { pending: 1, processing: 0, done: 5, failed: 0, skippedBudget: 0 } });
  });

  it('solytiq://entity/{type}/{id} rejects an invalid entity type without touching the database', async () => {
    expect(await readMcpResource('user-1', 'solytiq://entity/bogus/123')).toBeNull();
    expect(getEntityIndexEntryMock).not.toHaveBeenCalled();
  });

  it('solytiq://entity/{type}/{id} returns null (not a 500) when the entity is invisible/missing', async () => {
    getEntityIndexEntryMock.mockResolvedValue(null);
    expect(await readMcpResource('user-1', 'solytiq://entity/task/999')).toBeNull();
  });

  it('solytiq://entity/{type}/{id} returns the resolved entity as JSON', async () => {
    getEntityIndexEntryMock.mockResolvedValue({ srn: 'srn:task:1', entityType: 'task', entityId: '1', title: 'Buy milk' });
    const res = await readMcpResource('user-1', 'solytiq://entity/task/1');
    expect(getEntityIndexEntryMock).toHaveBeenCalledWith('user-1', 'task', '1');
    expect(JSON.parse(res!.text).title).toBe('Buy milk');
  });

  it('solytiq://graph/{workspaceId} 404s (returns null) when the caller cannot access the workspace', async () => {
    userCanAccessWorkspaceMock.mockResolvedValue(false);
    expect(await readMcpResource('user-1', 'solytiq://graph/ws_1')).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('solytiq://graph/{workspaceId} only includes edges whose BOTH endpoints are in the returned node set', async () => {
    userCanAccessWorkspaceMock.mockResolvedValue(true);
    queryMock
      .mockResolvedValueOnce(rows([{ entity_type: 'task', entity_id: '1', title: 'A', deep_link: '/dashboard' }])) // nodes
      .mockResolvedValueOnce(rows([
        { id: 'lnk_1', src_type: 'task', src_id: '1', dst_type: 'list', dst_id: 'list_1', link_type: 'links_to', origin: 'manual' }, // dst not in node set
      ])); // edges
    const res = await readMcpResource('user-1', 'solytiq://graph/ws_1');
    const parsed = JSON.parse(res!.text);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.edges).toHaveLength(0);
  });

  it('solytiq://agent/{workspaceId}/runs 404s when the caller cannot access the workspace', async () => {
    userCanAccessWorkspaceMock.mockResolvedValue(false);
    expect(await readMcpResource('user-1', 'solytiq://agent/ws_1/runs')).toBeNull();
  });

  it('solytiq://agent/{workspaceId}/runs returns the run list as JSON', async () => {
    userCanAccessWorkspaceMock.mockResolvedValue(true);
    queryMock.mockResolvedValueOnce(rows([{ id: 'agrun_1', goal: 'do stuff', status: 'success', mode: 'autonomous', started_at: 't', finished_at: 't' }]));
    const res = await readMcpResource('user-1', 'solytiq://agent/ws_1/runs');
    expect(JSON.parse(res!.text)).toHaveLength(1);
  });
});
