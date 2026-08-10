// ---------------------------------------------------------------------------
// Automation Hub — execution engine.
//
// Loop prevention, concretely: every mutation that can fire a trigger takes
// an explicit MutationActor. fireTrigger() no-ops immediately unless
// actor.type === 'user'. HTTP routes always pass a 'user' actor; this
// engine's action handlers (automationTypes.ts) always pass an 'automation'
// actor when they call the same mutation functions (createListTask,
// deleteTaskRow, ...) in backend/src/routes/lists.ts. A chain can therefore
// fire off a genuine user action exactly once — never recursively — by
// construction, not by a depth counter. Grep `fireTrigger(` to audit every
// call site (task-completed/task-created in routes/lists.ts, plus the
// schedule sweep below, which isn't mutation-triggered at all).
//
// EXECUTION MODEL — per-step, not one all-or-nothing transaction: each node
// runs and, if it writes to the database, commits its own writes immediately
// (single-statement actions via the bare `query` on ctx.exec; any action with
// more than one dependent write opens its own short-lived transaction via
// ctx.withTransaction). If a later node fails, EARLIER successful writes are
// NOT rolled back — this replaces an earlier "whole run is one transaction"
// guarantee, a deliberate change: once an HTTP request has been sent (the new
// http_request action) there is no way to "undo" it anyway, so treating the
// whole chain as atomic was never fully honest once external side effects
// entered the picture. Run History's per-step log shows exactly how far a
// run got. A run is still fired `void ...catch(...)`, never awaited by the
// request that caused it, and downstream effects reach other clients the
// normal way, via the DB-trigger → sync_log → SSE pipeline every other
// mutation uses.
//
// DATA FLOW — every node (the trigger, and every action) produces a JSON
// `output`, accumulated into `nodeOutputs` (keyed by node id, seeded with the
// trigger's own output under its node id). Before each action's params reach
// validate()/execute(), resolveExpressions() (automationExpressions.ts)
// substitutes any `{{trigger.x}}`/`{{$json.x}}`/`{{nodes.<id>.x}}` tokens
// against the scope built so far — so a later node can reference an earlier
// one's result without any action implementing this itself.
// ---------------------------------------------------------------------------

import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from './db';
import { QueryExec } from './workspaceUtil';
import { getActionDef, getTriggerDef, serializeTriggerOutput, ActionRollbackSignal, type ActionResult, type TriggerContext } from './automationTypes';
import { normalizeAutomationGraph, orderedActionNodes, AutomationGraph } from './automationGraph';
import { buildScope, resolveExpressions } from './automationExpressions';
import { createNotification } from './notifications';
import { AUTOMATION_RUN_DEADLINE_MS, AUTOMATION_MAX_CONCURRENT_PER_WORKSPACE, AUTOMATION_MAX_CONCURRENT_GLOBAL } from './automationBudget';
import { claimDueRows, releaseOwnedLeases } from './jobLease';
import { WORKER_ID } from './workerId';

// ---------------------------------------------------------------------------
// B7 — in-process concurrency budget (per-workspace + global). See
// automationBudget.ts's own header for why this is process-local (accurate
// for today's single-worker deployment; a genuinely cross-replica limit
// needs B3's durable claim/lease primitive once automations run on more
// than one worker replica — documented, not silently assumed away).
// ---------------------------------------------------------------------------
const runningByWorkspace = new Map<string, number>();
let runningGlobal = 0;

/** Test-only: reset the in-process concurrency counters between test files. */
export function __resetAutomationConcurrencyForTests(): void {
  runningByWorkspace.clear();
  runningGlobal = 0;
}
/** Test-only: current in-flight run counts, for asserting the budget's own
 *  bookkeeping (increments on start, decrements on finish, even on error). */
export function __getAutomationConcurrencyForTests(): { global: number; byWorkspace: Map<string, number> } {
  return { global: runningGlobal, byWorkspace: new Map(runningByWorkspace) };
}

