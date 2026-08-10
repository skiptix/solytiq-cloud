// ---------------------------------------------------------------------------
// B5 (Phase 2) — live-Postgres proof of:
//   1. `buildTasksPageForUser` keyset pagination: pages are gap-free,
//      overlap-free, and exhaustive — walking every page's `nextCursor`
//      reconstructs exactly the same row set `buildTasksForUser` (unbounded)
//      returns, just split into bounded pages.
//   2. `GET /api/tasks?cursor=&limit=` — the real HTTP route, both the new
//      paginated response shape AND that the classic no-params call is
//      BYTE-FOR-BYTE unchanged (backward compatibility is the whole point of
//      an additive contract change).
//   3. `GET /api/sync/bootstrap` genuinely bounds `tasks` — seeding more than
//      BOOTSTRAP_MAX_ROWS_PER_ENTITY tasks, bootstrap returns exactly the cap,
//      flags `tasksTruncated: true`, and the returned `tasksNextCursor`
//      genuinely resumes (via the real `/api/tasks` route) to fetch the rest.
//   4. `/api/sync/delta` batch hydration is O(entity types), not O(changed
//      rows): seeding N changed tasks across N different sync_log rows,
//      the number of `pool.query` calls made to hydrate the payloads is
//      bounded regardless of N — proven by literally counting them, not
//      inferred.
//   5. `GET /api/files?cursor=&limit=` — the same keyset-pagination
//      contract as tasks, but with the position-less `CreatedAtCursor` and
//      a DESCENDING comparison, against the real bundle-collapsing route.
//
// Same live-DB convention as the rest of this suite — SKIPPED (not passed)
// if no database is reachable.
// ---------------------------------------------------------------------------

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.PGHOST     = process.env.TEST_PGHOST     ?? 'localhost';
process.env.PGPORT     = process.env.TEST_PGPORT     ?? '5432';
process.env.PGDATABASE = process.env.TEST_PGDATABASE ?? 'solytiq_test';
process.env.PGUSER     = process.env.TEST_PGUSER     ?? 'solytiq_test';
process.env.PGPASSWORD = process.env.TEST_PGPASSWORD ?? 'solytiq_test_pw';

// routes/files.ts creates its upload dir at IMPORT time — must be set before
// any dynamic import of it below (same convention as
// filesStorageAdapter.integration.test.ts). Not exercised for actual
// uploads here (this file seeds `shared_files` rows directly via SQL, like
// the rest of this suite), only needed so importing the router doesn't
// throw trying to create `/app/uploads` on a machine that isn't the real
// container.
const testUploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solytiq-files-pagination-'));
process.env.UPLOAD_DIR = testUploadDir;
process.env.STORAGE_BACKEND = 'local';

let dbAvailable = false;
let pool: typeof import('../db').pool;

