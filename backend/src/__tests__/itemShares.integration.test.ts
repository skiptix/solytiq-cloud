// ---------------------------------------------------------------------------
// "Shared with members" — live-Postgres, live-HTTP end-to-end test of the
// per-item invitation cascade.
//
// This file exists for the things a mock QueryExec cannot prove. The unit
// tests (itemShares.test.ts) assert which SQL is ISSUED; only a real database
// can assert what that SQL RETRIEVES, and every claim this feature makes is a
// retrieval claim:
//
//   * One grant on a FOLDER reaches the boards, timelines and pages inside it
//     — including the deeply nested ones (a sublist of a sublist, a markdown
//     page's auto-managed Todo mirror) that the recursive walk exists for.
//   * It reaches an item added to the folder AFTER the invite, and stops
//     reaching one moved out of it — the whole reason the cascade is resolved
//     at read time instead of materialized as per-item rows.
//   * The blast radius is exactly the folder: a sibling folder in the SAME
//     workspace stays invisible. A cascade that over-reaches by one join is
//     still "working" to a mock.
//   * An invitee who is a member of NO workspace can actually edit the shared
//     board over HTTP — the point of the feature, and the one thing that
//     depends on reads and writes agreeing about the same tree.
//
// Same live-DB convention as objectPolicy.integration.test.ts — env vars set
// before any dynamic import, SKIPPED (not passed) if no database is reachable.
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
  console.warn(`⚠️  itemShares.integration.test.ts: no reachable Postgres — every test in this file is SKIPPED, not passed. (${(err as Error)?.message})`);
}

