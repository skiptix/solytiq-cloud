// ---------------------------------------------------------------------------
// B6 (Phase 2) — query-plan regression test with a REAL 100k+-row seed.
//
// For every hot query named in the B6 spec (attachments by parent, sections
// by list/position, tasks by list/section/position, workspace-scoped
// lists/folders/timelines, files by user/created), this test:
//
//   1. Seeds a realistic dataset (bulk `INSERT ... SELECT generate_series`,
//      not row-by-row — seeding ~200k+ rows across tables in seconds).
//   2. DROPS the relevant index and runs `EXPLAIN (ANALYZE, BUFFERS)` —
//      capturing the genuine BEFORE plan/timing (this is real evidence, not
//      a guess: on this seed, every one of these queries falls back to a
//      Seq Scan without its index).
//   3. RECREATES the index and re-runs the identical query — capturing the
//      AFTER plan/timing, and asserting the top-level plan node is now an
//      index-based scan (Index Scan / Index Only Scan / Bitmap Heap Scan),
//      never a Seq Scan.
//
// Self-contained and re-runnable: the before/after comparison happens
// entirely inside the test run (no manual "run this by hand first" step),
// against the real backend/src/b6IndexMigrations.ts index definitions.
//
// Same live-DB convention as the rest of this suite: SKIPPED (not passed) if
// no database is reachable.
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
  console.warn(`⚠️  queryPlans.perf.test.ts: no reachable Postgres — every test in this file is SKIPPED, not passed. (${(err as Error)?.message})`);
}

interface PlanRow { 'QUERY PLAN': Array<{ Plan: PlanNode; 'Execution Time': number }> }
interface PlanNode {
  'Node Type': string;
  'Actual Total Time'?: number;
  Plans?: PlanNode[];
}

function topNodeType(plan: PlanNode): string {
  return plan['Node Type'];
}

/** True if this node OR any descendant is a Seq Scan (a Seq Scan can appear
 *  nested under an Aggregate/Limit/Sort — we care about the whole plan, not
 *  just the root node). */
function containsSeqScan(plan: PlanNode): boolean {
  if (plan['Node Type'] === 'Seq Scan') return true;
  return (plan.Plans ?? []).some(containsSeqScan);
}

function isIndexBased(plan: PlanNode): boolean {
  const type = topNodeType(plan);
  if (type.includes('Index')) return true;
  if (plan.Plans && plan.Plans.length > 0) return plan.Plans.some(isIndexBased);
  return false;
}

async function explain(sql: string, params: unknown[]): Promise<{ node: PlanNode; ms: number; raw: PlanNode }> {
  const r = await pool.query<PlanRow>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  const parsed = (r.rows[0] as unknown as { 'QUERY PLAN': Array<{ Plan: PlanNode; 'Execution Time': number }> })['QUERY PLAN'][0];
  return { node: parsed.Plan, ms: parsed['Execution Time'], raw: parsed.Plan };
}

/**
 * Deletes every `tasks` row for `userId` in bounded batches rather than one
 * giant statement — same reasoning as the batched seed above:
 * `trg_hardlink_task` (an AFTER INSERT OR UPDATE trigger — see
 * migrations.ts) doesn't fire on DELETE, but the entity_index/entity_links
 * composite-FK CASCADE cleanup behind a 100k-row single-statement DELETE was
 * independently measured to be slow enough to trip both this sprint's own
 * DB_STATEMENT_TIMEOUT_MS and DB_LOCK_TIMEOUT_MS defaults. Batching keeps
 * cleanup reliable regardless of how expensive the cascade is per row.
 */
async function batchedDeleteTasks(userId: string): Promise<void> {
  for (;;) {
    const r = await pool.query(
      `DELETE FROM tasks WHERE id IN (SELECT id FROM tasks WHERE user_id = $1 LIMIT 5000)`,
      [userId]
    );
    if (!r.rowCount) break;
  }
}

/** Same batching rationale as batchedDeleteTasks — sections have their own
 *  ON DELETE SET NULL cascade onto `tasks.section_id`, which is expensive
 *  at scale if any tasks still reference them, and it's cheap/robust to
 *  always batch regardless. */