/**
 * B9 — a safe, aggregate-only snapshot for the `/metrics` endpoint: how many
 * automation runs are in flight globally right now, and how many DISTINCT
 * workspaces currently have at least one running, out of this budget's own
 * ceilings (AUTOMATION_MAX_CONCURRENT_GLOBAL/PER_WORKSPACE — see
 * automationBudget.ts). Deliberately does NOT expose workspace ids — this is
 * read from an unauthenticated endpoint, same posture as
 * `sse.ts`'s `getSseConnectionStats()`.
 */
export function getAutomationConcurrencyStats(): { runningGlobal: number; activeWorkspaceCount: number; globalLimit: number } {
  return { runningGlobal, activeWorkspaceCount: runningByWorkspace.size, globalLimit: AUTOMATION_MAX_CONCURRENT_GLOBAL };
}

function tryAcquireRunSlot(workspaceId: string): { ok: true } | { ok: false; reason: string } {
  if (runningGlobal >= AUTOMATION_MAX_CONCURRENT_GLOBAL) {
    return { ok: false, reason: `global concurrent-run limit reached (${AUTOMATION_MAX_CONCURRENT_GLOBAL})` };
  }
  const wsCount = runningByWorkspace.get(workspaceId) ?? 0;
  if (wsCount >= AUTOMATION_MAX_CONCURRENT_PER_WORKSPACE) {
    return { ok: false, reason: `workspace concurrent-run limit reached (${AUTOMATION_MAX_CONCURRENT_PER_WORKSPACE})` };
  }
  runningGlobal += 1;
  runningByWorkspace.set(workspaceId, wsCount + 1);
  return { ok: true };
}

function releaseRunSlot(workspaceId: string): void {
  runningGlobal = Math.max(0, runningGlobal - 1);
  const wsCount = runningByWorkspace.get(workspaceId) ?? 0;
  if (wsCount <= 1) runningByWorkspace.delete(workspaceId);
  else runningByWorkspace.set(workspaceId, wsCount - 1);
}

/**
 * Tell the automation's owner it ran (live runs only). The actor is the system
 * (actorId null) — an automation isn't a user — so this always reaches the
 * owner even though other notification types suppress self-notification.
 */
async function notifyAutomationOwner(
  automationId: string,
  ownerId: string,
  workspaceId: string | null,
  status: 'success' | 'failed',
  runId: string
): Promise<void> {
  try {
    const r = await query<{ name: string }>(`SELECT name FROM automations WHERE id = $1`, [automationId]);
    const name = r.rows[0]?.name ?? 'Automation';
    // A high-frequency trigger (e.g. task_completed on a busy list) would flood
    // the owner's feed with success pings. Coalesce successes to at most one per
    // automation per hour via a dedupe key; always surface failures individually.
    const dedupeKey = status === 'failed'
      ? null
      : `autorun:${automationId}:success:${new Date().toISOString().slice(0, 13)}`;
    await createNotification({
      userId: ownerId,
      type: 'automation_run',
      actorId: null,
      title: status === 'failed' ? `Automation "${name}" failed` : `Automation "${name}" ran`,
      body: null,
      entityType: 'automation',
      entityId: automationId,
      workspaceId,
      data: { automationName: name, status, runId },
      dedupeKey,
    });
  } catch (err) {
    aerr('notifyAutomationOwner failed', automationId, err);
  }
}

export type MutationActor =
  | { type: 'user'; userId: string }
  | { type: 'automation'; automationId: string; runId: string };

export type TriggerTypeId = 'task_completed' | 'list_all_completed' | 'task_created' | 'schedule';

