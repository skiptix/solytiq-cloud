import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db';
import { authenticate } from '../middleware';
import { broadcastToUser } from '../sse';
import { resolveWorkspaceForUser, werr } from '../workspaceUtil';
import {
  captureListStructure,
  captureTimelineStructure,
  instantiateListStructure,
  instantiateTimelineStructure,
  makeTaskIdGenerator,
  normalizeTemplateListNode,
  normalizeTemplateTimelineNode,
  todayISODate,
  type TemplateListNode,
  type TemplateTimelineNode,
} from '../templateUtil';
import { getListForUser } from './lists';
import { getTimelineForUser } from './timelines';

const router = Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// Row type + sanitizer
// ---------------------------------------------------------------------------

interface TemplateRow {
  id: string;
  user_id: string;
  type: 'list' | 'timeline';
  name: string;
  description: string | null;
  emoji: string | null;
  color: string | null;
  color_bg: string | null;
  is_shared: boolean;
  structure: TemplateListNode | TemplateTimelineNode;
  created_at: string;
  updated_at: string;
  owner_name?: string | null;
  owner_username?: string | null;
}

function summarize(row: TemplateRow) {
  if (row.type === 'list') {
    const node = row.structure as TemplateListNode;
    const sections = node.sections ?? [];
    const taskCount = sections.reduce((n, s) => n + (s.tasks?.length ?? 0), 0);
    return { sectionCount: sections.length, taskCount };
  }
  const node = row.structure as TemplateTimelineNode;
  return { milestoneCount: (node.milestones ?? []).length };
}

function sanitize(row: TemplateRow, requestingUserId: string) {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    description: row.description,
    emoji: row.emoji,
    color: row.color,
    colorBg: row.color_bg,
    isShared: row.is_shared,
    isOwner: row.user_id === requestingUserId,
    ownerName: row.owner_name || row.owner_username || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    summary: summarize(row),
  };
}

// ---------------------------------------------------------------------------
// GET /api/templates?type=list|timeline — own templates + every shared
// (is_shared) template from any user of this instance.
// ---------------------------------------------------------------------------

