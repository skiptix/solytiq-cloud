// ---------------------------------------------------------------------------
// push_subscriptions CRUD.
//
// A subscription is minted by the BROWSER's push service (Apple's for an iOS
// Home Screen app, Google's/Mozilla's elsewhere) and is identified by its own
// opaque `endpoint` URL. That endpoint is the natural key: the same device
// re-subscribing hands back the same endpoint, so an upsert on it keeps one row
// per device rather than accumulating a new one per launch — the same shape the
// `homescreen_connections` install-id upsert already established.
//
// Every function here accepts an injectable QueryExec (defaulting to the pool)
// per the codebase convention, so it composes inside a caller's transaction and
// is unit-testable against a mock exec with no live database.
// ---------------------------------------------------------------------------

import { query } from '../db';
import type { QueryExec } from '../workspaceUtil';

/** The shape the browser's PushSubscription.toJSON() produces. */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface StoredPushSubscription {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceName: string;
  osVersion: string | null;
  installId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  device_name: string;
  os_version: string | null;
  install_id: string | null;
  created_at: string;
  last_used_at: string | null;
}

function sanitizeRow(r: SubscriptionRow): StoredPushSubscription {
  return {
    id: r.id,
    userId: r.user_id,
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    deviceName: r.device_name,
    osVersion: r.os_version,
    installId: r.install_id,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

/** A push endpoint must be an https URL — anything else is either a client bug
 *  or an attempt to make this server issue requests somewhere it shouldn't. */
export function isValidEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2000) return false;
  try {
    return new URL(endpoint).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Register (or refresh) a device's subscription.
 *
 * The conflict target is `endpoint` alone, NOT (user_id, endpoint): a browser
 * profile has exactly one subscription per push service, so if a second user
 * signs in on the same device the endpoint genuinely moves to them. Keying on
 * the pair would leave the first user's stale row behind and keep delivering
 * their notifications to a device someone else is now holding.
 */
export async function upsertSubscription(
  userId: string,
  sub: PushSubscriptionInput,
  device: { deviceName?: string | null; osVersion?: string | null; installId?: string | null },
  exec: QueryExec = query
): Promise<StoredPushSubscription> {
  const r = await exec(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device_name, os_version, install_id, last_used_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (endpoint) DO UPDATE SET
       user_id       = EXCLUDED.user_id,
       p256dh        = EXCLUDED.p256dh,
       auth          = EXCLUDED.auth,
       device_name   = EXCLUDED.device_name,
       os_version    = EXCLUDED.os_version,
       install_id    = EXCLUDED.install_id,
       last_used_at  = NOW(),
       failure_count = 0,
       last_error    = NULL
     RETURNING *`,
    [
      userId,
      sub.endpoint,
      sub.keys.p256dh,
      sub.keys.auth,
      device.deviceName || 'Home Screen App',
      device.osVersion ?? null,
      device.installId ?? null,
    ]
  );
  return sanitizeRow(r.rows[0] as unknown as SubscriptionRow);
}

/** Every live subscription for one user — the fan-out list for a notification. */
export async function listSubscriptionsForUser(userId: string, exec: QueryExec = query): Promise<StoredPushSubscription[]> {
  const r = await exec(
    `SELECT * FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId]
  );
  return (r.rows as unknown as SubscriptionRow[]).map(sanitizeRow);
}

/** Remove one subscription by endpoint, scoped to its owner. Used by the
 *  client's own unsubscribe path — a user revoking a device. */
export async function deleteSubscriptionByEndpoint(userId: string, endpoint: string, exec: QueryExec = query): Promise<boolean> {
  const r = await exec(`DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, [userId, endpoint]);
  return (r.rowCount ?? 0) > 0;
}

/** Remove one subscription by id, scoped to its owner (the Settings device list). */
export async function deleteSubscriptionById(userId: string, id: string, exec: QueryExec = query): Promise<boolean> {
  const r = await exec(`DELETE FROM push_subscriptions WHERE user_id = $1 AND id = $2`, [userId, id]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Drop a subscription the push service itself has rejected as gone (404/410).
 *
 * Deliberately NOT scoped to a user: this is the push service telling us the
 * endpoint no longer exists at all, and the row is identified by that endpoint.
 * Keeping it would mean retrying a dead endpoint on every future notification
 * forever.
 */
export async function deleteDeadSubscription(endpoint: string, exec: QueryExec = query): Promise<void> {
  await exec(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
}

/** Record a transient delivery failure. A subscription is NOT deleted for these
 *  — only an explicit 404/410 from the push service proves it's really gone —
 *  but the counter surfaces a persistently broken device in Settings. */
export async function recordDeliveryFailure(endpoint: string, error: string, exec: QueryExec = query): Promise<void> {
  await exec(
    `UPDATE push_subscriptions SET failure_count = failure_count + 1, last_error = $2 WHERE endpoint = $1`,
    [endpoint, error.slice(0, 500)]
  );
}

/** Mark a successful delivery — resets the failure counter and stamps the row
 *  so Settings can show when a device last actually received something. */
export async function recordDeliverySuccess(endpoint: string, exec: QueryExec = query): Promise<void> {
  await exec(
    `UPDATE push_subscriptions SET last_used_at = NOW(), failure_count = 0, last_error = NULL WHERE endpoint = $1`,
    [endpoint]
  );
}
