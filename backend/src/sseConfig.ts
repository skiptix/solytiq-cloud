// ---------------------------------------------------------------------------
// B7 (Phase 2) — centrally-configured SSE resource budgets.
//
// Every value here is validated (falls back to a safe default on a missing
// or non-numeric env var, never throws) and independently overridable, same
// convention as dbConfig.ts / uploadLimits.ts.
// ---------------------------------------------------------------------------

function envInt(name: string, def: number, opts: { min?: number } = {}): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  const min = opts.min ?? 0;
  return n >= min ? n : def;
}

/** Max simultaneous SSE connections a single user may hold on THIS process.
 *  Default lowered from the earlier S4 value (8) to the B7 spec's own
 *  literal default (5) — still configurable, and the (S4-established)
 *  eviction behavior on the 6th+ connection is unchanged: the OLDEST
 *  connection is closed to make room, never a hard rejection, so a
 *  reconnect storm degrades gracefully instead of locking a user out. */
export const SSE_MAX_CONNECTIONS_PER_USER = envInt('SSE_MAX_CONNECTIONS_PER_USER', 5, { min: 1 });

/** Hard cap, in bytes, on how much UNSENT data this process will buffer for
 *  one SSE connection before giving up on it. A client that stops reading
 *  (a suspended tab, a dead network path the TCP stack hasn't noticed yet)
 *  would otherwise let `res.write()`'s internal buffer grow unbounded —
 *  this is what turns that into a bounded, observable, recoverable failure:
 *  the connection is dropped, its heartbeat/queue memory is freed, and the
 *  client's own EventSource reconnects and resyncs via `/api/sync/delta`
 *  (frames are nudges, never the source of truth — see syncLog.ts). */
export const SSE_MAX_QUEUE_BYTES = envInt('SSE_MAX_QUEUE_BYTES', 256 * 1024, { min: 1024 });

/** Max lifetime of one SSE connection before this process force-closes it
 *  (the client's EventSource auto-reconnects transparently). Bounds how
 *  long a single connection can go without a fresh auth/config check beyond
 *  what sweepStaleSseConnections already re-verifies, and lets a rolling
 *  config/deploy take effect for long-lived streams without waiting
 *  indefinitely for every client to naturally disconnect. */
export const SSE_MAX_CONNECTION_AGE_MS = envInt('SSE_MAX_CONNECTION_AGE_MS', 4 * 60 * 60 * 1000, { min: 60_000 });
