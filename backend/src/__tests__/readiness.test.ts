// ---------------------------------------------------------------------------
// B8 — /readyz decision logic. Fully mocked deps, no DB, no HTTP, no real
// sleeps for the outage duration — proves the readiness gate deterministically
// and fast.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { checkReadiness, type ReadinessDeps } from '../readiness';

function deps(overrides: Partial<ReadinessDeps> = {}): ReadinessDeps {
  return {
    pingDb: async () => {},
    getSchemaVersion: async () => ({ legacyMigrationsApplied: true, appliedVersionedMigrations: ['a', 'b'] }),
    isShuttingDown: () => false,
    timeoutMillis: 200,
    ...overrides,
  };
}

describe('checkReadiness', () => {
  it('is ready when DB pings ok and the schema is migrated', async () => {
    const r = await checkReadiness(deps());
    expect(r).toEqual({ ready: true, schemaVersionCount: 2 });
  });

  it('is immediately not-ready during shutdown, without even attempting a DB ping', async () => {
    let pinged = false;
    const r = await checkReadiness(deps({
      isShuttingDown: () => true,
      pingDb: async () => { pinged = true; },
    }));
    expect(r).toEqual({ ready: false, reason: 'shutting_down' });
    expect(pinged).toBe(false);
  });

  it('reports db_unreachable when pingDb rejects', async () => {
    const r = await checkReadiness(deps({ pingDb: async () => { throw new Error('ECONNREFUSED'); } }));
    expect(r).toEqual({ ready: false, reason: 'db_unreachable' });
  });

  it('reports db_unreachable when pingDb hangs past the configured timeout — this is what bounds "readiness goes red within N seconds" independent of a hung connection', async () => {
    const started = Date.now();
    const r = await checkReadiness(deps({
      timeoutMillis: 50,
      pingDb: () => new Promise(() => { /* never resolves — simulates a fully wedged DB */ }),
    }));
    const elapsed = Date.now() - started;
    expect(r).toEqual({ ready: false, reason: 'db_unreachable' });
    // Bounded by the configured timeout, not by the hang itself.
    expect(elapsed).toBeLessThan(500);
  });

  it('reports db_unreachable when getSchemaVersion hangs past the timeout', async () => {
    const r = await checkReadiness(deps({
      timeoutMillis: 50,
      getSchemaVersion: () => new Promise(() => {}),
    }));
    expect(r).toEqual({ ready: false, reason: 'db_unreachable' });
  });

  it('reports schema_not_migrated when the legacy monolith has never run on this database', async () => {
    const r = await checkReadiness(deps({
      getSchemaVersion: async () => ({ legacyMigrationsApplied: false, appliedVersionedMigrations: [] }),
    }));
    expect(r).toEqual({ ready: false, reason: 'schema_not_migrated' });
  });

  it('shutdown takes priority over every other check', async () => {
    const r = await checkReadiness(deps({
      isShuttingDown: () => true,
      pingDb: async () => { throw new Error('would also fail, but shutdown wins'); },
    }));
    expect(r).toEqual({ ready: false, reason: 'shutting_down' });
  });
});
