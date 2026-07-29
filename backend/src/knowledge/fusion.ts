// ---------------------------------------------------------------------------
// Pure ranking-fusion helpers for hybrid (lexical + vector) search. No DB, no
// HTTP — knowledge/search.ts supplies the ranked lists and consumes the
// fused result.
// ---------------------------------------------------------------------------

export interface RankedItem {
  key: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion — combine N independently-ranked lists (e.g. a
 * trigram-lexical ranking and a pgvector cosine-similarity ranking) into one
 * score per key, using each item's RANK POSITION rather than its raw score
 * (scores from different retrieval methods aren't on comparable scales; rank
 * position is). `k` is RRF's standard smoothing constant — 60 is the
 * conventional default from the original paper and most hybrid-search
 * implementations.
 */
export function reciprocalRankFusion(rankings: RankedItem[][], k = 60): Map<string, number> {
  const fused = new Map<string, number>();
  for (const ranking of rankings) {
    const sorted = [...ranking].sort((a, b) => b.score - a.score);
    sorted.forEach((item, i) => {
      const contribution = 1 / (k + i + 1);
      fused.set(item.key, (fused.get(item.key) ?? 0) + contribution);
    });
  }
  return fused;
}

/**
 * Nudge fused scores toward well-connected entities (higher PageRank from the
 * Graph Layer — see graph/metrics.ts) — a document referenced from many
 * places is more likely to be the canonical answer than an orphaned one with
 * an equally good text match. `weight` caps the boost's influence relative to
 * retrieval relevance, which must always dominate: this is a tie-breaker, not
 * a replacement for search quality.
 */
export function applyGraphBoost(
  fused: Map<string, number>,
  pagerankByKey: Map<string, number>,
  weight = 0.15
): Map<string, number> {
  const boosted = new Map<string, number>();
  for (const [key, score] of fused) {
    const pr = pagerankByKey.get(key) ?? 0;
    boosted.set(key, score * (1 + weight * pr));
  }
  return boosted;
}

/** Sort a fused score map into a ranked array, highest first. */
export function rankByScore(scores: Map<string, number>): RankedItem[] {
  return [...scores.entries()].map(([key, score]) => ({ key, score })).sort((a, b) => b.score - a.score);
}
