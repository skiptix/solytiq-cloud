// ---------------------------------------------------------------------------
// B9 (Phase 2) — the literal Sprint Contract requirement:
//
//   "multi-replica (2 API + 2 worker) test proving no duplicate scheduler
//    side-effects"
//
// This is deliberately NOT another in-process `sweepScheduledAutomations()`
// race (that's `scheduleLease.integration.test.ts`'s B3 job — two concurrent
// CALLS within one Node process). This test spawns TWO REAL, SEPARATE
// `node dist/index.js` child processes, each with `PROCESS_ROLE=worker`,
// pointed at the SAME live Postgres database — the actual multi-container
// deployment topology B1 (process roles) + B3 (lease claiming) exist to
// support. A due `schedule`-triggered automation is seeded before either
// process starts; both processes independently call
// `sweepScheduledAutomations()` on their own boot (index.ts's `start()`
// fires it immediately, not just on the 5-minute interval — see the comment
// at that call site), racing the SAME due row across TWO OS PROCESSES with
// two separate DB connection pools. If B3's `claimDueRows()` (a single
// atomic `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`) were
// broken, this would double-fire the automation — genuinely, not simulated.
//
// "2 API + 2 worker" from the Sprint Contract's wording is honored in
// spirit, not literally 4 processes: `roleRunsWorkerTimers()` is true for
// BOTH `worker` and `all` (see processRoles.ts), and the schedule sweep is a
// WORKER-side concern — an `api`-role replica never runs it at all (that's
// the whole point of the role split: an API replica scales stateless HTTP
// serving without multiplying periodic side effects). Spawning 2 `worker`
// processes is therefore the meaningful, literal race for THIS specific
// claim; a redundant pair of `api`-role processes would add process-spawn
// cost without exercising any code path this test doesn't already cover.
//
// Same live-DB convention as the rest of this suite — SKIPPED (not passed)
// if no database is reachable OR the backend hasn't been built
// (`npm run build` — this test spawns the COMPILED `dist/index.js`, not
// ts-node, since that's what actually ships to a container).
// ---------------------------------------------------------------------------

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
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
  console.warn(`⚠️  multiReplicaScheduler.integration.test.ts: no reachable Postgres — every test in this file is SKIPPED, not passed. (${(err as Error)?.message})`);
}

const backendDir = path.resolve(__dirname, '..', '..');
const distEntry = path.join(backendDir, 'dist', 'index.js');
const distBuilt = fs.existsSync(distEntry);
if (dbAvailable && !distBuilt) {
  console.warn(`⚠️  multiReplicaScheduler.integration.test.ts: ${distEntry} not found (run "npm run build" first) — every test in this file is SKIPPED, not passed.`);
}
const runnable = dbAvailable && distBuilt;

