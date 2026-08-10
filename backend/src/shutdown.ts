// ---------------------------------------------------------------------------
// B8 — graceful shutdown.
//
// Before this, the process had NO SIGTERM/SIGINT handler at all: Node's
// default behavior on SIGTERM is to terminate IMMEDIATELY — every in-flight
// HTTP request, SSE stream, and open DB connection is severed mid-flight,
// and nothing tells /readyz to go red first so a load balancer keeps routing
// new traffic to a process that's already gone. This module is the single
// place that sequences an orderly drain:
//
//   1. Flip readiness red FIRST (so new traffic stops arriving) — this is
//      why `isShuttingDown()` is checked before anything else in
//      readiness.ts's `checkReadiness()`.
//   2. Stop accepting new HTTP connections (`server.close()`); let already
//      in-flight requests finish (bounded by the deadline below).
//   3. Close every open SSE stream (nothing left to push to once the
//      process is going away, and an open stream would otherwise block
//      `server.close()`'s callback from ever firing, since Node's HTTP
//      server considers a still-open keep-alive/SSE connection "in use").
//   4. Stop every periodic timer (setInterval handles collected at startup)
//      and the sync dispatcher's LISTEN connection — no new job should be
//      claimed once shutdown has started (see B3/B7's "keine neuen Jobs bei
//      Shutdown claimen").
//   5. Close the DB pool.
//
// A hard deadline (`resolveShutdownDeadlineMillis`, default 25s) forces
// `process.exit(1)` if the drain hasn't finished by then — an orchestrator's
// own SIGKILL grace period is typically 30s, so this must finish comfortably
// inside that or the container is killed mid-cleanup with no chance to log
// why.
// ---------------------------------------------------------------------------

import type { Server } from 'http';
import type { Pool } from 'pg';
import { resolveShutdownDeadlineMillis } from './dbConfig';

let shuttingDown = false;

/** Read by readiness.ts's `checkReadiness()` — see that module's own header
 *  for why this must be checked before any other readiness signal. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Test-only reset — vitest reuses the module registry across test files
 *  unless explicitly reset, and this module's shutdown flag is otherwise
 *  process-lifetime, one-way (by design: a process that received SIGTERM
 *  should never un-shut-down). */
export function __resetShutdownStateForTests(): void {
  shuttingDown = false;
}

export interface ShutdownDeps {
  server: Pick<Server, 'close'> | null;
  pool: Pick<Pool, 'end'>;
  /** Every `setInterval`/`setTimeout` handle registered at startup — cleared
   *  before the pool closes so no sweep can fire mid-drain and try to use an
   *  already-closing pool. */
  timers: Array<ReturnType<typeof setInterval>>;
  /** Ends every open SSE response and clears the in-memory client registry —
   *  see sse.ts's `closeAllSseConnectionsForShutdown`. Optional so a
   *  `worker`-role process (which never runs SSE, see processRoles.ts) can
   *  omit it. */
  closeSse?: () => void;
  /** Stops the sync dispatcher's LISTEN connection so it doesn't try to
   *  reconnect after the process has already committed to exiting — see
   *  syncLog.ts's `stopSyncDispatcher`. Optional for the same reason as
   *  `closeSse`. */
  stopSyncDispatcher?: () => Promise<void>;
  /**
   * B8 — releases every lease (schedule-triggered `automations` rows,
   * `embedding_queue` rows) THIS process currently holds from a
   * partially-worked claimed batch, EXCLUDING whatever single item (if any)
   * is still actively in flight — see automationEngine.ts's
   * `releaseUnstartedScheduleLeases()` / embeddingWorker.ts's
   * `releaseUnstartedEmbeddingLeases()` and jobLease.ts's
   * `releaseOwnedLeases()` for the full safety reasoning. Spec wording:
   * "Jobs leasen/abschließen oder freigeben" — this is the "freigeben"
   * (release) half; expiry alone (the pre-existing behavior) already
   * covered eventual recovery but left the REST of a fleet waiting out a
   * dead process's full lease duration even on a clean, orderly shutdown,
   * which this closes. Optional so a `worker`-role process wires it in
   * (it's the one that ever holds these leases) while an `api`-role process
   * (which never claims either table) can omit it. Runs BEFORE the pool
   * closes (needs a live DB connection) but does not need to run before
   * `closeSse`/timers-cleared — ordering relative to those is irrelevant,
   * since lease release neither depends on nor blocks either. */
  releaseOwnedLeases?: () => Promise<void>;
  deadlineMillis?: number;
  /** Injectable so a test can observe the terminal action without actually
   *  killing the test process. Defaults to `process.exit`. */
  exit?: (code: number) => void;
  log?: (msg: string) => void;
}

function closeServer(server: Pick<Server, 'close'> | null): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * Runs the drain sequence described in the module header. Idempotent — a
 * second SIGTERM/SIGINT while already draining is a no-op (does not restart
 * or double-run the sequence), matching real-world behavior where an
 * orchestrator can send SIGTERM more than once during a slow drain.
 */
export async function runGracefulShutdown(signal: string, deps: ShutdownDeps): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  const log = deps.log ?? ((msg: string) => console.log(msg));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const deadlineMs = deps.deadlineMillis ?? resolveShutdownDeadlineMillis();

  log(`${signal} received — starting graceful shutdown (deadline ${deadlineMs}ms). Readiness is now red.`);

  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  const hardDeadline = new Promise<void>((resolve) => {
    hardTimer = setTimeout(() => {
      log(`⚠️  graceful shutdown exceeded ${deadlineMs}ms deadline — forcing exit.`);
      exit(1);
      resolve();
    }, deadlineMs);
  });

  const drain = (async () => {
    // Timers first: no new sweep should start once we've committed to
    // shutting down, regardless of how long the rest of the drain takes.
    for (const t of deps.timers) clearInterval(t);

    // B8: release whatever leases this process is still holding from a
    // partially-worked batch (excluding anything genuinely in flight) —
    // see `releaseOwnedLeases` dep's own doc comment above for the full
    // "why now, why safe" reasoning. Best-effort like every other drain
    // step here: a failure here must not abort the rest of the shutdown
    // sequence, and the pre-existing expiry-based recovery still applies
    // as a fallback regardless.
    try { await deps.releaseOwnedLeases?.(); } catch (err) { log(`shutdown: releaseOwnedLeases error: ${(err as Error).message}`); }

    // SSE next: an open stream keeps the HTTP server's connection count
    // above zero, which would otherwise stall server.close()'s callback.
    try { deps.closeSse?.(); } catch (err) { log(`shutdown: closeSse error: ${(err as Error).message}`); }
    try { await deps.stopSyncDispatcher?.(); } catch (err) { log(`shutdown: stopSyncDispatcher error: ${(err as Error).message}`); }

    // Stop accepting new connections / let in-flight requests finish.
    await closeServer(deps.server);

    // Pool last — anything still trying to query after this point is a bug
    // in the drain ordering above, not something to paper over here.
    try { await deps.pool.end(); } catch (err) { log(`shutdown: pool.end error: ${(err as Error).message}`); }

    log('graceful shutdown complete.');
  })();

  await Promise.race([drain, hardDeadline]);
  if (hardTimer) clearTimeout(hardTimer);
}
