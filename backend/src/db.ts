import { Pool, PoolClient, QueryResult, QueryResultRow, types } from 'pg';
import { resolvePoolConfig } from './dbConfig';

// Return DATE columns as plain "YYYY-MM-DD" strings, not JS Date objects.
// Without this, pg converts DATE → Date, which res.json() serialises to a full
// ISO timestamp ("2026-05-22T00:00:00.000Z"), breaking the frontend date parser.
types.setTypeParser(types.builtins.DATE, (val: string) => val);

// B8: pool size + every acquire/idle/statement/lock timeout is now validated,
// centrally-configured, and overridable — see dbConfig.ts's own header for
// why node-postgres's un-set defaults (most notably an UNBOUNDED acquire
// wait) were a real resource-exhaustion risk this closes.
const poolConfig = resolvePoolConfig();

export const pool = new Pool({
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'solytiq',
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD || '',
  max: poolConfig.max,
  idleTimeoutMillis: poolConfig.idleTimeoutMillis,
  connectionTimeoutMillis: poolConfig.connectionTimeoutMillis,
  // node-postgres passes these through verbatim as per-connection `SET`
  // statements at connect time (see pg's Client `statement_timeout` /
  // `lock_timeout` / `idle_in_transaction_session_timeout` options) — every
  // connection in the pool gets the same bounded session, not just the ones
  // this module happens to touch directly.
  statement_timeout: poolConfig.statementTimeoutMillis || undefined,
  lock_timeout: poolConfig.lockTimeoutMillis || undefined,
  idle_in_transaction_session_timeout: poolConfig.idleInTransactionSessionTimeoutMillis || undefined,
});

/** B8/B9 — instantaneous pool-saturation snapshot (total/idle/waiting
 *  connections), read by /metrics and the pool-saturation integration test.
 *  `pool.waitingCount > 0` for a sustained period is the signal an operator
 *  needs to size `DB_POOL_MAX` up (or find the query holding connections
 *  too long) before requests start timing out on acquire. */
export function getPoolStats(): { total: number; idle: number; waiting: number; max: number } {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: poolConfig.max };
}

// B8 — CORRECTNESS: node-postgres's own docs are explicit that the pool
// "will emit an error on the pool itself if any idle client in it
// encounters an error while sitting idly in the pool ... It is your
// responsibility to add a listener ... so that your application doesn't
// crash." Before this handler existed, a DB restart/network blip that
// dropped an IDLE pooled connection (not one actively in use) fired an
// unhandled 'error' event, which Node treats as an uncaught exception and
// crashes the ENTIRE process — verified against this exact codebase: a real
// `pg_ctlcluster stop` against a running `all`-role process killed it
// outright (exit code 1) rather than letting /readyz simply report
// `db_unreachable` as B8's own gate expects. This handler is the fix: log
// and drop the dead client, nothing more — every live request/health check
// keeps using the pool exactly as before, and /readyz's own `SELECT 1` ping
// (see index.ts) is what correctly reports the outage instead.
pool.on('error', (err) => {
  console.error('⚠️  postgres pool: idle client error (connection dropped, pool recovers automatically):', err.message);
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

/**
 * Run `fn` inside a single transaction. Commits on success, rolls back on any
 * thrown error, and always releases the client. Use this for any operation that
 * performs more than one dependent write so partial failures can't leave the
 * database in an inconsistent state.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }
}
