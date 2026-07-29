// ---------------------------------------------------------------------------
// Hybrid knowledge search — trigram-lexical + pgvector-cosine retrieval,
// combined with Reciprocal Rank Fusion and a PageRank-based graph boost (see
// fusion.ts), scoped through the SAME visibility boundary as every other
// Graph Layer read (graph/visibility.ts's visibleCondition). Never queries
// entity_chunks without joining through entity_index + visibleCondition — an
// entity the caller can't see must never surface a chunk here either.
// ---------------------------------------------------------------------------

import { query } from '../db';
import type { QueryExec } from '../workspaceUtil';
import { visibleCondition } from '../graph/visibility';
import { resolveRefs, type EntityIndexEntry } from '../graph/entityIndex';
import { isPgvectorAvailable } from './state';
import { getEmbeddingConfig, embedTexts, toVectorLiteral, type KnowledgeAppSettings } from './embedProvider';
import { reciprocalRankFusion, applyGraphBoost, rankByScore, type RankedItem } from './fusion';

export interface KnowledgeSearchOptions {
  entityTypes?: string[];
  workspaceId?: string;
  limit?: number;
}

export interface KnowledgeSearchHit {
  entity: EntityIndexEntry;
  chunkContent: string;
  chunkIndex: number;
  score: number;
}

interface ChunkCandidateRow {
  entity_type: string;
  entity_id: string;
  chunk_index: number;
  content: string;
}

function chunkKey(entityType: string, entityId: string, chunkIndex: number): string {
  return `${entityType}:${entityId}:${chunkIndex}`;
}

