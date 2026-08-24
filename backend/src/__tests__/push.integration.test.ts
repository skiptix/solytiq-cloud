// ---------------------------------------------------------------------------
// Push notifications + collaborator audience — live-Postgres test.
//
// This file exists for the claims a mock QueryExec structurally cannot check.
// push.test.ts asserts which SQL is ISSUED; only a real database can assert
// what it RETRIEVES, and the two load-bearing claims of this feature are both
// retrieval claims:
//
//   * "everyone marked on or added to this board / page / timeline is
//     notified" — resolveItemAudience() has to actually pull the owner, the
//     directly-invited, the FOLDER-inherited invitee, and the tagged user, and
//     has to stop at people who merely share the workspace. An audience that
//     over-reaches by one join still looks correct to a mock.
//   * a subscription is keyed on the ENDPOINT, so a second user signing in on
//     one device TAKES THE ROW OVER rather than leaving the first user's stale
//     row behind still receiving their notifications on someone else's phone.
//
// Plus one schema-level invariant worth a real database: push preference
// defaults exist on a freshly-inserted user, since every gate reads them.
//
// Same live-DB convention as itemShares.integration.test.ts — env vars set
// before any dynamic import, SKIPPED (not passed) if no database is reachable.
// ---------------------------------------------------------------------------

import { beforeAll, describe, expect, it } from 'vitest';

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
  console.warn(`⚠️  push.integration.test.ts: no reachable Postgres — every test in this file is SKIPPED, not passed. (${(err as Error)?.message})`);
}

