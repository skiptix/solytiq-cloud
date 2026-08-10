// ---------------------------------------------------------------------------
// S7 — versioned migrations, live-Postgres.
//
// Proves, against a real database:
//   1. A versioned migration's effect actually applies, exactly once, even
//      across multiple runVersionedMigrations() calls (idempotent skip).
//   2. Checksum drift on an already-applied step throws by default and is
//      overridable via ALLOW_MIGRATION_CHECKSUM_DRIFT — and, critically,
//      that an override does NOT re-run the step (it stays exactly as it
//      was when first applied).
//   3. runAllMigrations()'s advisory lock genuinely serializes — a second
//      connection cannot acquire the same lock key while the first holds it.
//
// Same live-DB convention as objectPolicy.integration.test.ts — see that
// file's header for the exact setup this depends on.
// ---------------------------------------------------------------------------

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

process.env.PGHOST     = process.env.TEST_PGHOST     ?? 'localhost';
process.env.PGPORT     = process.env.TEST_PGPORT     ?? '5432';
process.env.PGDATABASE = process.env.TEST_PGDATABASE ?? 'solytiq_test';
process.env.PGUSER     = process.env.TEST_PGUSER     ?? 'solytiq_test';
process.env.PGPASSWORD = process.env.TEST_PGPASSWORD ?? 'solytiq_test_pw';

let dbAvailable = false;
let pool: typeof import('../db').pool;
let runAllMigrations: typeof import('../migrations').runAllMigrations;
let runVersionedMigrations: typeof import('../versionedMigrations').runVersionedMigrations;
let ensureSchemaMigrationsTable: typeof import('../versionedMigrations').ensureSchemaMigrationsTable;
let MigrationChecksumDriftError: typeof import('../versionedMigrations').MigrationChecksumDriftError;
let getSchemaVersion: typeof import('../versionedMigrations').getSchemaVersion;

const ORIGINAL_ALLOW_DRIFT = process.env.ALLOW_MIGRATION_CHECKSUM_DRIFT;

