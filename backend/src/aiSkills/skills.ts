// ---------------------------------------------------------------------------
// AI Skills data layer — admin-curated, instance-wide context bundles that
// personalize/extend Sol, the Agent Runtime, and MCP clients.
//
// Not workspace-scoped (unlike the Knowledge Base): a Skill is instance-wide,
// so access is simpler — anyone signed in can READ an enabled skill (that's
// the whole point, it's meant to inform every user's assistant), only an
// admin can WRITE (create/update/delete/enable/disable, and manage bundled
// files). See isUserAdmin() below, used by both the REST routes and the
// admin-gated AI tools in aiTools.ts.
//
// Every exported function takes an injectable QueryExec (defaulting to the
// pool) per the established convention (see knowledgeBase/entries.ts), so it
// composes inside a caller's transaction and is unit-testable against a mock
// exec with no live DB.
// ---------------------------------------------------------------------------

import { v4 as uuidv4 } from 'uuid';
import { query } from '../db';
import type { QueryExec } from '../workspaceUtil';

export type AiSkillSource = 'manual' | 'upload_md' | 'upload_zip';
export type AiSkillOrigin = 'manual' | 'ai';

export interface AiSkillRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  content: string;
  enabled: boolean;
  source: AiSkillSource;
  origin: AiSkillOrigin;
  created_by: string | null;
  updated_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  file_count?: number;
}

export interface AiSkillFileRow {
  id: string;
  skill_id: string;
  file_path: string;
  content: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
}

