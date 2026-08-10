// ---------------------------------------------------------------------------
// B2 (Phase 2) — pending -> ready object lifecycle for shared_files.
//
// Before this, a file upload wrote bytes to disk (via multer, BEFORE the
// route handler even ran) and only THEN reserved quota + inserted the DB
// row — a crash between those two steps left an orphaned file on disk with
// no DB record at all, and (the inverse risk this migration's columns
// exist to close) a crash between "quota reserved" and "bytes actually
// persisted" left no record that the byte range was ever supposed to
// exist, meaning a concurrent uploader's quota check couldn't see it as
// reserved.
//
// `object_status` (`pending` -> `ready`) makes both directions safe: the
// DB row (and its quota reservation) is created FIRST as `pending`, inside
// the SAME advisory-locked transaction the quota check already uses (see
// storageQuota.ts) — a concurrent uploader's own quota check sees this
// row's bytes as already spoken for even before the object write starts.
// Only once the object write actually succeeds does a plain UPDATE flip it
// to `ready`. `pending_expires_at` bounds how long a row is allowed to sit
// unfinished before `storage/orphanJanitor.ts`'s sweep reclaims it (deletes
// the row, releasing its quota reservation, and deletes any partial object
// that did get written) — see that module for the full sweep.
//
// Existing rows get `object_status = 'ready'` (the DEFAULT) — no backfill
// needed, since every row that already exists necessarily already has its
// bytes on disk (this migration didn't exist when they were created).
// ---------------------------------------------------------------------------

import { pool } from './db';
import type { VersionedMigration } from './versionedMigrations';

export const B2_STORAGE_MIGRATIONS: VersionedMigration[] = [
  {
    id: '2026_08_09_shared_files_object_lifecycle',
    description: 'add object_status (pending/ready) + pending_expires_at to shared_files for atomic upload + orphan cleanup',
    up: async () => {
      await pool.query(`ALTER TABLE shared_files ADD COLUMN IF NOT EXISTS object_status VARCHAR(20) NOT NULL DEFAULT 'ready'`);
      await pool.query(`ALTER TABLE shared_files ADD COLUMN IF NOT EXISTS pending_expires_at TIMESTAMPTZ`);
      // Supports the janitor's own claim-and-sweep query (pending rows past
      // their expiry) without scanning every ready row.
      await pool.query(`CREATE INDEX IF NOT EXISTS shared_files_pending_idx ON shared_files (pending_expires_at) WHERE object_status = 'pending'`);
    },
  },
];
