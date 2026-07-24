import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import itemSharesRouter from '../routes/itemShares';

// Regression test for the routing bug where itemSharesRouter — mounted at the
// broad `/api` prefix so it can serve both `/api/item-shares/*` and
// `/api/shared-with-me` — used a blanket `router.use(authenticate)`. That ran
// authenticate on EVERY `/api/*` request reaching the mount, including the
// public, intentionally unauthenticated `/api/share/*` endpoints registered
// after it in index.ts, 401ing every anonymous share visitor before the public
// handler was ever reached. Auth must be per-route so non-matching paths fall
// through.
describe('itemSharesRouter does not shadow public /api/share routes', () => {
  const app = express();
  app.use('/api', itemSharesRouter);
  // Sentinel public route registered AFTER the router, mirroring how index.ts
  // registers the real public `/api/share/*` endpoints after the mount.
  app.get('/api/share/folder/:token', (_req, res) => { res.json({ ok: true }); });

  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('lets an unauthenticated /api/share/* request fall through to the public handler (not 401)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/share/folder/sometoken`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('still requires auth on its own /api/shared-with-me route', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/shared-with-me`);
    expect(res.status).toBe(401);
  });

  it('still requires auth on its own /api/item-shares route', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/item-shares/list/abc/members`);
    expect(res.status).toBe(401);
  });
});
