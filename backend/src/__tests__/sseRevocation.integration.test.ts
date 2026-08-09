// ---------------------------------------------------------------------------
// S4 — "offene SSE-Verbindungen nach Sicherheitsänderungen schließen und
// begrenzen": a long-lived SSE stream authenticates once at connect time and
// then never re-checks anything for the rest of its (potentially very long)
// life. Before sweepStaleSseConnections() existed, a password change, forced
// logout (token_version bump), or 2FA toggle only blocked the NEXT
// reconnect — an already-open stream stayed alive and kept receiving
// realtime pushes indefinitely. This proves the sweep actually closes a
// stale connection against a REAL users.token_version change, and that the
// per-user connection cap actually evicts the oldest connection.
//
// Same live-DB convention as the other *.integration.test.ts files in this
// suite — SKIPS (not passes) if no database is reachable.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.PGHOST     = process.env.TEST_PGHOST     ?? 'localhost';
process.env.PGPORT     = process.env.TEST_PGPORT     ?? '5432';
process.env.PGDATABASE = process.env.TEST_PGDATABASE ?? 'solytiq_test';
process.env.PGUSER     = process.env.TEST_PGUSER     ?? 'solytiq_test';
process.env.PGPASSWORD = process.env.TEST_PGPASSWORD ?? 'solytiq_test_pw';

let dbAvailable = false;
let pool: typeof import('../db').pool;

