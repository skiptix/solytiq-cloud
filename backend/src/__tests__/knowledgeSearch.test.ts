import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { QueryExec } from '../workspaceUtil';

const resolveRefsMock = vi.fn();
vi.mock('../graph/entityIndex', () => ({ resolveRefs: (...args: unknown[]) => resolveRefsMock(...args) }));

const embedTextsMock = vi.fn();
vi.mock('../knowledge/embedProvider', async () => {
  const actual = await vi.importActual<typeof import('../knowledge/embedProvider')>('../knowledge/embedProvider');
  return { ...actual, embedTexts: (...args: unknown[]) => embedTextsMock(...args) };
});

import { hybridSearch } from '../knowledge/search';
import { setPgvectorAvailable } from '../knowledge/state';

function makeExec(rowsByCall: unknown[][] = []) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const exec = vi.fn(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    const rows = rowsByCall.shift() ?? [];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }) as unknown as QueryExec;
  return { exec, calls };
}

const ENTRY = {
  srn: 'srn:task:1', entityType: 'task', entityId: '1', workspaceId: 'ws_1', ownerId: 'user-1',
  title: 'Buy milk', emoji: null, color: null, subtitle: null, status: null, isArchived: false,
  isTrashed: false, deepLink: '/dashboard', createdAt: null, updatedAt: null,
};

describe('hybridSearch', () => {
  beforeEach(() => {
    resolveRefsMock.mockReset();
    embedTextsMock.mockReset();
    setPgvectorAvailable(false);
    process.env.EMBEDDING_API_KEY = 'test-key';
  });

  it('returns [] without touching the database for a too-short query', async () => {
    const { exec, calls } = makeExec();
    const hits = await hybridSearch('user-1', 'a', {}, {}, exec);
    expect(hits).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('lexical-only path (pgvector unavailable): runs the trigram query, skips the vector leg entirely, and resolves hits through visibility', async () => {
    setPgvectorAvailable(false);
    const { exec, calls } = makeExec([
      [{ entity_type: 'task', entity_id: '1', chunk_index: 0, content: 'remember to buy milk', sim: 0.8 }], // lexical
      [{ entity_type: 'task', entity_id: '1', pagerank: 0.2 }], // graph metrics
    ]);
    resolveRefsMock.mockResolvedValue(new Map([['task:1', ENTRY]]));

    const hits = await hybridSearch('user-1', 'milk', {}, {}, exec);

    expect(embedTextsMock).not.toHaveBeenCalled();
    expect(hits).toHaveLength(1);
    expect(hits[0].entity).toEqual(ENTRY);
    expect(hits[0].chunkContent).toBe('remember to buy milk');
    expect(calls[0].text).toContain('similarity(c.content, $1)');
    expect(calls[0].text).toContain('entity_index e');
  });

  it('drops a candidate chunk whose entity resolveRefs could not resolve (invisible / deleted) rather than surfacing it', async () => {
    setPgvectorAvailable(false);
    const { exec } = makeExec([
      [{ entity_type: 'task', entity_id: '1', chunk_index: 0, content: 'secret', sim: 0.9 }],
      [], // no graph metrics rows
    ]);
    resolveRefsMock.mockResolvedValue(new Map()); // resolveRefs found nothing visible
    const hits = await hybridSearch('user-1', 'secret', {}, {}, exec);
    expect(hits).toEqual([]);
  });

  it('vector path: embeds the query and fuses it with the lexical ranking when pgvector + a provider are both available', async () => {
    setPgvectorAvailable(true);
    embedTextsMock.mockResolvedValue([[0.1, 0.2, 0.3]]);
    const { exec } = makeExec([
      [{ entity_type: 'task', entity_id: '1', chunk_index: 0, content: 'buy milk', sim: 0.5 }],   // lexical
      [{ entity_type: 'task', entity_id: '1', chunk_index: 0, content: 'buy milk', sim: 0.95 }],  // vector
      [{ entity_type: 'task', entity_id: '1', pagerank: 0 }],                                     // graph metrics
    ]);
    resolveRefsMock.mockResolvedValue(new Map([['task:1', ENTRY]]));

    const hits = await hybridSearch('user-1', 'milk', { embedding_model: 'test-model' }, {}, exec);
    expect(embedTextsMock).toHaveBeenCalledWith(['milk'], expect.objectContaining({ model: 'test-model' }));
    expect(hits).toHaveLength(1);
  });

  it('a vector-leg failure (provider outage) degrades to the lexical result instead of throwing', async () => {
    setPgvectorAvailable(true);
    embedTextsMock.mockRejectedValue(new Error('provider down'));
    const { exec } = makeExec([
      [{ entity_type: 'task', entity_id: '1', chunk_index: 0, content: 'buy milk', sim: 0.5 }], // lexical
      [{ entity_type: 'task', entity_id: '1', pagerank: 0 }],                                   // graph metrics
    ]);
    resolveRefsMock.mockResolvedValue(new Map([['task:1', ENTRY]]));

    const hits = await hybridSearch('user-1', 'milk', { embedding_model: 'test-model' }, {}, exec);
    expect(hits).toHaveLength(1);
  });
});
