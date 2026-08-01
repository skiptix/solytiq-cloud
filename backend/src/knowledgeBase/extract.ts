// ---------------------------------------------------------------------------
// Suggest-only concept extraction.
//
// Scans a workspace's existing content for terms that LOOK like the workspace's
// own vocabulary and proposes them; a human accepts each one. Nothing here ever
// writes an entry directly — an unreviewed suggestion is not a definition, and
// the whole value of the Knowledge Base is that a model can trust it.
//
// The candidate finder is a deterministic heuristic, NOT an LLM sweep: it costs
// nothing, runs the same way twice, and is unit-testable as a pure function.
// (An always-on extraction sweep was considered and rejected — it spends
// provider budget continuously and fills the base with unvetted noise. Drafting
// a rich entry is still available on demand through the AI's own
// create_knowledge_entry tool.)
// ---------------------------------------------------------------------------

import { v4 as uuidv4 } from 'uuid';
import { query } from '../db';
import type { QueryExec } from '../workspaceUtil';
import { flattenMarkdownBlocks } from '../knowledge/chunker';
import { formatSrn, type EntityType } from '../graph/srn';
import { createEntry, type KnowledgeBaseRow, type KnowledgeEntryRow } from './entries';

/** Where a candidate term was seen. */
export interface TermEvidence {
  srn: string;
  /** The sentence/line it appeared in, trimmed for display. */
  snippet: string;
}

export interface TermCandidate {
  term: string;
  occurrences: number;
  evidence: TermEvidence[];
}

export interface SourceDoc {
  entityType: EntityType;
  entityId: string;
  text: string;
}

// Words that start a sentence or are simply common — a capitalized "The" is not
// a concept. Kept deliberately small: over-filtering hides real domain terms,
// and every candidate is reviewed by a human anyway.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'while', 'for', 'to', 'of', 'in', 'on',
  'at', 'by', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'this', 'that', 'these', 'those',
  'it', 'its', 'we', 'you', 'they', 'he', 'she', 'i', 'my', 'our', 'your', 'their', 'me', 'us', 'them',
  'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
  'not', 'no', 'yes', 'all', 'any', 'some', 'each', 'every', 'here', 'there', 'what', 'which', 'who', 'how', 'why',
  'add', 'new', 'todo', 'done', 'note', 'notes', 'task', 'tasks', 'list', 'page', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
]);

const MIN_OCCURRENCES = 2;
const MAX_CANDIDATES = 40;
const SNIPPET_MAX = 160;

function isStopword(word: string): boolean {
  return STOPWORDS.has(word.toLowerCase());
}

/** ALL-CAPS run of 2-6 letters/digits — TLA-shaped, e.g. "SRN", "MCP", "Q3". */
function isAcronym(word: string): boolean {
  return /^[A-Z][A-Z0-9]{1,5}$/.test(word);
}

/** Capitalized word that isn't a stopword and isn't purely numeric. */
function isProperish(word: string): boolean {
  return /^[A-Z][a-zA-Z0-9-]{1,}$/.test(word) && !isStopword(word);
}

function trimSnippet(line: string): string {
  const clean = line.replace(/\s+/g, ' ').trim();
  return clean.length > SNIPPET_MAX ? `${clean.slice(0, SNIPPET_MAX - 1)}…` : clean;
}

/**
 * Find candidate terms across a set of documents.
 *
 * Two shapes are recognized: acronyms (SRN, MCP) and capitalized noun phrases
 * of up to three words (Q3 Rollout, Release Train). A candidate must appear in
 * at least `minOccurrences` places overall — a term used exactly once is a
 * passing mention, not shared vocabulary worth defining.
 *
 * Pure: no DB, no network, no clock. See __tests__/knowledgeExtract.test.ts.
 */