router.get('/', async (req: Request, res: Response) => {
  try {
    const type = req.query.type as string | undefined;
    const params: unknown[] = [req.userId];
    let typeFilter = '';
    if (type === 'list' || type === 'timeline') {
      params.push(type);
      typeFilter = `AND t.type = $${params.length}`;
    }
    const result = await query<TemplateRow>(
      `SELECT t.*, u.full_name AS owner_name, u.username AS owner_username
       FROM templates t JOIN users u ON t.user_id = u.id
       WHERE (t.user_id = $1 OR t.is_shared = true)
       ${typeFilter}
       ORDER BY t.updated_at DESC`,
      params
    );
    res.json({ templates: result.rows.map((r) => sanitize(r, req.userId!)) });
  } catch (err) {
    werr('templates GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/templates — capture an existing list/timeline you own into a new
// template.
// ---------------------------------------------------------------------------

router.post('/', async (req: Request, res: Response) => {
  try {
    const { type, sourceId, name, description, isShared } = req.body as {
      type?: 'list' | 'timeline';
      sourceId?: string;
      name?: string;
      description?: string;
      isShared?: boolean;
    };

    if (type !== 'list' && type !== 'timeline') {
      res.status(400).json({ error: 'type must be "list" or "timeline"' });
      return;
    }
    if (!sourceId) {
      res.status(400).json({ error: 'sourceId is required' });
      return;
    }

    const today = todayISODate();
    let structure: TemplateListNode | TemplateTimelineNode;
    let templateName = name?.trim();

    if (type === 'list') {
      const own = await query<{ user_id: string; name: string }>('SELECT user_id, name FROM lists WHERE id = $1', [sourceId]);
      if (own.rows.length === 0) { res.status(404).json({ error: 'List not found' }); return; }
      if (own.rows[0].user_id !== req.userId) { res.status(403).json({ error: 'You can only save your own lists as templates' }); return; }
      structure = await captureListStructure(sourceId, req.userId!, today);
      if (!templateName) templateName = own.rows[0].name;
    } else {
      const own = await query<{ user_id: string; name: string }>('SELECT user_id, name FROM timelines WHERE id = $1', [sourceId]);
      if (own.rows.length === 0) { res.status(404).json({ error: 'Timeline not found' }); return; }
      if (own.rows[0].user_id !== req.userId) { res.status(403).json({ error: 'You can only save your own timelines as templates' }); return; }
      structure = await captureTimelineStructure(sourceId, req.userId!, today);
      if (!templateName) templateName = own.rows[0].name;
    }

    const templateId = `template_${uuidv4()}`;
    const result = await query<TemplateRow>(
      `INSERT INTO templates (id, user_id, type, name, description, emoji, color, color_bg, is_shared, structure)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        templateId, req.userId, type, templateName, description?.trim() || null,
        structure.emoji, structure.color, structure.colorBg, Boolean(isShared), JSON.stringify(structure),
      ]
    );

    res.status(201).json({ template: sanitize(result.rows[0], req.userId!) });
    broadcastToUser(req.userId!, 'template');
  } catch (err) {
    werr('templates POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/templates/:id — update metadata (owner or admin only). The
// captured structure itself is immutable — a template is a snapshot; save a
// new one to update its contents.
// ---------------------------------------------------------------------------

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, emoji, color, colorBg, isShared } = req.body as {
      name?: string;
      description?: string | null;
      emoji?: string | null;
      color?: string | null;
      colorBg?: string | null;
      isShared?: boolean;
    };

    const existing = await query<{ user_id: string }>('SELECT user_id FROM templates WHERE id = $1', [id]);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'Template not found' }); return; }
    const isOwner = existing.rows[0].user_id === req.userId;
    if (!isOwner && !req.user?.isAdmin) { res.status(403).json({ error: 'Permission denied' }); return; }

    const result = await query<TemplateRow>(
      `UPDATE templates
       SET name        = COALESCE($1, name),
           description = CASE WHEN $2 THEN $3 ELSE description END,
           emoji       = CASE WHEN $4 THEN $5 ELSE emoji END,
           color       = CASE WHEN $6 THEN $7 ELSE color END,
           color_bg    = CASE WHEN $8 THEN $9 ELSE color_bg END,
           is_shared   = COALESCE($10, is_shared),
           updated_at  = NOW()
       WHERE id = $11
       RETURNING *`,
      [
        name?.trim() || null,
        'description' in req.body, description ?? null,
        'emoji' in req.body, emoji ?? null,
        'color' in req.body, color ?? null,
        'colorBg' in req.body, colorBg ?? null,
        typeof isShared === 'boolean' ? isShared : null,
        id,
      ]
    );

    const row = { ...result.rows[0] } as TemplateRow;
    res.json({ template: sanitize(row, req.userId!) });
    broadcastToUser(req.userId!, 'template');
  } catch (err) {
    werr('templates PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/templates/:id/structure — the full captured tree, owner or admin
// only (unlike the gallery list, which only ever sends `summary` counts).
// Powers the structure editor.
// ---------------------------------------------------------------------------

router.get('/:id/structure', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const existing = await query<{ user_id: string; type: 'list' | 'timeline'; structure: TemplateListNode | TemplateTimelineNode }>(
      'SELECT user_id, type, structure FROM templates WHERE id = $1',
      [id]
    );
    if (existing.rows.length === 0) { res.status(404).json({ error: 'Template not found' }); return; }
    const row = existing.rows[0];
    const isOwner = row.user_id === req.userId;
    if (!isOwner && !req.user?.isAdmin) { res.status(404).json({ error: 'Template not found' }); return; }

    res.json({ type: row.type, structure: row.structure });
  } catch (err) {
    werr('templates GET structure error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/templates/:id/structure — replace the captured tree (owner or
// admin only). Structural edits: add/remove/reorder sections, tasks, and
// milestones, and edit their fields. The submitted tree is fully re-validated
// and re-normalized server-side rather than trusted as-is.
// ---------------------------------------------------------------------------

router.put('/:id/structure', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const existing = await query<{ user_id: string; type: 'list' | 'timeline' }>('SELECT user_id, type FROM templates WHERE id = $1', [id]);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'Template not found' }); return; }
    const isOwner = existing.rows[0].user_id === req.userId;
    if (!isOwner && !req.user?.isAdmin) { res.status(403).json({ error: 'Permission denied' }); return; }

    const { type } = existing.rows[0];
    const normalized = type === 'list'
      ? normalizeTemplateListNode(req.body?.structure)
      : normalizeTemplateTimelineNode(req.body?.structure);
    if (!normalized) { res.status(400).json({ error: 'Invalid structure' }); return; }

    const result = await query<TemplateRow>(
      `UPDATE templates SET structure = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [JSON.stringify(normalized), id]
    );

    res.json({ template: sanitize(result.rows[0], req.userId!) });
    broadcastToUser(req.userId!, 'template');
  } catch (err) {
    werr('templates PUT structure error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/templates/:id
// ---------------------------------------------------------------------------

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const existing = await query<{ user_id: string }>('SELECT user_id FROM templates WHERE id = $1', [id]);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'Template not found' }); return; }
    const isOwner = existing.rows[0].user_id === req.userId;
    if (!isOwner && !req.user?.isAdmin) { res.status(403).json({ error: 'Permission denied' }); return; }

    await query('DELETE FROM templates WHERE id = $1', [id]);
    res.json({ success: true });
    broadcastToUser(req.userId!, 'template');
  } catch (err) {
    werr('templates DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/templates/:id/use — materialize a new list/timeline from the
// template. Attachments only carry over when the requester is the template's
// owner (see templateUtil.ts).
// ---------------------------------------------------------------------------

router.post('/:id/use', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, isPublic, workspaceId, folderId } = req.body as {
      name?: string;
      isPublic?: boolean;
      workspaceId?: string;
      folderId?: string;
    };

    const tRes = await query<TemplateRow>('SELECT * FROM templates WHERE id = $1', [id]);
    if (tRes.rows.length === 0) { res.status(404).json({ error: 'Template not found' }); return; }
    const tpl = tRes.rows[0];
    // A private template you don't own doesn't exist as far as you're concerned.
    if (tpl.user_id !== req.userId && !tpl.is_shared) { res.status(404).json({ error: 'Template not found' }); return; }

    const resolvedWs = await resolveWorkspaceForUser(req.userId!, workspaceId);
    const allowAttachments = tpl.user_id === req.userId;
    const nextTaskId = makeTaskIdGenerator();
    const trimmedName = name?.trim() || undefined;

    if (tpl.type === 'list') {
      const node = tpl.structure as TemplateListNode;
      const createdId = await withTransaction((client) =>
        instantiateListStructure(
          client, node,
          { userId: req.userId!, workspaceId: resolvedWs, folderId: folderId ?? null, depth: 0, allowAttachments, nextTaskId },
          trimmedName, isPublic
        )
      );
      broadcastToUser(req.userId!, 'lists');
      const list = await getListForUser(req.userId!, createdId);
      res.status(201).json({ list });
    } else {
      const node = tpl.structure as TemplateTimelineNode;
      const createdId = await withTransaction((client) =>
        instantiateTimelineStructure(
          client, node,
          { userId: req.userId!, workspaceId: resolvedWs, folderId: folderId ?? null, allowAttachments },
          trimmedName, isPublic
        )
      );
      broadcastToUser(req.userId!, 'timelines');
      const timeline = await getTimelineForUser(req.userId!, createdId);
      res.status(201).json({ timeline });
    }
  } catch (err) {
    werr('templates use error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
