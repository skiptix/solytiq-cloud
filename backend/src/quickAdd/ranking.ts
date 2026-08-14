// ---------------------------------------------------------------------------
// Quick Add — prediction ranking. Pure: no DB, no HTTP.
//
// predict.ts supplies the candidate memory rows retrieved by each channel
// (exact key hit, trigram similarity, word similarity, vector cosine) and this
// module turns them into a ranked list of SECTIONS with a confidence.
//
// The ranking reuses the Knowledge Layer's Reciprocal Rank Fusion
// (knowledge/fusion.ts) for exactly the reason that module's own header gives:
// the channels' raw scores aren't on comparable scales (a trigram similarity
// of 0.4 and a cosine similarity of 0.4 mean nothing alike), but their RANK
// POSITIONS are. Channel weights then express how much each channel is TRUSTED,
// which is a separate question from how it scores.
//
// Two rules this module enforces that the rest of the feature depends on:
//
//   1. It only ever sees ONE section per memory row — `MemoryCandidate.sectionId`
//      is that item's LAST known section. There is no code path here that could
//      reach an earlier placement, because earlier placements are not in the
//      projection this ranks over (see quickAdd/memory.ts).
//   2. Confidence is a share of the vote, DAMPENED by how much evidence exists.
//      One weak fuzzy match must not present as certainty just because nothing
//      competed with it.
// ---------------------------------------------------------------------------

import { reciprocalRankFusion, rankByScore, type RankedItem } from '../knowledge/fusion';
import { tokenOverlap } from './titleKey';

/** Retrieval channels, in descending order of how much they're trusted. */
export type MatchChannel = 'exact' | 'lexical' | 'word' | 'vector' | 'token';

/**
 * How much each channel contributes to the fused score. An exact
 * normalized-title hit is the ground truth this feature exists to exploit —
 * "I have literally added this item before, and it ended up in Doing" — so it
 * dominates. The fuzzy channels are corroboration, not authority.
 */
export const CHANNEL_WEIGHTS: Record<MatchChannel, number> = {
  exact: 4,
  lexical: 1,
  word: 1.1,
  vector: 1.4,
  token: 0.9,
};

/** A memory row retrieved by at least one channel. `sectionId` is its LAST section — never an earlier one. */
export interface MemoryCandidate {
  titleKey: string;
  title: string;
  sectionId: string;
  occurrences: number;
  /** ISO timestamp of the most recent placement recorded for this title. */
  lastSeenAt: string;
  /** Raw per-channel scores, only for the channels that actually retrieved it. */
  scores: Partial<Record<MatchChannel, number>>;
}

export interface SectionPrediction {
  sectionId: string;
  /** 0..1 — share of the fused vote, dampened by total evidence. */
  confidence: number;
  /** Raw fused weight behind this section, before normalization. Useful for debugging/tests. */
  score: number;
  /** The single strongest remembered item behind this prediction — shown as the suggestion's "because…". */
  because: { title: string; occurrences: number; channel: MatchChannel } | null;
}

/**
 * Half-life of a placement's relevance. A board reorganized six months ago
 * shouldn't keep voting at full strength, but old memory is still better than
 * none — hence the floor below rather than a decay to zero.
 */
const RECENCY_HALF_LIFE_DAYS = 45;
const RECENCY_FLOOR = 0.25;

/**
 * How much a match counts as EVIDENCE, as opposed to how much it counts toward
 * the score. These are separate questions and were conflated at first, with a
 * bug as the result: a single exact hit — "I added this exact item before and
 * it went to Doing", the strongest signal this feature has — was dampened to
 * below the display floor purely for being ONE row, and never surfaced.
 *
 * An exact hit saturates on its own. A fuzzy one needs corroboration before it
 * presents as confident.
 */
const CHANNEL_EVIDENCE: Record<MatchChannel, number> = {
  exact: 4,
  vector: 1.5,
  word: 1.5,
  lexical: 1,
  token: 1,
};

/** Evidence behind the winner at which confidence stops being dampened at all. */
const EVIDENCE_SATURATION = 2;

/** Below this, a suggestion is too speculative to be worth showing at all. */
export const MIN_CONFIDENCE = 0.34;

export function recencyWeight(lastSeenAt: string, now: number): number {
  const seen = Date.parse(lastSeenAt);
  if (!Number.isFinite(seen)) return RECENCY_FLOOR;
  const ageDays = Math.max(0, (now - seen) / 86_400_000);
  const decayed = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * decayed;
}

/**
 * Repetition weight. Logarithmic, not linear: an item placed in Doing 20 times
 * is more reliable than one placed there twice, but not ten times more — and a
 * linear weight lets one pathologically repeated item drown out everything else.
 */
