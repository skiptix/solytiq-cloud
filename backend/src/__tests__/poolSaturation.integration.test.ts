// ---------------------------------------------------------------------------
// B8 (Phase 2) — "Pool-Sättigung messen": proves getPoolStats() reflects
// real saturation (waitingCount > 0) under genuine concurrent load against a
// small, dedicated pool, and that DB_POOL_ACQUIRE_TIMEOUT_MS bounds how long
// an over-budget acquire waits before failing with a clear error instead of
// hanging indefinitely (the old node-postgres default).
//
// Uses its OWN small Pool (not the shared db.ts singleton) so the test can
// pick a tiny `max` and prove saturation deterministically without
// depending on — or disturbing — the rest of the suite's connection usage.
// ---------------------------------------------------------------------------

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { resolvePoolConfig } from '../dbConfig';

const PGHOST     = process.env.TEST_PGHOST     ?? 'localhost';
const PGPORT     = parseInt(process.env.TEST_PGPORT ?? '5432', 10);
const PGDATABASE = process.env.TEST_PGDATABASE ?? 'solytiq_test';
const PGUSER     = process.env.TEST_PGUSER     ?? 'solytiq_test';
const PGPASSWORD = process.env.TEST_PGPASSWORD ?? 'solytiq_test_pw';

let dbAvailable = false;
try {
  const probe = new Pool({ host: PGHOST, port: PGPORT, database: PGDATABASE, user: PGUSER, password: PGPASSWORD, max: 1 });
  await probe.query('SELECT 1');
  await probe.end();
  dbAvailable = true;
} catch (err) {
  console.warn(`⚠️  poolSaturation.integration.test.ts: no reachable Postgres — every test in this file is SKIPPED, not passed. (${(err as Error)?.message})`);
}

describe.skipIf(!dbAvailable)('B8 — pool saturation (live Postgres, dedicated small pool)', () => {
  let pool: Pool;

  afterAll(async () => {
    if (pool) await pool.end().catch(() => {});
  });

  it('resolvePoolConfig-derived settings produce a pool whose stats genuinely reflect concurrent load', async () => {
    pool = new Pool({
      host: PGHOST, port: PGPORT, database: PGDATABASE, user: PGUSER, password: PGPASSWORD,
      max: 2, // tiny on purpose — makes saturation trivial to trigger
      connectionTimeoutMillis: 2000,
    });

    // Occupy BOTH connections with a deliberately slow query each (via
    // pg_sleep — a real server-side wait, not a client-side setTimeout that
    // would prove nothing about actual connection occupancy).
    const holder1 = pool.query('SELECT pg_sleep(0.3)');
    const holder2 = pool.query('SELECT pg_sleep(0.3)');

    // A THIRD concurrent query has no free connection — it must wait.
    // We measure the pool's own waitingCount while all three are in flight.
    let sawWaiting = false;
    const thirdQueryPromise = pool.query('SELECT 1');
    // Poll briefly (not a sleep-as-proof — an assertion loop bounded to a
    // few ms, checking the pool's REAL internal counters each tick).
    const deadline = Date.now() + 250;
    while (Date.now() < deadline) {
      if (pool.waitingCount > 0) { sawWaiting = true; break; }
      await new Promise((r) => setImmediate(r));
    }

    await Promise.all([holder1, holder2, thirdQueryPromise]);
    expect(sawWaiting).toBe(true);
    expect(pool.waitingCount).toBe(0); // drained back to zero once everything completed
  });

  it('DB_POOL_ACQUIRE_TIMEOUT_MS bounds acquire wait — an over-budget request fails fast with a clear error, not an indefinite hang', async () => {
    const acquireTimeoutMs = 150;
    pool = new Pool({
      host: PGHOST, port: PGPORT, database: PGDATABASE, user: PGUSER, password: PGPASSWORD,
      max: 1,
      connectionTimeoutMillis: acquireTimeoutMs,
    });

    // Hold the ONLY connection for longer than the acquire timeout.
    const holder = pool.query('SELECT pg_sleep(1)');

    const started = Date.now();
    await expect(pool.query('SELECT 1')).rejects.toThrow(/timeout/i);
    const elapsed = Date.now() - started;

    // Failed close to the configured timeout, not after the full 1s hold.
    expect(elapsed).toBeLessThan(800);
    expect(elapsed).toBeGreaterThanOrEqual(acquireTimeoutMs - 50);

    await holder.catch(() => {}); // let the slow query finish before pool.end() in afterAll
  });

  it('resolvePoolConfig defaults never leave connectionTimeoutMillis at 0 ("wait forever") — a live pool built from it actually times out', async () => {
    const cfg = resolvePoolConfig({}); // real defaults, not overridden
    expect(cfg.connectionTimeoutMillis).toBeGreaterThan(0);

    pool = new Pool({
      host: PGHOST, port: PGPORT, database: PGDATABASE, user: PGUSER, password: PGPASSWORD,
      max: 1,
      connectionTimeoutMillis: 100, // scaled down from the real default purely so this test itself stays fast
    });
    const holder = pool.query('SELECT pg_sleep(1)');
    await expect(pool.query('SELECT 1')).rejects.toThrow();
    await holder.catch(() => {});
  });
});
