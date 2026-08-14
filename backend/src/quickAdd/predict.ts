// ---------------------------------------------------------------------------
// Quick Add — the predictor. DB retrieval + orchestration; all the actual
// scoring lives in ranking.ts (pure) so it can be tested without a database.
//
// Four retrieval channels, fused in ranking.ts:
//
//   exact    the normalized title has been placed on this board before
//   lexical  pg_trgm `similarity()` over the whole stored title
//   word     pg_trgm `word_similarity()` — matches when the query is a phrase
//            inside a longer remembered title ("login" ↔ "fix the login bug")
//   vector   pgvector cosine over the memory row's embedding
//
// The first three need nothing but pg_trgm, which this schema has always had.
// The vector channel is strictly additive: no pgvector extension, or no
// embedding provider configured, and it simply doesn't contribute — the same
// degrade-gracefully contract knowledge/search.ts holds, checked against
// reality (isPgvectorAvailable(), is a key present) rather than against a
// feature flag someone has to remember to keep in sync with the infrastructure.
// ---------------------------------------------------------------------------

import { query } from '../db';
import type { QueryExec } from '../workspaceUtil';
import { werr } from '../workspaceUtil';
import { isPgvectorAvailable } from '../knowledge/state';
import { getEmbeddingConfig, embedTexts, toVectorLiteral, type KnowledgeAppSettings } from '../knowledge/embedProvider';
import { titleKey } from './titleKey';
import { rankSections, usefulPredictions, withTokenScores, type MemoryCandidate, type SectionPrediction } from './ranking';

/** How many rows each fuzzy channel may contribute. Enough for the vote to be robust, small enough to stay cheap. */
const CHANNEL_LIMIT = 25;

/** pg_trgm floors. Below these a "match" is noise that would only dilute the vote. */
const LEXICAL_THRESHOLD = 0.22;
const WORD_THRESHOLD = 0.45;

export interface QuickAddSuggestion {
  sectionId: string;
  label: string;
  emoji: string | null;
  confidence: number;
  /** Human-readable justification shown under the chip, e.g. `"Fix login bug" went here 4×`. */
  reason: string;
}

interface MemoryDbRow {
  title_key: string;
  title: string;
  last_section_id: string;
  occurrences: number;
  last_seen_at: string;
  score: number;
}

function toCandidate(row: MemoryDbRow, channel: 'exact' | 'lexical' | 'word' | 'vector'): MemoryCandidate {
  return {
    titleKey: row.title_key,
    title: row.title,
    sectionId: row.last_section_id,
    occurrences: Number(row.occurrences),
    lastSeenAt: row.last_seen_at,
    scores: { [channel]: Number(row.score) },
  };
}

/** Merge the channels' hits, keeping ONE candidate per memory row carrying every channel that found it. */
function mergeCandidates(groups: MemoryCandidate[][]): MemoryCandidate[] {
  const merged = new Map<string, MemoryCandidate>();
  for (const group of groups) {
    for (const candidate of group) {
      const existing = merged.get(candidate.titleKey);
      if (existing) existing.scores = { ...existing.scores, ...candidate.scores };
      else merged.set(candidate.titleKey, { ...candidate });
    }
  }
  return [...merged.values()];
}

// A small in-process cache of query embeddings. The live "hint while typing"
// path re-predicts on a debounce, so the same prefix is embedded repeatedly
// within seconds — without this, every pause in typing is a billable provider
// round trip. Bounded and insertion-ordered: oldest key evicted first.
const QUERY_EMBEDDING_CACHE = new Map<string, number[]>();
const QUERY_EMBEDDING_CACHE_MAX = 500;

function cacheQueryEmbedding(key: string, vector: number[]): void {
  if (QUERY_EMBEDDING_CACHE.size >= QUERY_EMBEDDING_CACHE_MAX) {
    const oldest = QUERY_EMBEDDING_CACHE.keys().next().value;
    if (oldest !== undefined) QUERY_EMBEDDING_CACHE.delete(oldest);
  }
  QUERY_EMBEDDING_CACHE.set(key, vector);
}

async function appSettings(exec: QueryExec): Promise<KnowledgeAppSettings> {
  const r = await exec(`SELECT key, value FROM app_settings`);
  const out: Record<string, string> = {};
  for (const row of r.rows as Array<{ key: string; value: string }>) out[row.key] = row.value;
  return out as KnowledgeAppSettings;
}

/**
 * Embed the query title, or return null when the semantic channel isn't
 * available. Never throws: a provider outage degrades the prediction to
 * lexical-only rather than failing the request the user is waiting on.
 */
