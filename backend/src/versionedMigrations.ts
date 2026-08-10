// ---------------------------------------------------------------------------
// S7 — versioned migrations (go-forward mechanism).
//
// CLAUDE.md's own documented convention is "migrations in code, not files":
// `migrations.ts`'s `runMigrations()` is one large, idempotent function of
// `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
// statements re-run on every boot. That convention is NOT being retrofitted
// here — rewriting ~2700 lines of already-idempotent, already-battle-tested
// schema history into a stepped ledger would be pure risk for zero benefit
// (every one of those statements already converges to the same end state
// regardless of how many times or in what order-relative-to-itself it runs).
//
// What THIS module adds, for every migration written from now on:
//   1. A `schema_migrations` ledger — one row per applied step, so it's
//      possible to answer "what has actually run against this database" by
//      querying rather than reading source and reasoning about IF NOT EXISTS
//      guards by hand.
//   2. A CHECKSUM per step, verified on every subsequent boot — if an
//      already-applied step's logic is edited after the fact (e.g. someone
//      "fixes" a bug in a migration that already ran in production), that is
//      a genuine data-integrity signal: the running database's schema may no
//      longer match what the (now-different) migration source claims to
//      produce. This fails CLOSED (throws, halting startup) by default,
//      matching CLAUDE.md's "no weakening of safety nets" — a silently
//      ignored drift is exactly the kind of fail-open behavior that rule
//      forbids. `ALLOW_MIGRATION_CHECKSUM_DRIFT=true` is a deliberate,
//      explicit, documented operator override for the rare legitimate case
//      (e.g. a comment-only edit), mirroring this codebase's established
//      "safe default + explicit env-var opt-out" pattern (NUKE_SKIP_RESTART,
//      TRUST_CF_CONNECTING_IP).
//   3. Each step's effect AND its ledger row commit together in one
//      transaction — a step can never appear "applied" without its own
//      writes having actually landed, or vice versa.
//
// `VERSIONED_MIGRATIONS` started EMPTY through Phase 1 (S1-S7) — no
// fabricated no-op migration was added just to exercise the mechanism at
// boot. The mechanism itself is fully exercised by versionedMigrations.test.ts
// and versionedMigrations.integration.test.ts against synthetic step lists.
//
// Phase 2 (B6) is the first REAL content: `B6_INDEX_MIGRATIONS`
// (b6IndexMigrations.ts) — measured, evidence-backed hot-path indexes, each
// built `CONCURRENTLY` (see this module's own `concurrent: true` support
// above, added specifically because these steps need it).
// ---------------------------------------------------------------------------

import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool, withTransaction } from './db';

// ---------------------------------------------------------------------------
// B6 (Phase 2) addition — CONCURRENTLY-built index steps.
//
// Postgres flatly refuses `CREATE INDEX CONCURRENTLY` inside a transaction
// block ("CREATE INDEX CONCURRENTLY cannot run inside a transaction block") —
// verified directly against this exact schema. Every step above runs inside
// `withTransaction(...)`, so a step that needs CONCURRENTLY (any index build
// large enough to matter for a production table — the entire point of using
// CONCURRENTLY at all, since it avoids taking the ACCESS EXCLUSIVE lock a
// plain CREATE INDEX holds for the build's full duration) could never use
// this mechanism as originally written. `concurrent: true` is the escape
// hatch: such a step's `up()` runs OUTSIDE any transaction, on the pool
// directly (autocommit), and its ledger row is inserted in a SEPARATE, tiny
// transaction immediately after — see `runVersionedMigrations` below for the
// exact sequencing and its crash-recovery properties.
// ---------------------------------------------------------------------------

interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface VersionedMigration {
  /** Stable, unique id — e.g. `2026_08_06_add_widget_color`. Never reuse or
   *  rename an id once it has shipped; the ledger keys on it verbatim. */
  id: string;
  /** Human-readable one-liner shown in logs/getSchemaVersion(). */
  description: string;
  /** Runs inside a transaction shared with this step's own ledger insert
   *  (UNLESS `concurrent: true` — see below). Must be genuinely idempotent-
   *  safe to retry ONCE if the process crashes between the effect committing
   *  and... it can't, for a transactional step — see the module header:
   *  effect + ledger row commit atomically, so there is no partial-applied
   *  state to retry into. Still, prefer IF NOT EXISTS-style DDL as a second
   *  line of defense, matching the rest of this codebase's convention. */
  up: (client: PoolClient) => Promise<void>;
  /**
   * Set for a step whose `up()` issues `CREATE INDEX CONCURRENTLY` (or any
   * other statement Postgres refuses inside a transaction block) — such a
   * step runs on a plain pool connection with autocommit, NOT inside
   * `withTransaction`, and its ledger row is inserted separately right after
   * it succeeds. Unlike a transactional step, a crash between the DDL
   * succeeding and the ledger insert IS possible here — see
   * `runVersionedMigrations`'s handling: `up()` must use
   * `CREATE INDEX CONCURRENTLY IF NOT EXISTS` so a retried run (ledger row
   * still missing) is a cheap no-op rather than a duplicate-index error, and
   * the FIRST thing `runVersionedMigrations` does for a concurrent step is
   * check `pg_index.indisvalid` for the index by name — a previous attempt
   * that crashed mid-build leaves an INVALID index Postgres will never
   * re-attempt on its own (a known CONCURRENTLY gotcha: IF NOT EXISTS treats
   * an invalid index as "already exists" and skips it), so an invalid index
   * is dropped and rebuilt before the ledger row is written.
   */
  concurrent?: boolean;
  /** Required when `concurrent` is true — the exact index name `up()`
   *  creates, used for the pre-flight invalid-index check described above.
   *  Not used for a transactional step. */
  indexName?: string;
}

/** SHA-256 of a step's own description + up.toString() — a coarse but real
 *  drift signal. Function source text changes (even whitespace) change the
 *  checksum; that's intentional (any edit to what a step DOES is worth
 *  surfacing), not a false-positive concern in practice, since a step should
 *  never be edited post-deployment anyway (see module header). */
export function computeMigrationChecksum(step: Pick<VersionedMigration, 'id' | 'description' | 'up'>): string {
  return crypto.createHash('sha256').update(`${step.id}\n${step.description}\n${step.up.toString()}`).digest('hex');
}

