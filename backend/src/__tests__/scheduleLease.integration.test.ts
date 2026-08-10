// ---------------------------------------------------------------------------
// B3 (Phase 2) — live-Postgres proof of the literal gate:
//
//   "Zwei Worker erzeugen für einen fälligen Job genau einen erfolgreichen
//    Abschluss; Crash nach Claim und vor Ack wird nach Lease-Ablauf
//    übernommen."
//
// Exercised against the REAL production path (sweepScheduledAutomations ->
// claimDueRows -> runAutomation), not a stand-in — a genuine schedule-
// trigger automation with a trivial `code` action is seeded, then two
// "workers" (two concurrent calls to sweepScheduledAutomations) race it.
//
// Same live-DB convention as the rest of this suite — SKIPPED (not passed)
// if no database is reachable.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.PGHOST     = process.env.TEST_PGHOST     ?? 'localhost';
process.env.PGPORT     = process.env.TEST_PGPORT     ?? '5432';
process.env.PGDATABASE = process.env.TEST_PGDATABASE ?? 'solytiq_test';
process.env.PGUSER     = process.env.TEST_PGUSER     ?? 'solytiq_test';
process.env.PGPASSWORD = process.env.TEST_PGPASSWORD ?? 'solytiq_test_pw';

let dbAvailable = false;
let pool: typeof import('../db').pool;
let sweepScheduledAutomations: typeof import('../automationEngine').sweepScheduledAutomations;
let releaseUnstartedScheduleLeases: typeof import('../automationEngine').releaseUnstartedScheduleLeases;
let claimDueRows: typeof import('../jobLease').claimDueRows;
let WORKER_ID: string;