export function occurrenceWeight(occurrences: number): number {
  return 1 + Math.log2(Math.max(1, occurrences));
}

/** Add the JS-side word-overlap score to each candidate, in place of a fifth SQL query. */
export function withTokenScores(candidates: MemoryCandidate[], queryTitle: string): MemoryCandidate[] {
  return candidates.map((c) => {
    const overlap = tokenOverlap(queryTitle, c.title);
    if (overlap <= 0) return c;
    return { ...c, scores: { ...c.scores, token: overlap } };
  });
}

/**
 * Fuse every channel's ranking into one score per memory row.
 *
 * Each channel is ranked independently and fused by RRF, then multiplied by
 * that channel's weight. A row retrieved by several channels accumulates
 * several contributions, which is what makes agreement between an exact hit
 * and a vector hit count for more than either alone.
 */
export function fuseCandidates(candidates: MemoryCandidate[]): Map<string, number> {
  const byChannel = new Map<MatchChannel, RankedItem[]>();
  for (const candidate of candidates) {
    for (const [channel, score] of Object.entries(candidate.scores) as [MatchChannel, number][]) {
      if (!Number.isFinite(score)) continue;
      const bucket = byChannel.get(channel) ?? [];
      bucket.push({ key: candidate.titleKey, score });
      byChannel.set(channel, bucket);
    }
  }

  const fused = new Map<string, number>();
  for (const [channel, ranking] of byChannel) {
    const weight = CHANNEL_WEIGHTS[channel] ?? 1;
    for (const [key, contribution] of reciprocalRankFusion([ranking])) {
      fused.set(key, (fused.get(key) ?? 0) + contribution * weight);
    }
  }
  return fused;
}

/** The channel that contributed most to a candidate, for the human-readable "because". */
function strongestChannel(candidate: MemoryCandidate): MatchChannel {
  let best: MatchChannel = 'lexical';
  let bestWeighted = -Infinity;
  for (const [channel, score] of Object.entries(candidate.scores) as [MatchChannel, number][]) {
    const weighted = (CHANNEL_WEIGHTS[channel] ?? 1) * score;
    if (weighted > bestWeighted) { bestWeighted = weighted; best = channel; }
  }
  return best;
}

/**
 * Rank sections from the fused per-row scores.
 *
 * Every row votes for exactly one section (its last), weighted by fused
 * retrieval score × recency × repetition. Confidence is the winner's share of
 * the total vote, multiplied by an evidence factor so a lone half-match reads
 * as a hint rather than a certainty.
 */
export function rankSections(
  candidates: MemoryCandidate[],
  now: number = Date.now()
): SectionPrediction[] {
  if (candidates.length === 0) return [];

  const fused = fuseCandidates(candidates);
  const byKey = new Map(candidates.map((c) => [c.titleKey, c]));

  const sectionScore = new Map<string, number>();
  const sectionEvidence = new Map<string, number>();
  const sectionBest = new Map<string, { weighted: number; candidate: MemoryCandidate }>();

  for (const { key, score } of rankByScore(fused)) {
    const candidate = byKey.get(key);
    if (!candidate) continue;
    const weighted = score * recencyWeight(candidate.lastSeenAt, now) * occurrenceWeight(candidate.occurrences);
    sectionScore.set(candidate.sectionId, (sectionScore.get(candidate.sectionId) ?? 0) + weighted);
    sectionEvidence.set(
      candidate.sectionId,
      (sectionEvidence.get(candidate.sectionId) ?? 0) + candidate.occurrences * CHANNEL_EVIDENCE[strongestChannel(candidate)]
    );
    const incumbent = sectionBest.get(candidate.sectionId);
    if (!incumbent || weighted > incumbent.weighted) {
      sectionBest.set(candidate.sectionId, { weighted, candidate });
    }
  }

  const total = [...sectionScore.values()].reduce((sum, v) => sum + v, 0);
  if (total <= 0) return [];

  return [...sectionScore.entries()]
    .map(([sectionId, score]) => {
      const evidence = sectionEvidence.get(sectionId) ?? 0;
      const evidenceFactor = Math.min(1, evidence / EVIDENCE_SATURATION);
      const best = sectionBest.get(sectionId)?.candidate ?? null;
      return {
        sectionId,
        score,
        confidence: (score / total) * evidenceFactor,
        because: best
          ? { title: best.title, occurrences: best.occurrences, channel: strongestChannel(best) }
          : null,
      };
    })
    .sort((a, b) => b.confidence - a.confidence || b.score - a.score);
}

/** Drop predictions too weak to act on, and cap how many chips the UI is offered. */
export function usefulPredictions(predictions: SectionPrediction[], limit = 3): SectionPrediction[] {
  return predictions.filter((p) => p.confidence >= MIN_CONFIDENCE).slice(0, limit);
}
