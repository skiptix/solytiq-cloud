// ---------------------------------------------------------------------------
// Quick Add — title normalization, prediction ranking, and the recording rule
// that makes "only the LAST section" true.
//
// Uses the mock-QueryExec convention established by workspaceIntegrity.test.ts,
// so nothing here needs a live database. The normalization and ranking modules
// are pure and are tested directly; memory.ts is tested through a mock exec
// that records the SQL it was handed.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { normalizeTitle, titleKey, tokenize, tokenOverlap } from '../quickAdd/titleKey';
import {
  rankSections, usefulPredictions, withTokenScores, fuseCandidates,
  recencyWeight, occurrenceWeight, MIN_CONFIDENCE, type MemoryCandidate,
} from '../quickAdd/ranking';
import { recordPlacement } from '../quickAdd/memory';
import { buildBubbleBlocks } from '../quickAdd/kbBubble';
import type { QueryExec } from '../workspaceUtil';

const NOW = Date.parse('2026-08-14T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function candidate(over: Partial<MemoryCandidate> & { sectionId: string }): MemoryCandidate {
  return {
    titleKey: over.titleKey ?? over.sectionId,
    title: over.title ?? 'an item',
    occurrences: over.occurrences ?? 1,
    lastSeenAt: over.lastSeenAt ?? daysAgo(1),
    scores: over.scores ?? { exact: 1 },
    ...over,
  };
}

/** Records every statement it's handed, so a test can assert on what was written. */
function recordingExec(): QueryExec & { statements: Array<{ sql: string; params: unknown[] }> } {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const exec = (async (sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });
    return { rows: [], rowCount: 0 };
  }) as unknown as QueryExec & { statements: typeof statements };
  exec.statements = statements;
  return exec;
}

describe('titleKey normalization', () => {
  it('collapses case, punctuation and spacing so one item is one memory', () => {
    const variants = ['Fix login bug', 'fix   login   bug', 'FIX LOGIN BUG!!', '  Fix, login: bug  '];
    const keys = new Set(variants.map(titleKey));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe('fix login bug');
  });

  it('strips accents so an accented and unaccented spelling share a memory', () => {
    expect(titleKey('Rechnung fällig')).toBe(titleKey('Rechnung fallig'));
  });

  it('keeps non-latin letters rather than erasing the title', () => {
    expect(normalizeTitle('Отчёт готов')).not.toBe('');
  });

  it('returns an empty key for a title with no alphanumerics — nothing to remember it by', () => {
    expect(titleKey('!!! ??? ---')).toBe('');
    expect(titleKey('🎉')).toBe('');
  });

  it('does NOT collapse titles that differ only by a stopword — they are different items', () => {
    expect(titleKey('call the client')).not.toBe(titleKey('call client'));
  });
});

describe('tokenize / tokenOverlap', () => {
  it('drops stopwords and single characters from the word signal', () => {
    expect(tokenize('Fix the login bug a')).toEqual(['fix', 'login', 'bug']);
  });

  it('scores a shared-content-word pair above an unrelated one', () => {
    const related = tokenOverlap('login bug', 'bug in the login form');
    const unrelated = tokenOverlap('login bug', 'order new chairs');
    expect(related).toBeGreaterThan(unrelated);
    expect(unrelated).toBe(0);
  });

  it('is 0 when either side has no meaningful words', () => {
    expect(tokenOverlap('the a of', 'login bug')).toBe(0);
  });
});

describe('recency and repetition weighting', () => {
  it('weights a recent placement above an old one', () => {
    expect(recencyWeight(daysAgo(1), NOW)).toBeGreaterThan(recencyWeight(daysAgo(200), NOW));
  });

  it('never decays to zero — old memory still beats no memory', () => {
    expect(recencyWeight(daysAgo(3650), NOW)).toBeGreaterThan(0.2);
  });

  it('grows sub-linearly with repetition so one repeated item cannot drown the board', () => {
    const two = occurrenceWeight(2);
    const twenty = occurrenceWeight(20);
    expect(twenty).toBeGreaterThan(two);
    expect(twenty).toBeLessThan(two * 5);
  });
});

