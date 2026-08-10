// ---------------------------------------------------------------------------
// /api/automations — Automation Hub CRUD + run history + notifications.
//
// Permission model: any workspace member can create their own automation;
// only the creator (or an admin) can rename/edit its graph/enable-disable/
// delete it; every workspace member can view it and its run history
// read-only. Gated behind the App Directory ('automations' must be
// installed) like gps/files/mcp.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db';
import { authenticate } from '../middleware';
import { broadcastToUser } from '../sse';
import { requireAppInstalled } from '../appsRegistry';
import { userCanAccessWorkspace, werr, wlog } from '../workspaceUtil';
import { versionGuardSql, resolveVersionedUpdateFailure } from '../concurrency';
import { normalizeAutomationGraph, assertGraphRefsInWorkspace, assertGraphWorkspaceRefsAccessible, type AutomationEdge } from '../automationGraph';
import { getAutomationNodeTypeDefs, type TriggerContext } from '../automationTypes';
import { computeNextFireAt, runAutomation } from '../automationEngine';

const router = Router();
router.use(authenticate);
router.use(requireAppInstalled('automations'));

// ---------------------------------------------------------------------------
// Row type + sanitizer
// ---------------------------------------------------------------------------

type OwnerEntityType = 'list' | 'timeline' | 'markdownList';
const OWNER_ENTITY_TABLES: Record<OwnerEntityType, string> = {
  list: 'lists',
  timeline: 'timelines',
  markdownList: 'markdown_lists',
};

interface AutomationRow {
  id: string;
  workspace_id: string;
  user_id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  graph: unknown;
  trigger_type: string;
  trigger_scope: Record<string, unknown>;
  owner_entity_type: OwnerEntityType | null;
  owner_entity_id: string | null;
  next_fire_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  owner_name?: string | null;
  owner_username?: string | null;
}

function sanitize(row: AutomationRow, requestingUserId: string) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerEntityType: row.owner_entity_type,
    ownerEntityId: row.owner_entity_id,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    graph: row.graph,
    triggerType: row.trigger_type,
    isOwner: row.user_id === requestingUserId,
    ownerId: row.user_id,
    ownerName: row.owner_name || row.owner_username || null,
    version: row.version,
    nextFireAt: row.next_fire_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Resolve the workspace a Board/Page/Timeline belongs to — the sole source
 *  of truth for which workspace a NEW automation is created in, replacing
 *  the old free-standing `workspaceId` request field. Returns null if the
 *  type is unrecognized or the entity doesn't exist (never guesses). */
async function resolveOwnerEntityWorkspace(type: unknown, id: unknown): Promise<string | null> {
  if (type !== 'list' && type !== 'timeline' && type !== 'markdownList') return null;
  if (typeof id !== 'string' || !id) return null;
  const table = OWNER_ENTITY_TABLES[type];
  const r = await query<{ workspace_id: string }>(`SELECT workspace_id FROM ${table} WHERE id = $1`, [id]);
  return r.rows[0]?.workspace_id ?? null;
}

