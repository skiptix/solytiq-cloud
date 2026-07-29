// ---------------------------------------------------------------------------
// Agent Runtime — the actual execution loop. Reuses the SAME shared AI tool
// registry (aiTools.ts) the internal "Sol" assistant and the MCP server use —
// no separate tool surface for the agent — wrapped with policy enforcement
// (graph/agent/policy.ts), mutation logging for revert (agent/inverse.ts),
// and human-approval gating (agent_proposals).
//
// A run is fire-and-forget from the caller's perspective (routes/agent.ts
// inserts the `agent_runs` row and returns its id immediately; the loop below
// runs in the background and updates that row as it goes) — the same
// `void ...catch()` pattern automationEngine.ts's runAutomation() uses, for
// the same reason: an HTTP request shouldn't block on a multi-turn LLM loop.
// ---------------------------------------------------------------------------

import { v4 as uuidv4 } from 'uuid';
import { query } from '../db';
import { executeAiTool, getOpenRouterToolDefs } from '../aiTools';
import { createNotification, createNotifications } from '../notifications';
import {
  parseAgentPolicy, canUseTool, needsApproval, exceedsRunLimits,
  DEFAULT_AGENT_POLICY, type AgentMode, type AgentPolicy,
} from './policy';
import { snapshotBeforeToolCall, buildMutationRecord, type MutationRecord } from './inverse';

export interface AgentRunStep {
  nodeType: 'trigger' | 'tool';
  toolName?: string;
  args?: Record<string, unknown>;
  status: 'ok' | 'error' | 'proposed' | 'denied';
  output?: unknown;
  error?: string;
  durationMs?: number;
}

export interface StartAgentRunInput {
  workspaceId: string;
  userId: string;
  goal: string;
  triggerType: string;
  triggerContext?: Record<string, unknown>;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

const MAX_STEP_OUTPUT_CHARS = 4000;
const MAX_TURNS_HARD_CAP = 30; // absolute ceiling regardless of policy — never an infinite loop even on a misconfigured policy

function truncate(text: string): string {
  return text.length > MAX_STEP_OUTPUT_CHARS ? `${text.slice(0, MAX_STEP_OUTPUT_CHARS)}…[truncated]` : text;
}

function buildSystemPrompt(goal: string, triggerContext: Record<string, unknown> | undefined): string {
  return [
    'You are an autonomous workspace agent inside Solytiq Cloud, a task/project management app.',
    'You act on behalf of the user who owns this run, using only the tools provided — never claim to have done something you did not call a tool for.',
    'Some tool calls may be queued for human approval instead of executed immediately; if a tool result says so, treat that action as NOT YET DONE.',
    'Be concise. Once the goal is accomplished (or you determine it cannot be), stop calling tools and reply with a short summary of what you did.',
    triggerContext && Object.keys(triggerContext).length ? `Trigger context: ${JSON.stringify(triggerContext)}` : '',
    `Goal: ${goal}`,
  ].filter(Boolean).join('\n\n');
}

async function callOpenRouter(
  messages: ChatMessage[],
  tools: unknown[],
  model: string,
  apiKey: string
): Promise<{ message: ChatMessage; promptTokens: number; completionTokens: number }> {
  const abortCtrl = new AbortController();
  const timeoutId = setTimeout(() => abortCtrl.abort(), 60_000);
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.FRONTEND_URL ?? 'http://localhost',
        'X-Title': 'Solytiq Cloud Agent',
      },
      body: JSON.stringify({ model, messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }),
      signal: abortCtrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => `HTTP ${res.status}`);
      throw new Error(`AI service error: ${text}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message: ChatMessage }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error('AI service returned no message');
    return { message, promptTokens: data.usage?.prompt_tokens ?? 0, completionTokens: data.usage?.completion_tokens ?? 0 };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function createProposal(runId: string, workspaceId: string, toolName: string, args: Record<string, unknown>): Promise<string> {
  const id = `agprop_${uuidv4()}`;
  await query(
    `INSERT INTO agent_proposals (id, run_id, workspace_id, tool_name, tool_args, status, expires_at, created_at)
     VALUES ($1,$2,$3,$4,$5,'pending', NOW() + INTERVAL '7 days', NOW())`,
    [id, runId, workspaceId, toolName, JSON.stringify(args)]
  );
  const members = await query<{ user_id: string }>(`SELECT user_id FROM workspace_members WHERE workspace_id = $1`, [workspaceId]);
  await createNotifications(members.rows.map((r) => r.user_id), {
    type: 'agent_proposal',
    title: `The agent wants to run "${toolName}" and needs your approval`,
    entityType: 'workspace',
    entityId: workspaceId,
    workspaceId,
    data: { proposalId: id, toolName },
  });
  return id;
}

async function recordMutation(runId: string, workspaceId: string, m: MutationRecord): Promise<void> {
  await query(
    `INSERT INTO agent_mutations (id, run_id, workspace_id, tool_name, entity_type, entity_id, before_state, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
    [`agmut_${uuidv4()}`, runId, workspaceId, m.toolName, m.entityType, m.entityId, m.beforeState ? JSON.stringify(m.beforeState) : null]
  );
}