describe('rankSections', () => {
  it('predicts the section an identical item last went to', () => {
    const out = rankSections([
      candidate({ titleKey: 'fix login bug', sectionId: 'sec_doing', occurrences: 4, scores: { exact: 1 } }),
    ], NOW);
    expect(out[0].sectionId).toBe('sec_doing');
    expect(out[0].because?.channel).toBe('exact');
  });

  it('lets a strong exact hit outrank a pile of weak fuzzy ones in another section', () => {
    const out = rankSections([
      candidate({ titleKey: 'exact', sectionId: 'sec_right', occurrences: 3, scores: { exact: 1 } }),
      candidate({ titleKey: 'fuzzy_a', sectionId: 'sec_wrong', occurrences: 1, scores: { lexical: 0.3 } }),
      candidate({ titleKey: 'fuzzy_b', sectionId: 'sec_wrong', occurrences: 1, scores: { lexical: 0.28 } }),
    ], NOW);
    expect(out[0].sectionId).toBe('sec_right');
  });

  it('returns nothing when there is no memory at all', () => {
    expect(rankSections([], NOW)).toEqual([]);
  });

  it('dampens confidence when only one thin piece of evidence supports the winner', () => {
    const thin = rankSections([
      candidate({ titleKey: 'k', sectionId: 'sec_a', occurrences: 1, scores: { lexical: 0.25 } }),
    ], NOW);
    const solid = rankSections([
      candidate({ titleKey: 'k', sectionId: 'sec_a', occurrences: 8, scores: { exact: 1 } }),
    ], NOW);
    // Both are unopposed, so both take 100% of the vote — only the evidence
    // factor separates them, which is the point.
    expect(thin[0].confidence).toBeLessThan(solid[0].confidence);
    expect(solid[0].confidence).toBeGreaterThan(MIN_CONFIDENCE);
  });

  it('ages out a stale placement in favour of a recent one', () => {
    const out = rankSections([
      candidate({ titleKey: 'old', sectionId: 'sec_old', occurrences: 2, lastSeenAt: daysAgo(400), scores: { lexical: 0.6 } }),
      candidate({ titleKey: 'new', sectionId: 'sec_new', occurrences: 2, lastSeenAt: daysAgo(2), scores: { lexical: 0.6 } }),
    ], NOW);
    expect(out[0].sectionId).toBe('sec_new');
  });

  it('rewards agreement across channels over a single channel alone', () => {
    const agreeing = rankSections([
      candidate({ titleKey: 'a', sectionId: 'sec_a', scores: { lexical: 0.5, vector: 0.8, word: 0.6 } }),
    ], NOW)[0].score;
    const single = rankSections([
      candidate({ titleKey: 'a', sectionId: 'sec_a', scores: { lexical: 0.5 } }),
    ], NOW)[0].score;
    expect(agreeing).toBeGreaterThan(single);
  });
});

