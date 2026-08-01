// ---------------------------------------------------------------------------
// Knowledge Base data layer — the per-workspace curated dictionary.
//
// Deliberately NOT in backend/src/knowledge/, which is the RAG layer (chunking,
// embeddings, hybrid search). The two are complementary: this module owns terms
// people wrote down on purpose; that one owns fuzzy retrieval over everything
// else. Naming them apart keeps every future reader from having to disambiguate
// two things called "knowledge".
//
// Every exported function takes an injectable QueryExec (defaulting to the
// pool) per the established convention, so it composes inside a caller's
// transaction and is unit-testable against a mock exec with no live DB.
// ---------------------------------------------------------------------------

import { v4 as uuidv4 } from 'uuid';
import { query } from '../db';
import type { QueryExec } from '../workspaceUtil';

/** Entry kinds. Free-form enough to be useful, closed enough that an AI can filter on it. */
export const ENTRY_TYPES = ['concept', 'person', 'project', 'system', 'acronym', 'policy', 'process', 'other'] as const;
export type KnowledgeEntryType = (typeof ENTRY_TYPES)[number];

export function isValidEntryType(value: unknown): value is KnowledgeEntryType {
  return typeof value === 'string' && (ENTRY_TYPES as readonly string[]).includes(value);
}

/** Where an entry came from. `manual` = a person typed it; `ai` = a tool call; `extracted` = an accepted suggestion. */
export type KnowledgeEntryOrigin = 'manual' | 'ai' | 'extracted';

