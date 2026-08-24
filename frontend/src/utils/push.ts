// ---------------------------------------------------------------------------
// Web Push — the browser-side half.
//
// The whole point of this feature is iOS: a Home Screen app (see
// utils/homescreen.ts) can receive real lock-screen notifications, but only
// through a service worker, and only on iOS 16.4+. Three platform facts shape
// everything here and are worth stating once rather than rediscovering:
//
//  1. iOS grants Web Push ONLY to a site added to the Home Screen. In a normal
//     mobile Safari tab `Notification` may not even be defined — so support is
//     detected by feature-testing the actual APIs, never by sniffing the UA.
//  2. `Notification.requestPermission()` must be called from a real user
//     gesture on iOS. It is therefore never fired on load; PushPermissionPrompt
//     asks first and only calls this from the button's own click handler.
//  3. Permission is one-shot. A user who taps "Don't Allow" cannot be asked
//     again by any code — only by changing it in iOS Settings. That is exactly
//     why the in-app pre-prompt exists: it spends a dismissible in-app dialog
//     instead of the one irreversible system prompt.
//
// Everything here is best-effort and resolves rather than throws: push is an
// enhancement, and a browser that can't do it should degrade to the in-app feed
// silently, not surface an error the user can do nothing about.
// ---------------------------------------------------------------------------

import { apiGetPushPublicKey, apiSubscribePush, apiUnsubscribePush } from '../api/client';
import { detectHomeScreenDevice, getOrCreateInstallId, isHomeScreenApp } from './homescreen';

const SW_PATH = '/sw.js';

export type PushPermission = 'default' | 'granted' | 'denied' | 'unsupported';

/** Does this browser have the three APIs Web Push actually needs? Feature
 *  detection only — on iOS the very same Safari build exposes these inside a
 *  Home Screen app and not in a normal tab, so no UA test could answer this. */
export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof Notification !== 'undefined'
  );
}

/**
 * Can this browser realistically be ASKED for permission right now?
 *
 * On iOS the answer is no until the app has been installed to the Home Screen,
 * and showing a prompt that cannot succeed is worse than showing nothing — so
 * the UI uses this to decide between asking and explaining how to install.
 * Every other platform (desktop Chrome/Edge/Firefox, an installed PWA) can be
 * asked from a normal tab, which is why this is not simply `isHomeScreenApp()`.
 */
export function canRequestPush(): boolean {
  if (!isPushSupported()) return false;
  return !isIos() || isHomeScreenApp();
}

/** iOS/iPadOS, including iPads that report themselves as desktop Safari (they
 *  are identifiable by being a "Mac" with a touch screen). */
export function isIos(): boolean {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1;
}

/** True when the user is on iOS but hasn't installed to the Home Screen yet —
 *  the one case where the answer is "install first", not "grant permission". */
export function needsHomeScreenInstall(): boolean {
  return isPushSupported() && isIos() && !isHomeScreenApp();
}

export function getPushPermission(): PushPermission {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission as PushPermission;
}

/** Register (or reuse) the push service worker. Resolves to null rather than
 *  throwing when registration fails — see the module header. */
export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  try {
    const existing = await navigator.serviceWorker.getRegistration(SW_PATH);
    if (existing) return existing;
    return await navigator.serviceWorker.register(SW_PATH, { scope: '/' });
  } catch (err) {
    console.warn('Push service worker registration failed', err);
    return null;
  }
}

/**
 * Ask the OS for notification permission.
 *
 * MUST be called synchronously from within a user gesture handler on iOS —
 * awaiting anything first (a fetch, a store read) can lose the gesture and make
 * the prompt silently fail to appear. The caller is responsible for that; this
 * function does no I/O of its own before the call.
 */
export async function requestPushPermission(): Promise<PushPermission> {
  if (!isPushSupported()) return 'unsupported';
  try {
    return (await Notification.requestPermission()) as PushPermission;
  } catch {
    return getPushPermission();
  }
}

/**
 * The VAPID public key arrives as base64url from the server; the PushManager
 * wants raw bytes. Padding is re-added and the URL-safe alphabet translated
 * back — a subscription created from a mangled key fails at delivery time, not
 * here, so this is worth getting exactly right.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

export interface SubscribeResult {
  ok: boolean;
  permission: PushPermission;
  /** Why it didn't work, for the settings UI to explain rather than just fail. */
  reason?: 'unsupported' | 'denied' | 'not-configured' | 'failed';
}

/**
 * Register this device for push, assuming permission is already granted.
 *
 * Reuses an existing PushSubscription when the browser already has one for our
 * current VAPID key, and re-creates it when the key has changed (an instance
 * whose database was reset generates a new keypair, and every old subscription
 * bound to the previous one is permanently undeliverable). Either way the
 * endpoint is re-sent to the server, which upserts on it — so this is safe and
 * cheap to call on every launch, and doubles as the repair path for a
 * subscription the browser rotated on its own.
 */
export async function subscribeCurrentDevice(): Promise<SubscribeResult> {
  const permission = getPushPermission();
  if (permission === 'unsupported') return { ok: false, permission, reason: 'unsupported' };
  if (permission !== 'granted') return { ok: false, permission, reason: 'denied' };

  try {
    const registration = await ensureServiceWorker();
    if (!registration) return { ok: false, permission, reason: 'failed' };
    // `ready` rather than the registration alone: a worker still installing has
    // no active PushManager to subscribe through.
    await navigator.serviceWorker.ready;

    const { publicKey, configured } = await apiGetPushPublicKey();
    if (!configured || !publicKey) return { ok: false, permission, reason: 'not-configured' };

    const applicationServerKey = urlBase64ToUint8Array(publicKey);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !keyMatches(subscription, applicationServerKey)) {
      await subscription.unsubscribe().catch(() => {});
      subscription = null;
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        // Required to be true by every browser: a subscription that could push
        // silently without showing a notification is not permitted.
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey as unknown as BufferSource,
      });
    }

    const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      return { ok: false, permission, reason: 'failed' };
    }

    const device = detectHomeScreenDevice();
    await apiSubscribePush(
      { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } },
      { deviceName: device.deviceName, osVersion: device.osVersion, installId: getOrCreateInstallId() },
    );
    return { ok: true, permission };
  } catch (err) {
    console.warn('Push subscribe failed', err);
    return { ok: false, permission, reason: 'failed' };
  }
}

/** Does an existing subscription belong to the key we'd subscribe with today? */
function keyMatches(subscription: PushSubscription, key: Uint8Array): boolean {
  const existing = subscription.options?.applicationServerKey;
  if (!existing) return false;
  const bytes = new Uint8Array(existing as ArrayBuffer);
  if (bytes.length !== key.length) return false;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== key[i]) return false;
  return true;
}

/** Stop pushing to THIS device — drops the browser subscription and the server
 *  row together, so neither is left pointing at something the other forgot. */
export async function unsubscribeCurrentDevice(): Promise<void> {
  if (!isPushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration(SW_PATH);
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe().catch(() => {});
    await apiUnsubscribePush(endpoint).catch(() => {});
  } catch (err) {
    console.warn('Push unsubscribe failed', err);
  }
}

/** Is this exact device currently subscribed in the browser? */
export async function hasLocalSubscription(): Promise<boolean> {
  if (!isPushSupported()) return false;
  try {
    const registration = await navigator.serviceWorker.getRegistration(SW_PATH);
    return !!(await registration?.pushManager.getSubscription());
  } catch {
    return false;
  }
}