describe('usefulPredictions', () => {
  it('drops predictions below the confidence floor rather than showing a guess', () => {
    const weak = rankSections([
      candidate({ titleKey: 'a', sectionId: 'sec_a', occurrences: 1, scores: { lexical: 0.23 } }),
      candidate({ titleKey: 'b', sectionId: 'sec_b', occurrences: 1, scores: { lexical: 0.23 } }),
      candidate({ titleKey: 'c', sectionId: 'sec_c', occurrences: 1, scores: { lexical: 0.23 } }),
      candidate({ titleKey: 'd', sectionId: 'sec_d', occurrences: 1, scores: { lexical: 0.23 } }),
    ], NOW);
    expect(usefulPredictions(weak)).toEqual([]);
  });

  it('caps how many chips the UI is offered', () => {
    // Built directly rather than through rankSections: confidence is a SHARE of
    // the vote, so five real competing candidates would each fall under the
    // floor and the cap would never be exercised at all.
    const five = ['a', 'b', 'c', 'd', 'e'].map((s, i) => ({
      sectionId: `sec_${s}`, score: 5 - i, confidence: 0.9 - i * 0.05, because: null,
    }));
    const capped = usefulPredictions(five, 3);
    expect(capped).toHaveLength(3);
    expect(capped.map((p) => p.sectionId)).toEqual(['sec_a', 'sec_b', 'sec_c']);
  });

  it('surfaces a SINGLE exact hit — one remembered placement is the strongest signal there is', () => {
    // Regression: evidence dampening originally treated "one row" as thin
    // regardless of channel, pushing a verbatim repeat below the display floor
    // so the feature suggested nothing on exactly the case it exists for.
    const out = usefulPredictions(rankSections([
      candidate({ titleKey: 'fix login bug', sectionId: 'sec_doing', occurrences: 1, scores: { exact: 1 } }),
    ], NOW));
    expect(out).toHaveLength(1);
    expect(out[0].sectionId).toBe('sec_doing');
    expect(out[0].confidence).toBeGreaterThan(MIN_CONFIDENCE);
  });

  it('still holds a single WEAK fuzzy hit under the floor — corroboration is what fuzzy needs', () => {
    const out = usefulPredictions(rankSections([
      candidate({ titleKey: 'a', sectionId: 'sec_a', occurrences: 1, scores: { lexical: 0.25 } }),
      candidate({ titleKey: 'b', sectionId: 'sec_b', occurrences: 1, scores: { lexical: 0.24 } }),
      candidate({ titleKey: 'c', sectionId: 'sec_c', occurrences: 1, scores: { lexical: 0.23 } }),
    ], NOW));
    expect(out).toEqual([]);
  });
});

describe('withTokenScores', () => {
  it('adds a word-overlap score for a candidate sharing content words', () => {
    const [out] = withTokenScores([candidate({ titleKey: 'k', sectionId: 's', title: 'bug in the login form' })], 'login bug');
    expect(out.scores.token).toBeGreaterThan(0);
  });

  it('leaves an unrelated candidate untouched', () => {
    const [out] = withTokenScores([candidate({ titleKey: 'k', sectionId: 's', title: 'order new chairs' })], 'login bug');
    expect(out.scores.token).toBeUndefined();
  });
});

describe('fuseCandidates', () => {
  it('scores every retrieved row', () => {
    const fused = fuseCandidates([
      candidate({ titleKey: 'a', sectionId: 's1', scores: { exact: 1 } }),
      candidate({ titleKey: 'b', sectionId: 's2', scores: { lexical: 0.4 } }),
    ]);
    expect(fused.get('a')).toBeGreaterThan(0);
    expect(fused.get('b')).toBeGreaterThan(0);
  });

  it('trusts an exact hit over a lexical one at equal rank', () => {
    const exact = fuseCandidates([candidate({ titleKey: 'a', sectionId: 's', scores: { exact: 1 } })]).get('a')!;
    const lexical = fuseCandidates([candidate({ titleKey: 'a', sectionId: 's', scores: { lexical: 1 } })]).get('a')!;
    expect(exact).toBeGreaterThan(lexical);
  });
});

