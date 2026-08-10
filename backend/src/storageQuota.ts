// ---------------------------------------------------------------------------
// S6 — per-user storage quota: race-safe check-and-reserve.
//
// SECURITY: every upload endpoint that enforced a quota at all did so with a
// classic check-then-act race — `SELECT SUM(file_size) ... WHERE user_id = $1`
// on one connection, then (after the multer disk write had already
// happened) a separate `INSERT` on another. Two concurrent uploads from the
// SAME user can both read "under quota" before either commits, jointly
// landing the user well over their 15GB cap — CLAUDE.md's own documented
// invariant ("Storage quota checks must be done inside a transaction or with
// SELECT ... FOR UPDATE to prevent over-quota uploads under concurrent
// load") names this exact failure mode.
//
// withQuotaReservation() closes it with a per-user Postgres advisory
// transaction lock (`pg_advisory_xact_lock`): the SUM, the quota check, AND
// the caller's own INSERT(s) all run on ONE connection inside ONE
// transaction, serialized against any other in-flight reservation for the
// same user. The lock is released automatically on COMMIT/ROLLBACK — there
// is no code path that can leak it past this call.
// ---------------------------------------------------------------------------

import type { PoolClient } from 'pg';
import { pool, withTransaction } from './db';

const DEFAULT_QUOTA = 15 * 1024 * 1024 * 1024; // 15 GB

/** Minimal shape both `pool` and a `PoolClient` satisfy — lets every read
 *  below run identically whether or not it's inside a reservation's lock. */
interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export async function getUserQuota(exec: Queryable = pool): Promise<number> {
  const r = await exec.query<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = 'storage_quota_per_user'"
  );
  return r.rows[0] ? parseInt(r.rows[0].value, 10) : DEFAULT_QUOTA;
}

/**
 * Total bytes counted against a user's quota — every table that persists an
 * uploaded file's bytes to disk under UPLOAD_DIR.
 *
 * Deliberately EXCLUDES:
 *   - `markdown_list_images` (the same polymorphic table backs both Markdown
 *     Page inline images AND Knowledge Base entry images) — a pre-existing,
 *     documented design decision (see routes/markdownLists.ts's own header
 *     comment): its own 15MB-per-file multer cap is the bound, not the
 *     user's overall quota. Not a gap this fix changes.
 *   - `ai_chat_files` — multer `memoryStorage()`; the raw bytes are never
 *     written to disk at all (only extracted text is persisted to the DB),
 *     so there is no on-disk footprint to count.
 */
export async function getUserStorageUsed(userId: string, exec: Queryable = pool): Promise<number> {
  const r = await exec.query<{ used: string }>(
    `SELECT (
       COALESCE((SELECT SUM(file_size) FROM shared_files WHERE user_id = $1), 0)
     + COALESCE((SELECT SUM(file_size) FROM task_attachments WHERE user_id = $1 AND attachment_type = 'upload'), 0)
     + COALESCE((SELECT SUM(file_size) FROM milestone_attachments WHERE user_id = $1 AND attachment_type = 'upload'), 0)
     + COALESCE((SELECT SUM(file_size) FROM gps_files WHERE user_id = $1), 0)
     ) AS used`,
    [userId]
  );
  return parseInt(r.rows[0]?.used ?? '0', 10);
}

export class QuotaExceededError extends Error {
  constructor(public used: number, public quota: number) {
    super('Storage quota exceeded');
    this.name = 'QuotaExceededError';
  }
}

export type QuotaReservationResult<T> =
  | { ok: true; result: T }
  | { ok: false; used: number; quota: number };

/**
 * Runs `fn` (the caller's own INSERT of a new upload row, using the `client`
 * it's handed — NOT the module-level `query()` helper, which would use a
 * DIFFERENT connection and defeat the whole point) inside a single
 * transaction, gated by a per-user advisory lock so the quota check and the
 * insert are atomic together. `isAdmin` callers skip the check entirely
 * (admins are exempt everywhere else this quota is enforced) but still run
 * `fn` inside a plain transaction for a consistent call shape.
 */
export async function withQuotaReservation<T>(
  userId: string,
  additionalBytes: number,
  isAdmin: boolean,
  fn: (client: PoolClient) => Promise<T>
): Promise<QuotaReservationResult<T>> {
  if (isAdmin) {
    const result = await withTransaction(fn);
    return { ok: true, result };
  }
  try {
    const result = await withTransaction(async (client) => {
      // Scope the lock to THIS user only — hashtext() collapses the uuid
      // into the bigint key pg_advisory_xact_lock expects. A hash collision
      // across two different users only costs a little extra serialization
      // between them; it can never cause an incorrect quota decision, since
      // the SUM below is still computed per-user regardless of who else
      // happens to (rarely) share the same lock key.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`storage_quota:${userId}`]);
      const used = await getUserStorageUsed(userId, client);
      const quota = await getUserQuota(client);
      if (used + additionalBytes > quota) {
        throw new QuotaExceededError(used, quota);
      }
      return fn(client);
    });
    return { ok: true, result };
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return { ok: false, used: err.used, quota: err.quota };
    }
    throw err;
  }
}