export function sanitizeSkill(row: AiSkillRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    content: row.content,
    enabled: row.enabled,
    source: row.source,
    origin: row.origin,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    version: row.version,
    fileCount: row.file_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function sanitizeSkillFile(row: AiSkillFileRow) {
  return {
    id: row.id,
    skillId: row.skill_id,
    filePath: row.file_path,
    content: row.content,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type SanitizedSkill = ReturnType<typeof sanitizeSkill>;
export type SanitizedSkillFile = ReturnType<typeof sanitizeSkillFile>;

// ---------------------------------------------------------------------------
// Admin check — used by the REST routes (via requireAdmin) AND by the AI
// tools, whose handlers only ever receive a userId (see aiTools.ts's AiTool
// type). There is no role parameter on a tool call, so a mutation tool must
// re-derive it here rather than trusting anything the model claims.
// ---------------------------------------------------------------------------

export async function isUserAdmin(userId: string, exec: QueryExec = query): Promise<boolean> {
  const r = await exec(`SELECT is_admin FROM users WHERE id = $1`, [userId]);
  return (r.rows[0] as { is_admin?: boolean } | undefined)?.is_admin === true;
}

// ---------------------------------------------------------------------------
// Slugs — a stable, human-readable id a caller (including an AI tool with no
// UI) can reference a skill by, in addition to its opaque id.
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return base || 'skill';
}

async function uniqueSlug(name: string, exec: QueryExec, excludeId?: string): Promise<string> {
  const base = slugify(name);
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const r = await exec(
      `SELECT 1 FROM ai_skills WHERE slug = $1 ${excludeId ? 'AND id != $2' : ''}`,
      excludeId ? [candidate, excludeId] : [candidate]
    );
    if (r.rows.length === 0) return candidate;
  }
  // Astronomically unlikely (50 name collisions), but keep this total.
  return `${base}-${uuidv4().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export async function listSkills(
  opts: { enabledOnly?: boolean } = {},
  exec: QueryExec = query
): Promise<AiSkillRow[]> {
  const r = await exec(
    `SELECT s.*, COUNT(f.id)::int AS file_count
       FROM ai_skills s
       LEFT JOIN ai_skill_files f ON f.skill_id = s.id
       ${opts.enabledOnly ? 'WHERE s.enabled = true' : ''}
       GROUP BY s.id
       ORDER BY lower(s.name) ASC`
  );
  return r.rows as AiSkillRow[];
}

export async function getSkill(id: string, exec: QueryExec = query): Promise<AiSkillRow | null> {
  const r = await exec(
    `SELECT s.*, COUNT(f.id)::int AS file_count
       FROM ai_skills s
       LEFT JOIN ai_skill_files f ON f.skill_id = s.id
      WHERE s.id = $1
      GROUP BY s.id`,
    [id]
  );
  return (r.rows[0] as AiSkillRow | undefined) ?? null;
}

export async function getSkillBySlug(slug: string, exec: QueryExec = query): Promise<AiSkillRow | null> {
  const r = await exec(
    `SELECT s.*, COUNT(f.id)::int AS file_count
       FROM ai_skills s
       LEFT JOIN ai_skill_files f ON f.skill_id = s.id
      WHERE s.slug = $1
      GROUP BY s.id`,
    [slug]
  );
  return (r.rows[0] as AiSkillRow | undefined) ?? null;
}

/** Resolve a skill by its opaque id OR its slug — the shape an AI tool call receives. */
export async function findSkill(idOrSlug: string, exec: QueryExec = query): Promise<AiSkillRow | null> {
  return (await getSkill(idOrSlug, exec)) ?? (await getSkillBySlug(idOrSlug, exec));
}

export interface CreateSkillInput {
  name: string;
  description?: string;
  content: string;
  source?: AiSkillSource;
  origin?: AiSkillOrigin;
  createdBy?: string | null;
}

export type SkillResult<T> = { ok: true; skill: T } | { ok: false; error: string };

export async function createSkill(
  input: CreateSkillInput,
  exec: QueryExec = query
): Promise<SkillResult<AiSkillRow>> {
  const name = (input.name ?? '').trim();
  if (!name) return { ok: false, error: 'A name is required' };
  if (name.length > 200) return { ok: false, error: 'Name is too long (max 200 characters)' };
  const content = input.content ?? '';
  if (!content.trim()) return { ok: false, error: 'content (the SKILL.md body) is required' };

  const id = `skill_${uuidv4()}`;
  const slug = await uniqueSlug(name, exec);
  const r = await exec(
    `INSERT INTO ai_skills (id, name, slug, description, content, source, origin, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     RETURNING *, 0 AS file_count`,
    [id, name, slug, (input.description ?? '').trim(), content, input.source ?? 'manual', input.origin ?? 'manual', input.createdBy ?? null]
  );
  return { ok: true, skill: r.rows[0] as AiSkillRow };
}

export interface UpdateSkillInput {
  name?: string;
  description?: string;
  content?: string;
  enabled?: boolean;
  updatedBy?: string | null;
}

export async function updateSkill(
  id: string,
  input: UpdateSkillInput,
  exec: QueryExec = query
): Promise<SkillResult<AiSkillRow>> {
  const existing = await getSkill(id, exec);
  if (!existing) return { ok: false, error: 'Skill not found' };

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return { ok: false, error: 'A name is required' };
    if (name.length > 200) return { ok: false, error: 'Name is too long (max 200 characters)' };
    push('name', name);
    if (name !== existing.name) push('slug', await uniqueSlug(name, exec, id));
  }
  if (input.description !== undefined) push('description', input.description.trim());
  if (input.content !== undefined) {
    if (!input.content.trim()) return { ok: false, error: 'content cannot be empty' };
    push('content', input.content);
  }
  if (input.enabled !== undefined) push('enabled', input.enabled);
  if (input.updatedBy !== undefined) push('updated_by', input.updatedBy);

  if (sets.length === 0) return { ok: true, skill: existing };

  params.push(id);
  const r = await exec(
    `UPDATE ai_skills SET ${sets.join(', ')}, version = version + 1, updated_at = NOW()
      WHERE id = $${params.length}
      RETURNING *, (SELECT COUNT(*)::int FROM ai_skill_files WHERE skill_id = ai_skills.id) AS file_count`,
    params
  );
  const row = r.rows[0] as AiSkillRow | undefined;
  return row ? { ok: true, skill: row } : { ok: false, error: 'Skill not found' };
}

export async function setSkillEnabled(
  id: string,
  enabled: boolean,
  exec: QueryExec = query
): Promise<SkillResult<AiSkillRow>> {
  return updateSkill(id, { enabled }, exec);
}

export async function deleteSkill(id: string, exec: QueryExec = query): Promise<boolean> {
  const r = await exec(`DELETE FROM ai_skills WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Bundled files — text-only reference material alongside SKILL.md. Never
// executed (see index.ts's migration comment); read by the read_skill_file
// tool and, for a .zip upload, populated in bulk by replaceSkillFiles().
// ---------------------------------------------------------------------------

export async function listSkillFiles(skillId: string, exec: QueryExec = query): Promise<AiSkillFileRow[]> {
  const r = await exec(`SELECT * FROM ai_skill_files WHERE skill_id = $1 ORDER BY file_path ASC`, [skillId]);
  return r.rows as AiSkillFileRow[];
}

export async function getSkillFile(
  skillId: string,
  filePath: string,
  exec: QueryExec = query
): Promise<AiSkillFileRow | null> {
  const r = await exec(`SELECT * FROM ai_skill_files WHERE skill_id = $1 AND file_path = $2`, [skillId, filePath]);
  return (r.rows[0] as AiSkillFileRow | undefined) ?? null;
}

const MAX_SKILL_FILE_BYTES = 256 * 1024;

export async function setSkillFile(
  skillId: string,
  filePath: string,
  content: string,
  exec: QueryExec = query
): Promise<SkillResult<AiSkillFileRow>> {
  const cleanPath = filePath.trim().replace(/^\/+/, '');
  if (!cleanPath) return { ok: false, error: 'file_path is required' };
  if (cleanPath.includes('..')) return { ok: false, error: 'file_path may not contain ".."' };
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_SKILL_FILE_BYTES) return { ok: false, error: `File is too large (max ${MAX_SKILL_FILE_BYTES / 1024}KB)` };

  const id = `skf_${uuidv4()}`;
  const r = await exec(
    `INSERT INTO ai_skill_files (id, skill_id, file_path, content, size_bytes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (skill_id, file_path)
     DO UPDATE SET content = $4, size_bytes = $5, updated_at = NOW()
     RETURNING *`,
    [id, skillId, cleanPath, content, bytes]
  );
  return { ok: true, skill: r.rows[0] as AiSkillFileRow };
}

export async function removeSkillFile(skillId: string, filePath: string, exec: QueryExec = query): Promise<boolean> {
  const r = await exec(`DELETE FROM ai_skill_files WHERE skill_id = $1 AND file_path = $2`, [skillId, filePath]);
  return (r.rowCount ?? 0) > 0;
}

/** Replace a skill's entire file set (used by a .zip bundle upload). Caller
 *  should run this inside a transaction alongside the skill's own content
 *  update so a partial bundle never persists. */
export async function replaceSkillFiles(
  skillId: string,
  files: { path: string; content: string }[],
  exec: QueryExec = query
): Promise<void> {
  await exec(`DELETE FROM ai_skill_files WHERE skill_id = $1`, [skillId]);
  for (const f of files) {
    const bytes = Buffer.byteLength(f.content, 'utf8');
    if (bytes > MAX_SKILL_FILE_BYTES) continue; // bundle.ts already filters these, this is a hard backstop
    const id = `skf_${uuidv4()}`;
    await exec(
      `INSERT INTO ai_skill_files (id, skill_id, file_path, content, size_bytes) VALUES ($1, $2, $3, $4, $5)`,
      [id, skillId, f.path, f.content, bytes]
    );
  }
}
