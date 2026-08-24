// ---------------------------------------------------------------------------
// Web Push delivery — the write side of "every notification also reaches the
// user's phone".
//
// This module is called from exactly ONE place: `createNotification()` in
// notifications.ts, right after a genuinely new row is inserted — the same hook
// point, and the same "never on an ON CONFLICT dedupe no-op" rule, that the
// Resend email channel already uses. Push is therefore an additive third
// channel (in-app feed → email → device) that can never invent a notification
// the feed doesn't also have, and every future NotificationType is wired
// through it by construction rather than by remembering to add a call.
//
// Everything here is best-effort: a missing VAPID keypair, a user with no
// registered device, an opted-out preference, or a push service returning an
// error are all silent no-ops, never exceptions into the mutation that caused
// the notification.
//
// PLATFORM NOTE (iOS): Safari only delivers Web Push to a site that has been
// added to the Home Screen (iOS 16.4+), and only through a service worker. The
// service worker (frontend/public/sw.js) handles `push` and `notificationclick`
// and nothing else — see CLAUDE.md's "Push Notifications" section for why it
// deliberately has no `fetch` handler.
// ---------------------------------------------------------------------------

import webpush from 'web-push';
import { query } from '../db';
import type { NotificationType } from '../notifications';
import {
  deleteDeadSubscription,
  listSubscriptionsForUser,
  recordDeliveryFailure,
  recordDeliverySuccess,
  type StoredPushSubscription,
} from './subscriptions';
import { getVapidKeys } from './vapid';

/**
 * Default push-on/off per type when the user has no override.
 *
 * Unlike DEFAULT_EMAIL_PREFS — which is almost entirely OFF, because an inbox
 * is someone else's space and a fresh account should not start filling it —
 * push defaults ON across the board. A device only ever receives anything at
 * all after the user has explicitly granted the OS permission prompt, so that
 * grant IS the opt-in; making them then hunt through eleven toggles to actually
 * hear about anything would be a second, pointless opt-in.
 *
 * The two genuinely low-signal types are the exception: a SUCCESSFUL automation
 * run and an agent run completing are progress reports, not events worth
 * lighting up a lock screen for. (`automation_run` additionally passes through
 * shouldPushNotification() below, which suppresses the successful ones outright.)
 */
export const DEFAULT_PUSH_PREFS: Record<NotificationType, boolean> = {
  workspace_added: true,
  item_invite: true,
  meeting_invite: true,
  item_tagged: true,
  mention: true,
  automation_run: true,
  meeting_reminder: true,
  deadline_overdue: true,
  agent_run_complete: false,
  agent_proposal: true,
  agent_change: false,
  item_added: true,
  milestone_changed: true,
  page_edited: true,
};

/** Per-type filter beyond the user's on/off preference, mirroring the email
 *  channel's `shouldEmailNotification`: a failed automation run is worth a
 *  buzz, a successful one belongs in the feed only. */
export function shouldPushNotification(type: NotificationType, data: Record<string, unknown> | undefined): boolean {
  if (type === 'automation_run') return (data as { status?: string } | undefined)?.status === 'failed';
  return true;
}

/**
 * Types where a repeat about the SAME entity should REPLACE the previous
 * notification on the lock screen rather than stack beneath it.
 *
 * This is what stops "someone is actively editing a page" or "someone pasted in
 * twenty items" from turning into twenty separate buzzes. The browser collapses
 * on the `tag` field, so these get a tag derived from the target entity (all
 * repeats share it) while every other type gets its own notification id (never
 * collapses). `renotify` is set alongside, so the replacement still alerts
 * instead of silently swapping the text under a notification the user already
 * dismissed from their attention.
 */
const COLLAPSE_BY_ENTITY: ReadonlySet<NotificationType> = new Set<NotificationType>([
  'item_added',
  'page_edited',
  'milestone_changed',
  'automation_run',
  'deadline_overdue',
]);

/** The in-app route this notification points at. Mirrors ctaForNotification()
 *  in notifications.ts — kept as a separate, deliberately dumb switch rather
 *  than shared, because the frontend's own notificationTarget() is the richer
 *  authority and duplicating THAT server-side is what we're avoiding. */
function pathForNotification(entityType: string | null | undefined, entityId: string | null | undefined, data: Record<string, unknown> | undefined): string {
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  switch (entityType) {
    case 'list':         return entityId ? `/list/${entityId}` : '/dashboard';
    case 'timeline':     return entityId ? `/timeline/${entityId}` : '/dashboard';
    case 'markdownList': return entityId ? `/markdown-list/${entityId}` : '/dashboard';
    case 'folder':       return entityId ? `/folder/${entityId}` : '/dashboard';
    case 'automation':   return entityId ? `/automations/${entityId}` : '/automations';
    case 'meeting':      return '/calendar?show=meetings';
    case 'task':         { const l = str(data?.listId);     return l ? `/list/${l}` : '/dashboard'; }
    case 'milestone':    { const t = str(data?.timelineId); return t ? `/timeline/${t}` : '/dashboard'; }
    default:             return '/dashboard';
  }
}

export interface PushPayload {
  title: string;
  body: string;
  type: string;
  notificationId: string | null;
  url: string;
  workspaceId: string | null;
  tag: string;
  renotify: boolean;
  timestamp: number;
}

