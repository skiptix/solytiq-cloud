// ---------------------------------------------------------------------------
// Personal Access Tokens (PATs) for external AI agents (e.g. the MCP server).
//
// Unlike the 7-day session JWT, a PAT is a long-lived, individually revocable
// credential the user generates in Settings and pastes into Claude Desktop (or
// any MCP client). The raw secret is shown to the user exactly once; only a
// SHA-256 hash is stored, so a database leak never exposes usable tokens.
//
// Format:  solytiq_pat_<43 url-safe base64 chars>
// Lookup:  SHA-256(raw) === token_hash  (fast, indexed, constant work).
// ---------------------------------------------------------------------------

import crypto from 'crypto';
import { query } from './db';

const TOKEN_PREFIX = 'solytiq_pat_';

export interface GeneratedApiToken {
  /** The full secret — return to the user ONCE, never stored in plaintext. */
  raw: string;
  /** SHA-256 hex of the raw token — what we persist and look up by. */
  hash: string;
  /** Short, non-secret display hint (e.g. "solytiq_pat_AbCd…"). */
  prefix: string;
}

export function hashApiToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Mint a new random PAT. The raw value is only available from this call. */
export function generateApiToken(): GeneratedApiToken {
  const raw = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  return {
    raw,
    hash: hashApiToken(raw),
    // Show enough to recognise a token in a list without revealing it.
    prefix: raw.slice(0, TOKEN_PREFIX.length + 6) + '…',
  };
}

export interface ApiTokenAuthResult {
  userId: string;
  tokenId: string;
}

/**
 * Authenticate a raw PAT. Returns the owning user (and token id) when the token
 * exists, is not expired, and the owning user still exists; otherwise null.
 * Updates `last_used_at` opportunistically (fire-and-forget).
 */
export async function authenticateApiToken(raw: string): Promise<ApiTokenAuthResult | null> {
  if (!raw || !raw.startsWith(TOKEN_PREFIX)) return null;

  const hash = hashApiToken(raw);
  const result = await query<{ id: string; user_id: string; expires_at: string | null }>(
    `SELECT t.id, t.user_id, t.expires_at
     FROM api_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1`,
    [hash]
  );

  const row = result.rows[0];
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;

  // Touch last_used_at without blocking the request.
  query(`UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1`, [row.id]).catch(() => {});

  return { userId: row.user_id, tokenId: row.id };
}
