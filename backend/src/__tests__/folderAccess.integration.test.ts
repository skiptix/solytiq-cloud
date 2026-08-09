// ---------------------------------------------------------------------------
// S2 follow-up (found by independent post-handoff review, not the original
// S2 sprint) — live-Postgres, live-HTTP regression test for
// `PUT /api/folders/:id`'s write-access check.
//
// Before the fix, `canAccess = isOwner || isAdmin || folder.is_public ===
// true` let ANY signed-in instance user — not just a member of the folder's
// workspace — rename/recolor/reposition/collapse any `is_public=true`
// folder anywhere on the instance, including one inside another user's
// PRIVATE workspace. `is_public` is a READ-visibility grant to workspace
// members only (see objectPolicy.ts / CLAUDE.md's "Two distinct notions of
// public"), never a write grant — and every sibling write endpoint in this
// codebase (canvases.ts's PUT/DELETE, lists.ts's various PUT routes) already
// gates writes on ownership/admin alone. This file proves the fix: a
// non-member, a non-owner member, and a non-member-non-owner are all denied;
// the owner and an admin still succeed.
//
// Same live-DB convention as objectPolicy.integration.test.ts — env vars set
// before any dynamic import, SKIPPED (not passed) if no database is
// reachable. See that file's header for the exact setup this depends on.
// ---------------------------------------------------------------------------

import http from 'http';
import type { AddressInfo } from 'net';
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
  console.warn(`⚠️  folderAccess.integration.test.ts: no reachable Postgres — every test in this file is SKIPPED, not passed. (${(err as Error)?.message})`);
}

describe.skipIf(!dbAvailable)('S2 folder write-access — cross-tenant regression', () => {
  let server: http.Server;
  let baseUrl: string;

  const userA = 'a0000000-0000-4000-8000-0000000000fa'; // owner of the folder
  const userB = 'a0000000-0000-4000-8000-0000000000fb'; // outsider, then member
  const admin  = 'a0000000-0000-4000-8000-0000000000fc';
  const wsA = 'ws_test_folder_tenant_a';
  const folderId = 'folder_test_public_in_a';

  let tokenA: string;
  let tokenB: string;
  let tokenAdmin: string;

  beforeAll(async () => {
    // Locked entry point, not raw runMigrations() — see objectPolicy.
    // integration.test.ts's beforeAll comment for why (concurrent test
    // files racing DDL on the shared solytiq_test database). Found by an
    // independent review that this exact file reintroduced the raw call.
    const { runAllMigrations } = await import('../migrations');
    await runAllMigrations();

    const express = (await import('express')).default;
    const foldersRouter = (await import('../routes/folders')).default;
    const { generateToken, hashPassword } = await import('../auth');

    await pool.query(`DELETE FROM folders WHERE id = $1`, [folderId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [wsA]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [wsA]);
    await pool.query(`DELETE FROM users WHERE id IN ($1, $2, $3)`, [userA, userB, admin]);

    const pw = await hashPassword('irrelevant-for-this-test-x');
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, full_name, is_admin)
       VALUES ($1, 'folder_test_owner', 'folder-owner@test.local', $4, 'Owner', false),
              ($2, 'folder_test_outsider', 'folder-outsider@test.local', $4, 'Outsider', false),
              ($3, 'folder_test_admin', 'folder-admin@test.local', $4, 'Admin', true)`,
      [userA, userB, admin, pw]
    );
    tokenA = generateToken(userA, 0);
    tokenB = generateToken(userB, 0);
    tokenAdmin = generateToken(admin, 0);

    await pool.query(
      `INSERT INTO workspaces (id, name, visibility, owner_id) VALUES ($1, 'Folder Test Tenant A', 'private', $2)`,
      [wsA, userA]
    );
    await pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [wsA, userA]
    );

    // An IN-APP-PUBLIC folder inside tenant A's PRIVATE workspace — the exact
    // shape the pre-fix bug let any instance user write to.
    await pool.query(
      `INSERT INTO folders (id, user_id, name, is_public, workspace_id) VALUES ($1, $2, 'Public-in-A Folder', true, $3)`,
      [folderId, userA, wsA]
    );

    const app = express();
    app.use(express.json());
    app.use('/api/folders', foldersRouter);

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM folders WHERE id = $1`, [folderId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [wsA]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [wsA]);
    await pool.query(`DELETE FROM users WHERE id IN ($1, $2, $3)`, [userA, userB, admin]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  async function putFolder(token: string, body: Record<string, unknown>) {
    return fetch(`${baseUrl}/api/folders/${folderId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  it('a non-member outsider CANNOT rename a public folder in someone else\'s private workspace (404, existence-safe)', async () => {
    const res = await putFolder(tokenB, { name: 'Pwned by outsider' });
    expect(res.status).toBe(404);
  });

  it('the write was actually rejected, not silently accepted', async () => {
    const row = await pool.query<{ name: string }>(`SELECT name FROM folders WHERE id = $1`, [folderId]);
    expect(row.rows[0].name).toBe('Public-in-A Folder');
  });

  it('EVEN as a genuine workspace member (not owner), the outsider still CANNOT write — is_public/membership is a read grant only', async () => {
    await pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [wsA, userB]
    );
    try {
      const res = await putFolder(tokenB, { name: 'Pwned by member' });
      expect(res.status).toBe(404);
      const row = await pool.query<{ name: string }>(`SELECT name FROM folders WHERE id = $1`, [folderId]);
      expect(row.rows[0].name).toBe('Public-in-A Folder');
    } finally {
      await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [wsA, userB]);
    }
  });

  it('the owner CAN rename their own folder', async () => {
    const res = await putFolder(tokenA, { name: 'Renamed by owner' });
    expect(res.status).toBe(200);
    const row = await pool.query<{ name: string }>(`SELECT name FROM folders WHERE id = $1`, [folderId]);
    expect(row.rows[0].name).toBe('Renamed by owner');
  });

  it('an instance admin CAN rename any folder', async () => {
    const res = await putFolder(tokenAdmin, { name: 'Renamed by admin' });
    expect(res.status).toBe(200);
    const row = await pool.query<{ name: string }>(`SELECT name FROM folders WHERE id = $1`, [folderId]);
    expect(row.rows[0].name).toBe('Renamed by admin');
  });
});
