// ---------------------------------------------------------------------------
// S6 — storage-quota race condition, live-Postgres.
//
// Proves two things a mock QueryExec unit test can't:
//   1. getUserStorageUsed() correctly aggregates bytes across every
//      contributing table (shared_files, task_attachments 'upload' rows,
//      milestone_attachments 'upload' rows, gps_files) and correctly
//      EXCLUDES 'linked' attachments (they reference an existing shared_files
//      row rather than consuming new disk space of their own).
//   2. withQuotaReservation() genuinely serializes concurrent reservations
//      for the SAME user — firing many simultaneous reservations that would
//      jointly blow the quota (but each individually fits) must never let
//      more of them succeed than the quota actually allows. This is the
//      literal race CLAUDE.md's Security Notes item 7 describes and the
//      pre-fix files.ts code (SELECT SUM ... then, on a SEPARATE connection,
//      INSERT) was vulnerable to.
//
// Same live-DB convention as objectPolicy.integration.test.ts — env vars set
// before any dynamic import, every test SKIPS (not passes) with no reachable
// database. See that file's header for the exact setup this depends on.
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
let getUserStorageUsed: typeof import('../storageQuota').getUserStorageUsed;
let withQuotaReservation: typeof import('../storageQuota').withQuotaReservation;

try {
  const dbMod = await import('../db');
  pool = dbMod.pool;
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch (err) {
  console.warn(
    `⚠️  storageQuota.integration.test.ts: no reachable Postgres at ` +
    `${process.env.PGUSER}@${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE} ` +
    `— every test in this file is SKIPPED, not passed. (${(err as Error)?.message})`
  );
}

if (dbAvailable) {
  ({ runAllMigrations } = await import('../migrations'));
  ({ getUserStorageUsed, withQuotaReservation } = await import('../storageQuota'));
}

describe.skipIf(!dbAvailable)('S6 storage quota — live DB', () => {
  const userA = 'b0000000-0000-4000-8000-00000000000a';
  const userB = 'b0000000-0000-4000-8000-00000000000b';
  const taskId = '9991000000001';
  const timelineId = 'tl_test_quota_1';
  const milestoneId = 'ms_test_quota_1';

  beforeAll(async () => {
    // Locked entry point, not raw runMigrations() — see objectPolicy.
    // integration.test.ts's beforeAll comment for why (concurrent test
    // files racing DDL on the shared solytiq_test database).
    await runAllMigrations();

    // Clean slate for a re-run — children before parents.
    await pool.query(`DELETE FROM gps_files WHERE user_id IN ($1, $2)`, [userA, userB]);
    await pool.query(`DELETE FROM task_attachments WHERE task_id = $1`, [taskId]);
    await pool.query(`DELETE FROM milestone_attachments WHERE milestone_id = $1`, [milestoneId]);
    await pool.query(`DELETE FROM shared_files WHERE user_id IN ($1, $2)`, [userA, userB]);
    await pool.query(`DELETE FROM milestones WHERE id = $1`, [milestoneId]);
    await pool.query(`DELETE FROM timelines WHERE id = $1`, [timelineId]);
    await pool.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
    await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [userA, userB]);

    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, is_admin)
       VALUES ($1, 'quota_test_a', 'quota_test_a@example.com', 'x', false),
              ($2, 'quota_test_b', 'quota_test_b@example.com', 'x', false)`,
      [userA, userB]
    );
    await pool.query(
      `INSERT INTO tasks (id, user_id, title, source) VALUES ($1, $2, 'quota test task', 'dash')`,
      [taskId, userA]
    );
    await pool.query(`INSERT INTO timelines (id, user_id, name) VALUES ($1, $2, 'quota test timeline')`, [timelineId, userA]);
    await pool.query(`INSERT INTO milestones (id, timeline_id, title) VALUES ($1, $2, 'quota test milestone')`, [milestoneId, timelineId]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM gps_files WHERE user_id IN ($1, $2)`, [userA, userB]);
    await pool.query(`DELETE FROM task_attachments WHERE task_id = $1`, [taskId]);
    await pool.query(`DELETE FROM milestone_attachments WHERE milestone_id = $1`, [milestoneId]);
    await pool.query(`DELETE FROM shared_files WHERE user_id IN ($1, $2)`, [userA, userB]);
    await pool.query(`DELETE FROM milestones WHERE id = $1`, [milestoneId]);
    await pool.query(`DELETE FROM timelines WHERE id = $1`, [timelineId]);
    await pool.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
    await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [userA, userB]);
    await pool.end();
  });

  describe('getUserStorageUsed — cross-table aggregation', () => {
    it('sums shared_files + upload-type task/milestone attachments + gps_files, and EXCLUDES linked attachments', async () => {
      // A fresh user with nothing yet.
      expect(await getUserStorageUsed(userB)).toBe(0);

      await pool.query(
        `INSERT INTO shared_files (id, user_id, original_name, file_size, file_path, share_token)
         VALUES ('sf_quota_test_1', $1, 'a.bin', 1000, 'a.bin', 'tok_quota_test_1')`,
        [userB]
      );
      // A 'linked' shared_files reference on the same underlying file must
      // NOT double-count — it references sf_quota_test_1's bytes, not new
      // disk space of its own.
      await pool.query(
        `INSERT INTO task_attachments (id, task_id, user_id, attachment_type, file_size, shared_file_id)
         VALUES ('ta_quota_linked', $1, $2, 'linked', 1000, 'sf_quota_test_1')`,
        [taskId, userB]
      );
      expect(await getUserStorageUsed(userB)).toBe(1000);

      await pool.query(
        `INSERT INTO task_attachments (id, task_id, user_id, attachment_type, file_size, file_path)
         VALUES ('ta_quota_upload', $1, $2, 'upload', 2000, 'ta_quota_upload.bin')`,
        [taskId, userB]
      );
      expect(await getUserStorageUsed(userB)).toBe(3000);

      await pool.query(
        `INSERT INTO milestone_attachments (id, milestone_id, user_id, attachment_type, file_size, file_path)
         VALUES ('ma_quota_upload', $1, $2, 'upload', 4000, 'ma_quota_upload.bin')`,
        [milestoneId, userB]
      );
      expect(await getUserStorageUsed(userB)).toBe(7000);

      await pool.query(
        `INSERT INTO gps_files (id, user_id, original_name, file_type, file_path, file_size)
         VALUES ('gps_quota_test_1', $1, 'track.gpx', 'gpx', 'track.gpx', 8000)`,
        [userB]
      );
      expect(await getUserStorageUsed(userB)).toBe(15000);

      // Another user's data must never bleed into this total.
      expect(await getUserStorageUsed(userA)).toBe(0);
    });
  });

  describe('withQuotaReservation — race-condition fix', () => {
    it('a single reservation under quota succeeds and is reflected in the next read', async () => {
      const before = await getUserStorageUsed(userA);
      const reservation = await withQuotaReservation(userA, 500, false, (client) =>
        client.query(
          `INSERT INTO gps_files (id, user_id, original_name, file_type, file_path, file_size)
           VALUES ('gps_quota_single', $1, 'single.gpx', 'gpx', 'single.gpx', 500)`,
          [userA]
        )
      );
      expect(reservation.ok).toBe(true);
      expect(await getUserStorageUsed(userA)).toBe(before + 500);
    });

    it('a reservation that would exceed quota is rejected and performs NO write', async () => {
      // app_settings.storage_quota_per_user isn't set in this fresh test DB,
      // so getUserQuota() returns the 15GB default — use a byte count that
      // exceeds it outright rather than trying to fill 15GB in a test.
      const HUGE = 20 * 1024 * 1024 * 1024; // 20GB > the 15GB default
      const before = await getUserStorageUsed(userA);
      const reservation = await withQuotaReservation(userA, HUGE, false, (client) =>
        client.query(
          `INSERT INTO gps_files (id, user_id, original_name, file_type, file_path, file_size)
           VALUES ('gps_quota_should_not_exist', $1, 'huge.gpx', 'gpx', 'huge.gpx', $2)`,
          [userA, HUGE]
        )
      );
      expect(reservation.ok).toBe(false);
      if (!reservation.ok) {
        expect(reservation.used).toBe(before);
        expect(reservation.quota).toBeGreaterThan(0);
      }
      // The rejected reservation's INSERT must have been rolled back — not
      // just "not counted", genuinely never committed.
      const check = await pool.query(`SELECT id FROM gps_files WHERE id = 'gps_quota_should_not_exist'`);
      expect(check.rows.length).toBe(0);
      expect(await getUserStorageUsed(userA)).toBe(before);
    });

    it('an admin reservation always succeeds regardless of quota', async () => {
      const HUGE = 20 * 1024 * 1024 * 1024;
      const reservation = await withQuotaReservation(userA, HUGE, true, (client) =>
        client.query(
          `INSERT INTO gps_files (id, user_id, original_name, file_type, file_path, file_size)
           VALUES ('gps_quota_admin', $1, 'admin.gpx', 'gpx', 'admin.gpx', $2)`,
          [userA, HUGE]
        )
      );
      expect(reservation.ok).toBe(true);
      const check = await pool.query(`SELECT id FROM gps_files WHERE id = 'gps_quota_admin'`);
      expect(check.rows.length).toBe(1);
      await pool.query(`DELETE FROM gps_files WHERE id = 'gps_quota_admin'`);
    });

    it(
      'THE CORE FIX: many concurrent reservations for the SAME user, each individually under quota but jointly over it, never let the total accepted bytes exceed the quota',
      async () => {
        // Give this user a tiny, deterministic quota via app_settings so the
        // race window is easy to hit reliably without waiting on huge byte
        // counts, then restore the previous value afterward.
        const QUOTA = 10_000; // 10,000 bytes
        const prevSetting = await pool.query<{ value: string }>(
          `SELECT value FROM app_settings WHERE key = 'storage_quota_per_user'`
        );
        await pool.query(
          `INSERT INTO app_settings (key, value) VALUES ('storage_quota_per_user', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [String(QUOTA)]
        );

        try {
          const raceUser = 'b0000000-0000-4000-8000-0000000000ab';
          await pool.query(`DELETE FROM gps_files WHERE user_id = $1`, [raceUser]);
          await pool.query(`DELETE FROM users WHERE id = $1`, [raceUser]);
          await pool.query(
            `INSERT INTO users (id, username, email, password_hash, is_admin)
             VALUES ($1, 'quota_race_user', 'quota_race@example.com', 'x', false)`,
            [raceUser]
          );

          // Each individual upload is 3,000 bytes — comfortably under the
          // 10,000-byte quota on its own. 8 of them fired SIMULTANEOUSLY
          // would jointly total 24,000 bytes — well over quota — if the
          // check-then-act race isn't actually closed. At most 3 (9,000
          // bytes) can legitimately fit; a 4th (12,000) must not.
          const CONCURRENT = 8;
          const CHUNK = 3000;
          const results = await Promise.all(
            Array.from({ length: CONCURRENT }, (_, i) =>
              withQuotaReservation(raceUser, CHUNK, false, (client) =>
                client.query(
                  `INSERT INTO gps_files (id, user_id, original_name, file_type, file_path, file_size)
                   VALUES ($1, $2, 'race.gpx', 'gpx', 'race.gpx', $3)`,
                  [`gps_quota_race_${i}`, raceUser, CHUNK]
                )
              )
            )
          );

          const accepted = results.filter((r) => r.ok).length;
          const rejected = results.filter((r) => !r.ok).length;
          expect(accepted + rejected).toBe(CONCURRENT);
          // The whole point: accepted bytes must never exceed the quota,
          // no matter how many requests raced simultaneously.
          expect(accepted * CHUNK).toBeLessThanOrEqual(QUOTA);
          // And the DB's own SUM must agree exactly with what was accepted
          // — not more (over quota) and not less (a false rejection that
          // still wrote data, or a lost write).
          const finalUsed = await getUserStorageUsed(raceUser);
          expect(finalUsed).toBe(accepted * CHUNK);

          await pool.query(`DELETE FROM gps_files WHERE user_id = $1`, [raceUser]);
          await pool.query(`DELETE FROM users WHERE id = $1`, [raceUser]);
        } finally {
          if (prevSetting.rows[0]) {
            await pool.query(
              `UPDATE app_settings SET value = $1 WHERE key = 'storage_quota_per_user'`,
              [prevSetting.rows[0].value]
            );
          } else {
            await pool.query(`DELETE FROM app_settings WHERE key = 'storage_quota_per_user'`);
          }
        }
      },
      15000
    );
  });
});
