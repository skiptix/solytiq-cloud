// ---------------------------------------------------------------------------
// VAPID keypair management for Web Push.
//
// VAPID ("Voluntary Application Server Identification") is how Apple's,
// Google's and Mozilla's push services identify THIS instance as the legitimate
// sender for a subscription. Every subscription a browser mints is bound to the
// public key it was created with, so the keypair has exactly two requirements:
// it must exist, and it must never change afterwards.
//
// It is therefore generated ONCE on first boot and stored in `app_settings`,
// not read from an env var — a self-hosted instance gets working push with zero
// extra configuration, which is the same reason the Resend API key lives there
// rather than in the environment. An operator who wants to supply their own
// keypair (e.g. to keep subscriptions alive across a database reset) can still
// set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, which take precedence.
//
// The private half is encrypted at rest with the same AES-256-GCM helper the
// Resend key uses (resendCrypto.ts) — it is the one value here that genuinely
// is a secret; a subscription's own p256dh/auth are public material the browser
// hands out in the clear.
// ---------------------------------------------------------------------------

import webpush from 'web-push';
import { query } from '../db';
import { decryptSecret, encryptSecret } from '../resendCrypto';

const PUBLIC_KEY_SETTING = 'vapid_public_key';
const PRIVATE_KEY_SETTING = 'vapid_private_key';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  /** `mailto:`/`https:` contact the push service can reach the operator on. */
  subject: string;
}

// Cached for the process lifetime. The keypair is immutable once generated, so
// unlike the Resend settings (which an admin can rotate from the UI at any
// moment) there is nothing to re-read — a cache miss only costs one query.
let cached: VapidKeys | null = null;

/** The contact address the push service sees. Not a delivery channel — it is
 *  only used by push providers to reach an operator about a misbehaving sender,
 *  so a generic mailto is a fine default when none is configured. */
function vapidSubject(): string {
  const configured = process.env.VAPID_SUBJECT?.trim();
  if (configured && (configured.startsWith('mailto:') || configured.startsWith('https://'))) return configured;
  return 'mailto:admin@solytiq.local';
}

/**
 * The instance keypair, generating and persisting one on first call.
 *
 * Concurrency: two replicas booting at once could both find no row and both
 * generate. The INSERT is `ON CONFLICT DO NOTHING` followed by a re-read, so
 * the loser adopts the winner's keys rather than silently running with a
 * keypair the database doesn't hold — which would invalidate every
 * subscription minted against it the moment that replica restarted.
 */
export async function getVapidKeys(): Promise<VapidKeys | null> {
  if (cached) return cached;

  const envPublic = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPrivate = process.env.VAPID_PRIVATE_KEY?.trim();
  if (envPublic && envPrivate) {
    cached = { publicKey: envPublic, privateKey: envPrivate, subject: vapidSubject() };
    return cached;
  }

  try {
    const existing = await readStoredKeys();
    if (existing) {
      cached = existing;
      return cached;
    }

    const generated = webpush.generateVAPIDKeys();
    await query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2), ($3, $4) ON CONFLICT (key) DO NOTHING`,
      [PUBLIC_KEY_SETTING, generated.publicKey, PRIVATE_KEY_SETTING, encryptSecret(generated.privateKey)]
    );
    // Re-read rather than trusting what we just generated: on a race the
    // INSERT was a no-op and the stored pair belongs to the other replica.
    const stored = await readStoredKeys();
    if (!stored) return null;
    cached = stored;
    console.log('🔔 Generated this instance\'s VAPID keypair for Web Push.');
    return cached;
  } catch (err) {
    console.error('🔔 ✗ getVapidKeys failed', err);
    return null;
  }
}

async function readStoredKeys(): Promise<VapidKeys | null> {
  const r = await query<{ key: string; value: string }>(
    `SELECT key, value FROM app_settings WHERE key = ANY($1)`,
    [[PUBLIC_KEY_SETTING, PRIVATE_KEY_SETTING]]
  );
  const map: Record<string, string> = {};
  for (const row of r.rows) map[row.key] = row.value;
  const publicKey = map[PUBLIC_KEY_SETTING];
  const privateKey = map[PRIVATE_KEY_SETTING];
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey: decryptSecret(privateKey), subject: vapidSubject() };
}

/** The public key the browser needs to create a subscription. Safe to expose to
 *  any authenticated client — it is, by design, public. */
export async function getVapidPublicKey(): Promise<string | null> {
  const keys = await getVapidKeys();
  return keys?.publicKey ?? null;
}

/** Test seam — drops the process-lifetime cache. */
export function resetVapidCache(): void {
  cached = null;
}
