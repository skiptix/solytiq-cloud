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
import { checkVersionConflict } from '../concurrency';
import { normalizeAutomationGraph, assertGraphListsInWorkspace } from '../automationGraph';
import { getAutomationNodeTypeDefs } from '../automationTypes';
import { computeNextFireAt } from '../automationEngine';

const router = Router();
router.use(authenticate);
router.use(requireAppInstalled('automations'));

// ---------------------------------------------------------------------------
// Row type + sanitizer
// ---------------------------------------------------------------------------

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
// Notifications (the `notify` action's inbox) — always scoped to the
// requester's own rows. Registered before the /:id routes below: /:id is a
// single-segment param pattern that would otherwise swallow a literal
// /notifications request (Express matches in registration order).
// ---------------------------------------------------------------------------

router.get('/notifications', async (req: Request, res: Response) => {
  try {
    const unreadOnly = req.query.unreadOnly === 'true';
    const result = await query(
      `SELECT id, automation_id, run_id, message, read_at, created_at
       FROM automation_notifications
       WHERE user_id = $1 ${unreadOnly ? 'AND read_at IS NULL' : ''}
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.userId]
    );
    res.json({
      notifications: result.rows.map((r: any) => ({
        id: r.id,
        automationId: r.automation_id,
        runId: r.run_id,
        message: r.message,
        readAt: r.read_at,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    werr('automations GET notifications error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/notifications/read-all', async (req: Request, res: Response) => {
  try {
    await query(`UPDATE automation_notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`, [req.userId]);
    res.json({ success: true });
  } catch (err) {
    werr('automations PUT notifications read-all error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/notifications/:id/read', async (req: Request, res: Response) => {
  try {
    const result = await query(
      `UPDATE automation_notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.id, req.userId]
    );
    if (result.rowCount === 0) { res.status(404).json({ error: 'Notification not found' }); return; }
    res.json({ success: true });
  } catch (err) {
    werr('automations PUT notification read error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/automations?workspaceId= — every automation in a workspace the
// user can access (owner or not — visible read-only to the whole workspace).
// ---------------------------------------------------------------------------

router.get('/', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) { res.status(400).json({ error: 'workspaceId is required' }); return; }
    if (!(await userCanAccessWorkspace(req.userId!, workspaceId))) {
      res.json({ automations: [] });
      return;
    }
    const result = await query<AutomationRow>(
      `SELECT a.*, u.full_name AS owner_name, u.username AS owner_username
       FROM automations a JOIN users u ON a.user_id = u.id
       WHERE a.workspace_id = $1
       ORDER BY a.updated_at DESC`,
      [workspaceId]
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
      `SELECT id, trigger_type, status, steps, error, started_at, finished_at
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
// POST /api/automations — create (any workspace member; graph validated,
// including that every referenced list belongs to this same workspace).
// ---------------------------------------------------------------------------

router.post('/', async (req: Request, res: Response) => {
  try {
    const { workspaceId, name, description, graph } = req.body as {
      workspaceId?: string;
      name?: string;
      description?: string;
      graph?: unknown;
    };

    if (!workspaceId) { res.status(400).json({ error: 'workspaceId is required' }); return; }
    if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }
    if (!(await userCanAccessWorkspace(req.userId!, workspaceId))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    const normalized = normalizeAutomationGraph(graph);
    if (!normalized.ok) { res.status(400).json({ error: normalized.error }); return; }
    const listError = await assertGraphListsInWorkspace(query, normalized.value.graph, workspaceId);
    if (listError) { res.status(400).json({ error: listError }); return; }

    const id = `automation_${uuidv4()}`;
    const nextFireAt = normalized.value.triggerType === 'schedule'
      ? computeNextFireAt(normalized.value.triggerScope)
      : null;

    const result = await query<AutomationRow>(
      `INSERT INTO automations (id, workspace_id, user_id, name, description, graph, trigger_type, trigger_scope, next_fire_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        id, workspaceId, req.userId, name.trim(), description?.trim() || null,
        JSON.stringify(normalized.value.graph), normalized.value.triggerType,
        JSON.stringify(normalized.value.triggerScope), nextFireAt ? nextFireAt.toISOString() : null,
      ]
    );

    wlog(`automation CREATE ✓ id=${id} workspace=${workspaceId} owner=${req.userId} trigger=${normalized.value.triggerType}`);
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

    const { name, description, graph, expectedVersion } = req.body as {
      name?: string;
      description?: string | null;
      graph?: unknown;
      expectedVersion?: number;
    };

    const conflict = await checkVersionConflict('automations', id, expectedVersion);
    if (conflict !== null) { res.status(409).json({ error: 'Version conflict', currentVersion: conflict }); return; }

    let graphSql = '';
    const params: unknown[] = [];
    if (graph !== undefined) {
      const normalized = normalizeAutomationGraph(graph);
      if (!normalized.ok) { res.status(400).json({ error: normalized.error }); return; }
      const listError = await assertGraphListsInWorkspace(query, normalized.value.graph, workspaceId);
      if (listError) { res.status(400).json({ error: listError }); return; }

      const nextFireAt = normalized.value.triggerType === 'schedule' ? computeNextFireAt(normalized.value.triggerScope) : null;
      params.push(JSON.stringify(normalized.value.graph), normalized.value.triggerType, JSON.stringify(normalized.value.triggerScope), nextFireAt ? nextFireAt.toISOString() : null);
      graphSql = `graph = $${params.length - 3}, trigger_type = $${params.length - 2}, trigger_scope = $${params.length - 1}, next_fire_at = $${params.length},`;
    }

    params.push(name?.trim() || null, 'description' in req.body, description ?? null, id);
    const result = await query<AutomationRow>(
      `UPDATE automations
       SET ${graphSql}
           name        = COALESCE($${params.length - 3}, name),
           description = CASE WHEN $${params.length - 2} THEN $${params.length - 1} ELSE description END,
           updated_at  = NOW()
       WHERE id = $${params.length}
       RETURNING *`,
      params
    );

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
