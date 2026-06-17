// ---------------------------------------------------------------------------
// CalDAV app-specific credentials.
//
// The CalDAV client (Apple Calendar, Thunderbird, …) authenticates with the
// user's email + a dedicated password generated here and shown to the user
// ONCE. Only a bcrypt hash is stored, and the credential is independently
// revocable — the account password is never exposed to the calendar client.
// ---------------------------------------------------------------------------

import crypto from 'crypto';
import { query } from '../db';
import { hashPassword, comparePassword } from '../auth';

// Apple-style grouped password: 4 × 4 lowercase/number groups, e.g. "a3kd-9f2p-…".
export function generateCaldavPassword(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'; // no ambiguous chars
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) out += '-';
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

// Short-lived verification cache. CalDAV clients poll often and re-send Basic
// auth on every request; bcrypt on each would be costly. The key includes the
// password, so only correct credentials are ever cached. Any password change or
// revoke clears the cache so revocation takes effect immediately.
const verifyCache = new Map<string, { userId: string; exp: number }>();
const VERIFY_TTL_MS = 5 * 60 * 1000;
const cacheKey = (email: string, password: string) =>
  crypto.createHash('sha256').update(`${email.toLowerCase()}:${password}`).digest('hex');

export async function setCaldavPassword(userId: string, rawPassword: string): Promise<void> {
  const hash = await hashPassword(rawPassword);
  await query(
    `INSERT INTO caldav_credentials (user_id, password_hash, created_at, last_used_at)
     VALUES ($1, $2, NOW(), NULL)
     ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, created_at = NOW(), last_used_at = NULL`,
    [userId, hash]
  );
  verifyCache.clear();
}

export async function revokeCaldav(userId: string): Promise<void> {
  await query(`DELETE FROM caldav_credentials WHERE user_id = $1`, [userId]);
  verifyCache.clear();
}

export interface CaldavStatus { connected: boolean; createdAt: string | null; lastUsedAt: string | null }

export async function getCaldavStatus(userId: string): Promise<CaldavStatus> {
  const r = await query<{ created_at: string; last_used_at: string | null }>(
    `SELECT created_at, last_used_at FROM caldav_credentials WHERE user_id = $1`,
    [userId]
  );
  const row = r.rows[0];
  return { connected: !!row, createdAt: row?.created_at ?? null, lastUsedAt: row?.last_used_at ?? null };
}

/**
 * Verify an email + CalDAV password pair. Returns the user id when valid,
 * else null. Touches last_used_at on success (fire-and-forget).
 */
export async function verifyCaldavLogin(email: string, password: string): Promise<{ userId: string } | null> {
  if (!email || !password) return null;

  const key = cacheKey(email, password);
  const hit = verifyCache.get(key);
  if (hit && hit.exp > Date.now()) return { userId: hit.userId };

  const r = await query<{ id: string; hash: string | null }>(
    `SELECT u.id, c.password_hash AS hash
     FROM users u
     LEFT JOIN caldav_credentials c ON c.user_id = u.id
     WHERE LOWER(u.email) = LOWER($1)`,
    [email]
  );
  const row = r.rows[0];
  if (!row || !row.hash) return null;
  const ok = await comparePassword(password, row.hash);
  if (!ok) return null;
  verifyCache.set(key, { userId: row.id, exp: Date.now() + VERIFY_TTL_MS });
  query(`UPDATE caldav_credentials SET last_used_at = NOW() WHERE user_id = $1`, [row.id]).catch(() => {});
  return { userId: row.id };
}
