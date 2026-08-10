// ---------------------------------------------------------------------------
// B3 (Phase 2) — lease columns for the shared claim primitive (jobLease.ts).
//
// Plain `ADD COLUMN IF NOT EXISTS` — safe inside the versioned-migration
// transaction wrapper (unlike the CONCURRENTLY index builds in
// b6IndexMigrations.ts, adding a nullable column is a fast, non-blocking
// metadata-only change in Postgres 11+, no table rewrite).
// ---------------------------------------------------------------------------

import { pool } from './db';
import type { VersionedMigration } from './versionedMigrations';

export const B3_LEASE_MIGRATIONS: VersionedMigration[] = [
  {
    id: '2026_08_09_lease_automations',
    description: 'add lease_owner/lease_expires_at to automations — atomic claim for the schedule-trigger sweep (closes a real double-fire race)',
    up: async () => {
      await pool.query(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS lease_owner VARCHAR(150)`);
      await pool.query(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ`);
      // Supports the claim's own WHERE (trigger_type='schedule' AND enabled
      // AND next_fire_at<=NOW()) filtered further by lease freshness.
      await pool.query(`CREATE INDEX IF NOT EXISTS automations_schedule_due_idx ON automations (next_fire_at) WHERE trigger_type = 'schedule' AND enabled = true`);
    },
  },
  {
    id: '2026_08_09_lease_embedding_queue',
    description: 'add lease_owner/lease_expires_at/max_attempts/next_attempt_at to embedding_queue — reclaimable crash recovery + backoff retry + dead-letter',
    up: async () => {
      await pool.query(`ALTER TABLE embedding_queue ADD COLUMN IF NOT EXISTS lease_owner VARCHAR(150)`);
      await pool.query(`ALTER TABLE embedding_queue ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ`);
      await pool.query(`ALTER TABLE embedding_queue ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 5`);
      await pool.query(`ALTER TABLE embedding_queue ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ`);
    },
  },
];
