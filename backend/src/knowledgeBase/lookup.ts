// ---------------------------------------------------------------------------
// Term lookup — the "dictionary" half of the Knowledge Base, and the reason
// this feature exists separately from knowledge/search.ts.
//
// knowledge_search answers "what content is relevant to this query" with a
// RANKED GUESS. This answers "what does this workspace mean by X" with a
// DEFINITION or nothing. The distinction matters for an AI: a ranked guess that
// is 60% right is worse than a clean miss when the model is about to state a
// fact about the user's own vocabulary.
//
// Resolution order is strictly exactness-first:
//   1. exact term match (case-insensitive)
//   2. exact alias match (case-insensitive)
//   3. no definition — but return near-miss suggestions so a caller can say
//      "did you mean…" rather than inventing one.
// ---------------------------------------------------------------------------

import { query } from '../db';
import type { QueryExec } from '../workspaceUtil';
import { flattenMarkdownBlocks } from '../knowledge/chunker';
import { normalizeContent, sanitizeEntry, type KnowledgeEntryRow, type SanitizedEntry } from './entries';

export interface TermLookupHit {
  entry: SanitizedEntry;
  /** How the term resolved — an alias hit is still authoritative, just worth surfacing. */
  matchedOn: 'term' | 'alias';
  matchedAlias?: string;
  /** The entry body flattened to plain text, ready to hand to a model. */
  body: string;
}

export interface TermLookupMiss {
  /** Near-miss terms, best first. Never a substitute for a definition. */
  suggestions: Array<{ id: string; term: string; summary: string | null }>;
}

export type TermLookupResult = ({ found: true } & TermLookupHit) | ({ found: false } & TermLookupMiss);

/** Plain-text rendering of an entry, the form an AI actually consumes. */
export function entryBodyText(row: KnowledgeEntryRow): string {
  return flattenMarkdownBlocks(normalizeContent(row.content).blocks as Array<{ id: string; type: string }>);
}

/**
 * Resolve one term within a workspace's Knowledge Base. Callers must have
 * already checked the caller can access the workspace — this function is a
 * data lookup, not an access boundary.
 */
export async function lookupTerm(
  workspaceId: string,
  rawTerm: string,
  exec: QueryExec = query
): Promise<TermLookupResult> {
  const term = (rawTerm ?? '').trim();
  if (!term) return { found: false, suggestions: [] };

  // 1 + 2 in one pass: an exact term hit always outranks an alias hit, so a
  // term that is also somebody else's alias resolves to its own entry.
  const hit = await exec(
    `SELECT e.*,
            (lower(e.term) = lower($2)) AS term_match
       FROM knowledge_entries e
       JOIN knowledge_bases kb ON kb.id = e.kb_id
      WHERE kb.workspace_id = $1
        AND (lower(e.term) = lower($2)
             OR EXISTS (SELECT 1 FROM unnest(e.aliases) a WHERE lower(a) = lower($2)))
      ORDER BY term_match DESC
      LIMIT 1`,
    [workspaceId, term]
  );

  const row = hit.rows[0] as (KnowledgeEntryRow & { term_match: boolean }) | undefined;
  if (row) {
    const matchedAlias = row.term_match
      ? undefined
      : (row.aliases ?? []).find((a) => a.toLowerCase() === term.toLowerCase());
    return {
      found: true,
      entry: sanitizeEntry(row),
      matchedOn: row.term_match ? 'term' : 'alias',
      ...(matchedAlias ? { matchedAlias } : {}),
      body: entryBodyText(row),
    };
  }

  // 3. No definition. Offer near misses via the same trigram index the rest of
  // the app searches with, so the caller can prompt rather than guess.
  const near = await exec(
    `SELECT e.id, e.term, e.summary
       FROM knowledge_entries e
       JOIN knowledge_bases kb ON kb.id = e.kb_id
      WHERE kb.workspace_id = $1 AND e.term % $2
      ORDER BY similarity(e.term, $2) DESC
      LIMIT 5`,
    [workspaceId, term]
  );
  return {
    found: false,
    suggestions: near.rows as Array<{ id: string; term: string; summary: string | null }>,
  };
}

export interface GlossaryTerm {
  id: string;
  term: string;
  aliases: string[];
  entryType: string;
  summary: string | null;
}

/**
 * The compact glossary: terms + aliases + one-line summaries, no bodies.
 * This is what gets injected into Sol's system prompt and served as the MCP
 * `solytiq://knowledge/{workspaceId}` resource — small enough to carry on every
 * turn, which is precisely what makes the model aware a lookup is available.
 */
export async function listGlossary(
  workspaceId: string,
  limit = 500,
  exec: QueryExec = query
): Promise<GlossaryTerm[]> {
  const r = await exec(
    `SELECT e.id, e.term, e.aliases, e.entry_type, e.summary
       FROM knowledge_entries e
       JOIN knowledge_bases kb ON kb.id = e.kb_id
      WHERE kb.workspace_id = $1
      ORDER BY lower(e.term) ASC
      LIMIT $2`,
    [workspaceId, limit]
  );
  return (r.rows as Array<{ id: string; term: string; aliases: string[] | null; entry_type: string; summary: string | null }>)
    .map((row) => ({
      id: row.id,
      term: row.term,
      aliases: row.aliases ?? [],
      entryType: row.entry_type,
      summary: row.summary,
    }));
}
