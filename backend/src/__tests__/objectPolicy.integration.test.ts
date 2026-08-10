// ---------------------------------------------------------------------------
// S2 (Zentrale Objekt- und Tenant-Policy) — live-Postgres cross-tenant
// regression tests.
//
// Unlike the rest of this suite (mock QueryExec, no live DB — see
// workspaceIntegrity.test.ts's convention), this file proves the actual
// cross-tenant fix against a REAL database, because the routes under test
// (routes/tasks.ts, routes/taskAttachments.ts, routes/milestoneAttachments.ts,
// routes/canvases.ts) call the singleton `pool`/`query` from db.ts directly
// rather than accepting an injectable QueryExec.
//
// Setup this test depends on (see the phase handoff for exact commands):
//   - A local Postgres 16 reachable at localhost:5432.
//   - A role `solytiq_test` / password `solytiq_test_pw` owning a database
//     named `solytiq_test` (CREATE ROLE ... LOGIN PASSWORD ... CREATEDB;
//     CREATE DATABASE solytiq_test OWNER solytiq_test;).
// Override via TEST_PG{HOST,PORT,DATABASE,USER,PASSWORD} env vars if your
// setup differs. If the database isn't reachable, every test in this file is
// SKIPPED (not silently passed — see the visible "skipped" count in the
// vitest summary) with a console warning, so a CI/sandbox without live
// Postgres never reports a false green for this file.
//
// process.env is set, and every module under test is imported via a dynamic
// `await import()` (never a static `import … from`), BEFORE any of them is
// ever loaded — db.ts's `pool` is a module-level singleton constructed once
// from process.env at first import, and static imports are hoisted ahead of
// any top-level assignment, so only a dynamic import reliably sees this
// file's env overrides applied first.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.PGHOST     = process.env.TEST_PGHOST     ?? 'localhost';
process.env.PGPORT     = process.env.TEST_PGPORT     ?? '5432';
process.env.PGDATABASE = process.env.TEST_PGDATABASE ?? 'solytiq_test';
process.env.PGUSER     = process.env.TEST_PGUSER     ?? 'solytiq_test';
process.env.PGPASSWORD = process.env.TEST_PGPASSWORD ?? 'solytiq_test_pw';

let dbAvailable = false;
let pool: typeof import('../db').pool;
let runAllMigrations: typeof import('../migrations').runAllMigrations;
let buildTasksForUser: typeof import('../routes/tasks').buildTasksForUser;
let buildListsForUser: typeof import('../routes/lists').buildListsForUser;
let getListForUser: typeof import('../routes/lists').getListForUser;
let buildTimelinesForUser: typeof import('../routes/timelines').buildTimelinesForUser;
let getTimelineForUser: typeof import('../routes/timelines').getTimelineForUser;
let canAccessTask: typeof import('../routes/taskAttachments').canAccessTask;
let canAccessMilestone: typeof import('../routes/milestoneAttachments').canAccessMilestone;
let isObjectVisible: typeof import('../objectPolicy').isObjectVisible;
let userCanAccessWorkspace: typeof import('../workspaceUtil').userCanAccessWorkspace;