export function extractCandidateTerms(
  docs: SourceDoc[],
  opts: { minOccurrences?: number; maxCandidates?: number; exclude?: Set<string> } = {}
): TermCandidate[] {
  const minOccurrences = opts.minOccurrences ?? MIN_OCCURRENCES;
  const maxCandidates = opts.maxCandidates ?? MAX_CANDIDATES;
  const exclude = opts.exclude ?? new Set<string>();

  // Keyed case-insensitively so "Q3 rollout" and "Q3 Rollout" are one candidate;
  // the first-seen casing wins as the display form.
  const byKey = new Map<string, TermCandidate>();

  const record = (term: string, srn: string, snippet: string) => {
    const key = term.toLowerCase();
    if (exclude.has(key)) return;
    let cand = byKey.get(key);
    if (!cand) { cand = { term, occurrences: 0, evidence: [] }; byKey.set(key, cand); }
    cand.occurrences += 1;
    // At most one evidence row per source entity — five snippets from one page
    // is not five pieces of evidence.
    if (cand.evidence.length < 5 && !cand.evidence.some((e) => e.srn === srn)) {
      cand.evidence.push({ srn, snippet });
    }
  };

  for (const doc of docs) {
    if (!doc.text?.trim()) continue;
    const srn = formatSrn(doc.entityType, doc.entityId);
    for (const rawLine of doc.text.split(/[\n.!?;]+/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const snippet = trimSnippet(line);
      const words = line.split(/[^A-Za-z0-9-]+/).filter(Boolean);

      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        if (isAcronym(word)) { record(word, srn, snippet); continue; }
        if (!isProperish(word)) continue;
        // A capitalized word in position 0 is probably just sentence case, so
        // it only counts as part of a MULTI-word phrase, never on its own.
        const phrase: string[] = [word];
        for (let j = i + 1; j < words.length && phrase.length < 3; j++) {
          const next = words[j];
          if (!isProperish(next) && !isAcronym(next)) break;
          phrase.push(next);
        }
        if (phrase.length > 1) {
          record(phrase.join(' '), srn, snippet);
          i += phrase.length - 1;
        } else if (i > 0) {
          record(word, srn, snippet);
        }
      }
    }
  }

  return [...byKey.values()]
    .filter((c) => c.occurrences >= minOccurrences)
    .sort((a, b) => b.occurrences - a.occurrences || a.term.localeCompare(b.term))
    .slice(0, maxCandidates);
}

/** A one-line summary drafted from where the term actually appears — no model call. */
export function draftSummary(candidate: TermCandidate): string {
  const where = candidate.occurrences === 1 ? 'once' : `${candidate.occurrences} times`;
  const example = candidate.evidence[0]?.snippet;
  const base = `Mentioned ${where} across this workspace.`;
  return example ? `${base} e.g. "${example}"` : base;
}

/** Pull every content-bearing document in a workspace, in one pass per source table. */
export async function loadWorkspaceDocs(workspaceId: string, exec: QueryExec = query): Promise<SourceDoc[]> {
  const docs: SourceDoc[] = [];

  const tasks = await exec(
    `SELECT id::text AS id, title, note FROM tasks WHERE workspace_id = $1 LIMIT 2000`, [workspaceId]
  );
  for (const t of tasks.rows as Array<{ id: string; title: string; note: string | null }>) {
    docs.push({ entityType: 'task', entityId: t.id, text: [t.title, t.note].filter(Boolean).join('\n') });
  }

  const pages = await exec(
    `SELECT id, name, subtitle, content FROM markdown_lists WHERE workspace_id = $1 LIMIT 500`, [workspaceId]
  );
  for (const p of pages.rows as Array<{ id: string; name: string; subtitle: string | null; content: unknown }>) {
    const blocks = Array.isArray((p.content as { blocks?: unknown } | null)?.blocks)
      ? ((p.content as { blocks: Array<{ id: string; type: string }> }).blocks)
      : [];
    docs.push({
      entityType: 'markdownList', entityId: p.id,
      text: [p.name, p.subtitle, flattenMarkdownBlocks(blocks)].filter(Boolean).join('\n\n'),
    });
  }

  const milestones = await exec(
    `SELECT m.id, m.title, m.description FROM milestones m
       JOIN timelines t ON t.id = m.timeline_id
      WHERE t.workspace_id = $1 LIMIT 1000`, [workspaceId]
  );
  for (const m of milestones.rows as Array<{ id: string; title: string; description: string | null }>) {
    docs.push({ entityType: 'milestone', entityId: m.id, text: [m.title, m.description].filter(Boolean).join('\n') });
  }

  const lists = await exec(`SELECT id, name FROM lists WHERE workspace_id = $1 LIMIT 500`, [workspaceId]);
  for (const l of lists.rows as Array<{ id: string; name: string }>) {
    docs.push({ entityType: 'list', entityId: l.id, text: l.name });
  }

  return docs;
}

