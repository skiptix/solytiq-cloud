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
// A run's entire action chain executes inside one transaction (all-or-
// nothing) and is never awaited by the request that caused it — a user
// checking a task must not have their click latency depend on how many
// automations fire. Downstream effects reach other clients the normal way,
// via the DB-trigger → sync_log → SSE pipeline every other mutation uses.
// ---------------------------------------------------------------------------

import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from './db';
import { QueryExec } from './workspaceUtil';
import { getActionDef, TriggerContext } from './automationTypes';
import { normalizeAutomationGraph, orderedActionNodes, AutomationGraph } from './automationGraph';

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

interface RunStep {
  nodeId: string;
  actionType: string;
  ok: boolean;
  summary: string;
  error?: string;
}

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
 * Executes one automation's action chain for a single trigger event. Never
 * throws — every failure path is recorded on the automation_runs row instead,
 * so this is safe to call fire-and-forget (fireTrigger) or awaited in a loop
 * (the schedule sweep).
 */
export async function runAutomation(automation: AutomationRow, triggerType: string, ctx: TriggerContext): Promise<void> {
  const runId = `run_${uuidv4()}`;

  try {
    await query(
      `INSERT INTO automation_runs (id, automation_id, workspace_id, trigger_type, trigger_context) VALUES ($1, $2, $3, $4, $5)`,
      [runId, automation.id, automation.workspace_id, triggerType, JSON.stringify(ctx)]
    );
  } catch (err) {
    aerr('failed to create automation_runs row', automation.id, err);
    return;
  }

  const steps: RunStep[] = [];
  try {
    const normalized = normalizeAutomationGraph(automation.graph);
    if (!normalized.ok) throw new Error(normalized.error);
    const actionNodes = orderedActionNodes(normalized.value.graph, normalized.value.orderedActionIds);
    const actorTag: MutationActor = { type: 'automation', automationId: automation.id, runId };

    await withTransaction(async (client) => {
      const exec: QueryExec = (text, params) => client.query(text, params);
      for (const node of actionNodes) {
        const def = getActionDef(node.type);
        if (!def) throw new Error(`unknown action type "${node.type}"`);
        const result = await def.execute(
          {
            exec,
            workspaceId: automation.workspace_id,
            automationId: automation.id,
            automationOwnerId: automation.user_id,
            runId,
            actor: actorTag,
            trigger: ctx,
          },
          node.params
        );
        steps.push({ nodeId: node.id, actionType: node.type, ok: result.ok, summary: result.summary, error: result.error });
        if (!result.ok) throw new Error(result.error ?? `action "${node.type}" failed`);
      }
    });

    await query(`UPDATE automation_runs SET status = 'success', steps = $1, finished_at = NOW() WHERE id = $2`, [JSON.stringify(steps), runId]);
    alog(`run ✓ automation=${automation.id} trigger=${triggerType} steps=${steps.length}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    aerr(`run ✗ automation=${automation.id} trigger=${triggerType}:`, message);
    try {
      await query(`UPDATE automation_runs SET status = 'failed', steps = $1, error = $2, finished_at = NOW() WHERE id = $3`, [JSON.stringify(steps), message, runId]);
    } catch (err2) {
      aerr('failed to record automation_runs failure', automation.id, err2);
    }
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