async function fetchTaskInfo(taskId: string, exec: typeof query): Promise<{ title: string; listId: string | null } | null> {
  try {
    const r = await exec<{ title: string; list_id: string | null }>(`SELECT title, list_id FROM tasks WHERE id = $1`, [Number(taskId)]);
    const row = r.rows[0];
    return row ? { title: row.title, listId: row.list_id } : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort transparency notification: tell an item's creator — and, for
 * tasks, everyone tagged on it — that the agent just changed something they
 * own or care about. This is deliberately separate from `agent_run_complete`
 * (which only reaches the person who started the run): a task can belong to,
 * or be tagged with, someone other than whoever is directing the agent, and
 * an autonomous change to their item is exactly the kind of thing they'd want
 * surfaced. `createNotification`'s own actor===recipient guard means the
 * run's own owner is silently skipped when they're also the item's owner —
 * they already know, via the run itself.
 */
async function notifyMutationRecipients(
  m: MutationRecord, actorId: string, workspaceId: string, taggedUserIds: string[]
): Promise<void> {
  try {
    const recipients = new Set<string>(taggedUserIds);
    let title: string;
    let listId: string | null = null;

    if (m.beforeState && typeof m.beforeState.title === 'string') {
      // update_task / delete_task — the row (or its cascade-deleted task_tags)
      // may already be gone by now, so everything comes from the pre-capture.
      title = m.beforeState.title;
      if (typeof m.beforeState.user_id === 'string') recipients.add(m.beforeState.user_id);
      if (typeof m.beforeState.list_id === 'string') listId = m.beforeState.list_id;
    } else if (m.entityType === 'task') {
      // create_dashboard_task / create_task_in_list — the row still exists.
      const info = await fetchTaskInfo(m.entityId, query);
      if (!info) return;
      title = info.title;
      listId = info.listId;
      const ownerRes = await query<{ user_id: string }>(`SELECT user_id FROM tasks WHERE id = $1`, [Number(m.entityId)]);
      const ownerId = ownerRes.rows[0]?.user_id;
      if (ownerId) recipients.add(ownerId);
    } else {
      return; // only task mutations are tracked today — see REVERT_HANDLERS
    }

    if (recipients.size === 0) return;
    const verb = m.toolName.startsWith('create') ? 'created' : m.toolName.startsWith('delete') ? 'deleted' : 'updated';
    await createNotifications(recipients, {
      type: 'agent_change',
      actorId,
      title: `The agent ${verb} "${title}"`,
      entityType: m.entityType,
      entityId: m.entityId,
      workspaceId,
      data: { toolName: m.toolName, listId },
    });
  } catch (err) {
    console.error('🤖 ✗ notifyMutationRecipients failed:', err);
  }
}

/** Kick off a run. Returns immediately with the run's id — the loop itself runs in the background. */
export async function startAgentRun(input: StartAgentRunInput): Promise<{ runId: string; mode: AgentMode }> {
  const wsRes = await query<{ agent_mode: AgentMode; agent_policy: unknown }>(
    `SELECT agent_mode, agent_policy FROM workspaces WHERE id = $1`,
    [input.workspaceId]
  );
  const wsRow = wsRes.rows[0];
  if (!wsRow) throw new Error('Workspace not found');
  const mode = wsRow.agent_mode ?? 'off';
  if (mode === 'off') throw new Error('The agent is turned off for this workspace');
  const policy = parseAgentPolicy(wsRow.agent_policy);

  const runId = `agrun_${uuidv4()}`;
  await query(
    `INSERT INTO agent_runs (id, workspace_id, user_id, trigger_type, trigger_context, goal, mode, status, steps, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'running','[]',NOW())`,
    [runId, input.workspaceId, input.userId, input.triggerType, JSON.stringify(input.triggerContext ?? {}), input.goal, mode]
  );

  void executeRun(runId, input, mode, policy).catch((err) => {
    console.error('🤖 ✗ agent run crashed', runId, err);
  });

  return { runId, mode };
}

async function executeRun(runId: string, input: StartAgentRunInput, mode: AgentMode, policy: AgentPolicy): Promise<void> {
  const steps: AgentRunStep[] = [{ nodeType: 'trigger', status: 'ok', output: { triggerType: input.triggerType, goal: input.goal } }];
  let status: 'success' | 'failed' | 'blocked' = 'success';
  let errorMsg: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let model: string | null = null;

  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not configured');
    const settingsRes = await query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'ai_model'`);
    model = policy.model || settingsRes.rows[0]?.value || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

    const allowedDefs = getOpenRouterToolDefs().filter((d) => canUseTool(policy, d.function.name));
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(input.goal, input.triggerContext) },
      { role: 'user', content: input.goal },
    ];

    const maxToolCalls = policy.maxToolCallsPerRun ?? DEFAULT_AGENT_POLICY.maxToolCallsPerRun;
    let toolCalls = 0;
    let actions = 0;

    for (let turn = 0; turn < Math.min(maxToolCalls + 1, MAX_TURNS_HARD_CAP); turn++) {
      const { message, promptTokens: pt, completionTokens: ct } = await callOpenRouter(messages, allowedDefs, model, apiKey);
      promptTokens += pt;
      completionTokens += ct;
      messages.push(message);

      if (!message.tool_calls?.length) break; // the model is done

      for (const call of message.tool_calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* malformed model output — treated as empty args */ }

        if (exceedsRunLimits(policy, toolCalls, actions)) {
          steps.push({ nodeType: 'tool', toolName: call.function.name, args, status: 'denied', error: 'run limit reached' });
          messages.push({ role: 'tool', tool_call_id: call.id, content: 'This run has reached its action limit — the action was not executed.' });
          continue;
        }
        toolCalls++;

        if (!canUseTool(policy, call.function.name)) {
          steps.push({ nodeType: 'tool', toolName: call.function.name, args, status: 'denied', error: "not permitted by this workspace's agent policy" });
          messages.push({ role: 'tool', tool_call_id: call.id, content: "This tool is not permitted by the workspace's agent policy." });
          continue;
        }

        if (needsApproval(mode, policy, call.function.name, args)) {
          const proposalId = await createProposal(runId, input.workspaceId, call.function.name, args);
          steps.push({ nodeType: 'tool', toolName: call.function.name, args, status: 'proposed', output: { proposalId } });
          messages.push({ role: 'tool', tool_call_id: call.id, content: 'This action requires human approval and has been queued as a proposal — it was not executed yet.' });
          continue;
        }

        const started = Date.now();
        const before = await snapshotBeforeToolCall(call.function.name, args, input.userId, query);
        // update_task/delete_task cascade away (or simply move past) task_tags
        // by the time the tool returns, so anyone tagged has to be captured
        // now — used below by notifyMutationRecipients, not by revert.
        let taggedBefore: string[] = [];
        if (call.function.name === 'update_task' || call.function.name === 'delete_task') {
          const taskId = Number(args.task_id);
          if (Number.isFinite(taskId)) {
            const tagRes = await query<{ user_id: string }>(`SELECT user_id FROM task_tags WHERE task_id = $1`, [taskId]);
            taggedBefore = tagRes.rows.map((r) => r.user_id);
          }
        }
        const result = await executeAiTool(input.userId, call.function.name, args);
        const durationMs = Date.now() - started;
        actions++;

        if (result.ok) {
          const mutation = await buildMutationRecord(call.function.name, args, before, input.userId, query);
          if (mutation) {
            await recordMutation(runId, input.workspaceId, mutation);
            await notifyMutationRecipients(mutation, input.userId, input.workspaceId, taggedBefore);
          }
        }

        steps.push({
          nodeType: 'tool', toolName: call.function.name, args,
          status: result.ok ? 'ok' : 'error',
          output: result.ok ? truncate(result.result) : undefined,
          error: result.ok ? undefined : truncate(result.result),
          durationMs,
        });
        messages.push({ role: 'tool', tool_call_id: call.id, content: truncate(result.result) });
      }

      if (exceedsRunLimits(policy, toolCalls, actions)) { status = 'blocked'; break; }
    }
  } catch (err) {
    status = 'failed';
    errorMsg = err instanceof Error ? err.message : String(err);
  }

  await query(
    `UPDATE agent_runs SET status = $1, steps = $2, tokens_prompt = $3, tokens_completion = $4, model = $5, error = $6, finished_at = NOW() WHERE id = $7`,
    [status, JSON.stringify(steps), promptTokens, completionTokens, model, errorMsg, runId]
  );

  await createNotification({
    userId: input.userId,
    type: 'agent_run_complete',
    title: status === 'success' ? 'Your agent run finished' : status === 'blocked' ? 'Your agent run hit a policy limit' : 'Your agent run failed',
    body: errorMsg,
    entityType: 'workspace',
    entityId: input.workspaceId,
    workspaceId: input.workspaceId,
    data: { runId, status },
  });
}

/** Expire stale pending proposals (7-day TTL, set at creation) — registered on the same hourly cadence as the overdue-deadline sweep. */
export async function sweepExpiredProposals(): Promise<void> {
  try {
    const r = await query(`UPDATE agent_proposals SET status = 'expired' WHERE status = 'pending' AND expires_at < NOW()`);
    if (r.rowCount) console.log(`🤖 expired ${r.rowCount} stale agent proposal(s)`);
  } catch (err) {
    console.error('🤖 ✗ sweepExpiredProposals failed:', err);
  }
}
