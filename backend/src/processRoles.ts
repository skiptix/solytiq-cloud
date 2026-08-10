// ---------------------------------------------------------------------------
// B1 (Phase 2) — explicit process roles (api / worker / migrator / all).
//
// Before this, every backend process — regardless of how many replicas were
// running — registered the SAME ~12 setInterval() sweeps unconditionally in
// index.ts's start(). Two API replicas behind a load balancer (the
// horizontal-scaling target this phase exists for) would each independently
// fire sweepScheduledAutomations/sweepEmbeddingQueue/sweepGraphMetrics/etc.
// on their own timer, multiplying every periodic job's side effects by the
// replica count — e.g. two replicas would double-fire due automations,
// double-purge AI files concurrently, double-recompute pagerank. This module
// is the seam that lets a deployment run N stateless `api` replicas (HTTP +
// this process's OWN in-memory SSE clients only) alongside a `worker`
// replica that owns every periodic sweep, and an optional one-shot
// `migrator` process/init-container — see index.ts's start() for how each
// predicate below gates a concrete setInterval()/app.listen() call.
//
// `all` (the default) is a deliberate, additive, zero-risk default: it
// reproduces EXACTLY today's single-container behavior (docker-compose.yml
// ships one `backend` service with no PROCESS_ROLE set), so nobody's
// existing deployment changes unless they explicitly opt into running
// separate api/worker containers. This is the same "safe default + explicit
// env-var opt-out" pattern this codebase already uses elsewhere (see
// NUKE_SKIP_RESTART, TRUST_CF_CONNECTING_IP, ALLOW_MIGRATION_CHECKSUM_DRIFT).
//
// Every predicate here is a PURE function of a role string — no DB, no HTTP,
// no process.env read inside the predicates themselves — so this whole
// module is unit-testable with zero mocking (see processRoles.test.ts).
// ---------------------------------------------------------------------------

export type ProcessRole = 'all' | 'api' | 'worker' | 'migrator';

const VALID_ROLES: ReadonlySet<string> = new Set(['all', 'api', 'worker', 'migrator']);

/**
 * Reads PROCESS_ROLE from the given env (defaults to `process.env`, but
 * injectable so a test never depends on global mutable state leaking across
 * test files running in the same process). An unset or unrecognized value
 * falls back to `'all'` rather than throwing — a typo'd role should degrade
 * to the safe, fully-functional default, not crash startup.
 */
export function resolveProcessRole(env: NodeJS.ProcessEnv = process.env): ProcessRole {
  const raw = (env.PROCESS_ROLE ?? 'all').trim().toLowerCase();
  return (VALID_ROLES.has(raw) ? raw : 'all') as ProcessRole;
}

/**
 * Does this role run the periodic domain sweeps (automation schedules,
 * embedding queue, graph metrics, overdue-deadline notifications, expired
 * agent proposals, migration-drift verification, sync_log pruning, AI-file
 * purge, expired asset-ticket/share-session cleanup)? These must run exactly
 * ONCE fleet-wide, not once per replica — see B3 for the durable claim/lease
 * primitive that makes it safe to eventually run more than one `worker`.
 */
export function roleRunsWorkerTimers(role: ProcessRole): boolean {
  return role === 'all' || role === 'worker';
}

/**
 * Does this role serve the full business HTTP API (routes, SSE)? Both `all`
 * and `api` do. `worker` still exposes a minimal health surface (see
 * `roleRunsHealthOnly`/index.ts's worker-role app) but never the business
 * API. `migrator` never listens at all — it applies migrations and exits.
 */
export function roleRunsHttpApi(role: ProcessRole): boolean {
  return role === 'all' || role === 'api';
}

/** Does this role need its OWN minimal (/livez, /readyz only) HTTP surface —
 *  i.e. `worker`, which doesn't run the business API but still needs to be
 *  probeable by an orchestrator/Docker healthcheck. */
export function roleRunsHealthOnlyApi(role: ProcessRole): boolean {
  return role === 'worker';
}

/**
 * Does this role own its own live SSE connections and therefore must run the
 * sync dispatcher (LISTEN) + the stale-SSE-connection sweep? These are
 * PER-PROCESS concerns (each replica's in-memory `clients` registry in
 * sse.ts is local and only serves connections THIS process accepted) — NOT a
 * "run once fleet-wide" sweep like `roleRunsWorkerTimers` above, so a
 * `worker`-role process (no SSE clients of its own) correctly does NOT run
 * this, while every `api`/`all` replica does.
 */
export function roleRunsSse(role: ProcessRole): boolean {
  return role === 'all' || role === 'api';
}

/**
 * Does this role apply database migrations at startup? `migrator` and `all`
 * do (see the module header: `all` preserves today's exact behavior).
 * `api`/`worker` assume a `migrator` (or an `all`) instance already applied
 * them — see /readyz (B8), which fails closed if the expected schema isn't
 * there yet rather than silently serving traffic against a stale schema.
 */
export function roleRunsMigrations(role: ProcessRole): boolean {
  return role === 'all' || role === 'migrator';
}

/** `migrator` exits immediately after migrating — it never listens, never
 *  runs timers. A one-shot init-container / Job pattern. */
export function roleExitsAfterMigration(role: ProcessRole): boolean {
  return role === 'migrator';
}