export interface ScanResult {
  scanned: number;
  proposed: number;
  /** Candidates skipped because the term is already defined. */
  alreadyDefined: number;
}

/**
 * Run a scan and persist the candidates as `pending` suggestions. Idempotent by
 * construction: the unique (kb_id, lower(term)) index plus ON CONFLICT DO
 * NOTHING means re-running converges instead of stacking duplicates — the same
 * convergence property the graph backfill relies on.
 */
export async function runConceptScan(
  userId: string,
  base: KnowledgeBaseRow,
  exec: QueryExec = query
): Promise<ScanResult> {
  const docs = await loadWorkspaceDocs(base.workspace_id, exec);

  // Never propose something already defined — including by alias, so accepting
  // "MCP" as an alias of "Model Context Protocol" stops it being re-proposed.
  const definedRes = await exec(`SELECT term, aliases FROM knowledge_entries WHERE kb_id = $1`, [base.id]);
  const exclude = new Set<string>();
  for (const row of definedRes.rows as Array<{ term: string; aliases: string[] | null }>) {
    exclude.add(row.term.toLowerCase());
    for (const a of row.aliases ?? []) exclude.add(a.toLowerCase());
  }
  const before = exclude.size;

  const candidates = extractCandidateTerms(docs, { exclude });

  let proposed = 0;
  for (const cand of candidates) {
    const r = await exec(
      `INSERT INTO knowledge_suggestions (id, kb_id, term, summary, entry_type, evidence, status)
       VALUES ($1, $2, $3, $4, 'concept', $5, 'pending')
       ON CONFLICT (kb_id, lower(term)) DO NOTHING
       RETURNING id`,
      [`kbs_${uuidv4()}`, base.id, cand.term, draftSummary(cand), JSON.stringify(cand.evidence)]
    );
    if (r.rows.length > 0) proposed += 1;
  }

  return { scanned: docs.length, proposed, alreadyDefined: before };
}

export interface SuggestionRow {
  id: string;
  kb_id: string;
  term: string;
  summary: string | null;
  entry_type: string;
  evidence: TermEvidence[];
  status: string;
  created_at: string;
}

export async function listSuggestions(kbId: string, exec: QueryExec = query) {
  const r = await exec(
    `SELECT * FROM knowledge_suggestions WHERE kb_id = $1 AND status = 'pending' ORDER BY created_at DESC`,
    [kbId]
  );
  return (r.rows as SuggestionRow[]).map((row) => ({
    id: row.id,
    term: row.term,
    summary: row.summary,
    entryType: row.entry_type,
    evidence: row.evidence ?? [],
    createdAt: row.created_at,
  }));
}

/**
 * Accept a suggestion into a real entry, or reject it. A rejected suggestion is
 * kept (status `rejected`) rather than deleted, so the next scan's ON CONFLICT
 * skips it instead of proposing the same term forever.
 */
export async function decideSuggestion(
  userId: string,
  base: KnowledgeBaseRow,
  suggestionId: string,
  accept: boolean,
  exec: QueryExec = query
): Promise<{ ok: true; entry: KnowledgeEntryRow | null } | { ok: false; error: string }> {
  const r = await exec(
    `SELECT * FROM knowledge_suggestions WHERE id = $1 AND kb_id = $2 AND status = 'pending'`,
    [suggestionId, base.id]
  );
  const sug = r.rows[0] as SuggestionRow | undefined;
  if (!sug) return { ok: false, error: 'Suggestion not found or already decided' };

  if (!accept) {
    await exec(
      `UPDATE knowledge_suggestions SET status = 'rejected', decided_by = $1, decided_at = NOW() WHERE id = $2`,
      [userId, suggestionId]
    );
    return { ok: true, entry: null };
  }

  const created = await createEntry(userId, base.id, {
    term: sug.term,
    summary: sug.summary,
    entryType: 'concept',
    origin: 'extracted',
    // Carry the evidence forward so an accepted entry starts with a record of
    // where its term actually came from, rather than an empty page.
    properties: { extractedFrom: (sug.evidence ?? []).map((e) => e.srn) },
  }, exec);
  if (!created.ok) return { ok: false, error: created.error };

  await exec(
    `UPDATE knowledge_suggestions SET status = 'accepted', decided_by = $1, decided_at = NOW() WHERE id = $2`,
    [userId, suggestionId]
  );
  return { ok: true, entry: created.entry };
}