export async function ensureSchemaMigrationsTable(exec: Queryable = pool): Promise<void> {
  await exec.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id           VARCHAR(200) PRIMARY KEY,
      description  TEXT NOT NULL,
      checksum     VARCHAR(64) NOT NULL,
      applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export class MigrationChecksumDriftError extends Error {
  constructor(public migrationId: string) {
    super(
      `Migration "${migrationId}" has already been applied to this database, but its checksum no longer ` +
      `matches its current source — the step's logic was edited after it shipped. Startup is halted to avoid ` +
      `running against a schema that may not match what the migration source now claims to produce. If this ` +
      `edit is known-safe (e.g. a comment/formatting-only change), set ALLOW_MIGRATION_CHECKSUM_DRIFT=true to ` +
      `proceed anyway — this is a deliberate, explicit override, not a default.`
    );
    this.name = 'MigrationChecksumDriftError';
  }
}

function allowChecksumDrift(): boolean {
  return process.env.ALLOW_MIGRATION_CHECKSUM_DRIFT === 'true';
}

/**
 * Applies every not-yet-applied step in `steps`, in array order, each in its
 * own transaction alongside its ledger row. A step whose id is already in
 * the ledger is skipped — UNLESS its checksum has drifted, which throws
 * (see MigrationChecksumDriftError) unless explicitly overridden.
 */
export async function runVersionedMigrations(steps: VersionedMigration[]): Promise<void> {
  await ensureSchemaMigrationsTable();

  for (const step of steps) {
    const checksum = computeMigrationChecksum(step);
    const existing = await pool.query<{ checksum: string }>(
      `SELECT checksum FROM schema_migrations WHERE id = $1`,
      [step.id]
    );

    if (existing.rows.length > 0) {
      if (existing.rows[0].checksum !== checksum) {
        if (allowChecksumDrift()) {
          console.error(
            `⚠️  Migration "${step.id}" checksum drift detected — proceeding anyway because ` +
            `ALLOW_MIGRATION_CHECKSUM_DRIFT=true is set. This does NOT re-run the step.`
          );
        } else {
          throw new MigrationChecksumDriftError(step.id);
        }
      }
      continue; // already applied — never re-run a step, only verify it.
    }

    if (step.concurrent) {
      await applyConcurrentStep(step, checksum);
      continue;
    }

    await withTransaction(async (client) => {
      await step.up(client);
      await client.query(
        `INSERT INTO schema_migrations (id, description, checksum) VALUES ($1, $2, $3)`,
        [step.id, step.description, checksum]
      );
    });
  }
}

/**
 * Applies a `concurrent: true` step: a real dedicated pool connection (NOT
 * inside a transaction — `CREATE INDEX CONCURRENTLY` is rejected otherwise,
 * verified against this exact schema), a pre-flight check that drops a
 * left-behind INVALID index from a previously-crashed attempt (see
 * VersionedMigration's own doc comment for why that's necessary — plain
 * `IF NOT EXISTS` alone would treat an invalid index as "done"), then a
 * SEPARATE small transaction for the ledger row once the build succeeds.
 */
async function applyConcurrentStep(step: VersionedMigration, checksum: string): Promise<void> {
  if (!step.indexName) {
    throw new Error(`Versioned migration "${step.id}" is marked concurrent but has no indexName set.`);
  }
  const client = await pool.connect();
  try {
    const invalid = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_class c
         JOIN pg_index i ON i.indexrelid = c.oid
         WHERE c.relname = $1 AND i.indisvalid = false
       ) AS exists`,
      [step.indexName]
    );
    if (invalid.rows[0]?.exists) {
      console.warn(`⚠️  migration "${step.id}": found an INVALID leftover index "${step.indexName}" (from a previously-interrupted CONCURRENTLY build) — dropping and rebuilding.`);
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${step.indexName}`);
    }
    await step.up(client);
  } finally {
    client.release();
  }
  // Ledger insert as its own tiny statement, deliberately AFTER releasing the
  // dedicated connection above — a crash here leaves the index built but the
  // ledger row missing, which is safe-to-retry: the next boot re-enters this
  // function, finds the (now valid) index, and `up()`'s own
  // `CREATE INDEX CONCURRENTLY IF NOT EXISTS` is a cheap no-op before the
  // ledger row is (re-)written.
  await pool.query(
    `INSERT INTO schema_migrations (id, description, checksum) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [step.id, step.description, checksum]
  );
}

export interface SchemaVersionInfo {
  /** True once the legacy monolith (migrations.ts's runMigrations) has run
   *  at least once — inferred from the presence of a table it always
   *  creates first, since the legacy monolith has no ledger of its own. */
  legacyMigrationsApplied: boolean;
  /** Every versioned-migration id applied, oldest first. */
  appliedVersionedMigrations: string[];
  /** The most recent versioned migration's applied_at, or null if none yet. */
  latestVersionedMigrationAt: string | null;
}

/** Readiness-check surface — see the health endpoint in index.ts. Never
 *  throws on a fresh/never-migrated database; a missing ledger table just
 *  reads as "nothing applied yet" rather than an error. */
export async function getSchemaVersion(exec: Queryable = pool): Promise<SchemaVersionInfo> {
  let legacyMigrationsApplied = false;
  try {
    const r = await exec.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'users') AS exists`
    );
    legacyMigrationsApplied = r.rows[0]?.exists === true;
  } catch {
    legacyMigrationsApplied = false;
  }

  let appliedVersionedMigrations: string[] = [];
  let latestVersionedMigrationAt: string | null = null;
  try {
    const r = await exec.query<{ id: string; applied_at: string }>(
      `SELECT id, applied_at FROM schema_migrations ORDER BY applied_at ASC`
    );
    appliedVersionedMigrations = r.rows.map((row) => row.id);
    latestVersionedMigrationAt = r.rows.length > 0 ? r.rows[r.rows.length - 1].applied_at : null;
  } catch {
    // schema_migrations doesn't exist yet — reads as "none applied", not an error.
  }

  return { legacyMigrationsApplied, appliedVersionedMigrations, latestVersionedMigrationAt };
}

/** See the module header — Phase 2's B6 index migrations are the first real
 *  content in this ledger. Import is deliberately placed at the bottom of
 *  this file (rather than the top) so `b6IndexMigrations.ts`'s own
 *  `import type { VersionedMigration } from './versionedMigrations'` (a
 *  type-only, compile-time-erased import) can never form a real runtime
 *  circular dependency with this module. */
import { B6_INDEX_MIGRATIONS } from './b6IndexMigrations';
import { B3_LEASE_MIGRATIONS } from './b3LeaseMigrations';
import { B2_STORAGE_MIGRATIONS } from './b2StorageMigrations';
export const VERSIONED_MIGRATIONS: VersionedMigration[] = [
  // Every group here is independent of the others (own tables/columns) —
  // ordering is by sprint number purely for readability, not a functional
  // dependency between them.
  ...B2_STORAGE_MIGRATIONS,
  ...B3_LEASE_MIGRATIONS,
  ...B6_INDEX_MIGRATIONS,
];
