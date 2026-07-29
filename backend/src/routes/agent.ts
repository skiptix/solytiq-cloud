// ---------------------------------------------------------------------------
// /api/agent — Agent Runtime runs + proposals. Workspace-scoped, mirroring
// the Automation Hub's permission model (routes/automations.ts): any
// workspace member can view runs/proposals and start an ad-hoc run; deciding
// a pending proposal is likewise open to any member (the whole point of
// 'suggest' mode is team oversight, not just the run's own owner).
// ---------------------------------------------------------------------------

import { Router, Request, Response } from 'express';
import { query } from '../db';
import { authenticate } from '../middleware';
import { werr, userCanAccessWorkspace } from '../workspaceUtil';
import { startAgentRun } from '../agent/runtime';
import { revertMutation, type MutationRecord } from '../agent/inverse';
import { executeAiTool } from '../aiTools';
import { createNotification } from '../notifications';

const router = Router();
router.use(authenticate);

export interface AgentRunRow {
  id: string; workspace_id: string; user_id: string; trigger_type: string; trigger_context: unknown;
  goal: string; mode: string; status: string; steps: unknown; tokens_prompt: number; tokens_completion: number;
  model: string | null; error: string | null; started_at: string; finished_at: string | null;
}
export function runJson(r: AgentRunRow) {
  return {
    id: r.id, workspaceId: r.workspace_id, userId: r.user_id, triggerType: r.trigger_type,
    triggerContext: r.trigger_context, goal: r.goal, mode: r.mode, status: r.status, steps: r.steps,
    tokensPrompt: r.tokens_prompt, tokensCompletion: r.tokens_completion, model: r.model, error: r.error,
    startedAt: r.started_at, finishedAt: r.finished_at,
  };
}

interface AgentProposalRow {
  id: string; run_id: string; workspace_id: string; tool_name: string; tool_args: unknown; rationale: string | null;
  preview: unknown; status: string; decided_by: string | null; decided_at: string | null; expires_at: string; created_at: string;
}
function proposalJson(r: AgentProposalRow) {
  return {
    id: r.id, runId: r.run_id, workspaceId: r.workspace_id, toolName: r.tool_name, toolArgs: r.tool_args,
    rationale: r.rationale, preview: r.preview, status: r.status, decidedBy: r.decided_by, decidedAt: r.decided_at,
    expiresAt: r.expires_at, createdAt: r.created_at,
  };
}