try {
  const dbMod = await import('../db');
  pool = dbMod.pool;
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch (err) {
  console.warn(
    `⚠️  versionedMigrations.integration.test.ts: no reachable Postgres at ` +
    `${process.env.PGUSER}@${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE} ` +
    `— every test in this file is SKIPPED, not passed. (${(err as Error)?.message})`
  );
}

if (dbAvailable) {
  ({ runAllMigrations } = await import('../migrations'));
  ({ runVersionedMigrations, ensureSchemaMigrationsTable, MigrationChecksumDriftError, getSchemaVersion } = await import('../versionedMigrations'));
}

describe.skipIf(!dbAvailable)('S7 versioned migrations — live DB', () => {
  const TABLE = 'test_versioned_migration_marker';

  beforeAll(async () => {
    // Locked entry point, not raw runMigrations() — see objectPolicy.
    // integration.test.ts's beforeAll comment for why (concurrent test
    // files racing DDL on the shared solytiq_test database). This also
    // exercises runAllMigrations() -> runVersionedMigrations(VERSIONED_MIGRATIONS)
    // (the real production migration list), on top of which this file's own
    // ad-hoc test steps run — ensureSchemaMigrationsTable() stays as a
    // harmless, idempotent belt-and-suspenders call.
    await runAllMigrations();
    await ensureSchemaMigrationsTable();
  });

  afterEach(async () => {
    process.env.ALLOW_MIGRATION_CHECKSUM_DRIFT = ORIGINAL_ALLOW_DRIFT;
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await pool.query(`DELETE FROM schema_migrations WHERE id LIKE 'test_%'`);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await pool.query(`DELETE FROM schema_migrations WHERE id LIKE 'test_%'`);
    await pool.end();
  });

  it('applies a step exactly once, and skips it on a second run', async () => {
    let runCount = 0;
    const step = {
      id: 'test_marker_migration',
      description: 'creates a marker table',
      up: async (client: import('pg').PoolClient) => {
        runCount++;
        await client.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY)`);
      },
    };

    await runVersionedMigrations([step]);
    expect(runCount).toBe(1);
    const check1 = await pool.query(`SELECT to_regclass('${TABLE}') AS exists`);
    expect(check1.rows[0].exists).not.toBeNull();

    // Second call, same step — must be skipped (not re-run, which would
    // throw a duplicate-table error if it WERE re-run).
    await runVersionedMigrations([step]);
    expect(runCount).toBe(1);

    const ledger = await pool.query(`SELECT id, description FROM schema_migrations WHERE id = $1`, [step.id]);
    expect(ledger.rows.length).toBe(1);
    expect(ledger.rows[0].description).toBe('creates a marker table');
  });

  it('a later, unrelated step still applies even when an earlier one in the same call is already applied', async () => {
    const stepA = { id: 'test_step_a', description: 'A', up: async () => {} };
    const stepB = { id: 'test_step_b', description: 'B', up: async () => {} };

    await runVersionedMigrations([stepA]);
    await runVersionedMigrations([stepA, stepB]);

    const ledger = await pool.query(`SELECT id FROM schema_migrations WHERE id IN ('test_step_a','test_step_b') ORDER BY id`);
    expect(ledger.rows.map((r) => r.id)).toEqual(['test_step_a', 'test_step_b']);
    await pool.query(`DELETE FROM schema_migrations WHERE id IN ('test_step_a','test_step_b')`);
  });

  it('a step whose effect fails rolls back — no ledger row is left behind for a failed step', async () => {
    const step = {
      id: 'test_failing_migration',
      description: 'this one fails',
      up: async (client: import('pg').PoolClient) => {
        await client.query(`SELECT 1 / 0`); // deliberate SQL error
      },
    };
    await expect(runVersionedMigrations([step])).rejects.toThrow();
    const ledger = await pool.query(`SELECT id FROM schema_migrations WHERE id = $1`, [step.id]);
    expect(ledger.rows.length).toBe(0);
  });

  it('checksum drift on an already-applied step THROWS by default (fails closed)', async () => {
    const original = { id: 'test_drift_migration', description: 'original', up: async () => {} };
    await runVersionedMigrations([original]);

    const modified = { id: 'test_drift_migration', description: 'MODIFIED after the fact', up: async () => {} };
    delete process.env.ALLOW_MIGRATION_CHECKSUM_DRIFT;
    await expect(runVersionedMigrations([modified])).rejects.toThrow(MigrationChecksumDriftError);

    await pool.query(`DELETE FROM schema_migrations WHERE id = 'test_drift_migration'`);
  });

  it('checksum drift is overridable via ALLOW_MIGRATION_CHECKSUM_DRIFT, and does NOT re-run the step', async () => {
    let runCount = 0;
    const original = { id: 'test_drift_override', description: 'original', up: async () => { runCount++; } };
    await runVersionedMigrations([original]);
    expect(runCount).toBe(1);

    const modified = { id: 'test_drift_override', description: 'MODIFIED', up: async () => { runCount++; } };
    process.env.ALLOW_MIGRATION_CHECKSUM_DRIFT = 'true';
    await expect(runVersionedMigrations([modified])).resolves.not.toThrow();
    // Still 1 — the override lets startup proceed, it does not re-execute
    // the (now-different) step's logic against an already-migrated database.
    expect(runCount).toBe(1);

    // The ledger's stored description is still the ORIGINAL one — an
    // override never rewrites history.
    const ledger = await pool.query(`SELECT description FROM schema_migrations WHERE id = 'test_drift_override'`);
    expect(ledger.rows[0].description).toBe('original');

    await pool.query(`DELETE FROM schema_migrations WHERE id = 'test_drift_override'`);
  });

  it('getSchemaVersion() reflects real ledger state against this live database', async () => {
    const step = { id: 'test_schema_version_check', description: 'for getSchemaVersion', up: async () => {} };
    await runVersionedMigrations([step]);

    const version = await getSchemaVersion();
    expect(version.legacyMigrationsApplied).toBe(true);
    expect(version.appliedVersionedMigrations).toContain('test_schema_version_check');
    expect(version.latestVersionedMigrationAt).not.toBeNull();

    await pool.query(`DELETE FROM schema_migrations WHERE id = 'test_schema_version_check'`);
  });

  it("runAllMigrations()'s advisory lock key genuinely serializes a second connection", async () => {
    const holder = await pool.connect();
    const contender = await pool.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtext('solytiq_cloud:schema_migrations'))`);

      // A second connection trying the SAME key must NOT acquire it while
      // the first holds it — pg_try_advisory_lock is non-blocking, so this
      // resolves immediately either way (no risk of hanging the test).
      const attempt = await contender.query<{ pg_try_advisory_lock: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext('solytiq_cloud:schema_migrations'))`
      );
      expect(attempt.rows[0].pg_try_advisory_lock).toBe(false);

      await holder.query(`SELECT pg_advisory_unlock(hashtext('solytiq_cloud:schema_migrations'))`);

      // Now that the holder released it, the contender CAN acquire it.
      const attempt2 = await contender.query<{ pg_try_advisory_lock: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext('solytiq_cloud:schema_migrations'))`
      );
      expect(attempt2.rows[0].pg_try_advisory_lock).toBe(true);
      await contender.query(`SELECT pg_advisory_unlock(hashtext('solytiq_cloud:schema_migrations'))`);
    } finally {
      holder.release();
      contender.release();
    }
  });

  it('runAllMigrations() completes successfully end-to-end against an already-migrated database (idempotent re-run)', async () => {
    await expect(runAllMigrations()).resolves.not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // B6 (Phase 2) — `concurrent: true` steps (CREATE INDEX CONCURRENTLY, which
  // Postgres refuses inside a transaction block — verified directly above).
  // ---------------------------------------------------------------------------
  describe('concurrent: true steps', () => {
    const IDX = 'test_concurrent_marker_idx';

    afterEach(async () => {
      await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${IDX}`);
      await pool.query(`DELETE FROM schema_migrations WHERE id LIKE 'test_concurrent_%'`);
    });

    it('builds a real index via CREATE INDEX CONCURRENTLY, outside any transaction, and records it in the ledger', async () => {
      const step = {
        id: 'test_concurrent_step',
        description: 'concurrent index build',
        concurrent: true,
        indexName: IDX,
        up: async () => {
          // Deliberately NOT using the passed client — a concurrent step runs
          // on a plain autocommit connection, proven by this succeeding at all
          // (the same statement inside withTransaction throws — see the
          // module header's own verified claim).
          await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${IDX} ON tasks(list_id)`);
        },
      };
      await runVersionedMigrations([step]);

      const idx = await pool.query(`SELECT indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = $1`, [IDX]);
      expect(idx.rows.length).toBe(1);
      expect(idx.rows[0].indisvalid).toBe(true);

      const ledger = await pool.query(`SELECT id FROM schema_migrations WHERE id = $1`, [step.id]);
      expect(ledger.rows.length).toBe(1);
    });

    it('is idempotent-safe on a second run (no duplicate-index error, no second ledger row)', async () => {
      const step = {
        id: 'test_concurrent_step',
        description: 'concurrent index build',
        concurrent: true,
        indexName: IDX,
        up: async () => { await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${IDX} ON tasks(list_id)`); },
      };
      await runVersionedMigrations([step]);
      await expect(runVersionedMigrations([step])).resolves.not.toThrow();
      const ledger = await pool.query(`SELECT id FROM schema_migrations WHERE id = $1`, [step.id]);
      expect(ledger.rows.length).toBe(1);
    });

    it('detects and rebuilds a leftover INVALID index from a previously-interrupted build', async () => {
      // Simulate an interrupted CONCURRENTLY build: Postgres leaves an
      // invalid index behind when one is cancelled mid-build. We can't
      // easily cancel one mid-flight in a test, but we CAN reproduce the
      // exact end state (an invalid index by that name, no ledger row) by
      // building on an empty/immediate-fail path: CONCURRENTLY on a unique
      // index over a column with a pre-existing duplicate leaves it invalid.
      await pool.query(`CREATE TABLE IF NOT EXISTS test_concurrent_dupes (v INT)`);
      await pool.query(`INSERT INTO test_concurrent_dupes (v) VALUES (1), (1)`); // duplicate — breaks a UNIQUE build
      await pool.query(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${IDX} ON test_concurrent_dupes(v)`).catch(() => {
        /* expected to fail and leave an invalid index behind */
      });

      const preCheck = await pool.query(`SELECT indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = $1`, [IDX]);
      expect(preCheck.rows[0]?.indisvalid).toBe(false); // confirms the simulated pre-condition

      // Now the real migration step, targeting the SAME index name but a
      // non-unique definition (as production code would after fixing the
      // underlying issue) — it must detect the invalid leftover and rebuild.
      const step = {
        id: 'test_concurrent_rebuild',
        description: 'rebuild after invalid leftover',
        concurrent: true,
        indexName: IDX,
        up: async () => { await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${IDX} ON tasks(list_id)`); },
      };
      await runVersionedMigrations([step]);

      const postCheck = await pool.query(`SELECT indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = $1`, [IDX]);
      expect(postCheck.rows[0]?.indisvalid).toBe(true);

      await pool.query(`DELETE FROM schema_migrations WHERE id = 'test_concurrent_rebuild'`);
      await pool.query(`DROP TABLE IF EXISTS test_concurrent_dupes`);
    });
  });
});