async function loadAccessible(id: string, userId: string): Promise<AutomationRow | null> {
  const r = await query<AutomationRow>(
    `SELECT a.*, u.full_name AS owner_name, u.username AS owner_username
     FROM automations a JOIN users u ON a.user_id = u.id
     WHERE a.id = $1`,
    [id]
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  if (!(await userCanAccessWorkspace(userId, row.workspace_id))) return null;
  return row;
}

// ---------------------------------------------------------------------------
// GET /api/automations/node-types — static trigger/action catalog for the editor
// ---------------------------------------------------------------------------

router.get('/node-types', (_req: Request, res: Response) => {
  res.json(getAutomationNodeTypeDefs());
});

// ---------------------------------------------------------------------------
// GET /api/automations?ownerType=&ownerId= — every automation attached to one
// Board/Page/Timeline the user can access (owner or not — visible read-only
// to the whole workspace, per the model below). `?workspaceId=` alone is
// still accepted as a fallback for a pre-scoping automation with no owner
// entity (see the migration in index.ts) — there is no UI path to it anymore.
// ---------------------------------------------------------------------------

router.get('/', async (req: Request, res: Response) => {
  try {
    const ownerType = req.query.ownerType as string | undefined;
    const ownerId = req.query.ownerId as string | undefined;
    const workspaceIdParam = req.query.workspaceId as string | undefined;

    let workspaceId: string | null | undefined = workspaceIdParam;
    let ownerFilter = '';
    const params: unknown[] = [];
    if (ownerType && ownerId) {
      workspaceId = await resolveOwnerEntityWorkspace(ownerType, ownerId);
      if (!workspaceId) { res.status(404).json({ error: 'Owner entity not found' }); return; }
      params.push(ownerType, ownerId);
      ownerFilter = `AND a.owner_entity_type = $2 AND a.owner_entity_id = $3`;
    } else if (!workspaceId) {
      res.status(400).json({ error: 'ownerType+ownerId (or workspaceId) is required' });
      return;
    }

    if (!(await userCanAccessWorkspace(req.userId!, workspaceId))) {
      res.json({ automations: [] });
      return;
    }
    params.unshift(workspaceId);
    const result = await query<AutomationRow>(
      `SELECT a.*, u.full_name AS owner_name, u.username AS owner_username
       FROM automations a JOIN users u ON a.user_id = u.id
       WHERE a.workspace_id = $1 ${ownerFilter}
       ORDER BY a.updated_at DESC`,
      params
    );
    res.json({ automations: result.rows.map((r) => sanitize(r, req.userId!)) });
  } catch (err) {
    werr('automations GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/automations/:id
// ---------------------------------------------------------------------------

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const row = await loadAccessible(req.params.id, req.userId!);
    if (!row) { res.status(404).json({ error: 'Automation not found' }); return; }
    res.json({ automation: sanitize(row, req.userId!) });
  } catch (err) {
    werr('automations GET :id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/automations/:id/runs?limit=&before= — read-only run history
// ---------------------------------------------------------------------------

router.get('/:id/runs', async (req: Request, res: Response) => {
  try {
    const row = await loadAccessible(req.params.id, req.userId!);
    if (!row) { res.status(404).json({ error: 'Automation not found' }); return; }

    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '20', 10) || 20, 1), 100);
    const before = req.query.before as string | undefined;
    const params: unknown[] = [row.id];
    let beforeFilter = '';
    if (before) { params.push(before); beforeFilter = `AND started_at < $${params.length}`; }
    params.push(limit);

    const result = await query(
      `SELECT id, trigger_type, status, steps, error, is_test, started_at, finished_at
       FROM automation_runs
       WHERE automation_id = $1 ${beforeFilter}
       ORDER BY started_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json({
      runs: result.rows.map((r: any) => ({
        id: r.id,
        triggerType: r.trigger_type,
        status: r.status,
        steps: r.steps,
        error: r.error,
        isTest: r.is_test,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
      })),
    });
  } catch (err) {
    werr('automations GET runs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/automations/:id/test — creator or admin only. Runs the trigger
// (and, optionally, the action chain up to a given node) for REAL against
// real, auto-picked data: same engine, same permanent effects (e.g. an
// actual delete/rename), tagged is_test=true so Run History can label it.
// Node id omitted or equal to the trigger's own id → test just the trigger
// (zero actions run). Otherwise runs every action from the trigger through
// the given node, inclusive — lets you test incrementally while building.
// ---------------------------------------------------------------------------

router.post('/:id/test', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { nodeId } = req.body as { nodeId?: string };

    const existing = await query<{ user_id: string; workspace_id: string; graph: unknown; trigger_type: string; trigger_scope: Record<string, unknown> }>(
      'SELECT user_id, workspace_id, graph, trigger_type, trigger_scope FROM automations WHERE id = $1',
      [id]
    );
    if (existing.rows.length === 0) { res.status(404).json({ error: 'Automation not found' }); return; }
    const automation = existing.rows[0];
    if (automation.user_id !== req.userId && !req.user?.isAdmin) { res.status(403).json({ error: 'Permission denied' }); return; }

    const normalized = normalizeAutomationGraph(automation.graph);
    if (!normalized.ok) { res.status(400).json({ error: `Saved graph is invalid: ${normalized.error}` }); return; }
    const { graph, orderedActionIds, triggerType } = normalized.value;
    const triggerNode = graph.nodes.find((n) => n.kind === 'trigger')!;

    let includedActionIds: string[];
    if (!nodeId || nodeId === triggerNode.id) {
      includedActionIds = [];
    } else {
      const idx = orderedActionIds.indexOf(nodeId);
      if (idx === -1) { res.status(400).json({ error: 'Unknown node id' }); return; }
      includedActionIds = orderedActionIds.slice(0, idx + 1);
    }

    // Auto-pick real data to simulate the trigger event with.
    const scope = automation.trigger_scope ?? {};
    const scopedListId = typeof (scope as { listId?: unknown }).listId === 'string' ? (scope as { listId: string }).listId : undefined;
    let ctx: TriggerContext;
    if (triggerType === 'task_completed' || triggerType === 'task_created') {
      const rows = await query<{
        id: string; title: string; note: string | null; note_markdown: boolean; deadline: string | null;
        time_val: string | null; priority: string | null; badge: string | null; section_id: string | null;
        position: number; created_at: string; updated_at: string; list_id: string; checked: boolean; list_name: string;
      }>(
        scopedListId
          ? `SELECT t.id, t.title, t.note, t.note_markdown, t.deadline, t.time_val, t.priority, t.badge, t.section_id, t.position, t.created_at, t.updated_at, t.list_id, t.checked, l.name AS list_name FROM tasks t JOIN lists l ON t.list_id = l.id WHERE t.list_id = $1 AND t.source = 'list' ORDER BY t.updated_at DESC LIMIT 1`
          : `SELECT t.id, t.title, t.note, t.note_markdown, t.deadline, t.time_val, t.priority, t.badge, t.section_id, t.position, t.created_at, t.updated_at, t.list_id, t.checked, l.name AS list_name FROM tasks t JOIN lists l ON t.list_id = l.id WHERE l.workspace_id = $1 AND t.source = 'list' ORDER BY t.updated_at DESC LIMIT 1`,
        [scopedListId ?? automation.workspace_id]
      );
      if (rows.rows.length === 0) {
        res.status(400).json({ error: scopedListId ? 'No tasks found in the scoped list to test with — add a task first.' : 'No tasks found in this workspace to test with — add a task first.' });
        return;
      }
      const r = rows.rows[0];
      ctx = {
        workspaceId: automation.workspace_id,
        task: {
          id: String(r.id), title: r.title, listId: r.list_id, checked: triggerType === 'task_completed' ? true : r.checked,
          note: r.note, noteMarkdown: r.note_markdown ?? false, deadline: r.deadline, time: r.time_val,
          priority: r.priority, badge: r.badge, sectionId: r.section_id, position: r.position,
          createdAt: r.created_at, updatedAt: r.updated_at,
        },
        list: { id: r.list_id, name: r.list_name },
      };
    } else if (triggerType === 'list_all_completed') {
      if (!scopedListId) { res.status(400).json({ error: 'This automation has no list configured to test with.' }); return; }
      const listRows = await query<{ name: string }>('SELECT name FROM lists WHERE id = $1', [scopedListId]);
      if (listRows.rows.length === 0) { res.status(400).json({ error: 'The scoped list no longer exists.' }); return; }
      ctx = { workspaceId: automation.workspace_id, list: { id: scopedListId, name: listRows.rows[0].name } };
    } else {
      ctx = { workspaceId: automation.workspace_id };
    }

    const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
    const truncatedEdges: AutomationEdge[] = [];
    let prev = triggerNode.id;
    for (const aid of includedActionIds) {
      truncatedEdges.push({ id: `test_${prev}_${aid}`, source: prev, target: aid });
      prev = aid;
    }
    const truncatedGraph = {
      version: 1 as const,
      nodes: [triggerNode, ...includedActionIds.map((aid) => nodesById.get(aid)!)],
      edges: truncatedEdges,
    };

    const result = await runAutomation(
      { id, workspace_id: automation.workspace_id, user_id: automation.user_id, graph: truncatedGraph },
      triggerType,
      ctx,
      { isTest: true }
    );
    res.json({ result });
  } catch (err) {
    werr('automations POST test error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/automations — create, attached to one Board/Page/Timeline (any
// workspace member; graph validated, including that every referenced list
// belongs to this same workspace — unchanged from before this endpoint was
// re-scoped, so a "move to another list/workspace" action still validates
// and executes exactly as it always has, see automationGraph.ts).
// The automation's workspace is derived from the owner entity, not supplied
// independently — a client can no longer create an automation whose
// workspace_id disagrees with the Board/Page/Timeline it's attached to.
// ---------------------------------------------------------------------------

router.post('/', async (req: Request, res: Response) => {
  try {
    const { ownerEntityType, ownerEntityId, name, description, graph } = req.body as {
      ownerEntityType?: string;
      ownerEntityId?: string;
      name?: string;
      description?: string;
      graph?: unknown;
    };

    if (!ownerEntityType || !ownerEntityId) { res.status(400).json({ error: 'ownerEntityType and ownerEntityId are required' }); return; }
    if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }
    const workspaceId = await resolveOwnerEntityWorkspace(ownerEntityType, ownerEntityId);
    if (!workspaceId) { res.status(404).json({ error: 'Owner entity not found' }); return; }
    if (!(await userCanAccessWorkspace(req.userId!, workspaceId))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    const normalized = normalizeAutomationGraph(graph);
    if (!normalized.ok) { res.status(400).json({ error: normalized.error }); return; }
    const refError = await assertGraphRefsInWorkspace(query, normalized.value.graph, workspaceId);
    if (refError) { res.status(400).json({ error: refError }); return; }
    const wsRefError = await assertGraphWorkspaceRefsAccessible(normalized.value.graph, req.userId!, userCanAccessWorkspace);
    if (wsRefError) { res.status(400).json({ error: wsRefError }); return; }

    const id = `automation_${uuidv4()}`;
    const nextFireAt = normalized.value.triggerType === 'schedule'
      ? computeNextFireAt(normalized.value.triggerScope)
      : null;

    const result = await query<AutomationRow>(
      `INSERT INTO automations (id, workspace_id, user_id, name, description, graph, trigger_type, trigger_scope, owner_entity_type, owner_entity_id, next_fire_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        id, workspaceId, req.userId, name.trim(), description?.trim() || null,
        JSON.stringify(normalized.value.graph), normalized.value.triggerType,
        JSON.stringify(normalized.value.triggerScope), ownerEntityType, ownerEntityId,
        nextFireAt ? nextFireAt.toISOString() : null,
      ]
    );

    wlog(`automation CREATE ✓ id=${id} workspace=${workspaceId} owner=${req.userId} trigger=${normalized.value.triggerType} ownerEntity=${ownerEntityType}:${ownerEntityId}`);
    res.status(201).json({ automation: sanitize(result.rows[0], req.userId!) });
    broadcastToUser(req.userId!, 'automations');
  } catch (err) {
    werr('automations POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/automations/:id — rename/edit graph (creator or admin only)
// ---------------------------------------------------------------------------

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const existing = await query<{ user_id: string; workspace_id: string }>('SELECT user_id, workspace_id FROM automations WHERE id = $1', [id]);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'Automation not found' }); return; }
    const isOwner = existing.rows[0].user_id === req.userId;
    if (!isOwner && !req.user?.isAdmin) { res.status(403).json({ error: 'Permission denied' }); return; }
    const workspaceId = existing.rows[0].workspace_id;
    const creatorId = existing.rows[0].user_id;

    const { name, description, graph, expectedVersion } = req.body as {
      name?: string;
      description?: string | null;
      graph?: unknown;
      expectedVersion?: number;
    };

    // Optimistic concurrency (B4): folded into the UPDATE's own WHERE clause
    // below (versionGuardSql) instead of a standalone pre-check SELECT — see
    // concurrency.ts's header for why the old check-then-act pattern raced.
    let graphSql = '';
    const params: unknown[] = [];
    if (graph !== undefined) {
      const normalized = normalizeAutomationGraph(graph);
      if (!normalized.ok) { res.status(400).json({ error: normalized.error }); return; }
      const refError = await assertGraphRefsInWorkspace(query, normalized.value.graph, workspaceId);
      if (refError) { res.status(400).json({ error: refError }); return; }
      const wsRefError = await assertGraphWorkspaceRefsAccessible(normalized.value.graph, creatorId, userCanAccessWorkspace);
      if (wsRefError) { res.status(400).json({ error: wsRefError }); return; }

      const nextFireAt = normalized.value.triggerType === 'schedule' ? computeNextFireAt(normalized.value.triggerScope) : null;
      params.push(JSON.stringify(normalized.value.graph), normalized.value.triggerType, JSON.stringify(normalized.value.triggerScope), nextFireAt ? nextFireAt.toISOString() : null);
      graphSql = `graph = $${params.length - 3}, trigger_type = $${params.length - 2}, trigger_scope = $${params.length - 1}, next_fire_at = $${params.length},`;
    }

    params.push(name?.trim() || null, 'description' in req.body, description ?? null, id);
    const idParamIndex = params.length;
    const versionClause = versionGuardSql(params, expectedVersion);
    const result = await query<AutomationRow>(
      `UPDATE automations
       SET ${graphSql}
           name        = COALESCE($${idParamIndex - 3}, name),
           description = CASE WHEN $${idParamIndex - 2} THEN $${idParamIndex - 1} ELSE description END,
           updated_at  = NOW()
       WHERE id = $${idParamIndex}${versionClause}
       RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      const failure = await resolveVersionedUpdateFailure('automations', id);
      if (failure.notFound) { res.status(404).json({ error: 'Automation not found' }); return; }
      res.status(409).json({ error: 'Version conflict', currentVersion: failure.currentVersion }); return;
    }

    res.json({ automation: sanitize(result.rows[0], req.userId!) });
    broadcastToUser(req.userId!, 'automations');
  } catch (err) {
    werr('automations PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/automations/:id/enabled — creator or admin only
// ---------------------------------------------------------------------------

router.put('/:id/enabled', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') { res.status(400).json({ error: 'enabled must be a boolean' }); return; }

    const existing = await query<{ user_id: string }>('SELECT user_id FROM automations WHERE id = $1', [id]);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'Automation not found' }); return; }
    if (existing.rows[0].user_id !== req.userId && !req.user?.isAdmin) { res.status(403).json({ error: 'Permission denied' }); return; }

    const result = await query<AutomationRow>(
      `UPDATE automations SET enabled = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [enabled, id]
    );
    res.json({ automation: sanitize(result.rows[0], req.userId!) });
    broadcastToUser(req.userId!, 'automations');
  } catch (err) {
    werr('automations PUT enabled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/automations/:id — creator or admin only
// ---------------------------------------------------------------------------

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const existing = await query<{ user_id: string }>('SELECT user_id FROM automations WHERE id = $1', [id]);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'Automation not found' }); return; }
    if (existing.rows[0].user_id !== req.userId && !req.user?.isAdmin) { res.status(403).json({ error: 'Permission denied' }); return; }

    await query('DELETE FROM automations WHERE id = $1', [id]);
    res.json({ success: true });
    broadcastToUser(req.userId!, 'automations');
  } catch (err) {
    werr('automations DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