try {
  const dbMod = await import('../db');
  pool = dbMod.pool;
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch (err) {
  console.warn(`⚠️  scheduleLease.integration.test.ts: no reachable Postgres — every test in this file is SKIPPED, not passed. (${(err as Error)?.message})`);
}

if (dbAvailable) {
  ({ sweepScheduledAutomations, releaseUnstartedScheduleLeases } = await import('../automationEngine'));
  ({ claimDueRows } = await import('../jobLease'));
  ({ WORKER_ID } = await import('../workerId'));
}

describe.skipIf(!dbAvailable)('B3 — schedule-trigger claim/lease (live Postgres)', () => {
  const userId = 'b3000000-0000-4000-8000-0000000000d1';
  const wsId = 'ws_test_b3_lease';
  const automationId = 'automation_test_b3_lease';

  beforeAll(async () => {
    const { runAllMigrations } = await import('../migrations');
    await runAllMigrations();
    const { hashPassword } = await import('../auth');

    await pool.query(`DELETE FROM automation_runs WHERE automation_id = $1`, [automationId]);
    await pool.query(`DELETE FROM automations WHERE id = $1`, [automationId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [wsId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);

    const pw = await hashPassword('irrelevant-for-this-test-x');
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, full_name, is_admin) VALUES ($1, 'b3_lease_user', 'b3-lease@test.local', $2, 'Lease', false)`,
      [userId, pw]
    );
    await pool.query(`INSERT INTO workspaces (id, name, visibility, owner_id) VALUES ($1, 'B3 Lease Tenant', 'private', $2)`, [wsId, userId]);
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [wsId, userId]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM automation_runs WHERE automation_id = $1`, [automationId]);
    await pool.query(`DELETE FROM automations WHERE id = $1`, [automationId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [wsId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool.end();
  });

  function trivialGraph() {
    return {
      version: 1,
      nodes: [
        { id: 't1', kind: 'trigger', type: 'schedule', position: { x: 0, y: 0 }, params: { freq: 'daily', time: '09:00' } },
        { id: 'a1', kind: 'action', type: 'code', position: { x: 0, y: 0 }, params: { code: 'return { ranAt: Date.now() };' } },
      ],
      edges: [{ id: 'e1', source: 't1', target: 'a1' }],
    };
  }

  async function seedDueAutomation() {
    await pool.query(`DELETE FROM automation_runs WHERE automation_id = $1`, [automationId]);
    await pool.query(`DELETE FROM automations WHERE id = $1`, [automationId]);
    await pool.query(
      `INSERT INTO automations (id, workspace_id, user_id, name, enabled, graph, trigger_type, trigger_scope, next_fire_at, owner_entity_type, owner_entity_id)
       VALUES ($1, $2, $3, 'B3 Lease Test Automation', true, $4, 'schedule', $5, NOW() - INTERVAL '1 minute', NULL, NULL)`,
      [automationId, wsId, userId, JSON.stringify(trivialGraph()), JSON.stringify({ freq: 'daily', time: '09:00' })]
    );
  }

  beforeEach(async () => {
    await seedDueAutomation();
  });

  it('two CONCURRENT sweep calls racing the SAME due automation produce EXACTLY ONE successful run — never zero, never two', async () => {
    const [r1, r2] = await Promise.all([sweepScheduledAutomations(), sweepScheduledAutomations()]);
    // sweepScheduledAutomations() itself doesn't return per-automation
    // results (it's a void sweep — see automationEngine.ts), so the actual
    // proof reads back automation_runs directly.
    void r1; void r2;

    const runs = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM automation_runs WHERE automation_id = $1 ORDER BY started_at ASC`,
      [automationId]
    );
    expect(runs.rows.length).toBe(1); // exactly one run row was ever created for this due firing
    expect(runs.rows[0].status).toBe('success');

    // And the automation's own lease was released + next_fire_at advanced
    // past "now" — it won't be claimed again until its NEXT real due time.
    const row = await pool.query<{ lease_owner: string | null; lease_expires_at: string | null; next_fire_at: string }>(
      `SELECT lease_owner, lease_expires_at, next_fire_at FROM automations WHERE id = $1`,
      [automationId]
    );
    expect(row.rows[0].lease_owner).toBeNull();
    expect(row.rows[0].lease_expires_at).toBeNull();
    expect(new Date(row.rows[0].next_fire_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('THREE concurrent sweeps racing the same due automation still produce exactly one run (not just "fewer than three")', async () => {
    await Promise.all([sweepScheduledAutomations(), sweepScheduledAutomations(), sweepScheduledAutomations()]);
    const runs = await pool.query(`SELECT id FROM automation_runs WHERE automation_id = $1`, [automationId]);
    expect(runs.rows.length).toBe(1);
  });

  it('a due automation with an EXPIRED lease from a simulated crash (claimed, never released) IS reclaimed and fires', async () => {
    // Simulate "claimed by a worker that then crashed": stamp a lease that's
    // ALREADY expired, exactly the state a real crash mid-run would leave
    // behind once SCHEDULE_LEASE_DURATION_MS has elapsed.
    await pool.query(
      `UPDATE automations SET lease_owner = 'dead_worker_from_a_crash', lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [automationId]
    );
    await sweepScheduledAutomations();
    const runs = await pool.query(`SELECT id, status FROM automation_runs WHERE automation_id = $1`, [automationId]);
    expect(runs.rows.length).toBe(1);
    expect((runs.rows[0] as { status: string }).status).toBe('success');
  });

  it('a due automation with an ACTIVE (unexpired) lease from another worker is NOT claimed — no run at all', async () => {
    await pool.query(
      `UPDATE automations SET lease_owner = 'a_worker_still_actively_running_it', lease_expires_at = NOW() + INTERVAL '5 minutes' WHERE id = $1`,
      [automationId]
    );
    await sweepScheduledAutomations();
    const runs = await pool.query(`SELECT id FROM automation_runs WHERE automation_id = $1`, [automationId]);
    expect(runs.rows.length).toBe(0); // correctly left alone — another worker legitimately owns it right now
  });

  it('claimDueRows directly: two concurrent claims against the SAME single due row return disjoint sets (one gets it, one gets nothing)', async () => {
    const [batchA, batchB] = await Promise.all([
      claimDueRows<{ id: string }>({
        table: 'automations',
        dueWhereSql: `id = $1 AND trigger_type = 'schedule' AND enabled = true AND next_fire_at <= NOW()`,
        dueParams: [automationId],
        leaseDurationMs: 60_000,
        limit: 10,
        leaseOwnerId: 'test_worker_A',
      }),
      claimDueRows<{ id: string }>({
        table: 'automations',
        dueWhereSql: `id = $1 AND trigger_type = 'schedule' AND enabled = true AND next_fire_at <= NOW()`,
        dueParams: [automationId],
        leaseDurationMs: 60_000,
        limit: 10,
        leaseOwnerId: 'test_worker_B',
      }),
    ]);
    const totalClaimed = batchA.length + batchB.length;
    expect(totalClaimed).toBe(1); // exactly one of the two claimed it, never both, never neither
  });

  // -------------------------------------------------------------------------
  // B8 — graceful-shutdown lease release, against real Postgres and the
  // REAL exported `releaseUnstartedScheduleLeases()` (using this process's
  // actual WORKER_ID, not a stand-in string) — proves the shutdown-time
  // release genuinely frees up leased rows rather than only relying on
  // their natural expiry (which could otherwise leave the rest of a
  // partially-worked batch unclaimable for up to SCHEDULE_LEASE_DURATION_MS
  // after an orderly shutdown, not just a crash).
  // -------------------------------------------------------------------------
  describe('releaseUnstartedScheduleLeases (B8)', () => {
    const secondAutomationId = 'automation_test_b3_lease_2';

    async function seedSecondDueAutomation() {
      await pool.query(`DELETE FROM automation_runs WHERE automation_id = $1`, [secondAutomationId]);
      await pool.query(`DELETE FROM automations WHERE id = $1`, [secondAutomationId]);
      await pool.query(
        `INSERT INTO automations (id, workspace_id, user_id, name, enabled, graph, trigger_type, trigger_scope, next_fire_at, owner_entity_type, owner_entity_id)
         VALUES ($1, $2, $3, 'B3 Lease Test Automation 2', true, $4, 'schedule', $5, NOW() - INTERVAL '1 minute', NULL, NULL)`,
        [secondAutomationId, wsId, userId, JSON.stringify(trivialGraph()), JSON.stringify({ freq: 'daily', time: '09:00' })]
      );
    }

    afterAll(async () => {
      await pool.query(`DELETE FROM automation_runs WHERE automation_id = $1`, [secondAutomationId]);
      await pool.query(`DELETE FROM automations WHERE id = $1`, [secondAutomationId]);
    });

    it('genuinely releases a claimed-but-not-yet-started lease held by THIS process\'s real WORKER_ID, through the real exported function', async () => {
      await seedDueAutomation();
      await seedSecondDueAutomation();

      // Simulate "sweepScheduledAutomations claimed a batch of 2" by
      // claiming directly with the REAL WORKER_ID this process actually
      // uses (not a stand-in) — since neither automation is ACTUALLY being
      // executed by runAutomation() right now, `currentlyExecutingSchedule
      // AutomationId` inside automationEngine.ts is still `null`, so
      // releaseUnstartedScheduleLeases() below should release BOTH.
      const claimed = await claimDueRows<{ id: string }>({
        table: 'automations',
        dueWhereSql: `id = ANY($1::varchar[]) AND trigger_type = 'schedule' AND enabled = true AND next_fire_at <= NOW()`,
        dueParams: [[automationId, secondAutomationId]],
        leaseDurationMs: 60_000,
        limit: 10,
        leaseOwnerId: WORKER_ID,
      });
      expect(claimed.length).toBe(2); // both genuinely claimed under this process's real identity

      const beforeRelease = await pool.query<{ id: string; lease_owner: string | null }>(
        `SELECT id, lease_owner FROM automations WHERE id = ANY($1::varchar[])`, [[automationId, secondAutomationId]]
      );
      expect(beforeRelease.rows.every((r) => r.lease_owner === WORKER_ID)).toBe(true);

      const releasedCount = await releaseUnstartedScheduleLeases();
      expect(releasedCount).toBeGreaterThanOrEqual(2); // at least these two (could include leftovers from other tests' own claims under the same WORKER_ID, never fewer)

      const afterRelease = await pool.query<{ id: string; lease_owner: string | null; lease_expires_at: string | null }>(
        `SELECT id, lease_owner, lease_expires_at FROM automations WHERE id = ANY($1::varchar[])`, [[automationId, secondAutomationId]]
      );
      expect(afterRelease.rows.every((r) => r.lease_owner === null)).toBe(true);
      expect(afterRelease.rows.every((r) => r.lease_expires_at === null)).toBe(true);

      // And, being genuinely unleased again, either row is immediately
      // re-claimable by a (simulated) different worker — the real point of
      // releasing rather than waiting out the lease.
      const reclaimed = await claimDueRows<{ id: string }>({
        table: 'automations',
        dueWhereSql: `id = ANY($1::varchar[]) AND trigger_type = 'schedule' AND enabled = true AND next_fire_at <= NOW()`,
        dueParams: [[automationId, secondAutomationId]],
        leaseDurationMs: 60_000,
        limit: 10,
        leaseOwnerId: 'a_different_worker',
      });
      expect(reclaimed.length).toBe(2);
    });

    it('never touches a row leased by a DIFFERENT worker — only releases this process\'s own WORKER_ID leases', async () => {
      // Self-contained (does not depend on the previous test's leftover
      // state, and deliberately avoids `automationId` — the outer file's
      // own `beforeEach` reseeds THAT fixture fresh/unleased before every
      // single test in this whole file, including this one, so asserting
      // against it here would be coupled to hook-ordering rather than to
      // the behavior actually under test).
      await seedSecondDueAutomation();
      await pool.query(
        `UPDATE automations SET lease_owner = 'a_different_worker', lease_expires_at = NOW() + INTERVAL '5 minutes' WHERE id = $1`,
        [secondAutomationId]
      );

      await releaseUnstartedScheduleLeases();

      const stillLeased = await pool.query<{ id: string; lease_owner: string | null }>(
        `SELECT id, lease_owner FROM automations WHERE id = $1`, [secondAutomationId]
      );
      expect(stillLeased.rows[0].lease_owner).toBe('a_different_worker'); // untouched — not this process's own lease
    });
  });
});
