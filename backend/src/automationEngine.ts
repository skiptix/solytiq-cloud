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
  options: { isTest?: boolean } = {}
): Promise<RunResult> {
  const runId = `run_${uuidv4()}`;
  const isTest = options.isTest ?? false;

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

  for (const node of actionNodes) {
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
  return { runId, status: failed ? 'failed' : 'success', steps, error: failed ? errorMessage : null };
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

export async function sweepScheduledAutomations(): Promise<void> {
  try {
    const due = await query<AutomationRow>(
      `SELECT * FROM automations WHERE trigger_type = 'schedule' AND enabled = true AND next_fire_at <= NOW()`
    );
    for (const automation of due.rows) {
      await runAutomation(automation, 'schedule', { workspaceId: automation.workspace_id });
      const next = computeNextFireAt(automation.trigger_scope ?? {});
      await query(`UPDATE automations SET next_fire_at = $1 WHERE id = $2`, [next.toISOString(), automation.id]);
    }
  } catch (err) {
    aerr('sweepScheduledAutomations error', err);
  }
}
