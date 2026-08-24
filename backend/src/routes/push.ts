// ---------------------------------------------------------------------------
// /api/push — Web Push subscription management.
//
//   GET    /api/push/public-key      → the instance's VAPID public key + status
//   POST   /api/push/subscribe       → register/refresh this device
//   POST   /api/push/unsubscribe     → forget this device (by endpoint)
//   GET    /api/push/subscriptions   → this user's registered devices
//   DELETE /api/push/subscriptions/:id → revoke one device from Settings
//   POST   /api/push/test            → send a test notification to this user
//
// Every row is hard-scoped to the verified req.userId. The one deliberate
// exception is the dead-endpoint cleanup in push/send.ts, which deletes by
// endpoint alone — that path is driven by the push service reporting 410 Gone,
// not by a client request, and the endpoint IS the identity there.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware';
import { werr } from '../workspaceUtil';
import { getVapidPublicKey } from '../push/vapid';
import {
  deleteSubscriptionByEndpoint,
  deleteSubscriptionById,
  isValidEndpoint,
  listSubscriptionsForUser,
  upsertSubscription,
} from '../push/subscriptions';
import { buildPushPayload, sendPushToUser } from '../push/send';

const router = Router();
router.use(authenticate);

/** Cap the free-text device labels a client supplies, same as the mobile /
 *  homescreen connection routes. */
function trunc(v: unknown, max = 255): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

// GET /api/push/public-key — what the browser needs to create a subscription.
// `configured: false` (rather than a 404 or an error) is a real answer: it
// means push isn't available on this instance yet, and the client should stay
// quiet rather than showing a broken prompt.
router.get('/public-key', async (_req: Request, res: Response) => {
  try {
    const publicKey = await getVapidPublicKey();
    res.json({ publicKey, configured: !!publicKey });
  } catch (err) {
    werr('push public-key error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/push/subscribe
router.post('/subscribe', async (req: Request, res: Response) => {
  try {
    const { subscription, device } = req.body as {
      subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
      device?: { deviceName?: unknown; osVersion?: unknown; installId?: unknown };
    };

    const endpoint = subscription?.endpoint;
    const p256dh = subscription?.keys?.p256dh;
    const auth = subscription?.keys?.auth;
    if (!isValidEndpoint(endpoint) || typeof p256dh !== 'string' || typeof auth !== 'string' || !p256dh || !auth) {
      res.status(400).json({ error: 'A valid push subscription is required' });
      return;
    }

    const stored = await upsertSubscription(
      req.userId!,
      { endpoint, keys: { p256dh, auth } },
      {
        deviceName: trunc(device?.deviceName),
        osVersion: trunc(device?.osVersion),
        installId: trunc(device?.installId, 100),
      }
    );
    res.json({ subscription: { id: stored.id, deviceName: stored.deviceName, osVersion: stored.osVersion, createdAt: stored.createdAt } });
  } catch (err) {
    werr('push subscribe error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/push/unsubscribe — the client's own "stop pushing to THIS device".
// A missing row is reported as success: the caller's goal ("this endpoint no
// longer receives pushes") is satisfied either way, and a 404 would only
// tempt a client into retry logic for an already-correct state.
router.post('/unsubscribe', async (req: Request, res: Response) => {
  try {
    const { endpoint } = req.body as { endpoint?: unknown };
    if (!isValidEndpoint(endpoint)) {
      res.status(400).json({ error: 'A valid endpoint is required' });
      return;
    }
    await deleteSubscriptionByEndpoint(req.userId!, endpoint);
    res.json({ ok: true });
  } catch (err) {
    werr('push unsubscribe error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/push/subscriptions — the device list shown in Account Settings.
// Never returns p256dh/auth: they are this server's delivery credentials for
// that endpoint and the UI has no use for them.
router.get('/subscriptions', async (req: Request, res: Response) => {
  try {
    const subs = await listSubscriptionsForUser(req.userId!);
    res.json({
      subscriptions: subs.map((s) => ({
        id: s.id,
        deviceName: s.deviceName,
        osVersion: s.osVersion,
        installId: s.installId,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
      })),
    });
  } catch (err) {
    werr('push subscriptions GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/push/subscriptions/:id
router.delete('/subscriptions/:id', async (req: Request, res: Response) => {
  try {
    const removed = await deleteSubscriptionById(req.userId!, req.params.id);
    if (!removed) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ ok: true });
  } catch (err) {
    werr('push subscriptions DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/push/test — deliver a real notification to this user's own devices
// so the whole chain (VAPID keys, subscription, service worker, OS permission)
// can be verified from Settings without waiting for someone else to act.
//
// Deliberately bypasses the user's own preference gate: this is an explicit,
// self-directed request to see whether delivery works at all, and answering
// "sent to 0 devices" because a per-type toggle is off would be a confusing
// non-answer. It cannot reach anyone else — the recipient is always req.userId.
router.post('/test', async (req: Request, res: Response) => {
  try {
    const payload = buildPushPayload({
      type: 'workspace_added', // Any type works; only the tag/collapse rules read it.
      title: 'Push notifications are working',
      body: 'This is a test from Solytiq Cloud. You can turn notifications off any time in Settings → Notifications.',
      entityType: null,
      entityId: null,
      notificationId: `test_${Date.now()}`,
    });
    const delivered = await sendPushToUser(req.userId!, payload);
    res.json({ ok: delivered > 0, delivered });
  } catch (err) {
    werr('push test error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