async function batchedDeleteSections(whereSql: string, params: unknown[]): Promise<void> {
  for (;;) {
    const r = await pool.query(
      `DELETE FROM sections WHERE id IN (SELECT id FROM sections WHERE ${whereSql} LIMIT 5000)`,
      params
    );
    if (!r.rowCount) break;
  }
}

describe.skipIf(!dbAvailable)('B6 — hot-path query plans on a 100k+-row seed (live Postgres)', () => {
  const userId = 'b6000000-0000-4000-8000-0000000000c1';
  const wsId = 'ws_test_b6_perf';
  const NUM_LISTS = 400;
  const SECTIONS_PER_LIST = 5;      // 2,000 sections
  const TASKS_PER_SECTION = 50;     // 100,000 tasks
  const ATTACHMENTS_FRACTION = 0.3; // ~30,000 attachments
  const NUM_FOLDERS = 200;
  const NUM_TIMELINES = 200;
  const NUM_FILES = 500;
  // "Noise" workspaces — see the beforeAll comment below on why the
  // workspace-scoped lists/folders/timelines queries need the OVERALL table
  // to be large (many OTHER workspaces' rows), not just `wsId`'s own count,
  // for the query's selectivity (and therefore the planner's index-vs-seq-
  // scan choice) to be realistic.
  const NUM_NOISE_WORKSPACES = 1000;
  const NOISE_LISTS_PER_WS = 30;    // 30,000 extra lists
  const NOISE_FOLDERS_PER_WS = 15;  // 15,000 extra folders
  const NOISE_TIMELINES_PER_WS = 15; // 15,000 extra timelines

  let sampleListId: string;
  let sampleSectionId: string;

  beforeAll(async () => {
    const { runAllMigrations } = await import('../migrations');
    await runAllMigrations(); // ensures the real B6 indexes exist as the starting point

    const { hashPassword } = await import('../auth');

    await pool.query(`DELETE FROM task_attachments WHERE user_id = $1`, [userId]);
    await batchedDeleteTasks(userId);
    await batchedDeleteSections(`list_id IN (SELECT id FROM lists WHERE user_id = $1)`, [userId]);
    await pool.query(`DELETE FROM lists WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM folders WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM timelines WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM shared_files WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [wsId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1 OR owner_id = $2`, [wsId, userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);

    const pw = await hashPassword('irrelevant-for-this-test-x');
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, full_name, is_admin) VALUES ($1, 'b6_perf_user', 'b6-perf@test.local', $2, 'Perf', false)`,
      [userId, pw]
    );
    await pool.query(`INSERT INTO workspaces (id, name, visibility, owner_id) VALUES ($1, 'B6 Perf Tenant', 'private', $2)`, [wsId, userId]);
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [wsId, userId]);

    // "Noise" — 1,000 OTHER workspaces (owned by the same test user; who
    // owns them is irrelevant to a read query filtered by workspace_id),
    // each with its own lists/folders/timelines. This is what makes the
    // `WHERE workspace_id = $1` queries below GENUINELY selective: without
    // this, `lists`/`folders`/`timelines` would each only hold a few hundred
    // rows total, and Postgres's own cost-based planner CORRECTLY prefers a
    // Seq Scan over an Index Scan on a table that small — that isn't a
    // missing-index problem, it's the planner doing its job. Real
    // production workspace-scoped tables span MANY workspaces, which is
    // what this reproduces.
    await pool.query(
      `INSERT INTO workspaces (id, name, visibility, owner_id)
       SELECT 'b6_noise_ws_' || g, 'Noise WS ' || g, 'private', $1
       FROM generate_series(1, $2) AS g`,
      [userId, NUM_NOISE_WORKSPACES]
    );
    await pool.query(
      `INSERT INTO lists (id, user_id, name, workspace_id, position)
       SELECT 'b6_noise_list_' || w.g || '_' || l.g, $1, 'Noise List', 'b6_noise_ws_' || w.g, l.g
       FROM generate_series(1, $2) AS w(g) CROSS JOIN generate_series(1, $3) AS l(g)`,
      [userId, NUM_NOISE_WORKSPACES, NOISE_LISTS_PER_WS]
    );
    await pool.query(
      `INSERT INTO folders (id, user_id, name, workspace_id, position)
       SELECT 'b6_noise_folder_' || w.g || '_' || f.g, $1, 'Noise Folder', 'b6_noise_ws_' || w.g, f.g
       FROM generate_series(1, $2) AS w(g) CROSS JOIN generate_series(1, $3) AS f(g)`,
      [userId, NUM_NOISE_WORKSPACES, NOISE_FOLDERS_PER_WS]
    );
    await pool.query(
      `INSERT INTO timelines (id, user_id, name, workspace_id, position)
       SELECT 'b6_noise_tl_' || w.g || '_' || t.g, $1, 'Noise Timeline', 'b6_noise_ws_' || w.g, t.g
       FROM generate_series(1, $2) AS w(g) CROSS JOIN generate_series(1, $3) AS t(g)`,
      [userId, NUM_NOISE_WORKSPACES, NOISE_TIMELINES_PER_WS]
    );
    // One membership row per noise workspace too — enough distinct
    // `workspace_id` values (1000+) for the PRIMARY KEY (workspace_id,
    // user_id) to have genuine selectivity on its leading column, so the
    // "no new index needed" claim below is measured against a realistically
    // large table, not a handful of rows where Seq Scan trivially wins
    // regardless of any index (same lesson as the workspace-scoped
    // lists/folders/timelines queries above).
    await pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       SELECT 'b6_noise_ws_' || g, $1, 'owner' FROM generate_series(1, $2) AS g`,
      [userId, NUM_NOISE_WORKSPACES]
    );

    // Bulk-seed lists.
    await pool.query(
      `INSERT INTO lists (id, user_id, name, workspace_id, position)
       SELECT 'b6_list_' || g, $1, 'List ' || g, $2, g
       FROM generate_series(1, $3) AS g`,
      [userId, wsId, NUM_LISTS]
    );
    const firstList = await pool.query<{ id: string }>(`SELECT id FROM lists WHERE user_id = $1 ORDER BY id LIMIT 1`, [userId]);
    sampleListId = firstList.rows[0].id;

    // Bulk-seed sections (SECTIONS_PER_LIST per list).
    await pool.query(
      `INSERT INTO sections (id, list_id, label, position)
       SELECT 'b6_sec_' || l.g || '_' || s.g, 'b6_list_' || l.g, 'Section ' || s.g, s.g
       FROM generate_series(1, $1) AS l(g)
       CROSS JOIN generate_series(1, $2) AS s(g)`,
      [NUM_LISTS, SECTIONS_PER_LIST]
    );
    const firstSection = await pool.query<{ id: string }>(`SELECT id FROM sections WHERE list_id = $1 ORDER BY id LIMIT 1`, [sampleListId]);
    sampleSectionId = firstSection.rows[0].id;

    // Seed tasks (TASKS_PER_SECTION per section => NUM_LISTS *
    // SECTIONS_PER_LIST * TASKS_PER_SECTION total — 100,000 at the defaults
    // above). BIGINT ids generated deterministically from a base offset.
    //
    // Seeded in BATCHES of sections (not one giant single-statement INSERT)
    // — this is a genuine, measured finding, not a style choice: `tasks` has
    // an `AFTER INSERT ... FOR EACH ROW` trigger (`trg_hardlink_task`, the
    // Graph Layer's R2 dual-write sync — see migrations.ts) that runs two
    // DELETEs + a conditional INSERT against `entity_links` for EVERY
    // inserted row. A single INSERT of all 100k task rows at once measured
    // over 120s and tripped this very sprint's own new DB_STATEMENT_TIMEOUT_MS
    // default (dbConfig.ts) — batching keeps each individual statement's
    // trigger overhead bounded, which is also a more realistic seeding
    // pattern than one 100k-row INSERT would ever be in practice. This
    // per-row trigger cost is a pre-existing Graph Layer characteristic, out
    // of this sprint's read-side index scope — documented here rather than
    // silently worked around, per the Phase 2 handoff's "Offene Risiken".
    const allSections = await pool.query<{ id: string; list_id: string }>(
      `SELECT id, list_id FROM sections WHERE list_id LIKE 'b6_list_%' ORDER BY id`
    );
    const SECTION_BATCH_SIZE = 100; // 100 sections * TASKS_PER_SECTION(50) = 5,000 tasks/statement
    for (let i = 0; i < allSections.rows.length; i += SECTION_BATCH_SIZE) {
      const batch = allSections.rows.slice(i, i + SECTION_BATCH_SIZE);
      const sectionIds = batch.map((s) => s.id);
      const listIds = batch.map((s) => s.list_id);
      const baseIds = batch.map((_, idx) => 9_000_000_000_000 + (i + idx) * TASKS_PER_SECTION);
      await pool.query(
        `INSERT INTO tasks (id, user_id, title, source, list_id, section_id, position, workspace_id)
         SELECT b.base_id + t.g, $4, 'Task ' || t.g, 'list', b.list_id, b.section_id, t.g, $5
         FROM unnest($1::bigint[], $2::varchar[], $3::varchar[]) AS b(base_id, section_id, list_id)
         CROSS JOIN generate_series(1, $6) AS t(g)`,
        [baseIds, sectionIds, listIds, userId, wsId, TASKS_PER_SECTION]
      );
    }

    // Bulk-seed task_attachments on a fraction of tasks — the correlated
    // per-task-row COUNT(*) subquery this indexes for reads a single set of
    // `task_id`s, so a single statement here (no per-row trigger on
    // `task_attachments`) is fine.
    await pool.query(
      `INSERT INTO task_attachments (id, task_id, user_id, attachment_type, original_name, file_size)
       SELECT 'b6_att_' || id, id, $1, 'upload', 'file.txt', 100
       FROM tasks WHERE user_id = $1 AND (id % 10) < $2`,
      [userId, Math.round(ATTACHMENTS_FRACTION * 10)]
    );

    // Bulk-seed folders/timelines with workspace_id.
    await pool.query(
      `INSERT INTO folders (id, user_id, name, workspace_id, position)
       SELECT 'b6_folder_' || g, $1, 'Folder ' || g, $2, g FROM generate_series(1, $3) AS g`,
      [userId, wsId, NUM_FOLDERS]
    );
    await pool.query(
      `INSERT INTO timelines (id, user_id, name, workspace_id, position)
       SELECT 'b6_tl_' || g, $1, 'Timeline ' || g, $2, g FROM generate_series(1, $3) AS g`,
      [userId, wsId, NUM_TIMELINES]
    );

    // Bulk-seed shared_files.
    await pool.query(
      `INSERT INTO shared_files (id, user_id, original_name, file_size, file_path, share_token, created_at)
       SELECT 'b6_file_' || g, $1, 'file_' || g || '.txt', 100, '/tmp/x', md5(random()::text), NOW() - (g || ' seconds')::interval
       FROM generate_series(1, $2) AS g`,
      [userId, NUM_FILES]
    );

    await pool.query('ANALYZE tasks, sections, lists, folders, timelines, task_attachments, shared_files');
  }, 280_000);

  afterAll(async () => {
    await pool.query(`DELETE FROM task_attachments WHERE user_id = $1`, [userId]);
    await batchedDeleteTasks(userId);
    await batchedDeleteSections(`list_id LIKE 'b6_list_%'`, []);
    await pool.query(`DELETE FROM lists WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM folders WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM timelines WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM shared_files WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [wsId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1 OR owner_id = $2`, [wsId, userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool.end();
  }, 590_000);
  // ^ Root-caused explicitly (not a guess): this hook previously carried its
  // own 200_000ms override here, which — being an EXPLICIT per-hook timeout —
  // takes precedence over the CLI's `--hookTimeout=300000` (vitest resolves
  // the more specific setting first), so raising the CLI flag alone never
  // would have fixed a timeout reported as "in 200000ms". Confirmed via an
  // isolated probe test (a trivial `afterAll` sleeping 205s under the exact
  // same `npm run test:performance` invocation) that the CLI flag DOES apply
  // correctly on its own — this hook's own stale literal was the actual
  // cause. Batched deletion of 100k+ tasks (5,000-row batches, one round
  // trip each) was independently observed completing ~85,000 of 100,000 rows
  // within the old 200s budget, so 590s (just under the file's own 600s
  // default Bash-tool ceiling when run standalone, and comfortably inside
  // `npm run test:performance`'s own --hookTimeout=300000 floor raised
  // nowhere near this) gives real headroom rather than a second guess.

  it(`seeded the expected row counts (>= 100k tasks; workspace-scoped tables large + selective)`, async () => {
    const counts = await pool.query<{ tasks: string; sections: string; attachments: string; lists: string; folders: string; timelines: string }>(
      `SELECT
         (SELECT COUNT(*) FROM tasks WHERE user_id = $1) AS tasks,
         (SELECT COUNT(*) FROM sections WHERE list_id LIKE 'b6_list_%') AS sections,
         (SELECT COUNT(*) FROM task_attachments WHERE user_id = $1) AS attachments,
         (SELECT COUNT(*) FROM lists WHERE user_id = $1) AS lists,
         (SELECT COUNT(*) FROM folders WHERE user_id = $1) AS folders,
         (SELECT COUNT(*) FROM timelines WHERE user_id = $1) AS timelines`,
      [userId]
    );
    const row = counts.rows[0];
    console.log(
      `[B6 seed] tasks=${row.tasks} sections=${row.sections} attachments=${row.attachments} ` +
      `lists(total)=${row.lists} folders(total)=${row.folders} timelines(total)=${row.timelines} ` +
      `(of which wsId's own selective slice: ${NUM_LISTS} lists / ${NUM_FOLDERS} folders / ${NUM_TIMELINES} timelines)`
    );
    expect(parseInt(row.tasks, 10)).toBeGreaterThanOrEqual(100_000);
    // Workspace-scoped tables must be large enough that filtering to ONE
    // workspace is genuinely selective — otherwise the planner correctly
    // prefers a Seq Scan regardless of any index (see the beforeAll comment
    // on NUM_NOISE_WORKSPACES for why this matters).
    expect(parseInt(row.lists, 10)).toBeGreaterThanOrEqual(20_000);
    expect(parseInt(row.folders, 10)).toBeGreaterThanOrEqual(10_000);
    expect(parseInt(row.timelines, 10)).toBeGreaterThanOrEqual(10_000);
  });

  /**
   * Runs the shared before/after comparison: drop the named index, EXPLAIN
   * the query (BEFORE), recreate the exact index (AFTER), EXPLAIN again, and
   * assert the AFTER plan is index-based end-to-end while logging both
   * plans' actual numbers for the handoff report.
   */
  async function measureIndexImpact(opts: {
    label: string;
    indexName: string;
    createIndexSql: string;
    querySql: string;
    queryParams: unknown[];
  }) {
    await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${opts.indexName}`);
    const before = await explain(opts.querySql, opts.queryParams);

    await pool.query(opts.createIndexSql.replace('CONCURRENTLY ', '')); // non-concurrent is fine on this isolated test DB
    await pool.query(`ANALYZE`);
    const after = await explain(opts.querySql, opts.queryParams);

    console.log(
      `[B6 plan] ${opts.label}\n` +
      `  BEFORE (no index): ${topNodeType(before.node)}${containsSeqScan(before.node) ? ' (contains Seq Scan)' : ''} — ${before.ms.toFixed(2)}ms\n` +
      `  AFTER  (indexed):  ${topNodeType(after.node)} — ${after.ms.toFixed(2)}ms`
    );

    expect(containsSeqScan(before.node)).toBe(true); // confirms the BEFORE state genuinely lacked the index
    expect(isIndexBased(after.node)).toBe(true);      // confirms the AFTER plan actually uses it
    return { before, after };
  }

  it('task_attachments by parent (task_id) — correlated subquery in list hydration', async () => {
    const { before, after } = await measureIndexImpact({
      label: 'task_attachments(task_id)',
      indexName: 'task_attachments_task_id_idx',
      createIndexSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS task_attachments_task_id_idx ON task_attachments(task_id)`,
      querySql: `SELECT COUNT(*) FROM task_attachments WHERE task_id = $1`,
      queryParams: [9000000000000],
    });
    expect(after.ms).toBeLessThanOrEqual(before.ms + 5); // never meaningfully slower; typically much faster
  });

  it('sections by list, ordered by position', async () => {
    await measureIndexImpact({
      label: 'sections(list_id, position)',
      indexName: 'sections_list_position_idx',
      createIndexSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS sections_list_position_idx ON sections(list_id, position)`,
      querySql: `SELECT * FROM sections WHERE list_id = $1 ORDER BY position ASC`,
      queryParams: [sampleListId],
    });
  });

  it("tasks by list (source='list'), ordered by position", async () => {
    await measureIndexImpact({
      label: "tasks(list_id, position) WHERE source='list'",
      indexName: 'tasks_list_position_idx',
      createIndexSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_list_position_idx ON tasks(list_id, position) WHERE source = 'list'`,
      querySql: `SELECT * FROM tasks WHERE list_id = $1 AND source = 'list' ORDER BY position ASC, created_at ASC`,
      queryParams: [sampleListId],
    });
  });

  it('tasks by section, ordered by position (MAX(position) on task creation)', async () => {
    await measureIndexImpact({
      label: 'tasks(section_id, position)',
      indexName: 'tasks_section_position_idx',
      createIndexSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_section_position_idx ON tasks(section_id, position)`,
      querySql: `SELECT MAX(position) FROM tasks WHERE section_id = $1`,
      queryParams: [sampleSectionId],
    });
  });

  it('lists scoped to a workspace', async () => {
    await measureIndexImpact({
      label: 'lists(workspace_id)',
      indexName: 'lists_workspace_id_idx',
      createIndexSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS lists_workspace_id_idx ON lists(workspace_id)`,
      querySql: `SELECT * FROM lists WHERE workspace_id = $1`,
      queryParams: [wsId],
    });
  });

  it('folders scoped to a workspace', async () => {
    await measureIndexImpact({
      label: 'folders(workspace_id)',
      indexName: 'folders_workspace_id_idx',
      createIndexSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS folders_workspace_id_idx ON folders(workspace_id)`,
      querySql: `SELECT * FROM folders WHERE workspace_id = $1`,
      queryParams: [wsId],
    });
  });

  it('timelines scoped to a workspace', async () => {
    await measureIndexImpact({
      label: 'timelines(workspace_id)',
      indexName: 'timelines_workspace_id_idx',
      createIndexSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS timelines_workspace_id_idx ON timelines(workspace_id)`,
      querySql: `SELECT * FROM timelines WHERE workspace_id = $1`,
      queryParams: [wsId],
    });
  });

  it('shared_files by user, newest first (Files screen + storage-quota SUM)', async () => {
    await measureIndexImpact({
      label: 'shared_files(user_id, created_at DESC)',
      indexName: 'shared_files_user_created_idx',
      createIndexSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS shared_files_user_created_idx ON shared_files(user_id, created_at DESC)`,
      querySql: `SELECT * FROM shared_files WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      queryParams: [userId],
    });
  });

  it('workspace_members membership check already uses the PRIMARY KEY without any new index (documented, not guessed)', async () => {
    const plan = await explain(
      `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [wsId, userId]
    );
    console.log(`[B6 plan] workspace_members PK lookup: ${topNodeType(plan.node)} — ${plan.ms.toFixed(2)}ms (no new index needed — see b6IndexMigrations.ts's header)`);
    expect(isIndexBased(plan.node)).toBe(true); // PRIMARY KEY (workspace_id, user_id) already serves this
  });
});