// GET /api/agent/runs?workspaceId=&status=
router.get('/runs', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) { res.status(400).json({ error: 'workspaceId is required' }); return; }
    if (!(await userCanAccessWorkspace(req.userId!, workspaceId))) { res.status(403).json({ error: 'Forbidden' }); return; }
    const status = req.query.status as string | undefined;
    const params: unknown[] = [workspaceId];
    let filter = '';
    if (status) { params.push(status); filter = ` AND status = $${params.length}`; }
    const r = await query<AgentRunRow>(
      `SELECT * FROM agent_runs WHERE workspace_id = $1 ${filter} ORDER BY started_at DESC LIMIT 100`,
      params
    );
    res.json({ runs: r.rows.map(runJson) });
  } catch (err) {
    werr('agent GET /runs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/agent/runs/:id
router.get('/runs/:id', async (req: Request, res: Response) => {
  try {
    const r = await query<AgentRunRow>(`SELECT * FROM agent_runs WHERE id = $1`, [req.params.id]);
    const row = r.rows[0];
    if (!row || !(await userCanAccessWorkspace(req.userId!, row.workspace_id))) { res.status(404).json({ error: 'Run not found' }); return; }
    res.json({ run: runJson(row) });
  } catch (err) {
    werr('agent GET /runs/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/agent/runs — start an ad-hoc run
router.post('/runs', async (req: Request, res: Response) => {
  try {
    const { workspaceId, goal, triggerType, context } = req.body as {
      workspaceId?: string; goal?: string; triggerType?: string; context?: Record<string, unknown>;
    };
    if (!workspaceId || !goal?.trim()) { res.status(400).json({ error: 'workspaceId and goal are required' }); return; }
    if (!(await userCanAccessWorkspace(req.userId!, workspaceId))) { res.status(403).json({ error: 'Forbidden' }); return; }

    const { runId } = await startAgentRun({
      workspaceId, userId: req.userId!, goal: goal.trim(), triggerType: triggerType ?? 'manual', triggerContext: context,
    });
    const r = await query<AgentRunRow>(`SELECT * FROM agent_runs WHERE id = $1`, [runId]);
    res.status(201).json({ run: runJson(r.rows[0]) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal server error';
    if (msg.includes('turned off') || msg.includes('not found')) { res.status(400).json({ error: msg }); return; }
    werr('agent POST /runs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/agent/runs/:id/cancel — best-effort: a run already mid-loop finishes its current tool call,
// but its next turn will see the row's status and stop. V1: this simply marks the row; the loop itself
// doesn't poll for cancellation mid-turn (a real preemption would need a cancellation token threaded
// through executeRun — accepted as a known limitation given the loop is already turn-bounded).
router.post('/runs/:id/cancel', async (req: Request, res: Response) => {
  try {
    const existing = await query<AgentRunRow>(`SELECT * FROM agent_runs WHERE id = $1`, [req.params.id]);
    const row = existing.rows[0];
    if (!row || !(await userCanAccessWorkspace(req.userId!, row.workspace_id))) { res.status(404).json({ error: 'Run not found' }); return; }
    if (row.status !== 'running') { res.status(409).json({ error: 'Run is not in progress' }); return; }
    const r = await query<AgentRunRow>(`UPDATE agent_runs SET status = 'cancelled', finished_at = NOW() WHERE id = $1 RETURNING *`, [req.params.id]);
    res.json({ run: runJson(r.rows[0]) });
  } catch (err) {
    werr('agent POST /runs/:id/cancel error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/agent/runs/:id/revert — best-effort undo of every TRACKED mutation from this run
// (see agent/inverse.ts — only a curated subset of tools are revertible). Returns how many
// succeeded/failed/were skipped as not-revertible, never a single all-or-nothing failure.
router.post('/runs/:id/revert', async (req: Request, res: Response) => {
  try {
    const runRes = await query<AgentRunRow>(`SELECT * FROM agent_runs WHERE id = $1`, [req.params.id]);
    const run = runRes.rows[0];
    if (!run || !(await userCanAccessWorkspace(req.userId!, run.workspace_id))) { res.status(404).json({ error: 'Run not found' }); return; }

    const mutRes = await query<{ id: string; tool_name: string; entity_type: string; entity_id: string; before_state: unknown; reverted: boolean }>(
      `SELECT id, tool_name, entity_type, entity_id, before_state, reverted FROM agent_mutations WHERE run_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    );

    let reverted = 0, failed = 0, skipped = 0;
    for (const m of mutRes.rows) {
      if (m.reverted) { skipped++; continue; }
      const record: MutationRecord = {
        toolName: m.tool_name, entityType: m.entity_type, entityId: m.entity_id,
        beforeState: (m.before_state as Record<string, unknown> | null) ?? null,
      };
      try {
        await revertMutation(record, run.user_id, query);
        await query(`UPDATE agent_mutations SET reverted = true WHERE id = $1`, [m.id]);
        reverted++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await query(`UPDATE agent_mutations SET revert_error = $1 WHERE id = $2`, [errMsg, m.id]);
        failed++;
      }
    }
    res.json({ reverted, failed, skipped });
  } catch (err) {
    werr('agent POST /runs/:id/revert error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/agent/proposals?workspaceId=&status=pending
router.get('/proposals', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) { res.status(400).json({ error: 'workspaceId is required' }); return; }
    if (!(await userCanAccessWorkspace(req.userId!, workspaceId))) { res.status(403).json({ error: 'Forbidden' }); return; }
    const status = (req.query.status as string | undefined) ?? 'pending';
    const r = await query<AgentProposalRow>(
      `SELECT * FROM agent_proposals WHERE workspace_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 100`,
      [workspaceId, status]
    );
    res.json({ proposals: r.rows.map(proposalJson) });
  } catch (err) {
    werr('agent GET /proposals error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function loadProposalForDecision(req: Request, res: Response): Promise<AgentProposalRow | null> {
  const r = await query<AgentProposalRow>(`SELECT * FROM agent_proposals WHERE id = $1`, [req.params.id]);
  const row = r.rows[0];
  if (!row || !(await userCanAccessWorkspace(req.userId!, row.workspace_id))) { res.status(404).json({ error: 'Proposal not found' }); return null; }
  if (row.status !== 'pending') { res.status(409).json({ error: `Proposal already ${row.status}` }); return null; }
  return row;
}

// POST /api/agent/proposals/:id/accept — runs the queued tool call now, as the ORIGINAL run's owner
// (never the approver — the approver is granting permission, not acting on the user's own behalf).
router.post('/proposals/:id/accept', async (req: Request, res: Response) => {
  try {
    const row = await loadProposalForDecision(req, res);
    if (!row) return;
    const runRes = await query<{ user_id: string }>(`SELECT user_id FROM agent_runs WHERE id = $1`, [row.run_id]);
    const actingUserId = runRes.rows[0]?.user_id ?? req.userId!;

    const result = await executeAiTool(actingUserId, row.tool_name, (row.tool_args as Record<string, unknown>) ?? {});
    const decided = await query<AgentProposalRow>(
      `UPDATE agent_proposals SET status = $1, decided_by = $2, decided_at = NOW() WHERE id = $3 RETURNING *`,
      [result.ok ? 'applied' : 'failed', req.userId!, req.params.id]
    );
    if (runRes.rows[0]) {
      await createNotification({
        userId: actingUserId, type: 'agent_proposal',
        title: result.ok ? 'Your agent proposal was approved and applied' : 'Your approved agent proposal failed to apply',
        body: result.result, entityType: 'workspace', entityId: row.workspace_id, workspaceId: row.workspace_id,
        data: { proposalId: row.id, toolName: row.tool_name },
      });
    }
    res.json({ proposal: proposalJson(decided.rows[0]), result: result.result });
  } catch (err) {
    werr('agent POST /proposals/:id/accept error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/agent/proposals/:id/reject
router.post('/proposals/:id/reject', async (req: Request, res: Response) => {
  try {
    const row = await loadProposalForDecision(req, res);
    if (!row) return;
    const { reason } = req.body as { reason?: string };
    const decided = await query<AgentProposalRow>(
      `UPDATE agent_proposals SET status = 'rejected', decided_by = $1, decided_at = NOW() WHERE id = $2 RETURNING *`,
      [req.userId!, req.params.id]
    );
    const runRes = await query<{ user_id: string }>(`SELECT user_id FROM agent_runs WHERE id = $1`, [row.run_id]);
    if (runRes.rows[0]) {
      await createNotification({
        userId: runRes.rows[0].user_id, type: 'agent_proposal',
        title: 'Your agent proposal was rejected',
        body: reason ?? null, entityType: 'workspace', entityId: row.workspace_id, workspaceId: row.workspace_id,
        data: { proposalId: row.id, toolName: row.tool_name },
      });
    }
    res.json({ proposal: proposalJson(decided.rows[0]) });
  } catch (err) {
    werr('agent POST /proposals/:id/reject error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
