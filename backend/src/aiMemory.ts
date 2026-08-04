// ---------------------------------------------------------------------------
// Sol's long-term memory — small, durable per-user facts (preferences,
// standing context) that ride in every chat's system prompt, so Sol stops
// re-asking things it should already know. The user-scoped counterpart to
// AI Skills' instance-wide admin context: same "ride in every prompt, kept
// cheap" shape, but private to one user and writable by that user's own
// assistant rather than an admin.
//
// Deliberately NOT a transcript store — full chat history stays out of the
// system prompt entirely and is reached only via the search_chat_history AI
// tool (aiTools.ts), on demand. Memory here is meant to stay small: caps
// below keep it from growing into a second history log.
//
// Every exported function takes an injectable QueryExec (defaulting to the
// pool), per the established convention (see aiSkills/skills.ts), so it
// composes inside a caller's transaction and is unit-testable with no live DB.
// ---------------------------------------------------------------------------

import { v4 as uuidv4 } from 'uuid';
import { query } from './db';
import type { QueryExec } from './workspaceUtil';

export interface AiUserMemoryRow {
  id: string;
  user_id: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export function sanitizeMemory(row: AiUserMemoryRow) {
  return {
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type SanitizedMemory = ReturnType<typeof sanitizeMemory>;

export type MemoryResult<T> = { ok: true; memory: T } | { ok: false; error: string };

// Kept small on purpose — this rides in every single chat's system prompt, so
// it must never grow into a second, unbounded history log.
export const MAX_MEMORY_ENTRIES = 40;
export const MAX_MEMORY_CONTENT_LENGTH = 500;

export async function listMemory(userId: string, exec: QueryExec = query): Promise<AiUserMemoryRow[]> {
  const r = await exec(`SELECT * FROM ai_user_memory WHERE user_id = $1 ORDER BY created_at ASC`, [userId]);
  return r.rows as AiUserMemoryRow[];
}

export async function addMemory(
  userId: string,
  content: string,
  exec: QueryExec = query
): Promise<MemoryResult<AiUserMemoryRow>> {
  const clean = content.trim();
  if (!clean) return { ok: false, error: 'content is required' };
  if (clean.length > MAX_MEMORY_CONTENT_LENGTH) {
    return { ok: false, error: `content is too long (max ${MAX_MEMORY_CONTENT_LENGTH} characters) — keep it to one durable fact` };
  }
  const countRes = await exec(`SELECT COUNT(*)::int AS n FROM ai_user_memory WHERE user_id = $1`, [userId]);
  const count = (countRes.rows[0] as { n: number } | undefined)?.n ?? 0;
  if (count >= MAX_MEMORY_ENTRIES) {
    return { ok: false, error: `memory is full (max ${MAX_MEMORY_ENTRIES} entries) — remove something with forget_memory first` };
  }

  const id = `mem_${uuidv4()}`;
  const r = await exec(
    `INSERT INTO ai_user_memory (id, user_id, content) VALUES ($1, $2, $3) RETURNING *`,
    [id, userId, clean]
  );
  return { ok: true, memory: r.rows[0] as AiUserMemoryRow };
}

export async function removeMemory(userId: string, id: string, exec: QueryExec = query): Promise<boolean> {
  const r = await exec(`DELETE FROM ai_user_memory WHERE id = $1 AND user_id = $2`, [id, userId]);
  return (r.rowCount ?? 0) > 0;
}

export async function clearMemory(userId: string, exec: QueryExec = query): Promise<number> {
  const r = await exec(`DELETE FROM ai_user_memory WHERE user_id = $1`, [userId]);
  return r.rowCount ?? 0;
}
