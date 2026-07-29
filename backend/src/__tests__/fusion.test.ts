import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion, applyGraphBoost, rankByScore } from '../knowledge/fusion';

describe('reciprocalRankFusion', () => {
  it('a single ranking is preserved in order', () => {
    const fused = reciprocalRankFusion([[{ key: 'a', score: 0.9 }, { key: 'b', score: 0.5 }]]);
    expect(rankByScore(fused).map((r) => r.key)).toEqual(['a', 'b']);
  });

  it('an item ranked highly in BOTH lists outranks one that only appears in one', () => {
    const lexical = [{ key: 'a', score: 0.9 }, { key: 'b', score: 0.85 }];
    const vector = [{ key: 'b', score: 0.95 }, { key: 'a', score: 0.4 }];
    const fused = reciprocalRankFusion([lexical, vector]);
    const ranked = rankByScore(fused);
    // b is rank 1 in vector and rank 2 in lexical → higher combined RRF score than a (rank 1 lexical, rank 2 vector — same positions, symmetric case), but the real point: an item present in only one list never beats one present, even modestly, in both.
    const onlyInOne = reciprocalRankFusion([[{ key: 'c', score: 0.99 }], []]);
    expect(rankByScore(onlyInOne)[0].score).toBeLessThan(ranked[0].score);
  });

  it('ignores raw score magnitude — only rank position matters', () => {
    const listA = [{ key: 'x', score: 1000 }, { key: 'y', score: 999 }];
    const listB = [{ key: 'x', score: 0.001 }, { key: 'y', score: 0.0009 }];
    const fusedA = rankByScore(reciprocalRankFusion([listA]));
    const fusedB = rankByScore(reciprocalRankFusion([listB]));
    expect(fusedA.map((r) => r.key)).toEqual(fusedB.map((r) => r.key));
  });

  it('sums contributions across all supplied rankings, not just the last one', () => {
    const fused = reciprocalRankFusion([
      [{ key: 'a', score: 1 }],
      [{ key: 'a', score: 1 }],
      [{ key: 'a', score: 1 }],
    ]);
    const single = reciprocalRankFusion([[{ key: 'a', score: 1 }]]);
    expect(fused.get('a')!).toBeCloseTo(3 * single.get('a')!, 10);
  });

  it('an empty set of rankings fuses to an empty map', () => {
    expect(reciprocalRankFusion([]).size).toBe(0);
    expect(reciprocalRankFusion([[]]).size).toBe(0);
  });
});

describe('applyGraphBoost', () => {
  it('boosts a well-connected entity above an equally-scored orphan', () => {
    const fused = new Map([['a', 0.5], ['b', 0.5]]);
    const boosted = applyGraphBoost(fused, new Map([['a', 10], ['b', 0]]));
    expect(boosted.get('a')!).toBeGreaterThan(boosted.get('b')!);
  });

  it('a realistic pagerank spread (0-1, as recomputeWorkspacePagerank actually produces) never flips a real relevance gap at the default weight', () => {
    const fused = new Map([['strong', 1.0], ['weak', 0.1]]);
    // pagerank is a normalized distribution over one workspace's nodes (sums to
    // 1) — even the maximum possible value (a single dominant hub) shouldn't
    // let a weak match outrank a strong one at the default 0.15 weight.
    const boosted = applyGraphBoost(fused, new Map([['weak', 1], ['strong', 0]]));
    expect(boosted.get('strong')!).toBeGreaterThan(boosted.get('weak')!);
  });

  it('is a no-op multiplier (x1) for an entity with zero pagerank / not in the map', () => {
    const fused = new Map([['a', 0.42]]);
    const boosted = applyGraphBoost(fused, new Map());
    expect(boosted.get('a')).toBeCloseTo(0.42, 10);
  });
});

describe('rankByScore', () => {
  it('sorts descending by score', () => {
    const ranked = rankByScore(new Map([['low', 0.1], ['high', 0.9], ['mid', 0.5]]));
    expect(ranked.map((r) => r.key)).toEqual(['high', 'mid', 'low']);
  });
});