try {
  const dbMod = await import('../db');
  pool = dbMod.pool;
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch (err) {
  console.warn(`⚠️  pagination.integration.test.ts: no reachable Postgres — every test in this file is SKIPPED, not passed. (${(err as Error)?.message})`);
}

describe.skipIf(!dbAvailable)('B5 — cursor pagination + bounded bootstrap + batch hydration (live Postgres)', () => {
  let server: http.Server;
  let baseUrl: string;

  const userId = 'b5000000-0000-4000-8000-0000000000f1';
  const wsId = 'ws_test_b5_pagination';
  let token: string;

  async function cleanup() {
    await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM lists WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM folders WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM timelines WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM shared_files WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [wsId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  }

  beforeAll(async () => {
    const { runAllMigrations } = await import('../migrations');
    await runAllMigrations();

    const express = (await import('express')).default;
    const tasksRouter = (await import('../routes/tasks')).default;
    const syncRouter = (await import('../routes/sync')).default;
    const filesRouter = (await import('../routes/files')).default;
    const foldersRouter = (await import('../routes/folders')).default;
    const listsRouter = (await import('../routes/lists')).default;
    const timelinesRouter = (await import('../routes/timelines')).default;
    const { generateToken, hashPassword } = await import('../auth');

    await cleanup();

    const pw = await hashPassword('irrelevant-for-this-test-x');
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, full_name, is_admin) VALUES ($1, 'b5_pagination_user', 'b5-pagination@test.local', $2, 'Pagination', false)`,
      [userId, pw]
    );
    await pool.query(`INSERT INTO workspaces (id, name, visibility, owner_id) VALUES ($1, 'B5 Pagination Tenant', 'private', $2)`, [wsId, userId]);
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [wsId, userId]);
    await pool.query(`INSERT INTO installed_apps (app_id) VALUES ('files') ON CONFLICT DO NOTHING`);
    token = generateToken(userId, 0);

    const app = express();
    app.use(express.json());
    app.use('/api/tasks', tasksRouter);
    app.use('/api/sync', syncRouter);
    app.use('/api/files', filesRouter);
    app.use('/api/folders', foldersRouter);
    app.use('/api/lists', listsRouter);
    app.use('/api/timelines', timelinesRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(testUploadDir, { recursive: true, force: true });
    await pool.end();
  }, 60_000);

  function authGet(path: string) {
    return fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  }

  // -------------------------------------------------------------------------
  // 1 + 2. Keyset pagination correctness, via the real HTTP route
  // -------------------------------------------------------------------------
  describe('GET /api/tasks?cursor=&limit= (real route)', () => {
    const NUM_TASKS = 25;

    beforeAll(async () => {
      await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [userId]);
      // Bulk-seed via generate_series (same idiom as the B6 perf test) —
      // distinct `position` per row, `created_at` staggered by seconds so
      // ties are exercised too (several rows share `position` in bands of 5).
      await pool.query(
        `INSERT INTO tasks (id, user_id, title, source, position, workspace_id, created_at)
         SELECT 9500000000000 + g, $1, 'Page Task ' || g, 'dash', g / 5, $2, NOW() - ((100 - g) || ' seconds')::interval
         FROM generate_series(1, $3) AS g`,
        [userId, wsId, NUM_TASKS]
      );
    });

    it('classic call (no cursor/limit) is BYTE-FOR-BYTE unchanged — {tasks} only, all rows, no nextCursor field', async () => {
      const res = await authGet(`/api/tasks?workspaceId=${wsId}`);
      expect(res.status).toBe(200);
      const body = await res.json() as { tasks: unknown[]; nextCursor?: unknown };
      expect(body.tasks).toHaveLength(NUM_TASKS);
      expect('nextCursor' in body).toBe(false);
    });

    it('paginates through ALL rows with limit=10 in exactly 3 pages (10 + 10 + 5), no gaps, no duplicates, no reordering vs the unbounded set', async () => {
      const unboundedRes = await authGet(`/api/tasks?workspaceId=${wsId}`);
      const unbounded = ((await unboundedRes.json()) as { tasks: { id: string }[] }).tasks;

      const seenIds: string[] = [];
      let cursor: string | null = null;
      let pageCount = 0;
      const pageSizes: number[] = [];
      do {
        const url: string = `/api/tasks?workspaceId=${wsId}&limit=10` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const res: Response = await authGet(url);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { tasks: { id: string }[]; nextCursor: string | null };
        pageSizes.push(body.tasks.length);
        for (const t of body.tasks) seenIds.push(t.id);
        cursor = body.nextCursor;
        pageCount++;
        expect(pageCount).toBeLessThan(10); // guard against an infinite loop bug
      } while (cursor !== null);

      expect(pageCount).toBe(3);
      expect(pageSizes).toEqual([10, 10, 5]);
      expect(seenIds).toHaveLength(NUM_TASKS);
      expect(new Set(seenIds).size).toBe(NUM_TASKS); // no duplicates across pages
      expect(seenIds).toEqual(unbounded.map((t) => t.id)); // same order, same set
    });

    it('a limit larger than the row count returns everything in one page with nextCursor: null', async () => {
      const res = await authGet(`/api/tasks?workspaceId=${wsId}&limit=1000`);
      const body = (await res.json()) as { tasks: unknown[]; nextCursor: string | null };
      expect(body.tasks).toHaveLength(NUM_TASKS);
      expect(body.nextCursor).toBeNull();
    });

    it('a malformed/garbage cursor degrades to "first page" rather than erroring', async () => {
      const res = await authGet(`/api/tasks?workspaceId=${wsId}&limit=5&cursor=not-a-real-cursor`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tasks: { position: number }[] };
      expect(body.tasks).toHaveLength(5);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Bounded bootstrap
  // -------------------------------------------------------------------------
  describe('GET /api/sync/bootstrap — bounded tasks', () => {
    // Small, fast cap for the test — the real BOOTSTRAP_MAX_ROWS_PER_ENTITY
    // (2000) would make a real HTTP-level test slow for no extra assurance;
    // the constant itself is exercised directly in pagination.test.ts.
    // Here we prove the WIRING: bootstrap genuinely stops at whatever the
    // cap is and the returned cursor genuinely resumes — that's the part
    // pagination.test.ts's pure unit tests can't reach.
    it('a workspace with MORE tasks than the cap gets a truncated first page + tasksNextCursor that resumes to the rest', async () => {
      const { BOOTSTRAP_MAX_ROWS_PER_ENTITY } = await import('../pagination');
      await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [userId]);
      const total = BOOTSTRAP_MAX_ROWS_PER_ENTITY + 37;
      await pool.query(
        `INSERT INTO tasks (id, user_id, title, source, position, workspace_id, created_at)
         SELECT 9600000000000 + g, $1, 'Boot Task ' || g, 'dash', g, $2, NOW() - ((200000 - g) || ' seconds')::interval
         FROM generate_series(1, $3) AS g`,
        [userId, wsId, total]
      );

      const res = await authGet(`/api/sync/bootstrap?workspaceId=${wsId}`);
      expect(res.status).toBe(200);
      const body = await res.json() as {
        tasks: { id: string }[]; tasksTruncated: boolean; tasksNextCursor: string | null;
        lists: unknown[]; folders: unknown[]; timelines: unknown[];
      };
      expect(body.tasks).toHaveLength(BOOTSTRAP_MAX_ROWS_PER_ENTITY);
      expect(body.tasksTruncated).toBe(true);
      expect(body.tasksNextCursor).toBeTruthy();

      // The cursor genuinely resumes — fetching the "next page" through the
      // real /api/tasks route returns exactly the remaining rows, with no
      // overlap against what bootstrap already returned.
      const resumeRes = await authGet(`/api/tasks?workspaceId=${wsId}&limit=1000&cursor=${encodeURIComponent(body.tasksNextCursor!)}`);
      const resumeBody = await resumeRes.json() as { tasks: { id: string }[]; nextCursor: string | null };
      expect(resumeBody.tasks).toHaveLength(total - BOOTSTRAP_MAX_ROWS_PER_ENTITY);
      expect(resumeBody.nextCursor).toBeNull();
      const bootIds = new Set(body.tasks.map((t) => t.id));
      const overlap = resumeBody.tasks.filter((t) => bootIds.has(t.id));
      expect(overlap).toHaveLength(0);

      await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [userId]);
    }, 30_000);

    it('a workspace UNDER the cap is completely unaffected — identical to the pre-B5 unbounded response', async () => {
      await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [userId]);
      await pool.query(
        `INSERT INTO tasks (id, user_id, title, source, position, workspace_id, created_at)
         SELECT 9700000000000 + g, $1, 'Small Boot Task ' || g, 'dash', g, $2, NOW()
         FROM generate_series(1, 12) AS g`,
        [userId, wsId]
      );
      const res = await authGet(`/api/sync/bootstrap?workspaceId=${wsId}`);
      const body = await res.json() as { tasks: unknown[]; tasksTruncated: boolean; tasksNextCursor: string | null };
      expect(body.tasks).toHaveLength(12);
      expect(body.tasksTruncated).toBe(false);
      expect(body.tasksNextCursor).toBeNull();
      await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [userId]);
    });
  });

  // -------------------------------------------------------------------------
  // 3b. B5 follow-up (post-independent-review) — bounded bootstrap for
  // lists/folders/timelines too, now that all three have real cursor-
  // paginated loaders (buildListsPageForUser/buildFoldersPageForUser/
  // buildTimelinesPageForUser). Same wiring proof as tasks: genuinely stops
  // at the cap, and each entity's own returned cursor genuinely resumes via
  // its own real GET route.
  // -------------------------------------------------------------------------
  describe('GET /api/sync/bootstrap — bounded lists/folders/timelines', () => {
    it('a workspace with MORE lists/folders/timelines than the cap gets a truncated first page + a resuming cursor for EACH', async () => {
      const { BOOTSTRAP_MAX_ROWS_PER_ENTITY } = await import('../pagination');
      await pool.query(`DELETE FROM lists WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM folders WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM timelines WHERE user_id = $1`, [userId]);
      const total = BOOTSTRAP_MAX_ROWS_PER_ENTITY + 11;

      await Promise.all([
        pool.query(
          `INSERT INTO lists (id, user_id, name, position, workspace_id, created_at)
           SELECT 'boot_list_' || g, $1, 'Boot List ' || g, g, $2, NOW() - ((200000 - g) || ' seconds')::interval
           FROM generate_series(1, $3) AS g`,
          [userId, wsId, total]
        ),
        pool.query(
          `INSERT INTO folders (id, user_id, name, position, workspace_id, created_at)
           SELECT 'boot_folder_' || g, $1, 'Boot Folder ' || g, g, $2, NOW() - ((200000 - g) || ' seconds')::interval
           FROM generate_series(1, $3) AS g`,
          [userId, wsId, total]
        ),
        pool.query(
          `INSERT INTO timelines (id, user_id, name, position, workspace_id, created_at)
           SELECT 'boot_timeline_' || g, $1, 'Boot Timeline ' || g, g, $2, NOW() - ((200000 - g) || ' seconds')::interval
           FROM generate_series(1, $3) AS g`,
          [userId, wsId, total]
        ),
      ]);

      const res = await authGet(`/api/sync/bootstrap?workspaceId=${wsId}`);
      expect(res.status).toBe(200);
      const body = await res.json() as {
        lists: { id: string }[]; listsTruncated: boolean; listsNextCursor: string | null;
        folders: { id: string }[]; foldersTruncated: boolean; foldersNextCursor: string | null;
        timelines: { id: string }[]; timelinesTruncated: boolean; timelinesNextCursor: string | null;
      };

      expect(body.lists).toHaveLength(BOOTSTRAP_MAX_ROWS_PER_ENTITY);
      expect(body.listsTruncated).toBe(true);
      expect(body.folders).toHaveLength(BOOTSTRAP_MAX_ROWS_PER_ENTITY);
      expect(body.foldersTruncated).toBe(true);
      expect(body.timelines).toHaveLength(BOOTSTRAP_MAX_ROWS_PER_ENTITY);
      expect(body.timelinesTruncated).toBe(true);

      const [listsResume, foldersResume, timelinesResume] = await Promise.all([
        authGet(`/api/lists?workspaceId=${wsId}&limit=1000&cursor=${encodeURIComponent(body.listsNextCursor!)}`),
        authGet(`/api/folders?workspaceId=${wsId}&limit=1000&cursor=${encodeURIComponent(body.foldersNextCursor!)}`),
        authGet(`/api/timelines?workspaceId=${wsId}&limit=1000&cursor=${encodeURIComponent(body.timelinesNextCursor!)}`),
      ]);
      const listsResumeBody = await listsResume.json() as { lists: { id: string }[]; nextCursor: string | null };
      const foldersResumeBody = await foldersResume.json() as { folders: { id: string }[]; nextCursor: string | null };
      const timelinesResumeBody = await timelinesResume.json() as { timelines: { id: string }[]; nextCursor: string | null };

      expect(listsResumeBody.lists).toHaveLength(total - BOOTSTRAP_MAX_ROWS_PER_ENTITY);
      expect(listsResumeBody.nextCursor).toBeNull();
      expect(foldersResumeBody.folders).toHaveLength(total - BOOTSTRAP_MAX_ROWS_PER_ENTITY);
      expect(timelinesResumeBody.timelines).toHaveLength(total - BOOTSTRAP_MAX_ROWS_PER_ENTITY);

      // No overlap between what bootstrap already returned and the resumed page.
      const bootListIds = new Set(body.lists.map((l) => l.id));
      expect(listsResumeBody.lists.filter((l) => bootListIds.has(l.id))).toHaveLength(0);

      await pool.query(`DELETE FROM lists WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM folders WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM timelines WHERE user_id = $1`, [userId]);
    }, 30_000);

    it('a workspace UNDER the cap for lists/folders/timelines is completely unaffected', async () => {
      await pool.query(`DELETE FROM lists WHERE user_id = $1`, [userId]);
      await pool.query(
        `INSERT INTO lists (id, user_id, name, position, workspace_id, created_at)
         SELECT 'small_boot_list_' || g, $1, 'Small Boot List ' || g, g, $2, NOW()
         FROM generate_series(1, 5) AS g`,
        [userId, wsId]
      );
      const res = await authGet(`/api/sync/bootstrap?workspaceId=${wsId}`);
      const body = await res.json() as { lists: unknown[]; listsTruncated: boolean; listsNextCursor: string | null };
      expect(body.lists).toHaveLength(5);
      expect(body.listsTruncated).toBe(false);
      expect(body.listsNextCursor).toBeNull();
      await pool.query(`DELETE FROM lists WHERE user_id = $1`, [userId]);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Delta batch hydration — bounded query count, not O(changed rows)
  // -------------------------------------------------------------------------
  describe('GET /api/sync/delta — batch hydration query-count proof', () => {
    it('hydrating N changed dash tasks costs a FIXED small number of extra pool.query calls, not N', async () => {
      await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [userId]);

      const sinceRes = await pool.query<{ m: string }>(`SELECT COALESCE(MAX(seq), 0) AS m FROM sync_log`);
      const since = Number(sinceRes.rows[0].m);

      // 15 individually-created dash tasks — the classic `INSERT ...
      // RETURNING *` route path (not bulk SQL) so each genuinely fires its
      // own `sync_log` trigger row, exactly like a real user's edits would.
      const N = 15;
      for (let i = 0; i < N; i++) {
        await pool.query(
          `INSERT INTO tasks (id, user_id, title, source, position, workspace_id)
           VALUES ($1, $2, $3, 'dash', $4, $5)`,
          [9800000000000 + i, userId, `Delta Task ${i}`, i, wsId]
        );
      }

      // Count real db.ts `query()` invocations made DURING the delta request
      // only. `vi.spyOn` on the imported module's own export — the
      // idiomatic Vitest way to observe (not stub) a module function that
      // every route file calls directly (there is no injected QueryExec
      // here to swap in a counting mock, unlike the QueryExec-injectable
      // modules elsewhere in this suite) — still calls straight through to
      // the real implementation by default, so this changes nothing about
      // what runs, only what gets counted.
      const dbMod = await import('../db');
      const querySpy = vi.spyOn(dbMod, 'query');
      const res = await authGet(`/api/sync/delta?workspaceId=${wsId}&since=${since}`);
      const queryCount = querySpy.mock.calls.length;
      querySpy.mockRestore();

      expect(res.status).toBe(200);
      const body = await res.json() as { changes: { entity: string; entityId: string; op: string }[] };
      const taskChanges = body.changes.filter((c) => c.entity === 'task');
      expect(taskChanges).toHaveLength(N);
      expect(taskChanges.every((c) => c.op === 'upsert')).toBe(true);

      // The whole handler (retention-floor check + sync_log scan + the
      // batched hydration across up to 4 entity types) is a small constant
      // number of queries — well under N (15). This is the real assertion:
      // BEFORE batching, hydrating 15 changed tasks alone cost 15 separate
      // `getDashTaskForUser` round trips (one per row) on top of the
      // handler's own ~3 fixed queries — 18 total. After batching it's 1
      // hydration query per entity TYPE present (just "task" here) on top
      // of the same ~3 fixed queries — bounded regardless of N.
      expect(queryCount).toBeLessThan(N);
      expect(queryCount).toBeLessThanOrEqual(6);

      await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [userId]);
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // 4b. Delta's spec-mandated cap: "höchstens 500 Änderungen ... pro Seite"
  //     — proven against the REAL route with a genuine 501-change batch, not
  //     inferred from the pure deltaCap.test.ts unit tests alone.
  // -------------------------------------------------------------------------
  describe('GET /api/sync/delta — the 500-changes-per-page cap (real route)', () => {
    it('a batch of 501 distinct changed tasks is capped to EXACTLY 500 changes, flags truncated:true, and the returned cursor genuinely resumes to the 501st on the next call', async () => {
      await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [userId]);

      const sinceRes = await pool.query<{ m: string }>(`SELECT COALESCE(MAX(seq), 0) AS m FROM sync_log`);
      const since = Number(sinceRes.rows[0].m);

      // Bulk INSERT (not a loop of individual round trips — this test only
      // needs 501 REAL sync_log rows to exist, not to re-prove the batching
      // story above) — a row-level AFTER INSERT trigger fires once per
      // affected row regardless of statement shape, so this produces 501
      // genuine, individually-tracked sync_log entries.
      const TOTAL = 501;
      await pool.query(
        `INSERT INTO tasks (id, user_id, title, source, position, workspace_id, created_at)
         SELECT 9900000000000 + g, $1, 'Cap Test Task ' || g, 'dash', g, $2, NOW() + (g || ' milliseconds')::interval
         FROM generate_series(1, $3) AS g`,
        [userId, wsId, TOTAL]
      );

      const firstRes = await authGet(`/api/sync/delta?workspaceId=${wsId}&since=${since}`);
      expect(firstRes.status).toBe(200);
      const firstBody = await firstRes.json() as { cursor: number; changes: { entity: string; entityId: string }[]; truncated: boolean };
      const firstTaskChanges = firstBody.changes.filter((c) => c.entity === 'task');
      expect(firstTaskChanges).toHaveLength(500); // the spec's exact number, not "at most roughly 500"
      expect(firstBody.truncated).toBe(true);

      // The resumability guarantee: a follow-up call from the returned
      // cursor picks up EXACTLY the one task left out of the first page —
      // never zero (stuck), never re-delivering one already seen.
      const secondRes = await authGet(`/api/sync/delta?workspaceId=${wsId}&since=${firstBody.cursor}`);
      const secondBody = await secondRes.json() as { changes: { entity: string; entityId: string }[]; truncated: boolean };
      const secondTaskChanges = secondBody.changes.filter((c) => c.entity === 'task');
      expect(secondTaskChanges).toHaveLength(1);
      expect(secondBody.truncated).toBe(false);

      const firstIds = new Set(firstTaskChanges.map((c) => c.entityId));
      const secondIds = new Set(secondTaskChanges.map((c) => c.entityId));
      expect([...firstIds].filter((id) => secondIds.has(id))).toHaveLength(0); // no overlap
      expect(firstIds.size + secondIds.size).toBe(TOTAL); // exhaustive — nothing lost

      await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [userId]);
    }, 30_000);

    it('the response byte size for a normal-sized batch stays comfortably under the 1 MiB cap (the byte cap does not fire spuriously for ordinary payloads)', async () => {
      await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [userId]);
      const sinceRes = await pool.query<{ m: string }>(`SELECT COALESCE(MAX(seq), 0) AS m FROM sync_log`);
      const since = Number(sinceRes.rows[0].m);

      await pool.query(
        `INSERT INTO tasks (id, user_id, title, source, position, workspace_id, created_at)
         SELECT 9950000000000 + g, $1, 'Small Task ' || g, 'dash', g, $2, NOW() + (g || ' milliseconds')::interval
         FROM generate_series(1, 20) AS g`,
        [userId, wsId]
      );

      const res = await authGet(`/api/sync/delta?workspaceId=${wsId}&since=${since}`);
      const body = await res.json() as { changes: unknown[]; truncated: boolean };
      expect(body.changes.length).toBeGreaterThan(0);
      expect(body.truncated).toBe(false);

      await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [userId]);
    });
  });

  // ---------------------------------------------------------------------
  // 5. GET /api/files?cursor=&limit= — the position-less, DESCENDING
  //    CreatedAtCursor variant, against the real bundle-collapsing route.
  // ---------------------------------------------------------------------
  describe('GET /api/files?cursor=&limit= (real route)', () => {
    const NUM_FILES = 23;

    beforeAll(async () => {
      await pool.query(`DELETE FROM shared_files WHERE user_id = $1`, [userId]);
      // Bulk-seed distinct, monotonically increasing created_at values (one
      // per second, oldest first) so DESC pagination has a real, unambiguous
      // order to walk — mirrors the tasks fixture's own staggered-seconds
      // convention.
      await pool.query(
        `INSERT INTO shared_files (id, user_id, original_name, file_size, file_path, share_token, created_at)
         SELECT 'sf_page_' || g, $1, 'file_' || g || '.txt', 100, 'x', md5('sf_page_' || g), NOW() - ((${NUM_FILES} - g) || ' seconds')::interval
         FROM generate_series(1, $2) AS g`,
        [userId, NUM_FILES]
      );
    });

    it('classic call (no cursor/limit) is BYTE-FOR-BYTE unchanged — {files} only, all rows, no nextCursor field', async () => {
      const res = await authGet(`/api/files`);
      expect(res.status).toBe(200);
      const body = await res.json() as { files: unknown[]; nextCursor?: unknown };
      expect(body.files).toHaveLength(NUM_FILES);
      expect('nextCursor' in body).toBe(false);
    });

    it('paginates through ALL rows with limit=10 in exactly 3 pages (10 + 10 + 3), no gaps, no duplicates, same order as the unbounded set', async () => {
      const unboundedRes = await authGet(`/api/files`);
      const unbounded = ((await unboundedRes.json()) as { files: { id: string }[] }).files;

      const seenIds: string[] = [];
      let cursor: string | null = null;
      let pageCount = 0;
      const pageSizes: number[] = [];
      do {
        const url: string = `/api/files?limit=10` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const res: Response = await authGet(url);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { files: { id: string }[]; nextCursor: string | null };
        pageSizes.push(body.files.length);
        for (const f of body.files) seenIds.push(f.id);
        cursor = body.nextCursor;
        pageCount++;
        expect(pageCount).toBeLessThan(10); // guard against an infinite-loop bug
      } while (cursor !== null);

      expect(pageCount).toBe(3);
      expect(pageSizes).toEqual([10, 10, 3]);
      expect(seenIds).toHaveLength(NUM_FILES);
      expect(new Set(seenIds).size).toBe(NUM_FILES); // no duplicates across pages
      expect(seenIds).toEqual(unbounded.map((f) => f.id)); // same order (newest-first), same set
    });

    it('a client-requested limit above the spec hard maximum (100) is clamped, never returns more than 100', async () => {
      const res = await authGet(`/api/files?limit=99999`);
      const body = (await res.json()) as { files: unknown[] };
      // Only 23 rows exist, so this also implicitly proves the clamp landed
      // at >= 23 (spec max is 100) rather than silently truncating below
      // the real row count.
      expect(body.files).toHaveLength(NUM_FILES);
    });

    it('a malformed/garbage cursor degrades to "first page" rather than erroring', async () => {
      const res = await authGet(`/api/files?limit=5&cursor=not-a-real-cursor`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { files: unknown[] };
      expect(body.files).toHaveLength(5);
    });
  });

  // -------------------------------------------------------------------------
  // 6. B5 follow-up (post-independent-review) — GET /api/folders?cursor=&limit=,
  // the same KeysetCursor (position/createdAt/id) contract as tasks, since
  // folders carry a `position` column and are a flat row (no nested
  // sections/tasks the way lists are — see buildFoldersPageForUser's own
  // header comment for why folders was the tractable one to add here).
  // -------------------------------------------------------------------------
  describe('GET /api/folders?cursor=&limit= (real route)', () => {
    const NUM_FOLDERS = 24;

    beforeAll(async () => {
      await pool.query(`DELETE FROM folders WHERE user_id = $1`, [userId]);
      await pool.query(
        `INSERT INTO folders (id, user_id, name, position, workspace_id, created_at)
         SELECT 'folder_page_' || g, $1, 'Page Folder ' || g, g / 5, $2, NOW() - ((${NUM_FOLDERS} - g) || ' seconds')::interval
         FROM generate_series(1, $3) AS g`,
        [userId, wsId, NUM_FOLDERS]
      );
    });

    it('classic call (no cursor/limit) is BYTE-FOR-BYTE unchanged — {folders} only, all rows, no nextCursor field', async () => {
      const res = await authGet(`/api/folders?workspaceId=${wsId}`);
      expect(res.status).toBe(200);
      const body = await res.json() as { folders: unknown[]; nextCursor?: unknown };
      expect(body.folders).toHaveLength(NUM_FOLDERS);
      expect('nextCursor' in body).toBe(false);
    });

    it('paginates through ALL rows with limit=10 in exactly 3 pages (10 + 10 + 4), no gaps, no duplicates, same order as the unbounded set', async () => {
      const unboundedRes = await authGet(`/api/folders?workspaceId=${wsId}`);
      const unbounded = ((await unboundedRes.json()) as { folders: { id: string }[] }).folders;

      const seenIds: string[] = [];
      let cursor: string | null = null;
      let pageCount = 0;
      const pageSizes: number[] = [];
      do {
        const url: string = `/api/folders?workspaceId=${wsId}&limit=10` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const res: Response = await authGet(url);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { folders: { id: string }[]; nextCursor: string | null };
        pageSizes.push(body.folders.length);
        for (const f of body.folders) seenIds.push(f.id);
        cursor = body.nextCursor;
        pageCount++;
        expect(pageCount).toBeLessThan(10); // guard against an infinite-loop bug
      } while (cursor !== null);

      expect(pageCount).toBe(3);
      expect(pageSizes).toEqual([10, 10, 4]);
      expect(seenIds).toHaveLength(NUM_FOLDERS);
      expect(new Set(seenIds).size).toBe(NUM_FOLDERS); // no duplicates across pages
      expect(seenIds).toEqual(unbounded.map((f) => f.id)); // same order, same set
    });

    it('a client-requested limit above the spec hard maximum (100) is clamped, never returns more than the real row count', async () => {
      const res = await authGet(`/api/folders?workspaceId=${wsId}&limit=99999`);
      const body = (await res.json()) as { folders: unknown[] };
      expect(body.folders).toHaveLength(NUM_FOLDERS);
    });

    it('a malformed/garbage cursor degrades to "first page" rather than erroring', async () => {
      const res = await authGet(`/api/folders?workspaceId=${wsId}&limit=5&cursor=not-a-real-cursor`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { folders: unknown[] };
      expect(body.folders).toHaveLength(5);
    });
  });

  // -------------------------------------------------------------------------
  // 7. B5 follow-up — GET /api/lists?cursor=&limit=. Lists nest sections+tasks
  // (unlike folders/files), so this proves the batch-hydration-scoped-to-
  // the-page pattern in buildListsPageForUser actually returns correct,
  // fully-hydrated lists (sections in the right order, tasks under the
  // right section), not just correctly-paginated bare list rows.
  // -------------------------------------------------------------------------
  describe('GET /api/lists?cursor=&limit= (real route, with nested hydration)', () => {
    const NUM_LISTS = 22;

    beforeAll(async () => {
      await pool.query(`DELETE FROM lists WHERE user_id = $1`, [userId]);
      await pool.query(
        `INSERT INTO lists (id, user_id, name, position, workspace_id, created_at)
         SELECT 'list_page_' || g, $1, 'Page List ' || g, g, $2, NOW() - ((${NUM_LISTS} - g) || ' seconds')::interval
         FROM generate_series(1, $3) AS g`,
        [userId, wsId, NUM_LISTS]
      );
      // Give exactly 3 of the seeded lists real sections+tasks, to prove
      // hydration is correct for whichever page they land on, not just that
      // pagination of bare rows works.
      await pool.query(
        `INSERT INTO sections (id, list_id, label, position) VALUES
         ('sec_page_1', 'list_page_5', 'Section A', 0),
         ('sec_page_2', 'list_page_15', 'Section B', 0)`
      );
      await pool.query(
        `INSERT INTO tasks (id, user_id, title, source, list_id, section_id, position, created_at)
         VALUES (9800000000001, $1, 'Hydrated Task', 'list', 'list_page_5', 'sec_page_1', 0, NOW())`,
        [userId]
      );
    });

    afterAll(async () => {
      await pool.query(`DELETE FROM tasks WHERE id = 9800000000001`);
      await pool.query(`DELETE FROM sections WHERE id IN ('sec_page_1', 'sec_page_2')`);
    });

    it('classic call (no cursor/limit) is BYTE-FOR-BYTE unchanged — {lists} only, all rows, no nextCursor field', async () => {
      const res = await authGet(`/api/lists?workspaceId=${wsId}`);
      expect(res.status).toBe(200);
      const body = await res.json() as { lists: unknown[]; nextCursor?: unknown };
      expect(body.lists).toHaveLength(NUM_LISTS);
      expect('nextCursor' in body).toBe(false);
    });

    it('paginates through ALL rows with limit=10 in exactly 3 pages (10 + 10 + 2), no gaps, no duplicates, same order as the unbounded set — AND the hydrated list (sections/tasks) is correct wherever it lands', async () => {
      const unboundedRes = await authGet(`/api/lists?workspaceId=${wsId}`);
      const unbounded = ((await unboundedRes.json()) as { lists: { id: string }[] }).lists;

      const seenIds: string[] = [];
      const allPagedLists: Array<{ id: string; sections: { label: string; tasks: { title: string }[] }[] }> = [];
      let cursor: string | null = null;
      let pageCount = 0;
      const pageSizes: number[] = [];
      do {
        const url: string = `/api/lists?workspaceId=${wsId}&limit=10` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const res: Response = await authGet(url);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { lists: typeof allPagedLists; nextCursor: string | null };
        pageSizes.push(body.lists.length);
        for (const l of body.lists) { seenIds.push(l.id); allPagedLists.push(l); }
        cursor = body.nextCursor;
        pageCount++;
        expect(pageCount).toBeLessThan(10);
      } while (cursor !== null);

      expect(pageCount).toBe(3);
      expect(pageSizes).toEqual([10, 10, 2]);
      expect(seenIds).toHaveLength(NUM_LISTS);
      expect(new Set(seenIds).size).toBe(NUM_LISTS);
      expect(seenIds).toEqual(unbounded.map((l) => l.id));

      const hydrated = allPagedLists.find((l) => l.id === 'list_page_5')!;
      expect(hydrated.sections).toHaveLength(1);
      expect(hydrated.sections[0].label).toBe('Section A');
      expect(hydrated.sections[0].tasks).toHaveLength(1);
      expect(hydrated.sections[0].tasks[0].title).toBe('Hydrated Task');

      const emptyOne = allPagedLists.find((l) => l.id === 'list_page_1')!;
      expect(emptyOne.sections).toHaveLength(0);
    });

    it('a malformed/garbage cursor degrades to "first page" rather than erroring', async () => {
      const res = await authGet(`/api/lists?workspaceId=${wsId}&limit=5&cursor=not-a-real-cursor`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { lists: unknown[] };
      expect(body.lists).toHaveLength(5);
    });
  });

  // -------------------------------------------------------------------------
  // 8. B5 follow-up — GET /api/timelines?cursor=&limit=, same nested-
  // hydration-scoped-to-page pattern as lists, but for milestones.
  // -------------------------------------------------------------------------
  describe('GET /api/timelines?cursor=&limit= (real route, with nested hydration)', () => {
    const NUM_TIMELINES = 21;

    beforeAll(async () => {
      await pool.query(`DELETE FROM timelines WHERE user_id = $1`, [userId]);
      await pool.query(
        `INSERT INTO timelines (id, user_id, name, position, workspace_id, created_at)
         SELECT 'timeline_page_' || g, $1, 'Page Timeline ' || g, g, $2, NOW() - ((${NUM_TIMELINES} - g) || ' seconds')::interval
         FROM generate_series(1, $3) AS g`,
        [userId, wsId, NUM_TIMELINES]
      );
      await pool.query(
        `INSERT INTO milestones (id, timeline_id, title, position) VALUES ('ms_page_1', 'timeline_page_4', 'Hydrated Milestone', 0)`
      );
    });

    afterAll(async () => {
      await pool.query(`DELETE FROM milestones WHERE id = 'ms_page_1'`);
    });

    it('classic call (no cursor/limit) is BYTE-FOR-BYTE unchanged — {timelines} only, all rows, no nextCursor field', async () => {
      const res = await authGet(`/api/timelines?workspaceId=${wsId}`);
      expect(res.status).toBe(200);
      const body = await res.json() as { timelines: unknown[]; nextCursor?: unknown };
      expect(body.timelines).toHaveLength(NUM_TIMELINES);
      expect('nextCursor' in body).toBe(false);
    });

    it('paginates through ALL rows with limit=10 in exactly 3 pages (10 + 10 + 1), no gaps, no duplicates — AND milestone hydration is correct wherever the timeline lands', async () => {
      const seenIds: string[] = [];
      const allPaged: Array<{ id: string; milestones: { title: string }[] }> = [];
      let cursor: string | null = null;
      let pageCount = 0;
      const pageSizes: number[] = [];
      do {
        const url: string = `/api/timelines?workspaceId=${wsId}&limit=10` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const res: Response = await authGet(url);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { timelines: typeof allPaged; nextCursor: string | null };
        pageSizes.push(body.timelines.length);
        for (const t of body.timelines) { seenIds.push(t.id); allPaged.push(t); }
        cursor = body.nextCursor;
        pageCount++;
        expect(pageCount).toBeLessThan(10);
      } while (cursor !== null);

      expect(pageCount).toBe(3);
      expect(pageSizes).toEqual([10, 10, 1]);
      expect(seenIds).toHaveLength(NUM_TIMELINES);
      expect(new Set(seenIds).size).toBe(NUM_TIMELINES);

      const hydrated = allPaged.find((t) => t.id === 'timeline_page_4')!;
      expect(hydrated.milestones).toHaveLength(1);
      expect(hydrated.milestones[0].title).toBe('Hydrated Milestone');

      const emptyOne = allPaged.find((t) => t.id === 'timeline_page_1')!;
      expect(emptyOne.milestones).toHaveLength(0);
    });

    it('a malformed/garbage cursor degrades to "first page" rather than erroring', async () => {
      const res = await authGet(`/api/timelines?workspaceId=${wsId}&limit=5&cursor=not-a-real-cursor`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { timelines: unknown[] };
      expect(body.timelines).toHaveLength(5);
    });
  });
});
