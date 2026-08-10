// ---------------------------------------------------------------------------
// B8 — /readyz's actual decision logic, extracted as a pure(ish) function of
// INJECTED dependencies so it is unit-testable without a live database or a
// running HTTP server (see B1's "testbare Clock-, Query-, ... Schnittstellen"
// requirement — this is that seam for readiness).
//
// index.ts's `app.get('/readyz', ...)` handler is a thin wrapper: it builds
// the real `ReadinessDeps` (pool.query, getSchemaVersion, isShuttingDown) and
// calls `checkReadiness()`, then translates the result to an HTTP status.
// readiness.test.ts exercises `checkReadiness()` directly against fake
// deps — including a deliberately-hanging `pingDb` — to prove the "readiness
// goes red within N seconds of a DB outage" gate without ever touching a real
// database or sleeping for the full outage duration in the test itself.
// ---------------------------------------------------------------------------

export interface SchemaVersionSnapshot {
  legacyMigrationsApplied: boolean;
  appliedVersionedMigrations: string[];
}

export interface ReadinessDeps {
  /** Resolves once the DB round-trip succeeds, rejects on any failure. */
  pingDb: () => Promise<void>;
  /** Resolves with the current schema-migration state. */
  getSchemaVersion: () => Promise<SchemaVersionSnapshot>;
  /** True once SIGTERM/SIGINT has been received — readiness must go red
   *  IMMEDIATELY on shutdown, before anything else even gets checked, so an
   *  in-flight orchestrator health poll can't race a still-green response
   *  against a process that's already draining (see shutdown.ts). */
  isShuttingDown: () => boolean;
  /** Milliseconds the DB ping + schema check together are allowed to take
   *  before this function gives up and reports not-ready on its own,
   *  independent of whatever the underlying pool/query timeout is — this is
   *  what bounds "readiness goes red within 5 seconds of a DB outage" even
   *  if the pool's own acquire/statement timeout is configured longer. */
  timeoutMillis: number;
}

export type ReadinessResult =
  | { ready: true; schemaVersionCount: number }
  | { ready: false; reason: 'shutting_down' | 'schema_not_migrated' | 'db_unreachable' | 'timeout' };

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('readiness check timed out')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export async function checkReadiness(deps: ReadinessDeps): Promise<ReadinessResult> {
  if (deps.isShuttingDown()) return { ready: false, reason: 'shutting_down' };

  try {
    await withTimeout(deps.pingDb(), deps.timeoutMillis);
  } catch {
    return { ready: false, reason: 'db_unreachable' };
  }

  let schema: SchemaVersionSnapshot;
  try {
    schema = await withTimeout(deps.getSchemaVersion(), deps.timeoutMillis);
  } catch {
    return { ready: false, reason: 'db_unreachable' };
  }

  if (!schema.legacyMigrationsApplied) {
    return { ready: false, reason: 'schema_not_migrated' };
  }

  return { ready: true, schemaVersionCount: schema.appliedVersionedMigrations.length };
}