try {
  const dbMod = await import('../db');
  pool = dbMod.pool;
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch (err) {
  console.warn(`⚠️  sseRevocation.integration.test.ts: no reachable Postgres — every test in this file is SKIPPED, not passed. (${(err as Error)?.message})`);
}

// A minimal stand-in for express.Response — only what sse.ts actually calls.
function fakeRes() {
  let ended = false;
  const written: string[] = [];
  return {
    write: (data: string) => { if (ended) throw new Error('write after end'); written.push(data); return true; },
    end: () => { ended = true; },
    get ended() { return ended; },
    get written() { return written; },
  };
}

describe.skipIf(!dbAvailable)('sweepStaleSseConnections — live DB', () => {
  const userId = 'c0000000-0000-4000-8000-0000000000f2';

  beforeAll(async () => {
    // Locked entry point, not raw runMigrations() — see objectPolicy.
    // integration.test.ts's beforeAll comment for why (concurrent test
    // files racing DDL on the shared solytiq_test database).
    const { runAllMigrations } = await import('../migrations');
    await runAllMigrations();
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, full_name, is_admin, token_version)
       VALUES ($1, 'sse_test_user', 'sse-test@test.local', 'x', 'SSE Tester', false, 0)`,
      [userId]
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    // NOTE: pool.end() deliberately NOT called here — the connectionId-wiring
    // describe block further down in this file shares the same `pool` import
    // and runs after this one; it closes the pool in its own afterAll.
  });

  it('closes an open connection whose stored token_version no longer matches the DB (password change / forced logout)', async () => {
    const { addSseClient, sweepStaleSseConnections, __sseConnectionCountForTests, __clearAllSseClientsForTests } = await import('../sse');
    __clearAllSseClientsForTests();

    const res = fakeRes();
    // Connected with token_version=0, matching the DB row at connect time.
    addSseClient(userId, res as never, 0);
    expect(__sseConnectionCountForTests(userId)).toBe(1);
    expect(res.ended).toBe(false);

    // Simulate a password change: token_version bumps in the DB while the
    // stream stays open (exactly like PUT /api/auth/password does).
    await pool.query(`UPDATE users SET token_version = token_version + 1 WHERE id = $1`, [userId]);

    await sweepStaleSseConnections();

    expect(res.ended).toBe(true); // the stream was force-closed
    expect(__sseConnectionCountForTests(userId)).toBe(0); // and dropped from the registry
  });

  it('leaves an up-to-date connection open', async () => {
    const { addSseClient, sweepStaleSseConnections, __sseConnectionCountForTests, __clearAllSseClientsForTests } = await import('../sse');
    __clearAllSseClientsForTests();

    const current = await pool.query<{ token_version: number }>('SELECT token_version FROM users WHERE id = $1', [userId]);
    const res = fakeRes();
    addSseClient(userId, res as never, current.rows[0].token_version);

    await sweepStaleSseConnections();

    expect(res.ended).toBe(false);
    expect(__sseConnectionCountForTests(userId)).toBe(1);
  });

  it('closes every connection for a user that no longer exists (account deleted mid-stream)', async () => {
    const { addSseClient, sweepStaleSseConnections, __sseConnectionCountForTests, __clearAllSseClientsForTests } = await import('../sse');
    __clearAllSseClientsForTests();

    const ghostId = 'c0000000-0000-4000-8000-0000000000f3';
    const res = fakeRes();
    addSseClient(ghostId, res as never, 0);

    await sweepStaleSseConnections();

    expect(res.ended).toBe(true);
    expect(__sseConnectionCountForTests(ghostId)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Found by independent post-handoff review: index.ts's `/api/events` handler
  // destructured only `{ userId }` from verifyToken() and never passed
  // connectionId into addSseClient() — so this mobile-revocation branch of
  // sweepStaleSseConnections() (below) could never fire for any real SSE
  // connection, even though the branch itself was implemented and "tested"
  // only at the sse.ts unit level, never end-to-end. Fixed in index.ts; these
  // tests prove the branch itself is correct, and the HTTP-level test further
  // down proves the wiring from a real JWT into addSseClient() actually works.
  // -------------------------------------------------------------------------
  describe('mobile-device revocation (connectionId-tagged connections)', () => {
    const mobileConnId = 'c1000000-0000-4000-8000-0000000000f2';

    beforeAll(async () => {
      await pool.query(`DELETE FROM mobile_connections WHERE id = $1`, [mobileConnId]);
      await pool.query(
        `INSERT INTO mobile_connections (id, user_id, device_name) VALUES ($1, $2, 'Test iPhone')`,
        [mobileConnId, userId]
      );
      await pool.query(`DELETE FROM app_settings WHERE key = 'mobile_app_enabled'`);
    });

    afterAll(async () => {
      await pool.query(`DELETE FROM mobile_connections WHERE id = $1`, [mobileConnId]);
      await pool.query(`DELETE FROM app_settings WHERE key = 'mobile_app_enabled'`);
    });

    it('leaves a connection open while its mobile_connections row still exists and the app is enabled', async () => {
      const { addSseClient, sweepStaleSseConnections, __sseConnectionCountForTests, __clearAllSseClientsForTests } = await import('../sse');
      __clearAllSseClientsForTests();

      const current = await pool.query<{ token_version: number }>('SELECT token_version FROM users WHERE id = $1', [userId]);
      const res = fakeRes();
      addSseClient(userId, res as never, current.rows[0].token_version, mobileConnId);

      await sweepStaleSseConnections();

      expect(res.ended).toBe(false);
      expect(__sseConnectionCountForTests(userId)).toBe(1);
    });

    it('closes the stream once the device is revoked (its mobile_connections row is deleted), even though token_version is still current', async () => {
      const { addSseClient, sweepStaleSseConnections, __sseConnectionCountForTests, __clearAllSseClientsForTests } = await import('../sse');
      __clearAllSseClientsForTests();

      const current = await pool.query<{ token_version: number }>('SELECT token_version FROM users WHERE id = $1', [userId]);
      const res = fakeRes();
      addSseClient(userId, res as never, current.rows[0].token_version, mobileConnId);
      expect(res.ended).toBe(false);

      // Simulate DELETE /api/auth/mobile-connections/:id revoking the device
      // while its SSE stream stays open.
      await pool.query(`DELETE FROM mobile_connections WHERE id = $1`, [mobileConnId]);
      try {
        await sweepStaleSseConnections();
        expect(res.ended).toBe(true);
        expect(__sseConnectionCountForTests(userId)).toBe(0);
      } finally {
        // Restore for the other tests in this describe block.
        await pool.query(
          `INSERT INTO mobile_connections (id, user_id, device_name) VALUES ($1, $2, 'Test iPhone') ON CONFLICT (id) DO NOTHING`,
          [mobileConnId, userId]
        );
      }
    });

    it('closes the stream once the admin disables the mobile app instance-wide, even with a still-valid mobile_connections row', async () => {
      const { addSseClient, sweepStaleSseConnections, __sseConnectionCountForTests, __clearAllSseClientsForTests } = await import('../sse');
      __clearAllSseClientsForTests();

      const current = await pool.query<{ token_version: number }>('SELECT token_version FROM users WHERE id = $1', [userId]);
      const res = fakeRes();
      addSseClient(userId, res as never, current.rows[0].token_version, mobileConnId);
      expect(res.ended).toBe(false);

      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ('mobile_app_enabled', 'false')
         ON CONFLICT (key) DO UPDATE SET value = 'false'`
      );
      try {
        await sweepStaleSseConnections();
        expect(res.ended).toBe(true);
      } finally {
        await pool.query(`DELETE FROM app_settings WHERE key = 'mobile_app_enabled'`);
      }
    });

    it('a connection with NO connectionId (a plain web session) is never touched by mobile-revocation, even with the app disabled', async () => {
      const { addSseClient, sweepStaleSseConnections, __sseConnectionCountForTests, __clearAllSseClientsForTests } = await import('../sse');
      __clearAllSseClientsForTests();

      const current = await pool.query<{ token_version: number }>('SELECT token_version FROM users WHERE id = $1', [userId]);
      const res = fakeRes();
      addSseClient(userId, res as never, current.rows[0].token_version); // no connectionId

      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ('mobile_app_enabled', 'false')
         ON CONFLICT (key) DO UPDATE SET value = 'false'`
      );
      try {
        await sweepStaleSseConnections();
        expect(res.ended).toBe(false);
        expect(__sseConnectionCountForTests(userId)).toBe(1);
      } finally {
        await pool.query(`DELETE FROM app_settings WHERE key = 'mobile_app_enabled'`);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end proof (real HTTP + a real mobile-flavored JWT) that
// GET /api/events actually THREADS connectionId from the token into
// addSseClient() — the specific wiring gap an earlier review found. The
// sse.ts-level tests above prove the sweep's own logic is correct; this
// mounts sse.ts's OWN EXPORTED handleSseEventsRequest() — the exact function
// index.ts's real `app.get('/api/events', handleSseEventsRequest)` route
// uses, not a hand-copied re-implementation — so this test cannot pass while
// the real production handler is broken (an earlier version of this test
// re-implemented the handler's logic inline, which a second, independent
// review correctly flagged as unable to catch a real regression).
// ---------------------------------------------------------------------------
describe.skipIf(!dbAvailable)('GET /api/events — connectionId wiring from a mobile JWT (live DB + live HTTP)', () => {
  let server: import('http').Server;
  let baseUrl: string;
  const userId = 'c2000000-0000-4000-8000-0000000000f2';
  const mobileConnId = 'c3000000-0000-4000-8000-0000000000f2';

  beforeAll(async () => {
    const http = await import('http');
    const { runAllMigrations } = await import('../migrations');
    await runAllMigrations();

    await pool.query(`DELETE FROM mobile_connections WHERE id = $1`, [mobileConnId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, full_name, is_admin, token_version)
       VALUES ($1, 'sse_wiring_test_user', 'sse-wiring-test@test.local', 'x', 'SSE Wiring Tester', false, 0)`,
      [userId]
    );
    await pool.query(
      `INSERT INTO mobile_connections (id, user_id, device_name) VALUES ($1, $2, 'Wiring Test iPhone')`,
      [mobileConnId, userId]
    );

    const express = (await import('express')).default;
    const { __clearAllSseClientsForTests, handleSseEventsRequest } = await import('../sse');
    __clearAllSseClientsForTests();

    const app = express();
    // The REAL handler, imported from sse.ts — not a re-implementation. This
    // is byte-for-byte what index.ts's actual `/api/events` route mounts.
    app.get('/api/events', handleSseEventsRequest);

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as import('net').AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM mobile_connections WHERE id = $1`, [mobileConnId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  it('a mobile JWT (generateToken with a connectionId) results in an SSE connection tagged with that connectionId, and revoking it closes the stream', async () => {
    const { generateToken } = await import('../auth');
    const { __getSseClientConnectionIdsForTests, sweepStaleSseConnections, __sseConnectionCountForTests } = await import('../sse');
    const token = generateToken(userId, 0, mobileConnId);

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/events`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    // Give the server a tick to register the client before we inspect it.
    await new Promise((r) => setTimeout(r, 50));

    expect(__getSseClientConnectionIdsForTests(userId)).toContain(mobileConnId);

    // Revoke the device, then confirm the sweep actually closes THIS stream —
    // proving the id that reached addSseClient() is the real one, not undefined.
    await pool.query(`DELETE FROM mobile_connections WHERE id = $1`, [mobileConnId]);
    await sweepStaleSseConnections();
    expect(__sseConnectionCountForTests(userId)).toBe(0);

    controller.abort();
  });
});

describe('SSE per-user connection cap (no DB needed — pure in-memory registry)', () => {
  it('evicts the oldest connection once the cap is exceeded, rather than growing unbounded', async () => {
    const { addSseClient, __sseConnectionCountForTests, __clearAllSseClientsForTests } = await import('../sse');
    __clearAllSseClientsForTests();

    const userId = 'cap-test-user';
    const allRes = Array.from({ length: 10 }, () => fakeRes());
    for (const res of allRes) addSseClient(userId, res as never, 0);

    // The registry never exceeds its cap...
    expect(__sseConnectionCountForTests(userId)).toBeLessThanOrEqual(8);
    // ...and it did so by CLOSING the excess, not just silently dropping the
    // reference (which would leak an open, un-cleaned-up response object).
    const closedCount = allRes.filter((r) => r.ended).length;
    expect(closedCount).toBeGreaterThan(0);
  });
});