describe.skipIf(!dbAvailable)('Per-item invitations — the folder cascade', () => {
  let server: http.Server;
  let baseUrl: string;
  let guestToken: string;

  const ownerId   = 'b0000000-0000-4000-8000-0000000000b1';
  const guestId   = 'b0000000-0000-4000-8000-0000000000b2';
  const strangerId = 'b0000000-0000-4000-8000-0000000000b3';
  const wsId       = 'ws_test_item_shares';
  const sharedFolder = 'folder_shared_is';
  const otherFolder  = 'folder_other_is';

  const boardIn   = 'list_in_folder_is';       // directly inside the shared folder
  const boardOut  = 'list_other_folder_is';    // inside a SIBLING folder, same workspace
  const boardLate = 'list_added_later_is';     // dropped into the folder after the invite
  const sublist   = 'list_sub_is';             // sublist of boardIn
  const subSublist = 'list_subsub_is';         // sublist of the sublist
  const todoMirror = 'list_todo_mirror_is';    // the markdown page's Todo mirror
  const page       = 'md_in_folder_is';
  const timeline   = 'tl_in_folder_is';

  let isItemSharedWith: typeof import('../itemShares').isItemSharedWith;
  let getSharedItemIdsForUser: typeof import('../itemShares').getSharedItemIdsForUser;
  let getListForUser: typeof import('../routes/lists').getListForUser;
  let getFolderForUser: typeof import('../routes/folders').getFolderForUser;

  beforeAll(async () => {
    // Locked entry point, not raw runMigrations() — concurrent test files
    // otherwise race DDL on the shared solytiq_test database.
    const { runAllMigrations } = await import('../migrations');
    await runAllMigrations();

    const express = (await import('express')).default;
    const listsRouter = (await import('../routes/lists')).default;
    const { generateToken, hashPassword } = await import('../auth');
    ({ isItemSharedWith, getSharedItemIdsForUser } = await import('../itemShares'));
    ({ getListForUser } = await import('../routes/lists'));
    ({ getFolderForUser } = await import('../routes/folders'));

    const allLists = [boardIn, boardOut, boardLate, sublist, subSublist, todoMirror];
    await pool.query(`DELETE FROM markdown_lists WHERE id = $1`, [page]);
    await pool.query(`DELETE FROM timelines WHERE id = $1`, [timeline]);
    await pool.query(`DELETE FROM lists WHERE id = ANY($1::varchar[])`, [allLists]);
    await pool.query(`DELETE FROM folders WHERE id = ANY($1::varchar[])`, [[sharedFolder, otherFolder]]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [wsId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ownerId, guestId, strangerId]]);

    const pw = await hashPassword('irrelevant-for-this-test-x');
    for (const [id, name] of [[ownerId, 'is_owner'], [guestId, 'is_guest'], [strangerId, 'is_stranger']] as const) {
      await pool.query(
        `INSERT INTO users (id, username, email, password_hash, is_admin) VALUES ($1, $2, $3, $4, false)`,
        [id, name, `${name}@test.local`, pw]
      );
    }
    guestToken = generateToken(guestId, 0);

    // The guest is deliberately NOT a member of this workspace — an invitation
    // has to stand entirely on its own, or it isn't a sharing feature.
    await pool.query(`INSERT INTO workspaces (id, name, visibility, owner_id) VALUES ($1, 'Shares WS', 'private', $2)`, [wsId, ownerId]);
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [wsId, ownerId]);

    await pool.query(`INSERT INTO folders (id, user_id, name, workspace_id) VALUES ($1, $2, 'Shared folder', $3), ($4, $2, 'Sibling folder', $3)`,
      [sharedFolder, ownerId, wsId, otherFolder]);
    await pool.query(`INSERT INTO lists (id, user_id, name, folder_id, workspace_id) VALUES ($1, $2, 'In folder', $3, $4)`, [boardIn, ownerId, sharedFolder, wsId]);
    await pool.query(`INSERT INTO lists (id, user_id, name, folder_id, workspace_id) VALUES ($1, $2, 'Sibling folder board', $3, $4)`, [boardOut, ownerId, otherFolder, wsId]);
    await pool.query(`INSERT INTO lists (id, user_id, name, workspace_id) VALUES ($1, $2, 'Todo mirror', $3)`, [todoMirror, ownerId, wsId]);
    await pool.query(`INSERT INTO sections (id, list_id, label, position) VALUES ('sec_is_1', $1, 'Todo', 0)`, [boardIn]);
    await pool.query(`INSERT INTO tasks (id, user_id, title, source, list_id, section_id, workspace_id) VALUES (900001, $1, 'parent task', 'list', $2, 'sec_is_1', $3)`, [ownerId, boardIn, wsId]);
    await pool.query(`INSERT INTO lists (id, user_id, name, workspace_id, parent_task_id, depth) VALUES ($1, $2, 'Sublist', $3, 900001, 1)`, [sublist, ownerId, wsId]);
    await pool.query(`INSERT INTO tasks (id, user_id, title, source, list_id, workspace_id) VALUES (900002, $1, 'nested task', 'list', $2, $3)`, [ownerId, sublist, wsId]);
    await pool.query(`INSERT INTO lists (id, user_id, name, workspace_id, parent_task_id, depth) VALUES ($1, $2, 'Sub-sublist', $3, 900002, 2)`, [subSublist, ownerId, wsId]);
    await pool.query(
      `INSERT INTO markdown_lists (id, user_id, name, folder_id, workspace_id, todo_list_id, content)
       VALUES ($1, $2, 'Page', $3, $4, $5, '{"version":1,"blocks":[]}')`,
      [page, ownerId, sharedFolder, wsId, todoMirror]
    );
    await pool.query(`INSERT INTO timelines (id, user_id, name, folder_id, workspace_id) VALUES ($1, $2, 'TL', $3, $4)`, [timeline, ownerId, sharedFolder, wsId]);

    // ONE grant. Everything below is resolved from it.
    await pool.query(
      `INSERT INTO item_shares (item_type, item_id, user_id, invited_by) VALUES ('folder', $1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [sharedFolder, guestId, ownerId]
    );

    const app = express();
    app.use(express.json());
    app.use('/api/lists', listsRouter);
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!dbAvailable) return;
    await pool.query(`DELETE FROM markdown_lists WHERE id = $1`, [page]);
    await pool.query(`DELETE FROM timelines WHERE id = $1`, [timeline]);
    await pool.query(`DELETE FROM lists WHERE id = ANY($1::varchar[])`, [[boardIn, boardOut, boardLate, sublist, subSublist, todoMirror]]);
    await pool.query(`DELETE FROM folders WHERE id = ANY($1::varchar[])`, [[sharedFolder, otherFolder]]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [wsId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ownerId, guestId, strangerId]]);
    await pool.end();
  });

  it('reaches a board sitting directly in the shared folder', async () => {
    expect(await isItemSharedWith('list', boardIn, guestId)).toBe(true);
    expect(await getListForUser(guestId, boardIn)).not.toBeNull();
  });

  it('reaches the timeline and markdown page in that folder', async () => {
    expect(await isItemSharedWith('timeline', timeline, guestId)).toBe(true);
    expect(await isItemSharedWith('markdownList', page, guestId)).toBe(true);
  });

  it('reaches a sublist, and a sublist OF that sublist', async () => {
    // The recursive ancestor walk's whole reason to exist: a shared board whose
    // sublists 404 is not a shared board.
    expect(await isItemSharedWith('list', sublist, guestId)).toBe(true);
    expect(await isItemSharedWith('list', subSublist, guestId)).toBe(true);
  });

  it("reaches a markdown page's auto-managed Todo mirror, which sits in no folder at all", async () => {
    expect(await isItemSharedWith('list', todoMirror, guestId)).toBe(true);
  });

  it('stops at the folder boundary — a sibling folder in the SAME workspace stays private', async () => {
    expect(await isItemSharedWith('list', boardOut, guestId)).toBe(false);
    expect(await getListForUser(guestId, boardOut)).toBeNull();
    expect(await getFolderForUser(guestId, otherFolder)).toBeNull();
  });

  it('grants nothing at all to a user who was never invited', async () => {
    for (const id of [boardIn, sublist, subSublist, todoMirror]) {
      expect(await isItemSharedWith('list', id, strangerId)).toBe(false);
    }
    expect(await isItemSharedWith('timeline', timeline, strangerId)).toBe(false);
    expect(await getFolderForUser(strangerId, sharedFolder)).toBeNull();
  });

  it('picks up an item added to the folder AFTER the invite, with no re-share', async () => {
    await pool.query(`INSERT INTO lists (id, user_id, name, folder_id, workspace_id) VALUES ($1, $2, 'Added later', $3, $4)`,
      [boardLate, ownerId, sharedFolder, wsId]);
    expect(await isItemSharedWith('list', boardLate, guestId)).toBe(true);
  });

  it('drops an item moved OUT of the folder, with no revocation step', async () => {
    await pool.query(`UPDATE lists SET folder_id = $1 WHERE id = $2`, [otherFolder, boardLate]);
    expect(await isItemSharedWith('list', boardLate, guestId)).toBe(false);
    await pool.query(`UPDATE lists SET folder_id = $1 WHERE id = $2`, [sharedFolder, boardLate]);
  });

  it('lets the invitee actually EDIT the shared board over HTTP, owning no workspace membership', async () => {
    // Reads and writes must agree about the same tree; this is the assertion
    // that catches them drifting apart.
    const res = await fetch(`${baseUrl}/api/lists/${boardIn}/sections/sec_is_1/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${guestToken}` },
      body: JSON.stringify({ title: 'added by the invited collaborator' }),
    });
    expect(res.status).toBe(201);

    const persisted = await pool.query<{ title: string }>(
      `SELECT title FROM tasks WHERE list_id = $1 AND user_id = $2`, [boardIn, guestId]
    );
    expect(persisted.rows.map((r) => r.title)).toContain('added by the invited collaborator');
  });

  it('is visible to the graph layer wherever it is writable — the two must not disagree', async () => {
    // canWriteEntity resolves the full cascade; if visibleCondition resolved
    // less, a sublist of a board in a shared folder would be editable but 404
    // from /api/graph and /api/links, and absent from entity/knowledge search.
    const { isEntityVisible, canWriteEntity } = await import('../graph/visibility');
    for (const [type, id] of [['list', boardIn], ['list', subSublist], ['timeline', timeline], ['markdownList', page]] as const) {
      expect(await isEntityVisible(pool.query.bind(pool), guestId, type, id)).toBe(true);
      expect(await canWriteEntity(guestId, false, type, id)).toBe(true);
    }
    // …and the boundary holds on both sides too.
    expect(await isEntityVisible(pool.query.bind(pool), guestId, 'list', boardOut)).toBe(false);
    expect(await canWriteEntity(guestId, false, 'list', boardOut)).toBe(false);
  });

  it('lets a folder-invited collaborator be @mentioned on a board inside it', async () => {
    // resolveMentionUserIds is a second resolver over the same grant; matching
    // only the exact invited row would resolve to nobody and silently notify
    // no one.
    const { resolveMentionUserIds } = await import('../mentions');
    const ids = await resolveMentionUserIds(
      wsId, new Set(['is_guest']), ownerId, { itemType: 'list', itemId: boardIn }
    );
    expect(ids).toContain(guestId);

    const strangers = await resolveMentionUserIds(
      wsId, new Set(['is_stranger']), ownerId, { itemType: 'list', itemId: boardIn }
    );
    expect(strangers).not.toContain(strangerId);
  });

  it("names the folder as the source of an inherited member on a board's roster", async () => {
    const { listItemShares } = await import('../itemShares');
    const onBoard = await listItemShares('list', boardIn);
    const guest = onBoard.find((m) => m.userId === guestId);
    expect(guest?.via).toBe('inherited');
    expect(guest?.viaName).toBe('Shared folder');

    // A sublist's roster must not read as empty while several people can edit
    // it — that is worse than showing nothing, because it looks authoritative.
    const onSublist = await listItemShares('list', subSublist);
    expect(onSublist.find((m) => m.userId === guestId)?.via).toBe('inherited');

    // On the folder itself the same person is a DIRECT member — removable there.
    const onFolder = await listItemShares('folder', sharedFolder);
    expect(onFolder.find((m) => m.userId === guestId)?.via).toBe('direct');
  });

  it('shares the folder ALONE when the invite is scoped that way, and restores on switch back', async () => {
    // The invite dialog's "Folder only" choice. The folder itself stays
    // reachable — it is a real grant — but nothing inside it does, including
    // the sublists and Todo mirror the cascade would otherwise reach.
    const { addItemShare, getSharedItemIdsForUser: sharedIds } = await import('../itemShares');
    await addItemShare('folder', sharedFolder, guestId, ownerId, false);

    expect(await getFolderForUser(guestId, sharedFolder)).not.toBeNull();
    for (const id of [boardIn, sublist, subSublist, todoMirror]) {
      expect(await isItemSharedWith('list', id, guestId)).toBe(false);
    }
    expect(await isItemSharedWith('timeline', timeline, guestId)).toBe(false);
    expect(await isItemSharedWith('markdownList', page, guestId)).toBe(false);

    // "Shared with me" still lists the folder, contributing no contents.
    const narrow = await sharedIds(guestId);
    expect(narrow.folders).toContain(sharedFolder);
    expect(narrow.lists).not.toContain(boardIn);
    expect(narrow.timelines).not.toContain(timeline);

    // Re-inviting with the wider scope updates the existing row rather than
    // erroring, so the choice is never a one-way door.
    await addItemShare('folder', sharedFolder, guestId, ownerId, true);
    expect(await isItemSharedWith('list', boardIn, guestId)).toBe(true);
    expect(await isItemSharedWith('list', subSublist, guestId)).toBe(true);
    expect(await isItemSharedWith('timeline', timeline, guestId)).toBe(true);
  });

  it('surfaces the folder AND its contents in "Shared with me", but not nested items', async () => {
    const ids = await getSharedItemIdsForUser(guestId);
    expect(ids.folders).toContain(sharedFolder);
    expect(ids.lists).toEqual(expect.arrayContaining([boardIn, boardLate]));
    expect(ids.timelines).toContain(timeline);
    expect(ids.markdownLists).toContain(page);
    // Reachable, but they render UNDER something already listed — a sublist as
    // a top-level sidebar row would be wrong.
    expect(ids.lists).not.toContain(sublist);
    expect(ids.lists).not.toContain(todoMirror);
    expect(ids.lists).not.toContain(boardOut);
  });
});