export interface KnowledgeBaseRow {
  id: string;
  workspace_id: string;
  user_id: string;
  name: string;
  emoji: string | null;
  color: string | null;
  description: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeEntryRow {
  id: string;
  kb_id: string;
  user_id: string;
  term: string;
  aliases: string[];
  entry_type: string;
  summary: string | null;
  content: { version: 1; blocks: BlockLike[] } | null;
  properties: Record<string, unknown> | null;
  emoji: string | null;
  color: string | null;
  position: number;
  origin: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface BlockLike {
  id: string;
  type: string;
  [key: string]: unknown;
}

export function normalizeContent(raw: unknown): { version: 1; blocks: BlockLike[] } {
  if (raw && typeof raw === 'object' && Array.isArray((raw as { blocks?: unknown }).blocks)) {
    return { version: 1, blocks: (raw as { blocks: BlockLike[] }).blocks };
  }
  return { version: 1, blocks: [] };
}

export function sanitizeBase(row: KnowledgeBaseRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    name: row.name,
    emoji: row.emoji,
    color: row.color,
    description: row.description,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function sanitizeEntry(row: KnowledgeEntryRow) {
  return {
    id: row.id,
    kbId: row.kb_id,
    userId: row.user_id,
    term: row.term,
    aliases: row.aliases ?? [],
    entryType: row.entry_type,
    summary: row.summary,
    content: normalizeContent(row.content),
    properties: row.properties ?? {},
    emoji: row.emoji,
    color: row.color,
    position: row.position,
    origin: row.origin,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type SanitizedEntry = ReturnType<typeof sanitizeEntry>;
export type SanitizedBase = ReturnType<typeof sanitizeBase>;

// ---------------------------------------------------------------------------
// Knowledge Base (container)
// ---------------------------------------------------------------------------

/** The workspace's Knowledge Base, or null. Callers must have already checked workspace access. */
export async function getBaseForWorkspace(
  workspaceId: string,
  exec: QueryExec = query
): Promise<KnowledgeBaseRow | null> {
  const r = await exec(`SELECT * FROM knowledge_bases WHERE workspace_id = $1`, [workspaceId]);
  return (r.rows[0] as KnowledgeBaseRow | undefined) ?? null;
}

export async function getBaseById(id: string, exec: QueryExec = query): Promise<KnowledgeBaseRow | null> {
  const r = await exec(`SELECT * FROM knowledge_bases WHERE id = $1`, [id]);
  return (r.rows[0] as KnowledgeBaseRow | undefined) ?? null;
}

export interface CreateBaseInput {
  name?: string;
  emoji?: string | null;
  color?: string | null;
  description?: string | null;
}

/**
 * Create the workspace's Knowledge Base. The UNIQUE constraint on
 * workspace_id is the real guard — this returns the EXISTING base rather than
 * erroring on a double-create, so two tabs racing the sidebar's add button
 * converge on one base instead of one of them failing.
 */
export async function createBase(
  userId: string,
  workspaceId: string,
  input: CreateBaseInput = {},
  exec: QueryExec = query
): Promise<{ base: KnowledgeBaseRow; created: boolean }> {
  const existing = await getBaseForWorkspace(workspaceId, exec);
  if (existing) return { base: existing, created: false };

  const id = `kb_${uuidv4()}`;
  const r = await exec(
    `INSERT INTO knowledge_bases (id, workspace_id, user_id, name, emoji, color, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (workspace_id) DO NOTHING
     RETURNING *`,
    [id, workspaceId, userId, input.name?.trim() || 'Knowledge', input.emoji ?? '🧠', input.color ?? null, input.description ?? null]
  );
  const created = r.rows[0] as KnowledgeBaseRow | undefined;
  if (created) return { base: created, created: true };
  // Lost the race against a concurrent create — read the winner back.
  const winner = await getBaseForWorkspace(workspaceId, exec);
  if (!winner) throw new Error('knowledge base create failed');
  return { base: winner, created: false };
}

export interface UpdateBaseInput {
  name?: string;
  emoji?: string | null;
  color?: string | null;
  description?: string | null;
}

export async function updateBase(
  id: string,
  input: UpdateBaseInput,
  exec: QueryExec = query
): Promise<KnowledgeBaseRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (input.name !== undefined) push('name', input.name.trim() || 'Knowledge');
  if (input.emoji !== undefined) push('emoji', input.emoji);
  if (input.color !== undefined) push('color', input.color);
  if (input.description !== undefined) push('description', input.description);
  if (sets.length === 0) return getBaseById(id, exec);
  params.push(id);
  const r = await exec(
    `UPDATE knowledge_bases SET ${sets.join(', ')}, version = version + 1, updated_at = NOW()
      WHERE id = $${params.length} RETURNING *`,
    params
  );
  return (r.rows[0] as KnowledgeBaseRow | undefined) ?? null;
}

/**
 * Delete the base and — via ON DELETE CASCADE — every entry, suggestion, and
 * (through entity_index's composite FK) every graph edge touching them. There
 * is no Trash bucket for a Knowledge Base: it is one per workspace and deleting
 * it is an explicit, confirmed act, not the kind of accidental delete the trash
 * tables exist to soften.
 */
export async function deleteBase(id: string, exec: QueryExec = query): Promise<boolean> {
  const r = await exec(`DELETE FROM knowledge_bases WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export async function listEntries(kbId: string, exec: QueryExec = query): Promise<KnowledgeEntryRow[]> {
  const r = await exec(
    `SELECT * FROM knowledge_entries WHERE kb_id = $1 ORDER BY position ASC, lower(term) ASC`,
    [kbId]
  );
  return r.rows as KnowledgeEntryRow[];
}

export async function getEntry(id: string, exec: QueryExec = query): Promise<KnowledgeEntryRow | null> {
  const r = await exec(`SELECT * FROM knowledge_entries WHERE id = $1`, [id]);
  return (r.rows[0] as KnowledgeEntryRow | undefined) ?? null;
}

/** Normalize a user-supplied alias list: trimmed, de-duped case-insensitively, empties dropped. */
export function normalizeAliases(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of raw) {
    if (typeof a !== 'string') continue;
    const trimmed = a.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export interface CreateEntryInput {
  term: string;
  aliases?: unknown;
  entryType?: string;
  summary?: string | null;
  properties?: Record<string, unknown>;
  emoji?: string | null;
  color?: string | null;
  content?: { version: 1; blocks: BlockLike[] };
  origin?: KnowledgeEntryOrigin;
}

export type EntryResult<T> = { ok: true; entry: T } | { ok: false; error: string; conflict?: boolean };

export async function createEntry(
  userId: string,
  kbId: string,
  input: CreateEntryInput,
  exec: QueryExec = query
): Promise<EntryResult<KnowledgeEntryRow>> {
  const term = (input.term ?? '').trim();
  if (!term) return { ok: false, error: 'A term is required' };
  if (term.length > 200) return { ok: false, error: 'Term is too long (max 200 characters)' };
  if (input.entryType !== undefined && !isValidEntryType(input.entryType)) {
    return { ok: false, error: `entryType must be one of: ${ENTRY_TYPES.join(', ')}` };
  }

  const posRes = await exec(`SELECT COALESCE(MAX(position), -1) + 1 AS next FROM knowledge_entries WHERE kb_id = $1`, [kbId]);
  const position = Number((posRes.rows[0] as { next: number } | undefined)?.next ?? 0);

  const id = `kbe_${uuidv4()}`;
  const r = await exec(
    `INSERT INTO knowledge_entries (id, kb_id, user_id, term, aliases, entry_type, summary, content, properties, emoji, color, position, origin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (kb_id, lower(term)) DO NOTHING
     RETURNING *`,
    [
      id, kbId, userId, term, normalizeAliases(input.aliases), input.entryType ?? 'concept',
      input.summary ?? null, JSON.stringify(normalizeContent(input.content)),
      JSON.stringify(input.properties ?? {}), input.emoji ?? null, input.color ?? null,
      position, input.origin ?? 'manual',
    ]
  );
  const row = r.rows[0] as KnowledgeEntryRow | undefined;
  if (!row) {
    // A dictionary with two entries for one term stops being deterministic, so
    // this is a hard conflict rather than a silent second row.
    return { ok: false, error: `"${term}" is already defined in this Knowledge Base`, conflict: true };
  }
  return { ok: true, entry: row };
}

export interface UpdateEntryInput {
  term?: string;
  aliases?: unknown;
  entryType?: string;
  summary?: string | null;
  properties?: Record<string, unknown>;
  emoji?: string | null;
  color?: string | null;
  position?: number;
}

export async function updateEntry(
  id: string,
  input: UpdateEntryInput,
  exec: QueryExec = query
): Promise<EntryResult<KnowledgeEntryRow>> {
  if (input.entryType !== undefined && !isValidEntryType(input.entryType)) {
    return { ok: false, error: `entryType must be one of: ${ENTRY_TYPES.join(', ')}` };
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (input.term !== undefined) {
    const term = input.term.trim();
    if (!term) return { ok: false, error: 'A term is required' };
    if (term.length > 200) return { ok: false, error: 'Term is too long (max 200 characters)' };
    push('term', term);
  }
  if (input.aliases !== undefined) push('aliases', normalizeAliases(input.aliases));
  if (input.entryType !== undefined) push('entry_type', input.entryType);
  if (input.summary !== undefined) push('summary', input.summary);
  if (input.properties !== undefined) push('properties', JSON.stringify(input.properties));
  if (input.emoji !== undefined) push('emoji', input.emoji);
  if (input.color !== undefined) push('color', input.color);
  if (input.position !== undefined) push('position', input.position);

  if (sets.length === 0) {
    const current = await getEntry(id, exec);
    return current ? { ok: true, entry: current } : { ok: false, error: 'Entry not found' };
  }

  params.push(id);
  try {
    const r = await exec(
      `UPDATE knowledge_entries SET ${sets.join(', ')}, version = version + 1, updated_at = NOW()
        WHERE id = $${params.length} RETURNING *`,
      params
    );
    const row = r.rows[0] as KnowledgeEntryRow | undefined;
    return row ? { ok: true, entry: row } : { ok: false, error: 'Entry not found' };
  } catch (err) {
    // The only constraint a plain field update can violate is the per-KB
    // case-insensitive term uniqueness — surface it as a conflict, not a 500.
    if (isUniqueViolation(err)) {
      return { ok: false, error: `"${input.term?.trim()}" is already defined in this Knowledge Base`, conflict: true };
    }
    throw err;
  }
}

export function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === '23505';
}

export async function deleteEntry(id: string, exec: QueryExec = query): Promise<boolean> {
  const r = await exec(`DELETE FROM knowledge_entries WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

/** Replace an entry's block content wholesale. Block validation happens in blocks.ts. */
export async function setEntryContent(
  id: string,
  blocks: BlockLike[],
  exec: QueryExec = query
): Promise<KnowledgeEntryRow | null> {
  const r = await exec(
    `UPDATE knowledge_entries SET content = $1, version = version + 1, updated_at = NOW()
      WHERE id = $2 RETURNING *`,
    [JSON.stringify({ version: 1, blocks }), id]
  );
  return (r.rows[0] as KnowledgeEntryRow | undefined) ?? null;
}