describe.skipIf(!dbAvailable)('Push notifications (live DB)', () => {
  const ownerId    = 'c0000000-0000-4000-8000-0000000000c1';
  const invitedId  = 'c0000000-0000-4000-8000-0000000000c2';
  const taggedId   = 'c0000000-0000-4000-8000-0000000000c3';
  const folderKid  = 'c0000000-0000-4000-8000-0000000000c4';
  const bystanderId = 'c0000000-0000-4000-8000-0000000000c5';
  const wsId       = 'ws_test_push';
  const folderId   = 'folder_push';
  const boardId    = 'list_push_board';
  const inFolder   = 'list_push_in_folder';
  const timelineId = 'tl_push';

  let resolveItemAudience: typeof import('../collaborators').resolveItemAudience;
  let upsertSubscription: typeof import('../push/subscriptions').upsertSubscription;
  let listSubscriptionsForUser: typeof import('../push/subscriptions').listSubscriptionsForUser;
  let userWantsPush: typeof import('../push/send').userWantsPush;

  beforeAll(async () => {
    // Locked entry point, not raw runMigrations() — concurrent test files
    // otherwise race DDL on the shared solytiq_test database.
    const { runAllMigrations } = await import('../migrations');
    await runAllMigrations();

    ({ resolveItemAudience } = await import('../collaborators'));
    ({ upsertSubscription, listSubscriptionsForUser } = await import('../push/subscriptions'));
    ({ userWantsPush } = await import('../push/send'));

    const { hashPassword } = await import('../auth');
    const allUsers = [ownerId, invitedId, taggedId, folderKid, bystanderId];

    await pool.query(`DELETE FROM timelines WHERE id = $1`, [timelineId]);
    await pool.query(`DELETE FROM lists WHERE id = ANY($1::varchar[])`, [[boardId, inFolder]]);
    await pool.query(`DELETE FROM folders WHERE id = $1`, [folderId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [wsId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [allUsers]);

    const pw = await hashPassword('irrelevant-for-this-test-x');
    for (const [id, name] of [
      [ownerId, 'push_owner'], [invitedId, 'push_invited'], [taggedId, 'push_tagged'],
      [folderKid, 'push_folder_kid'], [bystanderId, 'push_bystander'],
    ] as const) {
      await pool.query(
        `INSERT INTO users (id, username, email, password_hash, is_admin) VALUES ($1, $2, $3, $4, false)`,
        [id, name, `${name}@test.local`, pw]
      );
    }

    await pool.query(`INSERT INTO workspaces (id, name, visibility, owner_id) VALUES ($1, 'Push WS', 'private', $2)`, [wsId, ownerId]);
    // The bystander is a full WORKSPACE member and must still NOT be notified:
    // membership grants visibility, being invited or tagged expresses
    // involvement — that distinction is the whole audience design.
    await pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
      [wsId, ownerId, bystanderId]
    );

    await pool.query(`INSERT INTO folders (id, user_id, name, workspace_id) VALUES ($1, $2, 'Push folder', $3)`, [folderId, ownerId, wsId]);
    await pool.query(`INSERT INTO lists (id, user_id, name, workspace_id) VALUES ($1, $2, 'Push board', $3)`, [boardId, ownerId, wsId]);
    await pool.query(`INSERT INTO lists (id, user_id, name, folder_id, workspace_id) VALUES ($1, $2, 'In folder', $3, $4)`, [inFolder, ownerId, folderId, wsId]);
    await pool.query(`INSERT INTO timelines (id, user_id, name, workspace_id) VALUES ($1, $2, 'Push timeline', $3)`, [timelineId, ownerId, wsId]);

    await pool.query(`INSERT INTO sections (id, list_id, label, position) VALUES ('sec_push_1', $1, 'Todo', 0)`, [boardId]);
    await pool.query(
      `INSERT INTO tasks (id, user_id, title, source, list_id, section_id, workspace_id) VALUES (910001, $1, 'a task', 'list', $2, 'sec_push_1', $3)`,
      [ownerId, boardId, wsId]
    );
    await pool.query(`INSERT INTO task_tags (task_id, user_id, tagged_by) VALUES (910001, $1, $2)`, [taggedId, ownerId]);

    await pool.query(
      `INSERT INTO item_shares (item_type, item_id, user_id, invited_by, include_all) VALUES ('list', $1, $2, $3, true)`,
      [boardId, invitedId, ownerId]
    );
    await pool.query(
      `INSERT INTO item_shares (item_type, item_id, user_id, invited_by, include_all) VALUES ('folder', $1, $2, $3, true)`,
      [folderId, folderKid, ownerId]
    );
  });

  describe('resolveItemAudience — who actually hears about a change', () => {
    it('includes the owner, a direct invitee and a tagged user on a board', async () => {
      const audience = await resolveItemAudience('list', boardId);
      expect(audience.userIds).toContain(ownerId);
      expect(audience.userIds).toContain(invitedId);
      expect(audience.userIds).toContain(taggedId);
      expect(audience.name).toBe('Push board');
      expect(audience.workspaceId).toBe(wsId);
    });

    it('EXCLUDES a plain workspace member who was never invited or tagged', async () => {
      const audience = await resolveItemAudience('list', boardId);
      expect(audience.userIds).not.toContain(bystanderId);
    });

    it('includes someone who reaches the board only through a shared FOLDER', async () => {
      const audience = await resolveItemAudience('list', inFolder);
      expect(audience.userIds).toContain(folderKid);
      expect(audience.userIds).toContain(ownerId);
      // The board-level invitee was invited to a DIFFERENT board — the cascade
      // must not leak them into this one.
      expect(audience.userIds).not.toContain(invitedId);
    });

    it('de-dupes someone who is both owner and reachable another way', async () => {
      const audience = await resolveItemAudience('list', boardId);
      expect(new Set(audience.userIds).size).toBe(audience.userIds.length);
    });

    it('resolves a timeline audience without any tag surface to draw from', async () => {
      const audience = await resolveItemAudience('timeline', timelineId);
      expect(audience.userIds).toEqual([ownerId]);
    });

    it('returns an empty audience for an item that no longer exists, rather than throwing', async () => {
      const audience = await resolveItemAudience('list', 'list_does_not_exist');
      expect(audience.userIds).toEqual([]);
    });
  });

  describe('subscription storage', () => {
    const endpoint = 'https://web.push.apple.com/integration-test-endpoint';

    it('keeps ONE row per device across repeat subscribes', async () => {
      await upsertSubscription(ownerId, { endpoint, keys: { p256dh: 'k1', auth: 'a1' } }, { deviceName: 'iPhone', osVersion: 'iOS 17.4', installId: 'hs_1' });
      await upsertSubscription(ownerId, { endpoint, keys: { p256dh: 'k2', auth: 'a2' } }, { deviceName: 'iPhone', osVersion: 'iOS 18.0', installId: 'hs_1' });

      const subs = await listSubscriptionsForUser(ownerId);
      const mine = subs.filter((s) => s.endpoint === endpoint);
      expect(mine).toHaveLength(1);
      // The refreshed keys win — a rotated subscription must not keep
      // delivering with the material it replaced.
      expect(mine[0].p256dh).toBe('k2');
      expect(mine[0].osVersion).toBe('iOS 18.0');
    });

    it('hands the row to the SECOND user who signs in on that same device', async () => {
      await upsertSubscription(invitedId, { endpoint, keys: { p256dh: 'k3', auth: 'a3' } }, { deviceName: 'iPhone', osVersion: 'iOS 18.0', installId: 'hs_1' });

      // The first user must no longer be delivered to on a phone that is now
      // signed in as someone else.
      const ownerSubs = await listSubscriptionsForUser(ownerId);
      expect(ownerSubs.some((s) => s.endpoint === endpoint)).toBe(false);

      const invitedSubs = await listSubscriptionsForUser(invitedId);
      expect(invitedSubs.some((s) => s.endpoint === endpoint)).toBe(true);
    });
  });

  describe('userWantsPush', () => {
    it('defaults to on for a fresh user with no stored preferences', async () => {
      expect(await userWantsPush(ownerId, 'mention')).toBe(true);
      expect(await userWantsPush(ownerId, 'item_added')).toBe(true);
    });

    it('honours a per-type override', async () => {
      await pool.query(`UPDATE users SET push_notification_prefs = '{"item_added": false}'::jsonb WHERE id = $1`, [ownerId]);
      expect(await userWantsPush(ownerId, 'item_added')).toBe(false);
      // An untouched type still falls back to its default — the map is sparse.
      expect(await userWantsPush(ownerId, 'mention')).toBe(true);
    });

    it('lets the master switch override every per-type preference at once', async () => {
      await pool.query(`UPDATE users SET push_enabled = false WHERE id = $1`, [ownerId]);
      expect(await userWantsPush(ownerId, 'mention')).toBe(false);
      await pool.query(`UPDATE users SET push_enabled = true, push_notification_prefs = '{}'::jsonb WHERE id = $1`, [ownerId]);
    });

    it('reports no for a user that does not exist rather than defaulting to yes', async () => {
      expect(await userWantsPush('c0000000-0000-4000-8000-00000000dead', 'mention')).toBe(false);
    });
  });
});
