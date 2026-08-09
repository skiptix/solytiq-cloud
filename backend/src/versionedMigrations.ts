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
// `VERSIONED_MIGRATIONS` starts EMPTY. This is deliberate, not a stub: no
// fabricated no-op migration was added just to exercise the mechanism at
// boot — that would inflate this diff with pointless production code. The
// mechanism itself is fully exercised by versionedMigrations.test.ts and
// versionedMigrations.integration.test.ts against synthetic step lists.
// ---------------------------------------------------------------------------

import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool, withTransaction } from './db';

interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface VersionedMigration {
  /** Stable, unique id — e.g. `2026_08_06_add_widget_color`. Never reuse or
   *  rename an id once it has shipped; the ledger keys on it verbatim. */
  id: string;
  /** Human-readable one-liner shown in logs/getSchemaVersion(). */
  description: string;
  /** Runs inside a transaction shared with this step's own ledger insert.
   *  Must be genuinely idempotent-safe to retry ONCE if the process crashes
   *  between the effect committing and... it can't — see the module header:
   *  effect + ledger row commit atomically, so there is no partial-applied
   *  state to retry into. Still, prefer IF NOT EXISTS-style DDL as a second
   *  line of defense, matching the rest of this codebase's convention. */
  up: (client: PoolClient) => Promise<void>;
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

    await withTransaction(async (client) => {
      await step.up(client);
      await client.query(
        `INSERT INTO schema_migrations (id, description, checksum) VALUES ($1, $2, $3)`,
        [step.id, step.description, checksum]
      );
    });
  }
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

/** No real migrations yet — see the module header for why this starts empty. */
export const VERSIONED_MIGRATIONS: VersionedMigration[] = [];