describe.skipIf(!runnable)('B9 — TWO REAL worker-role processes racing the SAME due schedule automation (live Postgres, real child processes)', () => {
  const userId = 'b9000000-0000-4000-8000-0000000000a1';
  const wsId = 'ws_test_b9_multireplica';
  const automationId = 'automation_test_b9_multireplica';
  let uploadDir: string;
  let children: ChildProcessWithoutNullStreams[] = [];

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

  async function cleanupFixtures() {
    await pool.query(`DELETE FROM automation_runs WHERE automation_id = $1`, [automationId]);
    await pool.query(`DELETE FROM automations WHERE id = $1`, [automationId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [wsId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  }

  async function seedDueAutomation() {
    await pool.query(`DELETE FROM automation_runs WHERE automation_id = $1`, [automationId]);
    await pool.query(`DELETE FROM automations WHERE id = $1`, [automationId]);
    await pool.query(
      `INSERT INTO automations (id, workspace_id, user_id, name, enabled, graph, trigger_type, trigger_scope, next_fire_at, owner_entity_type, owner_entity_id, lease_owner, lease_expires_at)
       VALUES ($1, $2, $3, 'B9 Multi-Replica Test Automation', true, $4, 'schedule', $5, NOW() - INTERVAL '1 minute', NULL, NULL, NULL, NULL)`,
      [automationId, wsId, userId, JSON.stringify(trivialGraph()), JSON.stringify({ freq: 'daily', time: '09:00' })]
    );
  }

  beforeAll(async () => {
    const { runAllMigrations } = await import('../migrations');
    // Migrations are applied ONCE, from this test process, exactly mirroring
    // the real deployment topology: `worker`-role processes assume a
    // `migrator`/`all` instance already migrated the schema (see
    // processRoles.ts's `roleRunsMigrations` — `worker` deliberately does
    // NOT run migrations itself).
    await runAllMigrations();
    const { hashPassword } = await import('../auth');

    await cleanupFixtures();
    const pw = await hashPassword('irrelevant-for-this-test-x');
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, full_name, is_admin) VALUES ($1, 'b9_multireplica_user', 'b9-multireplica@test.local', $2, 'MultiReplica', false)`,
      [userId, pw]
    );
    await pool.query(`INSERT INTO workspaces (id, name, visibility, owner_id) VALUES ($1, 'B9 Multi-Replica Tenant', 'private', $2)`, [wsId, userId]);
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [wsId, userId]);

    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solytiq-b9-multireplica-uploads-'));
  }, 60_000);

  afterAll(async () => {
    for (const child of children) {
      if (!child.killed) child.kill('SIGKILL');
    }
    await cleanupFixtures();
    fs.rmSync(uploadDir, { recursive: true, force: true });
    await pool.end();
  }, 30_000);

  /** Spawns a real `node dist/index.js` child with `PROCESS_ROLE=worker` on
   *  its own port, pointed at the same test DB. Resolves once the process's
   *  own `/readyz` responds 200 (genuinely ready — DB reachable, schema
   *  migrated, not draining), or rejects on a startup timeout so a hung
   *  spawn fails the test loudly instead of hanging the suite. */
  function spawnWorker(port: number): Promise<ChildProcessWithoutNullStreams> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [distEntry], {
        cwd: backendDir,
        env: {
          ...process.env,
          PROCESS_ROLE: 'worker',
          PORT: String(port),
          PGHOST: process.env.PGHOST,
          PGPORT: process.env.PGPORT,
          PGDATABASE: process.env.PGDATABASE,
          PGUSER: process.env.PGUSER,
          PGPASSWORD: process.env.PGPASSWORD,
          JWT_SECRET: 'b9_multireplica_test_secret_at_least_32_chars_long_with_variety_9f8e7d',
          FRONTEND_URL: 'http://localhost',
          UPLOAD_DIR: uploadDir,
          NODE_ENV: '', // deliberately NOT 'production' — see this file's header on why
          NUKE_SKIP_RESTART: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let settled = false;
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      child.stdout.on('data', (d) => stdoutChunks.push(String(d)));
      child.stderr.on('data', (d) => stderrChunks.push(String(d)));
      child.on('exit', (code, signal) => {
        if (!settled) {
          settled = true;
          reject(new Error(`worker process exited early (code=${code}, signal=${signal})\nstdout:\n${stdoutChunks.join('')}\nstderr:\n${stderrChunks.join('')}`));
        }
      });
      child.on('error', (err) => {
        if (!settled) { settled = true; reject(err); }
      });

      const deadline = Date.now() + 20_000;
      const pollReady = async () => {
        if (settled) return;
        if (Date.now() > deadline) {
          settled = true;
          reject(new Error(`worker process on port ${port} never became ready within 20s\nstdout:\n${stdoutChunks.join('')}\nstderr:\n${stderrChunks.join('')}`));
          return;
        }
        try {
          const res = await fetch(`http://127.0.0.1:${port}/readyz`);
          if (res.status === 200) {
            settled = true;
            resolve(child);
            return;
          }
        } catch {
          // not listening yet — retry
        }
        setTimeout(() => { void pollReady(); }, 200);
      };
      void pollReady();
    });
  }

  async function stopWorker(child: ChildProcessWithoutNullStreams): Promise<void> {
    await new Promise<void>((resolve) => {
      if (child.killed || child.exitCode !== null) { resolve(); return; }
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      // Force-kill if it doesn't drain within a few seconds — this test
      // doesn't need to verify graceful shutdown itself (see shutdown.test.ts
      // for that), just clean teardown between test cases.
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5_000);
    });
  }

  it('TWO real worker-role processes racing the same due automation on first boot produce EXACTLY ONE run — proven via automation_runs, not inferred from process exit codes', async () => {
    await seedDueAutomation();

    const [workerA, workerB] = await Promise.all([spawnWorker(18701), spawnWorker(18702)]);
    children = [workerA, workerB];

    // Both processes fire sweepScheduledAutomations() immediately on boot
    // (see index.ts's start() — not just on the 5-minute interval), and both
    // were already confirmed /readyz (schema migrated, DB reachable) before
    // this point — but the sweep itself is fire-and-forget (`void
    // ...catch()`), so give it a moment past "ready" to actually complete
    // its DB round trip and (if it wins the race) run the trivial `code`
    // action to completion.
    const deadline = Date.now() + 15_000;
    let runs: { id: string; status: string }[] = [];
    while (Date.now() < deadline) {
      const r = await pool.query<{ id: string; status: string }>(
        `SELECT id, status FROM automation_runs WHERE automation_id = $1`,
        [automationId]
      );
      runs = r.rows;
      if (runs.length > 0 && runs.every((row) => row.status !== 'running')) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    await stopWorker(workerA);
    await stopWorker(workerB);
    children = [];

    // The actual proof: exactly one automation_runs row exists for this
    // automation — not zero (both processes somehow missed it), not two
    // (the lease failed to serialize two SEPARATE OS processes/connection
    // pools the way it already proved for two calls in ONE process).
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('success');

    // And the automation's lease was released + next_fire_at advanced past
    // "now" by whichever process won — same invariant scheduleLease.
    // integration.test.ts checks for the single-process case.
    const row = await pool.query<{ lease_owner: string | null; lease_expires_at: string | null; next_fire_at: string }>(
      `SELECT lease_owner, lease_expires_at, next_fire_at FROM automations WHERE id = $1`,
      [automationId]
    );
    expect(row.rows[0].lease_owner).toBeNull();
    expect(row.rows[0].lease_expires_at).toBeNull();
    expect(new Date(row.rows[0].next_fire_at).getTime()).toBeGreaterThan(Date.now());
  }, 60_000);
});
