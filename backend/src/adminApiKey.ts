import crypto from 'crypto';
import { query } from './db';

const ADMIN_KEY_PREFIX = 'solytiq_admin_';

// ── Permission scopes ──────────────────────────────────────────────────────
// The single source of truth for what an admin API key is allowed to do. Each
// scope is one "feature" toggled in the key-creation wizard. `read` grants the
// instance-wide export; every other scope grants full manage (create/update/
// delete) for that resource family via the Admin API.
export const ADMIN_API_SCOPES = [
  'read',        // GET /export — read all instance data
  'users',       // create / update / delete user accounts
  'workspaces',  // create / update / delete workspaces
  'folders',     // create / update / delete folders
  'lists',       // create / update / delete lists, sections & items
  'timelines',   // create / update / delete timelines & milestones
  'meetings',    // create / update / delete calendar meetings
] as const;

export type AdminApiScope = (typeof ADMIN_API_SCOPES)[number];

const SCOPE_SET = new Set<string>(ADMIN_API_SCOPES);

/** Keep only valid, de-duplicated scopes. Falls back to `['read']` when empty. */
export function sanitizeScopes(input: unknown): AdminApiScope[] {
  const arr = Array.isArray(input) ? input : [];
  const clean = [...new Set(arr.filter((s): s is AdminApiScope => typeof s === 'string' && SCOPE_SET.has(s)))];
  return clean.length ? clean : ['read'];
}

export interface GeneratedAdminApiKey {
  raw: string;
  hash: string;
  prefix: string;
}

export interface AdminApiKeyAuthResult {
  keyId: string;
  createdBy: string;
  scopes: AdminApiScope[];
}

export function hashAdminApiKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function generateAdminApiKey(): GeneratedAdminApiKey {
  const raw = ADMIN_KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  return {
    raw,
    hash: hashAdminApiKey(raw),
    prefix: raw.slice(0, ADMIN_KEY_PREFIX.length + 6) + '…',
  };
}

export async function authenticateAdminApiKey(raw: string): Promise<AdminApiKeyAuthResult | null> {
  if (!raw || !raw.startsWith(ADMIN_KEY_PREFIX)) return null;

  const result = await query<{ id: string; created_by: string; revoked_at: string | null; scopes: unknown }>(
    `SELECT k.id, k.created_by, k.revoked_at, k.scopes
     FROM admin_api_keys k
     JOIN users u ON u.id = k.created_by AND u.is_admin = true
     WHERE k.key_hash = $1`,
    [hashAdminApiKey(raw)]
  );

  const row = result.rows[0];
  if (!row || row.revoked_at) return null;

  query(`UPDATE admin_api_keys SET last_used_at = NOW() WHERE id = $1`, [row.id]).catch(() => {});
  return { keyId: row.id, createdBy: row.created_by, scopes: sanitizeScopes(row.scopes) };
}
