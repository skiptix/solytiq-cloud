// ---------------------------------------------------------------------------
// B7 (Phase 2) — Automation Hub resource budgets.
//
// Before this, an automation graph had NO upper bound on node count
// (normalizeAutomationGraph only rejected an EMPTY graph, never a huge one),
// runAutomation()'s action-chain loop had NO overall wall-clock deadline
// (a slow/hanging http_request or a long chain of otherwise-fast actions
// could run indefinitely), and there was NO limit on how many runs of a
// workspace's automations — or of ALL automations instance-wide — could
// execute concurrently. A single misbehaving automation (or a burst of
// simultaneous triggers) could therefore consume unbounded node-processing
// time, unbounded wall-clock time per run, and unbounded concurrent
// resource usage (DB connections, memory, isolated-vm sandboxes for `code`
// nodes) with nothing to stop it.
//
// Every value here is centrally configured (validated env vars, same
// convention as dbConfig.ts/sseConfig.ts) and defaults to the exact values
// the Phase 2 spec calls out explicitly.
// ---------------------------------------------------------------------------

function envInt(name: string, def: number, opts: { min?: number } = {}): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  const min = opts.min ?? 0;
  return n >= min ? n : def;
}

/** Max total nodes (trigger + actions) a single automation graph may
 *  contain — enforced in automationGraph.ts's normalizeAutomationGraph() on
 *  every save, so an oversized graph is rejected before it's ever stored,
 *  not just at run time. */
export const AUTOMATION_MAX_NODES = envInt('AUTOMATION_MAX_NODES', 50, { min: 2 });

/** Overall wall-clock deadline for one run's ENTIRE action chain (not
 *  per-node — a chain of 40 fast actions and one slow one both count
 *  against the same budget). Enforced in automationEngine.ts's
 *  runAutomation() before each node executes; exceeding it stops the chain
 *  deterministically with a clear error, the same way a failed node does —
 *  Run History shows exactly how far it got, matching this codebase's
 *  existing "per-step, not all-or-nothing" execution model (see
 *  automationEngine.ts's own header). */
export const AUTOMATION_RUN_DEADLINE_MS = envInt('AUTOMATION_RUN_DEADLINE_MS', 60_000, { min: 1000 });

/** Max simultaneous RUNNING automation runs for one workspace (tenant). A
 *  burst of triggers (e.g. a bulk task-completion sweep) firing many
 *  automations at once is bounded per-tenant so one workspace's activity
 *  can't starve every other workspace's automations of the shared budget
 *  below. */
export const AUTOMATION_MAX_CONCURRENT_PER_WORKSPACE = envInt('AUTOMATION_MAX_CONCURRENT_PER_WORKSPACE', 4, { min: 1 });

/** Max simultaneous RUNNING automation runs across the WHOLE process
 *  (instance-wide). A hard ceiling independent of per-workspace fairness —
 *  see the module header on why this is process-local (single-worker
 *  today; see the Phase 2 handoff's B3 notes on why a genuinely
 *  cross-replica limit needs the durable claim/lease primitive, not an
 *  in-memory counter, once automations run on more than one worker
 *  replica). */
export const AUTOMATION_MAX_CONCURRENT_GLOBAL = envInt('AUTOMATION_MAX_CONCURRENT_GLOBAL', 20, { min: 1 });