describe('recordPlacement — the last-section-only rule', () => {
  const base = {
    listId: 'list_1', taskId: 42, title: 'Fix login bug',
    actor: { type: 'user' as const, userId: 'user_1' },
  };

  it('writes history AND overwrites the projection when an item lands in a section', async () => {
    const exec = recordingExec();
    await recordPlacement(exec, { ...base, fromSectionId: 'sec_todo', toSectionId: 'sec_doing', eventType: 'moved' });

    const events = exec.statements.filter((s) => /INSERT INTO section_placement_events/.test(s.sql));
    const memory = exec.statements.filter((s) => /INSERT INTO section_memory/.test(s.sql));
    expect(events).toHaveLength(1);
    expect(memory).toHaveLength(1);

    // The projection is UPSERTed, never appended to — this single assertion is
    // what stops an earlier placement from ever surviving alongside the last.
    expect(memory[0].sql).toMatch(/ON CONFLICT \(list_id, title_key\) DO UPDATE/);
    expect(memory[0].sql).toMatch(/last_section_id = EXCLUDED\.last_section_id/);
    expect(memory[0].params).toContain('sec_doing');
    expect(memory[0].params).not.toContain('sec_todo');
  });

  it('keys the projection on the NORMALIZED title so re-typing it differently still matches', async () => {
    const exec = recordingExec();
    await recordPlacement(exec, { ...base, title: '  FIX, Login   Bug! ', toSectionId: 'sec_doing', eventType: 'created' });
    const memory = exec.statements.find((s) => /INSERT INTO section_memory/.test(s.sql))!;
    expect(memory.params[1]).toBe('fix login bug');
  });

  it('records a delete in history but LEAVES the last known section standing', async () => {
    const exec = recordingExec();
    await recordPlacement(exec, { ...base, fromSectionId: 'sec_done', toSectionId: null, eventType: 'deleted' });

    expect(exec.statements.some((s) => /INSERT INTO section_placement_events/.test(s.sql))).toBe(true);
    // The board still knows where an item called this belongs — which is the
    // whole "doesn't matter if it's now moved, deleted or gone" requirement.
    expect(exec.statements.some((s) => /INSERT INTO section_memory/.test(s.sql))).toBe(false);
  });

  it('treats a move back to the staging tray the same way — history only', async () => {
    const exec = recordingExec();
    await recordPlacement(exec, { ...base, fromSectionId: 'sec_doing', toSectionId: null, eventType: 'staged' });
    expect(exec.statements.some((s) => /INSERT INTO section_memory/.test(s.sql))).toBe(false);
  });

  it('ignores a title with nothing memorable in it', async () => {
    const exec = recordingExec();
    await recordPlacement(exec, { ...base, title: '???', toSectionId: 'sec_doing', eventType: 'created' });
    expect(exec.statements).toHaveLength(0);
  });

  it('never throws into the caller — a memory failure must not fail the task write', async () => {
    const failing = (async () => { throw new Error('db is down'); }) as unknown as QueryExec;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      recordPlacement(failing, { ...base, toSectionId: 'sec_doing', eventType: 'created' })
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it('flags the board so the Knowledge Base bubble is reconciled by the sweep', async () => {
    const exec = recordingExec();
    await recordPlacement(exec, { ...base, toSectionId: 'sec_doing', eventType: 'created' });
    expect(exec.statements.some((s) => /quick_add_memory_dirty = true/.test(s.sql))).toBe(true);
  });
});

describe('buildBubbleBlocks', () => {
  it('renders the learned placements as a table a person can actually read', () => {
    const blocks = buildBubbleBlocks('Sprint board', [
      { title: 'Fix login bug', sectionLabel: 'Doing', occurrences: 4, lastSeenAt: '2026-08-01T10:00:00Z' },
    ]);
    const table = blocks.find((b) => b.type === 'table') as { rows: Array<{ cells: string[] }> } | undefined;
    expect(table).toBeDefined();
    expect(table!.rows[0].cells).toEqual(['Item', 'Last section', 'Times placed', 'Last seen']);
    expect(table!.rows[1].cells).toEqual(['Fix login bug', 'Doing', '4', '2026-08-01']);
  });

  it('explains itself even when empty, rather than leaving a bare orphan entry in the dictionary', () => {
    const blocks = buildBubbleBlocks('Sprint board', []);
    expect(blocks.every((b) => b.type === 'paragraph')).toBe(true);
    expect(blocks.map((b) => b.text).join(' ')).toMatch(/Nothing learned yet/);
  });

  it('caps the rendered rows but says so instead of silently truncating', () => {
    const rows = Array.from({ length: 130 }, (_, i) => ({
      title: `Item ${i}`, sectionLabel: 'Doing', occurrences: 1, lastSeenAt: '2026-08-01T10:00:00Z',
    }));
    const blocks = buildBubbleBlocks('Sprint board', rows);
    const table = blocks.find((b) => b.type === 'table') as { rows: unknown[] };
    expect(table.rows).toHaveLength(101); // header + 100
    expect(blocks.map((b) => b.text ?? '').join(' ')).toMatch(/30 more remembered items/);
  });
});