async function embedQuery(key: string, title: string, exec: QueryExec): Promise<number[] | null> {
  if (!isPgvectorAvailable()) return null;
  const cached = QUERY_EMBEDDING_CACHE.get(key);
  if (cached) return cached;
  try {
    const config = getEmbeddingConfig(await appSettings(exec));
    if (!config) return null;
    const [vector] = await embedTexts([title], config);
    if (!Array.isArray(vector) || vector.length === 0) return null;
    cacheQueryEmbedding(key, vector);
    return vector;
  } catch (err) {
    werr('quickAdd query embedding failed (falling back to lexical):', err);
    return null;
  }
}

export interface PredictOptions {
  /** Skip the provider round trip — used by the live while-typing path, where latency matters more than the last few points of accuracy. */
  lexicalOnly?: boolean;
  limit?: number;
  now?: number;
}

/** Rank the sections of `listId` by how likely `title` belongs in each. Empty array = no usable memory. */
export async function predictSections(
  listId: string,
  title: string,
  options: PredictOptions = {},
  exec: QueryExec = query
): Promise<SectionPrediction[]> {
  const key = titleKey(title);
  if (!key) return [];

  const exactRows = exec(
    `SELECT title_key, title, last_section_id, occurrences, last_seen_at, 1.0 AS score
       FROM section_memory WHERE list_id = $1 AND title_key = $2`,
    [listId, key]
  );
  const lexicalRows = exec(
    `SELECT title_key, title, last_section_id, occurrences, last_seen_at, similarity(title_key, $2) AS score
       FROM section_memory
      WHERE list_id = $1 AND similarity(title_key, $2) > $3
      ORDER BY score DESC LIMIT $4`,
    [listId, key, LEXICAL_THRESHOLD, CHANNEL_LIMIT]
  );
  const wordRows = exec(
    `SELECT title_key, title, last_section_id, occurrences, last_seen_at, word_similarity($2, title_key) AS score
       FROM section_memory
      WHERE list_id = $1 AND word_similarity($2, title_key) > $3
      ORDER BY score DESC LIMIT $4`,
    [listId, key, WORD_THRESHOLD, CHANNEL_LIMIT]
  );

  const [exact, lexical, word] = await Promise.all([exactRows, lexicalRows, wordRows]);

  const groups: MemoryCandidate[][] = [
    (exact.rows as MemoryDbRow[]).map((r) => toCandidate(r, 'exact')),
    (lexical.rows as MemoryDbRow[]).map((r) => toCandidate(r, 'lexical')),
    (word.rows as MemoryDbRow[]).map((r) => toCandidate(r, 'word')),
  ];

  if (!options.lexicalOnly) {
    const vector = await embedQuery(key, title, exec);
    if (vector) {
      try {
        // 1 - cosine distance, so a higher score is a better match in every
        // channel and ranking.ts never has to know which way a channel sorts.
        const vectorRows = await exec(
          `SELECT title_key, title, last_section_id, occurrences, last_seen_at,
                  1 - (embedding <=> $2::vector) AS score
             FROM section_memory
            WHERE list_id = $1 AND embedding IS NOT NULL
            ORDER BY embedding <=> $2::vector LIMIT $3`,
          [listId, toVectorLiteral(vector), CHANNEL_LIMIT]
        );
        groups.push((vectorRows.rows as MemoryDbRow[]).map((r) => toCandidate(r, 'vector')));
      } catch (err) {
        werr('quickAdd vector channel failed (falling back to lexical):', err);
      }
    }
  }

  const candidates = withTokenScores(mergeCandidates(groups), title);
  return rankSections(candidates, options.now ?? Date.now());
}

function describe(prediction: SectionPrediction): string {
  const because = prediction.because;
  if (!because) return 'Based on this board’s history';
  if (because.channel === 'exact') {
    return because.occurrences > 1
      ? `“${because.title}” went here ${because.occurrences}× before`
      : `“${because.title}” went here last time`;
  }
  return `Similar to “${because.title}”`;
}

/**
 * The full suggestion payload the API returns: predictions joined to their
 * sections' current label/emoji, with anything below the confidence floor
 * dropped. A section that has since been deleted simply falls out of the join.
 */
export async function suggestSections(
  listId: string,
  title: string,
  options: PredictOptions = {},
  exec: QueryExec = query
): Promise<QuickAddSuggestion[]> {
  const ranked = usefulPredictions(await predictSections(listId, title, options, exec), options.limit ?? 3);
  if (ranked.length === 0) return [];

  const sections = await exec(
    `SELECT id, label, emoji FROM sections WHERE id = ANY($1::varchar[]) AND list_id = $2`,
    [ranked.map((p) => p.sectionId), listId]
  );
  const byId = new Map((sections.rows as Array<{ id: string; label: string; emoji: string | null }>).map((s) => [s.id, s]));

  return ranked.flatMap((prediction) => {
    const section = byId.get(prediction.sectionId);
    if (!section) return [];
    return [{
      sectionId: section.id,
      label: section.label,
      emoji: section.emoji,
      confidence: Number(prediction.confidence.toFixed(3)),
      reason: describe(prediction),
    }];
  });
}
