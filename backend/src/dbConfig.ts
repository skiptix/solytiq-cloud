// ---------------------------------------------------------------------------
// B8 — validated, centrally-configured DB pool sizing and timeouts.
//
// Before this, `new Pool({...})` in db.ts set only connection credentials —
// every timeout knob (`max` pool size, acquire/idle/statement/lock timeouts)
// used node-postgres's own built-in defaults, most of which are effectively
// UNBOUNDED (`connectionTimeoutMillis` defaults to 0 — wait forever to
// acquire a connection under pool saturation; there is no default
// `statement_timeout`/`lock_timeout` at all). A single slow/blocked query
// could then hold a connection indefinitely, starving the whole pool with no
// way to observe or bound it — exactly the failure mode B8 exists to close.
//
// Every value here is validated (falls back to a safe default on a missing
// or non-numeric env var, never throws, never silently accepts a negative or
// zero value where that would be nonsensical) and overridable per-deployment.
// `resolvePoolConfig()` is a pure function of an env object — unit-testable
// with zero mocking, and the SAME function `db.ts` uses in production and a
// pool-saturation integration test uses to build its own scaled-down pool.
// ---------------------------------------------------------------------------

function envInt(env: NodeJS.ProcessEnv, name: string, def: number, opts: { min?: number } = {}): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  const min = opts.min ?? 0;
  return n >= min ? n : def;
}

export interface PoolConfig {
  /** Maximum concurrent connections this process's pool will open. */
  max: number;
  /** Milliseconds an idle connection is kept before being closed. */
  idleTimeoutMillis: number;
  /** Milliseconds to wait for a connection to become available before the
   *  `pool.connect()`/`pool.query()` call rejects — this is the "acquire
   *  timeout" the spec calls for; 0 would mean "wait forever" (the old
   *  implicit default), which is deliberately never this module's default. */
  connectionTimeoutMillis: number;
  /** Per-session `statement_timeout` (ms) — aborts any single SQL statement
   *  that runs longer than this. 0 disables it (unbounded) — a deliberate
   *  opt-out for a deployment with a known-longer legitimate query, never
   *  the default. */
  statementTimeoutMillis: number;
  /** Per-session `lock_timeout` (ms) — aborts a statement that has been
   *  waiting this long to acquire a row/table lock, converting a silent
   *  indefinite lock-wait into a fast, visible error. */
  lockTimeoutMillis: number;
  /** Per-session `idle_in_transaction_session_timeout` (ms) — kills a
   *  connection that opened a transaction and then went idle without
   *  committing/rolling back, the classic "forgot to release the client"
   *  leak that would otherwise hold a connection (and any locks it took)
   *  forever. */
  idleInTransactionSessionTimeoutMillis: number;
}

/**
 * Resolves the pool configuration from environment variables, always
 * returning a fully-populated, sane object — never partial, never throwing.
 * `env` defaults to `process.env` but is injectable for tests.
 */
export function resolvePoolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  return {
    max: envInt(env, 'DB_POOL_MAX', 20, { min: 1 }),
    idleTimeoutMillis: envInt(env, 'DB_POOL_IDLE_TIMEOUT_MS', 30_000, { min: 0 }),
    connectionTimeoutMillis: envInt(env, 'DB_POOL_ACQUIRE_TIMEOUT_MS', 10_000, { min: 1 }),
    statementTimeoutMillis: envInt(env, 'DB_STATEMENT_TIMEOUT_MS', 120_000, { min: 0 }),
    lockTimeoutMillis: envInt(env, 'DB_LOCK_TIMEOUT_MS', 15_000, { min: 0 }),
    idleInTransactionSessionTimeoutMillis: envInt(env, 'DB_IDLE_IN_TXN_TIMEOUT_MS', 30_000, { min: 0 }),
  };
}

/** How long /readyz's own DB ping + schema check is allowed to take before it
 *  gives up and reports not-ready — deliberately short and independent of
 *  the pool's own (much longer) statement_timeout, so a hung DB can never
 *  make readiness itself hang past this bound (see B8's gate: "Readiness
 *  wird bei DB-Ausfall innerhalb von 5 Sekunden rot"). */
export function resolveReadyzTimeoutMillis(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env, 'READYZ_TIMEOUT_MS', 3_000, { min: 100 });
}

/** Hard upper bound on graceful shutdown (SIGTERM/SIGINT) before the process
 *  force-exits regardless of what's still in flight — see shutdown.ts. */
export function resolveShutdownDeadlineMillis(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env, 'SHUTDOWN_DEADLINE_MS', 25_000, { min: 500 });
}
