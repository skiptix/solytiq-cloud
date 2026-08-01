// ---------------------------------------------------------------------------
// Knowledge Base — extraction heuristics, alias normalization, and term lookup.
//
// Uses the mock-QueryExec convention established by workspaceIntegrity.test.ts,
// so nothing here needs a live database. The extraction candidate finder is a
// pure function and is tested directly.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { extractCandidateTerms, draftSummary, type SourceDoc } from '../knowledgeBase/extract';
import { normalizeAliases, isValidEntryType, ENTRY_TYPES } from '../knowledgeBase/entries';
import { lookupTerm, listGlossary } from '../knowledgeBase/lookup';
import type { QueryExec } from '../workspaceUtil';

/** Minimal QueryExec stub: hands back a canned result per matched SQL fragment. */
function mockExec(routes: Array<{ match: RegExp; rows: unknown[] }>): QueryExec {
  return (async (text: string) => {
    for (const r of routes) if (r.match.test(text)) return { rows: r.rows, rowCount: r.rows.length };
    return { rows: [], rowCount: 0 };
  }) as unknown as QueryExec;
}

const doc = (entityId: string, text: string): SourceDoc => ({ entityType: 'task', entityId, text });

describe('extractCandidateTerms', () => {
  it('proposes a capitalized phrase that recurs across documents', () => {
    const out = extractCandidateTerms([
      doc('1', 'Kick off the Q3 Rollout next week'),
      doc('2', 'The Q3 Rollout depends on procurement'),
    ]);
    expect(out.map((c) => c.term)).toContain('Q3 Rollout');
  });

  it('ignores a term that appears only once — a passing mention is not vocabulary', () => {
    const out = extractCandidateTerms([doc('1', 'Kick off the Q3 Rollout next week')]);
    expect(out.map((c) => c.term)).not.toContain('Q3 Rollout');
  });

  it('picks up acronyms', () => {
    const out = extractCandidateTerms([
      doc('1', 'Wire up the MCP connector'),
      doc('2', 'MCP needs a bearer token'),
    ]);
    expect(out.map((c) => c.term)).toContain('MCP');
  });

  it('does not propose a sentence-initial capitalized stopword on its own', () => {
    const out = extractCandidateTerms([
      doc('1', 'The report is late'),
      doc('2', 'The report is still late'),
    ]);
    expect(out.map((c) => c.term)).not.toContain('The');
  });

  it('treats differing casing as one candidate, keeping the first-seen form', () => {
    const out = extractCandidateTerms([
      doc('1', 'Ship the Release Train'),
      doc('2', 'Release TRAIN slipped'),
      doc('3', 'Release Train review'),
    ]);
    const matches = out.filter((c) => c.term.toLowerCase() === 'release train');
    expect(matches).toHaveLength(1);
    expect(matches[0].term).toBe('Release Train');
  });

  it('honours the exclude set so an already-defined term is never re-proposed', () => {
    const docs = [doc('1', 'The Q3 Rollout starts'), doc('2', 'Q3 Rollout is on track')];
    const out = extractCandidateTerms(docs, { exclude: new Set(['q3 rollout']) });
    expect(out.map((c) => c.term)).not.toContain('Q3 Rollout');
  });

  it('records at most one piece of evidence per source entity', () => {
    const out = extractCandidateTerms([
      doc('1', 'Q3 Rollout here. Q3 Rollout again. Q3 Rollout once more'),
      doc('2', 'Q3 Rollout elsewhere'),
    ]);
    const cand = out.find((c) => c.term === 'Q3 Rollout')!;
    expect(cand.occurrences).toBeGreaterThan(2);
    expect(new Set(cand.evidence.map((e) => e.srn)).size).toBe(cand.evidence.length);
    expect(cand.evidence.length).toBe(2);
  });

  it('formats evidence SRNs for the entity they came from', () => {
    const out = extractCandidateTerms([
      { entityType: 'markdownList', entityId: 'md_1', text: 'Q3 Rollout plan' },
      { entityType: 'markdownList', entityId: 'md_2', text: 'Q3 Rollout budget' },
    ]);
    const cand = out.find((c) => c.term === 'Q3 Rollout')!;
    expect(cand.evidence[0].srn).toBe('srn:markdownList:md_1');
  });

  it('caps the candidate list', () => {
    const docs: SourceDoc[] = [];
    for (let i = 0; i < 60; i++) {
      docs.push(doc(`a${i}`, `Alpha${i} Beta${i} appears`), doc(`b${i}`, `Alpha${i} Beta${i} again`));
    }
    expect(extractCandidateTerms(docs, { maxCandidates: 10 })).toHaveLength(10);
  });

  it('ranks more frequent candidates first', () => {
    const out = extractCandidateTerms([
      doc('1', 'Release Train and Q3 Rollout'),
      doc('2', 'Release Train again'),
      doc('3', 'Release Train once more'),
      doc('4', 'Q3 Rollout second mention'),
    ]);
    const terms = out.map((c) => c.term);
    expect(terms.indexOf('Release Train')).toBeLessThan(terms.indexOf('Q3 Rollout'));
  });

  it('ignores empty documents without throwing', () => {
    expect(extractCandidateTerms([doc('1', ''), doc('2', '   ')])).toEqual([]);
  });
});