export interface AutomationRow {
  id: string;
  workspace_id: string;
  user_id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  graph: AutomationGraph;
  trigger_type: string;
  trigger_scope: Record<string, unknown>;
  next_fire_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface RunStep {
  nodeId: string;
  actionType: string;
  ok: boolean;
  summary: string;
  error?: string;
  output?: unknown;
}

export interface RunResult {
  runId: string;
  status: 'success' | 'failed';
  steps: RunStep[];
  error: string | null;
}

const CODE_SKIP_KEYS = new Set(['code']);
const MAX_STORED_OUTPUT_CHARS = 50_000;

function alog(...args: unknown[]): void {
  console.log('⚡', ...args);
}
function aerr(...args: unknown[]): void {
  console.error('⚡ ✗', ...args);
}

export function scopeMatches(type: TriggerTypeId, scope: Record<string, unknown>, ctx: TriggerContext): boolean {
  if (type === 'task_completed' || type === 'task_created') {
    const listId = scope.listId;
    return !listId || listId === ctx.list?.id;
  }
  if (type === 'list_all_completed') {
    return scope.listId === ctx.list?.id;
  }
  return false; // 'schedule' is fired by the sweep directly, never via fireTrigger
}

/**
 * Called from the extracted list-task mutation functions in routes/lists.ts.
 * A no-op for any non-'user' actor — see file header. Errors are swallowed
 * (logged only): a broken automation lookup must never break the mutation
 * that triggered it.
 */
export async function fireTrigger(type: TriggerTypeId, ctx: TriggerContext, actor: MutationActor): Promise<void> {
  if (actor.type !== 'user') return;
  try {
    const rows = await query<AutomationRow>(
      `SELECT * FROM automations WHERE workspace_id = $1 AND trigger_type = $2 AND enabled = true`,
      [ctx.workspaceId, type]
    );
    const matching = rows.rows.filter((a) => scopeMatches(type, a.trigger_scope ?? {}, ctx));
    for (const automation of matching) {
      void runAutomation(automation, type, ctx).catch((err) => aerr('unexpected runAutomation rejection', automation.id, err));
    }
  } catch (err) {
    aerr('fireTrigger lookup failed', type, ctx.workspaceId, err);
  }
}

/**
 * Opens a fresh, self-contained transaction for one action's own dependent
 * writes. An action reports failure by RETURNING `{ok: false}`, not by
 * throwing — a plain return would otherwise let db.ts's withTransaction
 * commit whatever was already written before the failure was noticed, so a
 * failed result is turned into a thrown ActionRollbackSignal (forcing
 * ROLLBACK) and unwrapped back into the original result afterwards.
 */
async function runActionTransaction<T>(fn: (exec: QueryExec) => Promise<T>): Promise<T> {
  try {
    return await withTransaction(async (client) => {
      const exec: QueryExec = (text, params) => client.query(text, params);
      const result = await fn(exec);
      if (result && typeof result === 'object' && 'ok' in (result as object) && (result as unknown as { ok: unknown }).ok === false) {
        throw new ActionRollbackSignal(result as unknown as ActionResult);
      }
      return result;
    });
  } catch (err) {
    if (err instanceof ActionRollbackSignal) return err.result as unknown as T;
    throw err;
  }
}

function truncateStepForStorage(step: RunStep): RunStep {
  if (step.output === undefined) return step;
  let json: string;
  try {
    json = JSON.stringify(step.output);
  } catch {
    return { ...step, output: undefined };
  }
  if (json === undefined || json.length <= MAX_STORED_OUTPUT_CHARS) return step;
  return { ...step, output: { truncated: true, preview: json.slice(0, MAX_STORED_OUTPUT_CHARS) } };
}

async function recordRunOutcome(runId: string, status: 'success' | 'failed', steps: RunStep[], error: string | null): Promise<void> {
  try {
    await query(
      `UPDATE automation_runs SET status = $1, steps = $2, error = $3, finished_at = NOW() WHERE id = $4`,
      [status, JSON.stringify(steps.map(truncateStepForStorage)), error, runId]
    );
  } catch (err) {
    aerr('failed to record automation_runs outcome', runId, err);
  }
}

/**
 * Executes one automation's action chain for a single trigger event. Never
 * throws — every failure path is recorded on the automation_runs row instead,
 * so this is safe to call fire-and-forget (fireTrigger) or awaited in a loop
 * (the schedule sweep) or awaited directly for its result (the manual
 * per-node test endpoint, `is_test=true`, which builds its own truncated
 * `graph` — only `id`/`workspace_id`/`user_id`/`graph` are ever read here).
 */
export async function runAutomation(
  automation: Pick<AutomationRow, 'id' | 'workspace_id' | 'user_id' | 'graph'>,
  triggerType: string,
  ctx: TriggerContext,
  options: { isTest?: boolean; deadlineMs?: number } = {}
): Promise<RunResult> {
  const runId = `run_${uuidv4()}`;
  const isTest = options.isTest ?? false;
  // B7: injectable so a test can exercise deadline-exceeded behavior in
  // milliseconds instead of waiting out the real (60s) default — see B1's
  // "testbare Clock-Schnittstellen" principle. Production call sites never
  // pass this, so they get the real configured budget.
  const deadlineMs = options.deadlineMs ?? AUTOMATION_RUN_DEADLINE_MS;

  // B7: acquire a concurrency slot BEFORE creating the run row — a run that
  // never gets to execute at all shouldn't occupy a slot, and a rejection
  // here still needs to be visible (logged + a failed run row), not a
  // silent drop, so an operator can see WHY an automation didn't fire.
  const slot = tryAcquireRunSlot(automation.workspace_id);
  if (!slot.ok) {
    aerr(`run ✗ automation=${automation.id} trigger=${triggerType}: ${slot.reason}`);
    try {
      await query(
        `INSERT INTO automation_runs (id, automation_id, workspace_id, trigger_type, trigger_context, is_test, status, error, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'failed', $7, NOW())`,
        [runId, automation.id, automation.workspace_id, triggerType, JSON.stringify(ctx), isTest, slot.reason]
      );
    } catch (err) {
      aerr('failed to create rejected automation_runs row', automation.id, err);
    }
    return { runId, status: 'failed', steps: [], error: slot.reason };
  }

  try {
    try {
      await query(
        `INSERT INTO automation_runs (id, automation_id, workspace_id, trigger_type, trigger_context, is_test) VALUES ($1, $2, $3, $4, $5, $6)`,
        [runId, automation.id, automation.workspace_id, triggerType, JSON.stringify(ctx), isTest]
      );
    } catch (err) {
      aerr('failed to create automation_runs row', automation.id, err);
      return { runId, status: 'failed', steps: [], error: 'Failed to create the run record' };
    }

    const steps: RunStep[] = [];

    const normalized = normalizeAutomationGraph(automation.graph);
    if (!normalized.ok) {
      aerr(`run ✗ automation=${automation.id} trigger=${triggerType}: invalid graph:`, normalized.error);
      await recordRunOutcome(runId, 'failed', steps, normalized.error);
      return { runId, status: 'failed', steps, error: normalized.error };
    }

    const triggerNode = normalized.value.graph.nodes.find((n) => n.kind === 'trigger')!;
    const actionNodes = orderedActionNodes(normalized.value.graph, normalized.value.orderedActionIds);
    const actorTag: MutationActor = { type: 'automation', automationId: automation.id, runId };

    const nodeOutputs: Record<string, unknown> = { [triggerNode.id]: serializeTriggerOutput(triggerType, ctx) };
    const triggerDef = getTriggerDef(triggerNode.type);
    steps.push({
      nodeId: triggerNode.id,
      actionType: triggerNode.type,
      ok: true,
      summary: `Trigger: ${triggerDef?.label ?? triggerNode.type}`,
      output: nodeOutputs[triggerNode.id],
    });

    let previousNodeId = triggerNode.id;
    let failed = false;
    let errorMessage: string | null = null;
    // B7: overall wall-clock deadline for the WHOLE chain (not per-node) —
    // checked before each node runs, so a chain that's already past budget
    // never starts "just one more" action. Deterministic: the SAME elapsed
    // time always yields the SAME stop point for a given chain, unlike a
    // race-prone external kill signal.
    const runStartedAt = Date.now();

    for (const node of actionNodes) {
      if (Date.now() - runStartedAt > deadlineMs) {
        errorMessage = `automation exceeded its ${deadlineMs}ms run deadline before node "${node.id}"`;
        steps.push({ nodeId: node.id, actionType: node.type, ok: false, summary: errorMessage, error: errorMessage });
        failed = true;
        break;
      }
      const def = getActionDef(node.type);
      if (!def) {
        errorMessage = `unknown action type "${node.type}"`;
        steps.push({ nodeId: node.id, actionType: node.type, ok: false, summary: errorMessage, error: errorMessage });
        failed = true;
        break;
      }

      const scope = buildScope(nodeOutputs, triggerNode.id, previousNodeId);
      const resolvedParams = resolveExpressions(node.params, scope, node.type === 'code' ? CODE_SKIP_KEYS : undefined);

      let result: ActionResult;
      try {
        result = await def.execute(
          {
            exec: query,
            withTransaction: runActionTransaction,
            workspaceId: automation.workspace_id,
            automationId: automation.id,
            automationOwnerId: automation.user_id,
            runId,
            nodeId: node.id,
            actor: actorTag,
            trigger: ctx,
            scope,
          },
          resolvedParams
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = { ok: false, summary: message, error: message };
      }

      steps.push({ nodeId: node.id, actionType: node.type, ok: result.ok, summary: result.summary, error: result.error, output: result.output });

      if (!result.ok) {
        errorMessage = result.error ?? result.summary;
        failed = true;
        break;
      }
      nodeOutputs[node.id] = result.output;
      previousNodeId = node.id;
    }

    await recordRunOutcome(runId, failed ? 'failed' : 'success', steps, errorMessage);
    if (failed) {
      aerr(`run ✗ automation=${automation.id} trigger=${triggerType}:`, errorMessage);
    } else {
      alog(`run ✓ automation=${automation.id} trigger=${triggerType} steps=${steps.length}${isTest ? ' (test)' : ''}`);
    }

    // Notify the automation's owner that it ran — live runs only (a Test button
    // run from the editor is the owner watching it happen, so it self-suppresses).
    // Best-effort, never awaited by the mutation that fired the trigger.
    if (!isTest) {
      void notifyAutomationOwner(automation.id, automation.user_id, automation.workspace_id, failed ? 'failed' : 'success', runId);
    }

    return { runId, status: failed ? 'failed' : 'success', steps, error: failed ? errorMessage : null };
  } finally {
    // B7: ALWAYS release the concurrency slot, regardless of success,
    // failure, deadline-exceeded, or an unexpected throw — an unreleased
    // slot would permanently shrink this workspace's (and the global)
    // budget for every future run.
    releaseRunSlot(automation.workspace_id);
  }
}

// ---------------------------------------------------------------------------
// Schedule trigger — not mutation-driven, so it never goes through
// fireTrigger/MutationActor. A periodic sweep (registered in index.ts's
// start(), same pattern as the existing AI-file-purge cron) fires anything
// due and reschedules it.
// ---------------------------------------------------------------------------

export function computeNextFireAt(scope: Record<string, unknown>, from: Date = new Date()): Date {
  const freq = scope.freq === 'weekly' ? 'weekly' : 'daily';
  const time = typeof scope.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(scope.time) ? scope.time : '09:00';
  const [hh, mm] = time.split(':').map((x) => parseInt(x, 10));

  const next = new Date(from.getTime());
  next.setSeconds(0, 0);
  next.setHours(hh, mm, 0, 0);

  if (freq === 'daily') {
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
    return next;
  }

  const dow = typeof scope.dayOfWeek === 'number' && scope.dayOfWeek >= 0 && scope.dayOfWeek <= 6 ? scope.dayOfWeek : 0;
  while (next.getDay() !== dow || next.getTime() <= from.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

// B3 (Phase 2): how long a claimed schedule-trigger automation's lease is
// held. Must comfortably exceed AUTOMATION_RUN_DEADLINE_MS (the run's own
// wall-clock budget, B7) plus room for the reschedule UPDATE — if a worker
// crashes mid-run, ANY worker's next sweep tick reclaims it once this
// elapses, rather than the automation silently never firing again.
const SCHEDULE_LEASE_DURATION_MS = AUTOMATION_RUN_DEADLINE_MS + 30_000;
const SCHEDULE_SWEEP_BATCH_SIZE = 50;

// B8 — the automation id (if any) THIS process is actively running through
// runAutomation() at this exact moment, within sweepScheduledAutomations()'s
// own sequential loop below. `null` whenever nothing is in flight. Read by
// `releaseUnstartedScheduleLeases()` (shutdown.ts's drain sequence) so a
// graceful shutdown can immediately release every OTHER lease this process
// is still holding from a partially-worked claimed batch — see that
// function's own doc comment and jobLease.ts's `releaseOwnedLeases()` for
// the full "why this is safe" reasoning. A plain module-level variable is
// sufficient (not a Set) because the loop below is strictly sequential —
// this process never has more than one schedule-triggered automation
// in flight at once.
let currentlyExecutingScheduleAutomationId: string | null = null;

/**
 * B8 — releases the lease on every `automations` row THIS process currently
 * holds via the schedule sweep, EXCEPT whichever one (if any) is actively
 * mid-`runAutomation()` right now. Safe to call at any time, including when
 * nothing is claimed (a no-op). See jobLease.ts's `releaseOwnedLeases()` for
 * why excluding the in-flight one is essential, not optional.
 */
export async function releaseUnstartedScheduleLeases(): Promise<number> {
  const exclude = currentlyExecutingScheduleAutomationId ? [currentlyExecutingScheduleAutomationId] : [];
  return releaseOwnedLeases('automations', WORKER_ID, exclude);
}

export async function sweepScheduledAutomations(): Promise<void> {
  try {
    // B3: atomic claim via the shared FOR UPDATE SKIP LOCKED primitive —
    // BEFORE this, the sweep did a bare, unlocked SELECT: two worker
    // processes (or two overlapping sweep ticks) racing the same due
    // automation could BOTH see it as due and BOTH fire it. The claim
    // itself IS the lock acquisition, so a concurrent sweep's own claim
    // attempt against the SAME row is guaranteed to return a disjoint set
    // (see jobLease.ts).
    const claimed = await claimDueRows<AutomationRow>({
      table: 'automations',
      dueWhereSql: `trigger_type = 'schedule' AND enabled = true AND next_fire_at <= NOW()`,
      dueParams: [],
      leaseDurationMs: SCHEDULE_LEASE_DURATION_MS,
      limit: SCHEDULE_SWEEP_BATCH_SIZE,
      leaseOwnerId: WORKER_ID,
    });
    for (const automation of claimed) {
      // Each claimed automation is handled independently — one throwing
      // (an unexpected error from runAutomation, or the reschedule UPDATE
      // failing) must not stop the rest of this batch from firing. An
      // automation left un-rescheduled here simply stays claimed until its
      // lease expires, then gets picked up again by a later sweep — see
      // the crash-recovery note on SCHEDULE_LEASE_DURATION_MS above.
      currentlyExecutingScheduleAutomationId = automation.id;
      try {
        await runAutomation(automation, 'schedule', { workspaceId: automation.workspace_id });
        const next = computeNextFireAt(automation.trigger_scope ?? {});
        // Reschedule AND release the lease in the same statement — a
        // narrower window than a separate release call, and correct either
        // way since the WHERE clause always re-checks lease freshness on
        // the next claim regardless.
        await query(
          `UPDATE automations SET next_fire_at = $1, lease_owner = NULL, lease_expires_at = NULL WHERE id = $2`,
          [next.toISOString(), automation.id]
        );
      } catch (err) {
        aerr('sweepScheduledAutomations: failed to fire/reschedule automation', automation.id, err);
      } finally {
        currentlyExecutingScheduleAutomationId = null;
      }
    }
  } catch (err) {
    aerr('sweepScheduledAutomations error', err);
  }
}
