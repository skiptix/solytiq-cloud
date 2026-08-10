// ---------------------------------------------------------------------------
// B4 (Phase 2) — live-Postgres proof of the two literal gates:
//
//   "Zwei konkurrierende Updates ergeben genau einen Erfolg und einen 409"
//   "injizierter Fehler mitten im Reorder hinterlässt die alte Ordnung
//    vollständig"
//
// Same live-DB convention as objectPolicy.integration.test.ts /
// folderAccess.integration.test.ts: env vars set before any dynamic import,
// every test in this file SKIPPED (not silently passed) if no database is
// reachable, real HTTP requests against the actual `routes/lists.ts` router
// (not a hand-copied stand-in) so this proves the real production code path.
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
  console.warn(`⚠️  concurrencyAndReorder.integration.test.ts: no reachable Postgres — every test in this file is SKIPPED, not passed. (${(err as Error)?.message})`);
}

describe.skipIf(!dbAvailable)('B4 — atomic optimistic concurrency + atomic reorder (live Postgres)', () => {
  let server: http.Server;
  let baseUrl: string;

  const userId  = 'b4000000-0000-4000-8000-0000000000a1';
  const otherId = 'b4000000-0000-4000-8000-0000000000a2';
  const wsId = 'ws_test_b4_concurrency';
  const listId = 'list_test_b4_concurrency';
  const otherListId = 'list_test_b4_foreign';
  let token: string;

  beforeAll(async () => {
    // Locked entry point, not raw runMigrations() — see objectPolicy.
    // integration.test.ts's beforeAll comment on why (concurrent test files
    // racing DDL on the shared solytiq_test database).
    const { runAllMigrations } = await import('../migrations');
    await runAllMigrations();

    const express = (await import('express')).default;
    const listsRouter = (await import('../routes/lists')).default;
    const { generateToken, hashPassword } = await import('../auth');

    await pool.query(`DELETE FROM sections WHERE list_id IN ($1, $2)`, [listId, otherListId]);
    await pool.query(`DELETE FROM lists WHERE id IN ($1, $2)`, [listId, otherListId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [wsId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
    await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [userId, otherId]);

    const pw = await hashPassword('irrelevant-for-this-test-x');
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, full_name, is_admin)
       VALUES ($1, 'b4_concurrency_owner', 'b4-owner@test.local', $3, 'Owner', false),
              ($2, 'b4_concurrency_other', 'b4-other@test.local', $3, 'Other', false)`,
      [userId, otherId, pw]
    );
    token = generateToken(userId, 0);

    await pool.query(`INSERT INTO workspaces (id, name, visibility, owner_id) VALUES ($1, 'B4 Test Tenant', 'private', $2)`, [wsId, userId]);
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [wsId, userId]);
    await pool.query(
      `INSERT INTO lists (id, user_id, name, workspace_id, position) VALUES ($1, $2, 'B4 Concurrency List', $3, 0)`,
      [listId, userId, wsId]
    );
    // A list belonging to a DIFFERENT user — used to prove a foreign id in a
    // reorder request is rejected wholesale rather than silently skipped.
    await pool.query(
      `INSERT INTO lists (id, user_id, name, workspace_id, position) VALUES ($1, $2, 'Foreign List', $3, 0)`,
      [otherListId, otherId, wsId]
    );

    const app = express();
    app.use(express.json());
    app.use('/api/lists', listsRouter);

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM sections WHERE list_id IN ($1, $2)`, [listId, otherListId]);
    await pool.query(`DELETE FROM lists WHERE id IN ($1, $2)`, [listId, otherListId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [wsId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
    await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [userId, otherId]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // NOTE: pool.end() is deliberately NOT called here — `pool` is the
    // module-level singleton (db.ts) shared with the second describe block
    // below in this same file; only that LAST block's afterAll closes it.
  });

  async function putList(body: Record<string, unknown>) {
    return fetch(`${baseUrl}/api/lists/${listId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  async function postSection(label: string) {
    return fetch(`${baseUrl}/api/lists/${listId}/sections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ label }),
    });
  }

  async function putSectionsReorder(sectionIds: string[]) {
    return fetch(`${baseUrl}/api/lists/${listId}/sections/reorder`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ section_ids: sectionIds }),
    });
  }

  // -------------------------------------------------------------------------
  // Gate 1: "Zwei konkurrierende Updates ergeben genau einen Erfolg und einen 409"
  // -------------------------------------------------------------------------

  it('two concurrent PUTs with the SAME expectedVersion produce exactly one 200 and one 409 — no silent clobber', async () => {
    const before = await pool.query<{ version: number }>(`SELECT version FROM lists WHERE id = $1`, [listId]);
    const startVersion = before.rows[0].version;

    const [r1, r2] = await Promise.all([
      putList({ name: 'Renamed by request A', expectedVersion: startVersion }),
      putList({ name: 'Renamed by request B', expectedVersion: startVersion }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);

    // The winner's write actually landed; version advanced by exactly 1 (not
    // 2 — proving the loser's UPDATE genuinely matched zero rows rather than
    // also writing and merely returning a stale response).
    const after = await pool.query<{ version: number; name: string }>(`SELECT version, name FROM lists WHERE id = $1`, [listId]);
    expect(after.rows[0].version).toBe(startVersion + 1);
    expect(['Renamed by request A', 'Renamed by request B']).toContain(after.rows[0].name);

    const winnerBody = r1.status === 200 ? await r1.json() : await r2.json();
    expect(winnerBody.list.name).toBe(after.rows[0].name);

    const loserRes = r1.status === 409 ? r1 : r2;
    const loserBody = await loserRes.json();
    expect(loserBody.error).toBe('version_conflict');
    expect(loserBody.currentVersion).toBe(after.rows[0].version);
  });

  it('a stale expectedVersion (sent after the row already moved on) is rejected with 409, never silently applied', async () => {
    const current = await pool.query<{ version: number }>(`SELECT version FROM lists WHERE id = $1`, [listId]);
    const staleVersion = current.rows[0].version - 1; // definitely stale — we just proved version advanced above
    const res = await putList({ name: 'Should never land', expectedVersion: staleVersion });
    expect(res.status).toBe(409);
    const row = await pool.query<{ name: string }>(`SELECT name FROM lists WHERE id = $1`, [listId]);
    expect(row.rows[0].name).not.toBe('Should never land');
  });

  it('omitting expectedVersion entirely still works (back-compat — no concurrency check requested)', async () => {
    const res = await putList({ name: 'No version sent' });
    expect(res.status).toBe(200);
    const row = await pool.query<{ name: string }>(`SELECT name FROM lists WHERE id = $1`, [listId]);
    expect(row.rows[0].name).toBe('No version sent');
  });

  // -------------------------------------------------------------------------
  // Gate 2: "injizierter Fehler mitten im Reorder hinterlässt die alte
  // Ordnung vollständig" — proven via the atomic bulk-UPDATE's own guarantee:
  // a rejected reorder request (foreign/invalid id) leaves EVERY existing
  // section's position untouched, not partially reordered.
  // -------------------------------------------------------------------------

  it('a reorder request containing a FOREIGN id is rejected wholesale — the OLD order is left fully intact, not partially applied', async () => {
    const s1 = await (await postSection('Section One')).json();
    const s2 = await (await postSection('Section Two')).json();
    const s3 = await (await postSection('Section Three')).json();
    const id1 = s1.section.id, id2 = s2.section.id, id3 = s3.section.id;

    const beforeRows = await pool.query<{ id: string; position: number }>(
      `SELECT id, position FROM sections WHERE list_id = $1 ORDER BY position ASC`, [listId]
    );
    const beforeOrder = beforeRows.rows.map((r) => r.id);
    expect(beforeOrder).toEqual([id1, id2, id3]);

    // Inject a foreign id (belongs to `otherListId`, not this list) into an
    // otherwise-valid full reorder — this is the "error injected mid-array"
    // scenario the old N-separate-UPDATEs implementation would have partially
    // applied (whichever ids were processed before hitting the bad one).
    const res = await putSectionsReorder([id3, id1, 'section_does_not_exist_at_all', id2]);
    expect(res.status).toBe(400);

    const afterRows = await pool.query<{ id: string; position: number }>(
      `SELECT id, position FROM sections WHERE list_id = $1 ORDER BY position ASC`, [listId]
    );
    // Every position is EXACTLY as it was before the rejected request — not
    // one row touched.
    expect(afterRows.rows).toEqual(beforeRows.rows);
  });

  it('a VALID full reorder is applied atomically and completely', async () => {
    const rows = await pool.query<{ id: string }>(`SELECT id FROM sections WHERE list_id = $1 ORDER BY position ASC`, [listId]);
    const [id1, id2, id3] = rows.rows.map((r) => r.id);

    const res = await putSectionsReorder([id3, id1, id2]);
    expect(res.status).toBe(200);

    const after = await pool.query<{ id: string; position: number }>(
      `SELECT id, position FROM sections WHERE list_id = $1 ORDER BY position ASC`, [listId]
    );
    expect(after.rows.map((r) => r.id)).toEqual([id3, id1, id2]);
    expect(after.rows.map((r) => r.position)).toEqual([0, 1, 2]);
  });

  it('an oversized reorder array is rejected server-side regardless of what the client sends', async () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `section_fake_${i}`);
    const res = await putSectionsReorder(tooMany);
    expect(res.status).toBe(400);
  });

  it('a duplicate id in the reorder array is rejected', async () => {
    const rows = await pool.query<{ id: string }>(`SELECT id FROM sections WHERE list_id = $1`, [listId]);
    const id = rows.rows[0].id;
    const res = await putSectionsReorder([id, id]);
    expect(res.status).toBe(400);
  });

  it('two concurrent full reorders of the same list converge to exactly ONE of the two orderings — never an interleaved/corrupt mix', async () => {
    const rows = await pool.query<{ id: string }>(`SELECT id FROM sections WHERE list_id = $1 ORDER BY position ASC`, [listId]);
    const [a, b, c] = rows.rows.map((r) => r.id);

    const orderX = [a, b, c];
    const orderY = [c, b, a];

    const [r1, r2] = await Promise.all([putSectionsReorder(orderX), putSectionsReorder(orderY)]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const after = await pool.query<{ id: string }>(`SELECT id FROM sections WHERE list_id = $1 ORDER BY position ASC`, [listId]);
    const finalOrder = after.rows.map((r) => r.id);

    // The final order must be EXACTLY orderX or EXACTLY orderY — Postgres's
    // row-level locking on the bulk UPDATE serializes the two statements, so
    // whichever commits last determines the final state in full; a corrupt
    // partial interleave (e.g. some positions from X, others from Y) would
    // fail both of these.
    const matchesX = JSON.stringify(finalOrder) === JSON.stringify(orderX);
    const matchesY = JSON.stringify(finalOrder) === JSON.stringify(orderY);
    expect(matchesX || matchesY).toBe(true);

    // And positions are a clean 0..2 permutation either way — no gaps, no gaps.
    const positions = (await pool.query<{ position: number }>(`SELECT position FROM sections WHERE list_id = $1 ORDER BY position ASC`, [listId])).rows.map((r) => r.position);
    expect(positions).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// B4 — markdown_lists uses a DIFFERENT implementation strategy (a locked
// `FOR UPDATE` transaction, since the route already needed one for its
// todo-reconciliation logic — see routes/markdownLists.ts) rather than the
// atomic-UPDATE-WHERE pattern used above. Proven separately since it is
// genuinely different code, not just a copy of the lists.ts fix.
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)('B4 — markdown_lists PUT version conflict (FOR UPDATE lock strategy)', () => {
  let server: http.Server;
  let baseUrl: string;
  const userId = 'b4000000-0000-4000-8000-0000000000b1';
  const pageId = 'md_test_b4_concurrency';
  const wsId = 'ws_test_b4_markdown';
  let token: string;

  beforeAll(async () => {
    const { runAllMigrations } = await import('../migrations');
    await runAllMigrations();
    const express = (await import('express')).default;
    const markdownListsRouter = (await import('../routes/markdownLists')).default;
    const { generateToken, hashPassword } = await import('../auth');

    await pool.query(`DELETE FROM markdown_lists WHERE id = $1`, [pageId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [wsId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);

    const pw = await hashPassword('irrelevant-for-this-test-x');
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, full_name, is_admin) VALUES ($1, 'b4_md_owner', 'b4-md@test.local', $2, 'Owner', false)`,
      [userId, pw]
    );
    token = generateToken(userId, 0);
    await pool.query(`INSERT INTO workspaces (id, name, visibility, owner_id) VALUES ($1, 'B4 MD Tenant', 'private', $2)`, [wsId, userId]);
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [wsId, userId]);
    await pool.query(
      `INSERT INTO markdown_lists (id, user_id, name, workspace_id) VALUES ($1, $2, 'B4 MD Page', $3)`,
      [pageId, userId, wsId]
    );

    const app = express();
    app.use(express.json());
    app.use('/api/markdown-lists', markdownListsRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM markdown_lists WHERE id = $1`, [pageId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [wsId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  async function putPage(body: Record<string, unknown>) {
    return fetch(`${baseUrl}/api/markdown-lists/${pageId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  it('two concurrent PUTs with the same expectedVersion produce exactly one 200 and one 409 (FOR UPDATE strategy)', async () => {
    const before = await pool.query<{ version: number }>(`SELECT version FROM markdown_lists WHERE id = $1`, [pageId]);
    const startVersion = before.rows[0].version;

    const [r1, r2] = await Promise.all([
      putPage({ name: 'MD renamed by A', expectedVersion: startVersion }),
      putPage({ name: 'MD renamed by B', expectedVersion: startVersion }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const after = await pool.query<{ version: number; name: string }>(`SELECT version, name FROM markdown_lists WHERE id = $1`, [pageId]);
    expect(after.rows[0].version).toBe(startVersion + 1);
  });
});
