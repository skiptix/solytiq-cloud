/* eslint-disable */
// ---------------------------------------------------------------------------
// Solytiq Cloud push service worker.
//
// WHY THIS FILE EXISTS AT ALL: CLAUDE.md's "Home Screen Install" section says
// this app deliberately ships NO service worker, because the ask there was
// "installable + launches standalone" and offline support would have to be
// reconciled with a JWT in localStorage and the cursor-based sync engine.
// That reasoning is untouched — this worker is not an offline cache. Web Push
// is simply not reachable any other way: on iOS (16.4+) a Home Screen app
// receives notifications only through a service worker's `push` event.
//
// So the scope here is exactly two events, `push` and `notificationclick`, and
// the file has NO `fetch` handler — nothing it does can serve a stale response,
// interfere with an auth header, or race the sync cursor. Do not add one
// without revisiting the reasoning in CLAUDE.md first.
// ---------------------------------------------------------------------------

const APP_ICON = '/icons/icon-192.png';
const BADGE_ICON = '/icons/badge-96.png';
const DEFAULT_TITLE = 'Solytiq Cloud';

// Take over immediately on install/activate rather than waiting for every tab
// to close. A user who just granted permission expects the next notification to
// arrive, not the one after they quit the app.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // A payload we can't parse still deserves to surface — a silent push is
    // worse than a generic one, because the user learns nothing happened.
    data = { title: DEFAULT_TITLE, body: event.data && event.data.text ? event.data.text() : '' };
  }

  const title = data.title || DEFAULT_TITLE;
  const options = {
    body: data.body || '',
    icon: APP_ICON,
    badge: BADGE_ICON,
    // Collapsing types share a tag so a burst replaces itself instead of
    // stacking; everything else carries a unique tag (see push/send.ts).
    tag: data.tag || undefined,
    renotify: data.renotify === true,
    timestamp: data.timestamp || Date.now(),
    // Everything the click handler needs to route, carried on the notification
    // itself — the worker has no store to look anything up in.
    data: {
      url: data.url || '/dashboard',
      workspaceId: data.workspaceId || null,
      notificationId: data.notificationId || null,
      type: data.type || null,
    },
    // A notification the user has to dismiss by hand is an interruption, not a
    // signal. Let the OS auto-hide it; the in-app feed keeps the record.
    requireInteraction: false,
    actions: [{ action: 'open', title: 'Open' }],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const target = (event.notification.data && event.notification.data.url) || '/dashboard';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Prefer focusing an already-open window and navigating it in place: on
      // iOS a Home Screen app is a single window, and openWindow() on top of it
      // is either ignored or spawns a second, confusing instance. postMessage
      // lets the running SPA route with its own router (preserving the
      // workspace switch notificationTarget() would do) instead of a hard load.
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({ type: 'notification-click', url: target, notificationId: event.notification.data?.notificationId ?? null });
          return client.focus();
        }
      }
      // Nothing open — cold-start the app straight at the target route.
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })
  );
});
