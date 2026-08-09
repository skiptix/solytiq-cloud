// ---------------------------------------------------------------------------
// S7 — versioned migrations, pure/mock-exec unit tests (no live DB needed).
// See versionedMigrations.integration.test.ts for the live-Postgres proof of
// actual application/checksum-drift/transaction behavior.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { computeMigrationChecksum, getSchemaVersion, MigrationChecksumDriftError, type VersionedMigration } from '../versionedMigrations';

describe('computeMigrationChecksum', () => {
  const base: Pick<VersionedMigration, 'id' | 'description' | 'up'> = {
    id: 'test_migration_1',
    description: 'a test migration',
    up: async () => {},
  };

  it('is deterministic for identical inputs', () => {
    expect(computeMigrationChecksum(base)).toBe(computeMigrationChecksum({ ...base }));
  });

  it('changes when the id changes', () => {
    expect(computeMigrationChecksum(base)).not.toBe(computeMigrationChecksum({ ...base, id: 'different_id' }));
  });

  it('changes when the description changes', () => {
    expect(computeMigrationChecksum(base)).not.toBe(computeMigrationChecksum({ ...base, description: 'a DIFFERENT test migration' }));
  });

  it('changes when the up() function source changes', () => {
    const modified: VersionedMigration['up'] = async (client) => { await client.query('SELECT 2'); };
    expect(computeMigrationChecksum(base)).not.toBe(computeMigrationChecksum({ ...base, up: modified }));
  });

  it('is a 64-char hex string (SHA-256)', () => {
    expect(computeMigrationChecksum(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('MigrationChecksumDriftError', () => {
  it('names the drifted migration id and mentions the override env var', () => {
    const err = new MigrationChecksumDriftError('my_migration_id');
    expect(err.name).toBe('MigrationChecksumDriftError');
    expect(err.message).toContain('my_migration_id');
    expect(err.message).toContain('ALLOW_MIGRATION_CHECKSUM_DRIFT');
    expect(err.migrationId).toBe('my_migration_id');
  });
});

describe('getSchemaVersion — mock exec (fresh/never-migrated database)', () => {
  it('reads legacyMigrationsApplied=false and an empty ledger without throwing, when neither table exists', async () => {
    const mockExec = {
      query: async () => {
        throw new Error('relation does not exist');
      },
    };
    const version = await getSchemaVersion(mockExec);
    expect(version.legacyMigrationsApplied).toBe(false);
    expect(version.appliedVersionedMigrations).toEqual([]);
    expect(version.latestVersionedMigrationAt).toBeNull();
  });

  it('reflects an empty ledger even once the legacy migrations table exists', async () => {
    const mockExec = {
      query: async (text: string) => {
        if (text.includes('information_schema.tables')) return { rows: [{ exists: true }] };
        return { rows: [] };
      },
    };
    const version = await getSchemaVersion(mockExec);
    expect(version.legacyMigrationsApplied).toBe(true);
    expect(version.appliedVersionedMigrations).toEqual([]);
    expect(version.latestVersionedMigrationAt).toBeNull();
  });

  it('reports applied versioned migrations oldest-first with the latest timestamp', async () => {
    const rows = [
      { id: 'm1', applied_at: '2026-01-01T00:00:00.000Z' },
      { id: 'm2', applied_at: '2026-02-01T00:00:00.000Z' },
    ];
    const mockExec = {
      query: async (text: string) => {
        if (text.includes('information_schema.tables')) return { rows: [{ exists: true }] };
        if (text.includes('schema_migrations')) return { rows };
        return { rows: [] };
      },
    };
    const version = await getSchemaVersion(mockExec);
    expect(version.appliedVersionedMigrations).toEqual(['m1', 'm2']);
    expect(version.latestVersionedMigrationAt).toBe('2026-02-01T00:00:00.000Z');
  });
});