describe('draftSummary', () => {
  it('quotes the first evidence snippet so an accepted entry starts with real context', () => {
    const summary = draftSummary({
      term: 'Q3 Rollout',
      occurrences: 3,
      evidence: [{ srn: 'srn:task:1', snippet: 'Kick off the Q3 Rollout next week' }],
    });
    expect(summary).toContain('3 times');
    expect(summary).toContain('Kick off the Q3 Rollout next week');
  });

  it('degrades gracefully with no evidence', () => {
    expect(draftSummary({ term: 'X', occurrences: 1, evidence: [] })).toContain('once');
  });
});

describe('normalizeAliases', () => {
  it('trims, drops empties, and de-dupes case-insensitively keeping first-seen casing', () => {
    expect(normalizeAliases([' MCP ', 'mcp', '', '   ', 'Model Context Protocol'])).toEqual([
      'MCP', 'Model Context Protocol',
    ]);
  });

  it('ignores non-string entries and non-array input', () => {
    expect(normalizeAliases(['ok', 42, null, undefined])).toEqual(['ok']);
    expect(normalizeAliases('not an array')).toEqual([]);
    expect(normalizeAliases(undefined)).toEqual([]);
  });
});

describe('isValidEntryType', () => {
  it('accepts every catalogued type and rejects anything else', () => {
    for (const t of ENTRY_TYPES) expect(isValidEntryType(t)).toBe(true);
    expect(isValidEntryType('nonsense')).toBe(false);
    expect(isValidEntryType(null)).toBe(false);
  });
});

describe('lookupTerm', () => {
  const entryRow = {
    id: 'kbe_1', kb_id: 'kb_1', user_id: 'u1', term: 'Q3 Rollout',
    aliases: ['Q3', 'the rollout'], entry_type: 'project', summary: 'Our Q3 launch programme.',
    content: { version: 1, blocks: [{ id: 'b1', type: 'paragraph', text: 'Runs July to September.' }] },
    properties: {}, emoji: null, color: null, position: 0, origin: 'manual', version: 1,
    created_at: 'x', updated_at: 'x',
  };

  it('resolves an exact term and flags the match kind', async () => {
    const exec = mockExec([{ match: /term_match/, rows: [{ ...entryRow, term_match: true }] }]);
    const res = await lookupTerm('ws1', 'Q3 Rollout', exec);
    expect(res.found).toBe(true);
    if (!res.found) return;
    expect(res.matchedOn).toBe('term');
    expect(res.entry.term).toBe('Q3 Rollout');
    // The body is flattened to plain text — the form a model actually consumes.
    expect(res.body).toContain('Runs July to September.');
  });

  it('reports which alias matched when the hit came through one', async () => {
    const exec = mockExec([{ match: /term_match/, rows: [{ ...entryRow, term_match: false }] }]);
    const res = await lookupTerm('ws1', 'Q3', exec);
    expect(res.found).toBe(true);
    if (!res.found) return;
    expect(res.matchedOn).toBe('alias');
    expect(res.matchedAlias).toBe('Q3');
  });

  it('returns an explicit miss with near-misses rather than a fuzzy "best" answer', async () => {
    const exec = mockExec([
      { match: /term_match/, rows: [] },
      { match: /similarity/, rows: [{ id: 'kbe_9', term: 'Q4 Rollout', summary: null }] },
    ]);
    const res = await lookupTerm('ws1', 'Q5 Rollout', exec);
    expect(res.found).toBe(false);
    if (res.found) return;
    expect(res.suggestions.map((s) => s.term)).toEqual(['Q4 Rollout']);
  });

  it('treats a blank term as a miss without querying', async () => {
    let called = false;
    const exec = (async () => { called = true; return { rows: [], rowCount: 0 }; }) as unknown as QueryExec;
    const res = await lookupTerm('ws1', '   ', exec);
    expect(res.found).toBe(false);
    expect(called).toBe(false);
  });
});

describe('listGlossary', () => {
  it('returns terms with aliases and summaries, defaulting a null alias array to empty', async () => {
    const exec = mockExec([{
      match: /FROM knowledge_entries/,
      rows: [
        { id: 'a', term: 'MCP', aliases: ['Model Context Protocol'], entry_type: 'system', summary: 'Tool protocol.' },
        { id: 'b', term: 'SRN', aliases: null, entry_type: 'concept', summary: null },
      ],
    }]);
    const terms = await listGlossary('ws1', 500, exec);
    expect(terms).toEqual([
      { id: 'a', term: 'MCP', aliases: ['Model Context Protocol'], entryType: 'system', summary: 'Tool protocol.' },
      { id: 'b', term: 'SRN', aliases: [], entryType: 'concept', summary: null },
    ]);
  });
});
