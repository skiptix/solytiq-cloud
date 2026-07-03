import crypto from 'crypto';
import { query } from './db';

const ADMIN_KEY_PREFIX = 'solytiq_admin_read_';

export interface GeneratedAdminApiKey {
  raw: string;
  hash: string;
  prefix: string;
}

export interface AdminApiKeyAuthResult {
  keyId: string;
  createdBy: string;
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

  const result = await query<{ id: string; created_by: string; revoked_at: string | null }>(
    `SELECT k.id, k.created_by, k.revoked_at
     FROM admin_api_keys k
     JOIN users u ON u.id = k.created_by AND u.is_admin = true
     WHERE k.key_hash = $1`,
    [hashAdminApiKey(raw)]
  );

  const row = result.rows[0];
  if (!row || row.revoked_at) return null;

  query(`UPDATE admin_api_keys SET last_used_at = NOW() WHERE id = $1`, [row.id]).catch(() => {});
  return { keyId: row.id, createdBy: row.created_by };
}