export interface BuildPayloadInput {
  type: NotificationType;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  workspaceId?: string | null;
  data?: Record<string, unknown>;
  notificationId?: string | null;
  /** Display name of whoever caused this — resolved by the caller. */
  actorName?: string | null;
}

/**
 * Shape the on-device notification.
 *
 * The headline is assembled the same way the in-app feed row is
 * (`<b>{actor}</b> {title}` — see NotificationItem.tsx), so a notification
 * reads identically whether the user sees it on their lock screen or in the
 * bell. Two things follow from a lock screen being a much smaller surface than
 * a feed row: the title is hard-capped so iOS truncates on our terms rather
 * than mid-word, and the body falls back to the title only when there is
 * genuinely no second line to show (a bubble with a blank body reads as broken).
 */
export function buildPushPayload(input: BuildPayloadInput): PushPayload {
  const headline = input.actorName ? `${input.actorName} ${input.title}` : input.title;
  const collapses = COLLAPSE_BY_ENTITY.has(input.type);
  return {
    title: truncate(headline, 120),
    // An empty body is what makes a notification look broken on iOS, so fall
    // back to the headline rather than shipping a blank second line.
    body: truncate(input.body?.trim() || input.title, 220),
    type: input.type,
    notificationId: input.notificationId ?? null,
    url: pathForNotification(input.entityType, input.entityId, input.data),
    workspaceId: input.workspaceId ?? null,
    // Collapsing types share a tag per entity so repeats replace each other;
    // everything else gets a unique tag so nothing is ever silently swallowed.
    tag: collapses
      ? `${input.type}:${input.entityType ?? 'x'}:${input.entityId ?? 'x'}`
      : `n:${input.notificationId ?? Date.now()}`,
    renotify: collapses,
    timestamp: Date.now(),
  };
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  // Prefer a word boundary, but only if one falls reasonably near the limit —
  // otherwise a single long token would cut the text to almost nothing.
  const cut = clean.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

interface PushRecipientRow {
  push_enabled: boolean;
  push_notification_prefs: Record<string, boolean> | null;
}

/** Does this user want a push for this type right now? Master switch first,
 *  then the sparse per-type override map, then the default. */
export async function userWantsPush(userId: string, type: NotificationType): Promise<boolean> {
  const r = await query<PushRecipientRow>(
    `SELECT push_enabled, push_notification_prefs FROM users WHERE id = $1`,
    [userId]
  );
  const row = r.rows[0];
  if (!row || !row.push_enabled) return false;
  const prefs = row.push_notification_prefs ?? {};
  return prefs[type] ?? DEFAULT_PUSH_PREFS[type] ?? true;
}

/** Deliver one already-built payload to every device a user has registered.
 *  Returns how many endpoints accepted it. */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<number> {
  const keys = await getVapidKeys();
  if (!keys) return 0;
  const subs = await listSubscriptionsForUser(userId);
  if (subs.length === 0) return 0;

  const body = JSON.stringify(payload);
  const results = await Promise.all(subs.map((sub) => deliver(sub, body, keys)));
  return results.filter(Boolean).length;
}

async function deliver(
  sub: StoredPushSubscription,
  body: string,
  keys: { publicKey: string; privateKey: string; subject: string }
): Promise<boolean> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      body,
      {
        vapidDetails: { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
        // A notification the device only learns about hours later is noise, not
        // news — expire it rather than have the push service hold it forever.
        TTL: 60 * 60 * 24,
        // iOS requires a priority high enough to wake the app's service worker;
        // 'normal' can be held until the device is next active anyway.
        urgency: 'high',
      }
    );
    await recordDeliverySuccess(sub.endpoint);
    return true;
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    // 404/410 is the push service saying this endpoint is permanently gone
    // (app deleted, subscription revoked). That is the ONLY signal that
    // justifies deleting a row — anything else may be transient, so it is
    // counted and surfaced in Settings instead.
    if (status === 404 || status === 410) {
      await deleteDeadSubscription(sub.endpoint);
    } else {
      await recordDeliveryFailure(sub.endpoint, `${status ?? ''} ${(err as Error).message ?? ''}`.trim());
      console.error('🔔 ✗ push delivery failed', status, (err as Error).message);
    }
    return false;
  }
}

export interface PushForNotificationInput extends BuildPayloadInput {
  userId: string;
}

/**
 * The one entry point notifications.ts calls. Resolves the recipient's
 * preference and the actor's display name, then fans out to their devices.
 *
 * Never throws — a push failure must not roll back, retry, or otherwise disturb
 * the notification row that has already been written.
 */
export async function sendPushForNotification(input: PushForNotificationInput & { actorId?: string | null }): Promise<void> {
  try {
    if (!shouldPushNotification(input.type, input.data)) return;
    if (!(await userWantsPush(input.userId, input.type))) return;

    let actorName = input.actorName ?? null;
    if (!actorName && input.actorId) {
      const r = await query<{ full_name: string | null; username: string }>(
        `SELECT full_name, username FROM users WHERE id = $1`,
        [input.actorId]
      );
      const actor = r.rows[0];
      actorName = actor ? (actor.full_name || actor.username) : null;
    }

    const payload = buildPushPayload({ ...input, actorName });
    await sendPushToUser(input.userId, payload);
  } catch (err) {
    console.error('🔔 ✗ sendPushForNotification failed', input.type, input.userId, err);
  }
}