export async function hybridSearch(
  userId: string,
  q: string,
  settings: KnowledgeAppSettings,
  opts: KnowledgeSearchOptions = {},
  exec: QueryExec = query
): Promise<KnowledgeSearchHit[]> {
  const trimmed = q.trim();
  if (trimmed.length < 2) return [];
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const poolSize = limit * 4;

  const params: unknown[] = [trimmed, userId];
  let filter = '';
  if (opts.entityTypes?.length) { params.push(opts.entityTypes); filter += ` AND c.entity_type = ANY($${params.length}::text[])`; }
  if (opts.workspaceId) { params.push(opts.workspaceId); filter += ` AND c.workspace_id = $${params.length}`; }
  params.push(poolSize);

  const chunksByKey = new Map<string, ChunkCandidateRow>();
  const rankings: RankedItem[][] = [];

  // 1. Lexical ranking — pg_trgm similarity over chunk text.
  const lexicalRes = await exec(
    `SELECT c.entity_type, c.entity_id, c.chunk_index, c.content, similarity(c.content, $1) AS sim
       FROM entity_chunks c
       JOIN entity_index e ON e.entity_type = c.entity_type AND e.entity_id = c.entity_id
      WHERE ${visibleCondition('e', 2)} AND c.content % $1 ${filter}
      ORDER BY sim DESC LIMIT $${params.length}`,
    params
  );
  const lexicalRanking: RankedItem[] = [];
  for (const row of lexicalRes.rows as Array<ChunkCandidateRow & { sim: number }>) {
    const key = chunkKey(row.entity_type, row.entity_id, row.chunk_index);
    chunksByKey.set(key, row);
    lexicalRanking.push({ key, score: row.sim });
  }
  rankings.push(lexicalRanking);

  // 2. Vector ranking — only when pgvector is installed AND an embedding
  // provider is configured (both are optional; this is graceful degradation,
  // never an error). Embeds the query itself with the same provider/model
  // used to embed chunks, so they live in the same vector space.
  if (isPgvectorAvailable()) {
    const config = getEmbeddingConfig(settings);
    if (config) {
      try {
        const [queryVector] = await embedTexts([trimmed], config);
        if (queryVector) {
          const vParams: unknown[] = [toVectorLiteral(queryVector), userId];
          let vFilter = '';
          if (opts.entityTypes?.length) { vParams.push(opts.entityTypes); vFilter += ` AND c.entity_type = ANY($${vParams.length}::text[])`; }
          if (opts.workspaceId) { vParams.push(opts.workspaceId); vFilter += ` AND c.workspace_id = $${vParams.length}`; }
          vParams.push(poolSize);
          const vectorRes = await exec(
            `SELECT c.entity_type, c.entity_id, c.chunk_index, c.content, 1 - (c.embedding <=> $1::vector) AS sim
               FROM entity_chunks c
               JOIN entity_index e ON e.entity_type = c.entity_type AND e.entity_id = c.entity_id
              WHERE ${visibleCondition('e', 2)} AND c.embedding IS NOT NULL ${vFilter}
              ORDER BY c.embedding <=> $1::vector LIMIT $${vParams.length}`,
            vParams
          );
          const vectorRanking: RankedItem[] = [];
          for (const row of vectorRes.rows as Array<ChunkCandidateRow & { sim: number }>) {
            const key = chunkKey(row.entity_type, row.entity_id, row.chunk_index);
            chunksByKey.set(key, row);
            vectorRanking.push({ key, score: row.sim });
          }
          rankings.push(vectorRanking);
        }
      } catch (err) {
        // A provider outage degrades to lexical-only rather than failing the whole search.
        console.error('📚 ✗ vector search leg failed, falling back to lexical-only:', err);
      }
    }
  }

  if (chunksByKey.size === 0) return [];

  let fused = reciprocalRankFusion(rankings);

  // 3. Graph boost — PageRank per entity, from the same entity_graph_metrics
  // table the Explore/Canvas graph UI already computes (graph/metrics.ts).
  const entityRows = [...new Map([...chunksByKey.values()].map((r) => [`${r.entity_type}:${r.entity_id}`, r])).values()];
  if (entityRows.length > 0) {
    const metricsRes = await exec(
      `SELECT m.entity_type, m.entity_id, m.pagerank FROM entity_graph_metrics m
         JOIN unnest($1::text[], $2::text[]) AS want(entity_type, entity_id)
           ON m.entity_type = want.entity_type AND m.entity_id = want.entity_id`,
      [entityRows.map((r) => r.entity_type), entityRows.map((r) => r.entity_id)]
    );
    const pagerankByEntity = new Map<string, number>();
    for (const row of metricsRes.rows as Array<{ entity_type: string; entity_id: string; pagerank: number }>) {
      pagerankByEntity.set(`${row.entity_type}:${row.entity_id}`, row.pagerank);
    }
    const pagerankByChunkKey = new Map<string, number>();
    for (const [key, row] of chunksByKey) pagerankByChunkKey.set(key, pagerankByEntity.get(`${row.entity_type}:${row.entity_id}`) ?? 0);
    fused = applyGraphBoost(fused, pagerankByChunkKey);
  }

  const ranked = rankByScore(fused);

  // 4. Collapse to the best chunk per entity (a search result is one row per
  // document, not per chunk) and resolve to live, visibility-checked
  // entity_index entries.
  const bestPerEntity = new Map<string, { key: string; score: number }>();
  for (const item of ranked) {
    const row = chunksByKey.get(item.key)!;
    const entityKey = `${row.entity_type}:${row.entity_id}`;
    if (!bestPerEntity.has(entityKey)) bestPerEntity.set(entityKey, item);
  }
  const topEntities = [...bestPerEntity.values()].slice(0, limit);
  const refs = topEntities.map((t) => {
    const row = chunksByKey.get(t.key)!;
    return { entityType: row.entity_type, entityId: row.entity_id };
  });
  const resolved = await resolveRefs(userId, refs, exec);

  const hits: KnowledgeSearchHit[] = [];
  for (const t of topEntities) {
    const row = chunksByKey.get(t.key)!;
    const entity = resolved.get(`${row.entity_type}:${row.entity_id}`);
    if (!entity) continue; // resolved out by visibility since the candidate query ran — treat like "not found"
    hits.push({ entity, chunkContent: row.content, chunkIndex: row.chunk_index, score: t.score });
  }
  return hits;
}