try {
  const dbMod = await import('../db');
  pool = dbMod.pool;
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch (err) {
  console.warn(
    `⚠️  objectPolicy.integration.test.ts: no reachable Postgres at ` +
    `${process.env.PGUSER}@${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE} ` +
    `— every test in this file is SKIPPED, not passed. (${(err as Error)?.message})`
  );
}

if (dbAvailable) {
  ({ runAllMigrations } = await import('../migrations'));
  ({ buildTasksForUser } = await import('../routes/tasks'));
  ({ buildListsForUser, getListForUser } = await import('../routes/lists'));
  ({ buildTimelinesForUser, getTimelineForUser } = await import('../routes/timelines'));
  ({ canAccessTask } = await import('../routes/taskAttachments'));
  ({ canAccessMilestone } = await import('../routes/milestoneAttachments'));
  ({ isObjectVisible } = await import('../objectPolicy'));
  ({ userCanAccessWorkspace } = await import('../workspaceUtil'));
}

describe.skipIf(!dbAvailable)('S2 central object policy — two-tenant cross-workspace regression', () => {
  const userA = 'a0000000-0000-4000-8000-00000000000a';
  const userB = 'a0000000-0000-4000-8000-00000000000b';
  const wsA = 'ws_test_tenant_a';
  const wsB = 'ws_test_tenant_b';
  const listId = 'list_test_public_in_a';
  const taskId = '9990000000001';
  const attachmentId = 'ta_test_attachment_1';
  const timelineId = 'tl_test_public_in_a';
  const milestoneId = 'ms_test_public_in_a';
  const milestoneAttachmentId = 'ma_test_attachment_1';
  const canvasId = 'canvas_test_public_in_a';

  beforeAll(async () => {
    // Use the locked runAllMigrations() (not the raw runMigrations()) even
    // though this is a single-process test: vitest runs test FILES as
    // separate concurrent worker processes by default, and several other
    // integration test files in this suite also migrate the same shared
    // solytiq_test database in their own beforeAll — without going through
    // the same advisory lock, those files race on DDL (confirmed
    // reproducible: concurrent "trigger already exists" failures). Routing
    // every live-DB test file through the one production-equivalent locked
    // entry point serializes them for free.
    await runAllMigrations();

    // Clean slate for a re-run.
    await pool.query(`DELETE FROM milestone_attachments WHERE id = $1`, [milestoneAttachmentId]);
    await pool.query(`DELETE FROM task_attachments WHERE id = $1`, [attachmentId]);
    await pool.query(`DELETE FROM milestones WHERE id = $1`, [milestoneId]);
    await pool.query(`DELETE FROM graph_canvases WHERE id = $1`, [canvasId]);
    await pool.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
    await pool.query(`DELETE FROM timelines WHERE id = $1`, [timelineId]);
    await pool.query(`DELETE FROM lists WHERE id = $1`, [listId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id IN ($1, $2)`, [wsA, wsB]);
    await pool.query(`DELETE FROM workspaces WHERE id IN ($1, $2)`, [wsA, wsB]);
    await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [userA, userB]);

    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, full_name, is_admin)
       VALUES ($1, 'tenant_a_owner', 'tenant-a@test.local', 'x', 'Tenant A', false),
              ($2, 'tenant_b_owner', 'tenant-b@test.local', 'x', 'Tenant B', false)`,
      [userA, userB]
    );

    // Two PRIVATE workspaces, each owned by a different user — the two-tenant matrix.
    await pool.query(
      `INSERT INTO workspaces (id, name, visibility, owner_id) VALUES ($1, 'Tenant A Workspace', 'private', $2)`,
      [wsA, userA]
    );
    await pool.query(
      `INSERT INTO workspaces (id, name, visibility, owner_id) VALUES ($1, 'Tenant B Workspace', 'private', $2)`,
      [wsB, userB]
    );
    await pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [wsA, userA]
    );
    await pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [wsB, userB]
    );

    // An IN-APP-PUBLIC list inside tenant A's PRIVATE workspace — this is the
    // exact shape the pre-fix bug leaked: `is_public = true` with no
    // workspace-membership check.
    await pool.query(
      `INSERT INTO lists (id, user_id, name, is_public, workspace_id) VALUES ($1, $2, 'Public-in-A List', true, $3)`,
      [listId, userA, wsA]
    );
    await pool.query(
      `INSERT INTO tasks (id, user_id, title, source, list_id, workspace_id)
       VALUES ($1, $2, 'Tenant A secret task', 'list', $3, $4)`,
      [taskId, userA, listId, wsA]
    );
    await pool.query(
      `INSERT INTO task_attachments (id, task_id, user_id, attachment_type, original_name, file_path)
       VALUES ($1, $2, $3, 'upload', 'secret.txt', 'secret.txt')`,
      [attachmentId, taskId, userA]
    );

    await pool.query(
      `INSERT INTO timelines (id, user_id, name, is_public, workspace_id) VALUES ($1, $2, 'Public-in-A Timeline', true, $3)`,
      [timelineId, userA, wsA]
    );
    await pool.query(
      `INSERT INTO milestones (id, timeline_id, title) VALUES ($1, $2, 'Tenant A secret milestone')`,
      [milestoneId, timelineId]
    );
    await pool.query(
      `INSERT INTO milestone_attachments (id, milestone_id, user_id, attachment_type, original_name, file_path)
       VALUES ($1, $2, $3, 'upload', 'secret.txt', 'secret.txt')`,
      [milestoneAttachmentId, milestoneId, userA]
    );

    await pool.query(
      `INSERT INTO graph_canvases (id, workspace_id, user_id, name, is_public) VALUES ($1, $2, $3, 'Public-in-A Canvas', true)`,
      [canvasId, wsA, userA]
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM milestone_attachments WHERE id = $1`, [milestoneAttachmentId]);
    await pool.query(`DELETE FROM task_attachments WHERE id = $1`, [attachmentId]);
    await pool.query(`DELETE FROM milestones WHERE id = $1`, [milestoneId]);
    await pool.query(`DELETE FROM graph_canvases WHERE id = $1`, [canvasId]);
    await pool.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
    await pool.query(`DELETE FROM timelines WHERE id = $1`, [timelineId]);
    await pool.query(`DELETE FROM lists WHERE id = $1`, [listId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id IN ($1, $2)`, [wsA, wsB]);
    await pool.query(`DELETE FROM workspaces WHERE id IN ($1, $2)`, [wsA, wsB]);
    await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [userA, userB]);
    await pool.end();
  });

  // --- Negative matrix: userB is a member of NEITHER wsA nor invited to
  // anything in it. Every one of these assertions FAILED (returned the
  // tenant-A data / true) before the S2 fix and must now all deny. ---

  it('buildTasksForUser: userB never sees tenant A\'s public-list task', async () => {
    const tasks = await buildTasksForUser(userB);
    expect(tasks.find(t => String(t.id) === taskId)).toBeUndefined();
  });

  it('buildListsForUser: userB never sees tenant A\'s public list', async () => {
    const lists = await buildListsForUser(userB);
    expect(lists.find(l => l.id === listId)).toBeUndefined();
  });

  it('getListForUser: userB gets null (existence-safe 404), not the list', async () => {
    expect(await getListForUser(userB, listId)).toBeNull();
  });

  it('buildTimelinesForUser / getTimelineForUser: userB never sees tenant A\'s public timeline', async () => {
    const timelines = await buildTimelinesForUser(userB);
    expect(timelines.find(t => t.id === timelineId)).toBeUndefined();
    expect(await getTimelineForUser(userB, timelineId)).toBeNull();
  });

  it('canAccessTask: userB cannot reach tenant A\'s task attachment', async () => {
    expect(await canAccessTask(taskId, userB)).toBe(false);
  });

  it('canAccessMilestone: userB cannot reach tenant A\'s milestone attachment', async () => {
    expect(await canAccessMilestone(milestoneId, userB)).toBe(false);
  });

  it('canvas policy (isObjectVisible): userB cannot see tenant A\'s public canvas', async () => {
    const canAccessWs = await userCanAccessWorkspace(userB, wsA);
    expect(canAccessWs).toBe(false);
    const row = { user_id: userA, is_public: true, workspace_id: wsA };
    expect(isObjectVisible(row, userB, canAccessWs, false)).toBe(false);
  });

  // --- Positive control: once userB is a genuine member of wsA, every one of
  // the SAME checks must flip to visible — proves the fix discriminates on
  // real membership rather than always denying. ---

  describe('once userB is added as a member of wsA', () => {
    beforeAll(async () => {
      await pool.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')
         ON CONFLICT DO NOTHING`,
        [wsA, userB]
      );
    });

    it('buildTasksForUser: userB now sees the task', async () => {
      const tasks = await buildTasksForUser(userB);
      expect(tasks.find(t => String(t.id) === taskId)).toBeDefined();
    });

    it('getListForUser: userB now sees the list', async () => {
      expect(await getListForUser(userB, listId)).not.toBeNull();
    });

    it('canAccessTask / canAccessMilestone: userB now passes', async () => {
      expect(await canAccessTask(taskId, userB)).toBe(true);
      expect(await canAccessMilestone(milestoneId, userB)).toBe(true);
    });

    it('canvas policy: userB now sees the canvas', async () => {
      const canAccessWs = await userCanAccessWorkspace(userB, wsA);
      expect(canAccessWs).toBe(true);
      const row = { user_id: userA, is_public: true, workspace_id: wsA };
      expect(isObjectVisible(row, userB, canAccessWs, false)).toBe(true);
    });
  });

  // --- Owner always sees their own content, in either workspace. ---
  it('userA (owner) always sees their own tenant-A content', async () => {
    const tasks = await buildTasksForUser(userA);
    expect(tasks.find(t => String(t.id) === taskId)).toBeDefined();
    expect(await canAccessTask(taskId, userA)).toBe(true);
    expect(await canAccessMilestone(milestoneId, userA)).toBe(true);
  });

  // --- Private (non-public) content in A is still invisible to a member of B
  // even after the fix — the fix must not have over-widened access. ---
  it('a PRIVATE (is_public=false) list in A stays invisible to userB even as a non-member of A', async () => {
    const privateListId = 'list_test_private_in_a';
    await pool.query(
      `INSERT INTO lists (id, user_id, name, is_public, workspace_id) VALUES ($1, $2, 'Private-in-A List', false, $3)
       ON CONFLICT (id) DO NOTHING`,
      [privateListId, userA, wsA]
    );
    try {
      expect(await getListForUser(userB, privateListId)).toBeNull();
    } finally {
      await pool.query(`DELETE FROM lists WHERE id = $1`, [privateListId]);
    }
  });
});
