// ---------------------------------------------------------------------------
// Thin wrapper around the Resend SDK. Configuration (API key, sender address/
// name, on/off) is admin-configurable from Settings → Email rather than an
// env var, so it lives in `app_settings` — the key encrypted at rest via
// resendCrypto.ts. Degrades gracefully: with no key configured (or the
// feature switched off), sendEmail() simply reports `{ok: false}` instead of
// throwing, the same "check reality, no feature flag to keep in sync"
// contract the Knowledge Layer's embedding provider already holds.
// ---------------------------------------------------------------------------

import { query } from '../db';
import { decryptSecret, encryptSecret } from '../resendCrypto';

const RESEND_SETTINGS_KEYS = ['resend_api_key', 'resend_enabled', 'resend_from_email', 'resend_from_name'] as const;

export interface ResendSettings {
  /** True once an API key has ever been saved (regardless of the enabled toggle). */
  configured: boolean;
  enabled: boolean;
  apiKey: string | null;
  fromEmail: string;
  fromName: string;
}

export async function getResendSettings(): Promise<ResendSettings> {
  const result = await query<{ key: string; value: string }>(
    `SELECT key, value FROM app_settings WHERE key = ANY($1)`,
    [RESEND_SETTINGS_KEYS as unknown as string[]]
  );
  const map: Record<string, string> = {};
  for (const row of result.rows) map[row.key] = row.value;
  const rawKey = map['resend_api_key'];
  return {
    configured: !!rawKey,
    enabled: map['resend_enabled'] !== 'false',
    apiKey: rawKey ? decryptSecret(rawKey) : null,
    fromEmail: map['resend_from_email'] ?? '',
    fromName: map['resend_from_name'] ?? 'Solytiq Cloud',
  };
}

/** Encrypts and stores a new API key. Pass an empty string to clear it. */
export async function setResendApiKey(rawKey: string): Promise<void> {
  const trimmed = rawKey.trim();
  if (!trimmed) {
    await query(`DELETE FROM app_settings WHERE key = 'resend_api_key'`);
    return;
  }
  await query(
    `INSERT INTO app_settings (key, value) VALUES ('resend_api_key', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [encryptSecret(trimmed)]
  );
}

/** Last 4 characters of the configured key, for display in the admin UI —
 *  never the key itself. Returns null when nothing is configured. */
export async function getResendApiKeyHint(): Promise<string | null> {
  const settings = await getResendSettings();
  if (!settings.apiKey) return null;
  return settings.apiKey.slice(-4);
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

export interface SendEmailResult {
  ok: boolean;
  error?: string;
}

// One cached SDK client per API key — avoids reconstructing it on every send
// while still picking up a rotated key on the next call (the settings row
// itself is always re-read fresh, only the SDK instance is cached).
let cachedClient: { apiKey: string; client: InstanceType<typeof import('resend').Resend> } | null = null;

async function getClient(apiKey: string) {
  if (cachedClient && cachedClient.apiKey === apiKey) return cachedClient.client;
  const { Resend } = await import('resend');
  const client = new Resend(apiKey);
  cachedClient = { apiKey, client };
  return client;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  try {
    const settings = await getResendSettings();
    if (!settings.enabled || !settings.configured || !settings.apiKey) {
      return { ok: false, error: 'Email notifications are not configured' };
    }
    if (!settings.fromEmail) {
      return { ok: false, error: 'No sender address configured' };
    }
    const client = await getClient(settings.apiKey);
    const from = settings.fromName ? `${settings.fromName} <${settings.fromEmail}>` : settings.fromEmail;
    const { error } = await client.emails.send({ from, to: input.to, subject: input.subject, html: input.html });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}
