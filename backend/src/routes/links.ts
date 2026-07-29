// ---------------------------------------------------------------------------
// /api/links — CRUD + read endpoints for graph edges (entity_links) and the
// link-type registry. Mounted at /api/links (see index.ts) behind both the
// general apiLimiter and a dedicated linksLimiter.
//
// Every route re-checks visibility per request (existence-safe: an entity a
// caller can't see 404s, never 403s, so nothing about it is leaked) — see
// CLAUDE.md's Graph Layer section for the write-permission model
// (write access to the SOURCE, read access to the DESTINATION).
// ---------------------------------------------------------------------------

import { Router, Request, Response } from 'express';
import { query, withTransaction } from '../db';
import { authenticate } from '../middleware';
import { werr, userCanAccessWorkspace } from '../workspaceUtil';
import type { QueryExec } from '../workspaceUtil';
import { parseSrn, formatSrn, isValidEntityType, type ParsedSrn, type EntityType } from '../graph/srn';
import { isEntityVisible, canWriteEntity } from '../graph/visibility';
import {
  upsertLink, getLinkById, updateLink, deleteLink, getEntityLinks, getBacklinks,
  getLinksBetween, findUnlinkedMentions, LinkError, type EntityLink, type ResolvedLink,
} from '../graph/links';
import {
  listLinkTypes, isSystemLinkType, CUSTOM_LINK_TYPE_PREFIX,
} from '../graph/linkTypes';
import { v4 as uuidv4 } from 'uuid';

const router = Router();
router.use(authenticate);

function linkJson(link: EntityLink) {
  return {
    id: link.id,
    src: formatSrn(link.srcType as EntityType, link.srcId),
    dst: formatSrn(link.dstType as EntityType, link.dstId),
    linkType: link.linkType,
    origin: link.origin,
    sourceBlockId: link.sourceBlockId,
    props: link.props,
    weight: link.weight,
    isCrossWorkspace: link.isCrossWorkspace,
    workspaceId: link.workspaceId,
    createdBy: link.createdBy,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}

function resolvedLinkJson(rl: ResolvedLink) {
  return {
    ...linkJson(rl.link),
    direction: rl.direction,
    neighbor: rl.neighbor,
  };
}

function parseSrnOr400(res: Response, raw: unknown, label: string): ParsedSrn | null {
  if (typeof raw !== 'string') {
    res.status(400).json({ error: `${label} is required` });
    return null;
  }
  const parsed = parseSrn(raw);
  if (!parsed) {
    res.status(400).json({ error: `${label} is not a valid SRN` });
    return null;
  }
  return parsed;
}

// GET /api/links?src=srn:...&dst=srn:...&type=&direction=out|in|both
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const srcRaw = typeof req.query.src === 'string' ? req.query.src : undefined;
    const dstRaw = typeof req.query.dst === 'string' ? req.query.dst : undefined;
    const linkType = typeof req.query.type === 'string' ? req.query.type : undefined;
    const direction = typeof req.query.direction === 'string' ? req.query.direction : 'both';

    if (!srcRaw && !dstRaw) { res.status(400).json({ error: 'src or dst is required' }); return; }
    if (!['out', 'in', 'both'].includes(direction)) { res.status(400).json({ error: 'direction must be out, in, or both' }); return; }

    if (srcRaw && dstRaw) {
      const src = parseSrnOr400(res, srcRaw, 'src');
      if (!src) return;
      const dst = parseSrnOr400(res, dstRaw, 'dst');
      if (!dst) return;
      if (!(await isEntityVisible(query, userId, src.entityType, src.entityId))) { res.status(404).json({ error: 'Source entity not found' }); return; }
      if (!(await isEntityVisible(query, userId, dst.entityType, dst.entityId))) { res.status(404).json({ error: 'Destination entity not found' }); return; }
      const links = await getLinksBetween(src, dst, linkType);
      res.json({ links: links.map(linkJson) });
      return;
    }

    const anchor = parseSrnOr400(res, srcRaw ?? dstRaw, srcRaw ? 'src' : 'dst');
    if (!anchor) return;
    if (!(await isEntityVisible(query, userId, anchor.entityType, anchor.entityId))) { res.status(404).json({ error: 'Entity not found' }); return; }

    let resolved = await getEntityLinks(userId, anchor, { linkTypes: linkType ? [linkType] : undefined });
    if (direction !== 'both') resolved = resolved.filter((r) => r.direction === direction);
    res.json({ links: resolved.map(resolvedLinkJson) });
  } catch (err) {
    werr('links GET / error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/links/entity/:type/:id — every link touching this entity, grouped by link_type
router.get('/entity/:type/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { type, id } = req.params;
    if (!isValidEntityType(type)) { res.status(400).json({ error: 'Invalid entity type' }); return; }
    if (!(await isEntityVisible(query, userId, type, id))) { res.status(404).json({ error: 'Entity not found' }); return; }

    const resolved = await getEntityLinks(userId, { entityType: type, entityId: id });
    const linksByType: Record<string, ReturnType<typeof resolvedLinkJson>[]> = {};
    for (const rl of resolved) {
      (linksByType[rl.link.linkType] ??= []).push(resolvedLinkJson(rl));
    }
    res.json({ srn: formatSrn(type, id), linksByType });
  } catch (err) {
    werr('links GET /entity error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/links/entity/:type/:id/backlinks
router.get('/entity/:type/:id/backlinks', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { type, id } = req.params;
    if (!isValidEntityType(type)) { res.status(400).json({ error: 'Invalid entity type' }); return; }
    if (!(await isEntityVisible(query, userId, type, id))) { res.status(404).json({ error: 'Entity not found' }); return; }

    const backlinks = await getBacklinks(userId, { entityType: type, entityId: id });
    res.json({ backlinks: backlinks.map(resolvedLinkJson) });
  } catch (err) {
    werr('links GET /backlinks error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/links/entity/:type/:id/unlinked — title-substring "unlinked mentions" heuristic (see graph/links.ts)
router.get('/entity/:type/:id/unlinked', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { type, id } = req.params;
    if (!isValidEntityType(type)) { res.status(400).json({ error: 'Invalid entity type' }); return; }
    if (!(await isEntityVisible(query, userId, type, id))) { res.status(404).json({ error: 'Entity not found' }); return; }

    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const candidates = await findUnlinkedMentions(userId, { entityType: type, entityId: id }, { limit: limitRaw });
    res.json({ candidates });
  } catch (err) {
    werr('links GET /unlinked error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

interface LinkPostBody {
  src?: string;
  dst?: string;
  linkType?: string;
  props?: Record<string, unknown>;
  sourceBlockId?: string | null;
}

/** Shared validation for one link-creation request. Writes an error response and returns null on failure. */
async function validateLinkCreate(
  req: Request,
  res: Response,
  body: LinkPostBody,
  label: string
): Promise<{ src: ParsedSrn; dst: ParsedSrn; body: LinkPostBody } | null> {
  const userId = req.userId!;
  const isAdmin = req.user?.isAdmin === true;
  if (!body?.src || !body?.dst || !body?.linkType) {
    res.status(400).json({ error: `${label}: src, dst, and linkType are required` });
    return null;
  }
  const src = parseSrn(body.src);
  const dst = parseSrn(body.dst);
  if (!src || !dst) { res.status(400).json({ error: `${label}: invalid SRN` }); return null; }
  if (!(await isEntityVisible(query, userId, src.entityType, src.entityId))) {
    res.status(404).json({ error: `${label}: source entity not found` });
    return null;
  }
  if (!(await isEntityVisible(query, userId, dst.entityType, dst.entityId))) {
    res.status(404).json({ error: `${label}: destination entity not found` });
    return null;
  }
  if (!(await canWriteEntity(userId, isAdmin, src.entityType, src.entityId))) {
    res.status(403).json({ error: `${label}: no permission to link from this item` });
    return null;
  }
  return { src, dst, body };
}

// POST /api/links
router.post('/', async (req: Request, res: Response) => {
  try {
    const valid = await validateLinkCreate(req, res, req.body as LinkPostBody, 'links');
    if (!valid) return;
    const { src, dst, body } = valid;
    const link = await upsertLink(query, {
      srcType: src.entityType,
      srcId: src.entityId,
      dstType: dst.entityType,
      dstId: dst.entityId,
      linkType: body.linkType!,
      origin: 'manual',
      props: body.props,
      sourceBlockId: body.sourceBlockId ?? null,
      createdBy: req.userId!,
    });
    res.status(201).json({ link: linkJson(link) });
  } catch (err) {
    if (err instanceof LinkError) { res.status(400).json({ error: err.message, code: err.code }); return; }
    werr('links POST / error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/links/batch — up to 100 links, validated up front, written in one transaction (Canvas save, import).
router.post('/batch', async (req: Request, res: Response) => {
  try {
    const items = (req.body as { links?: unknown[] })?.links;
    if (!Array.isArray(items) || items.length === 0) { res.status(400).json({ error: 'links array is required' }); return; }
    if (items.length > 100) { res.status(400).json({ error: 'Maximum 100 links per batch' }); return; }

    const validated: Array<{ src: ParsedSrn; dst: ParsedSrn; body: LinkPostBody }> = [];
    for (let i = 0; i < items.length; i++) {
      const valid = await validateLinkCreate(req, res, items[i] as LinkPostBody, `links[${i}]`);
      if (!valid) return; // validateLinkCreate already wrote the error response
      validated.push(valid);
    }

    const created = await withTransaction(async (client) => {
      const exec: QueryExec = (text, params) => client.query(text, params);
      const out: EntityLink[] = [];
      for (const item of validated) {
        out.push(
          await upsertLink(exec, {
            srcType: item.src.entityType,
            srcId: item.src.entityId,
            dstType: item.dst.entityType,
            dstId: item.dst.entityId,
            linkType: item.body.linkType!,
            origin: 'manual',
            props: item.body.props,
            sourceBlockId: item.body.sourceBlockId ?? null,
            createdBy: req.userId!,
          })
        );
      }
      return out;
    });
    res.status(201).json({ links: created.map(linkJson) });
  } catch (err) {
    if (err instanceof LinkError) { res.status(400).json({ error: err.message, code: err.code }); return; }
    werr('links POST /batch error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Can this user manage (edit/delete) an existing link — write access to either endpoint, or admin. */
async function canManageLink(userId: string, isAdmin: boolean, link: EntityLink): Promise<boolean> {
  if (isAdmin) return true;
  return (
    (await canWriteEntity(userId, false, link.srcType, link.srcId)) ||
    (await canWriteEntity(userId, false, link.dstType, link.dstId))
  );
}

// PATCH /api/links/:id — props/weight only. Endpoints and link type are immutable; delete + recreate instead.
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const isAdmin = req.user?.isAdmin === true;
    const link = await getLinkById(query, req.params.id);
    if (!link) { res.status(404).json({ error: 'Link not found' }); return; }
    if (link.origin === 'system') { res.status(409).json({ error: 'System-managed links cannot be edited' }); return; }
    if (!(await canManageLink(userId, isAdmin, link))) { res.status(403).json({ error: 'Not authorized' }); return; }

    const body = req.body as { props?: Record<string, unknown>; weight?: number };
    const updated = await updateLink(query, req.params.id, { props: body.props, weight: body.weight });
    res.json({ link: updated ? linkJson(updated) : null });
  } catch (err) {
    werr('links PATCH /:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/links/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const isAdmin = req.user?.isAdmin === true;
    const link = await getLinkById(query, req.params.id);
    if (!link) { res.status(404).json({ error: 'Link not found' }); return; }
    if (link.origin === 'system') { res.status(409).json({ error: 'System-managed links cannot be deleted directly' }); return; }
    if (!(await canManageLink(userId, isAdmin, link))) { res.status(403).json({ error: 'Not authorized' }); return; }

    await deleteLink(query, req.params.id);
    res.status(204).end();
  } catch (err) {
    werr('links DELETE /:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/links/types?workspaceId=
router.get('/types', async (req: Request, res: Response) => {
  try {
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
    if (workspaceId && !(await userCanAccessWorkspace(req.userId!, workspaceId))) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const types = await listLinkTypes(workspaceId ?? null);
    res.json({ types });
  } catch (err) {
    werr('links GET /types error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

interface LinkTypePostBody {
  workspaceId?: string;
  key?: string;
  label?: string;
  inverseKey?: string;
  inverseLabel?: string;
  symmetric?: boolean;
  color?: string;
  edgeStyle?: 'solid' | 'dashed' | 'dotted';
  allowedSrc?: string[];
  allowedDst?: string[];
}

// POST /api/links/types — custom link type, scoped to one workspace. Key must use the `x_` prefix.
router.post('/types', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const body = req.body as LinkTypePostBody;
    if (!body.workspaceId || !body.key || !body.label || !body.inverseKey || !body.inverseLabel) {
      res.status(400).json({ error: 'workspaceId, key, label, inverseKey, and inverseLabel are required' });
      return;
    }
    if (!(await userCanAccessWorkspace(userId, body.workspaceId))) { res.status(403).json({ error: 'Forbidden' }); return; }
    if (!body.key.startsWith(CUSTOM_LINK_TYPE_PREFIX)) {
      res.status(400).json({ error: `Custom link type keys must start with "${CUSTOM_LINK_TYPE_PREFIX}"` });
      return;
    }
    if (isSystemLinkType(body.key)) { res.status(400).json({ error: 'Key collides with a system link type' }); return; }

    const id = `wlt_${uuidv4()}`;
    const r = await query(
      `INSERT INTO workspace_link_types
         (id, workspace_id, key, label, inverse_key, inverse_label, is_symmetric, color, edge_style, allowed_src, allowed_dst, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (workspace_id, key) DO NOTHING
       RETURNING *`,
      [
        id, body.workspaceId, body.key, body.label, body.inverseKey, body.inverseLabel,
        body.symmetric ?? false, body.color ?? null, body.edgeStyle ?? 'solid',
        body.allowedSrc ?? [], body.allowedDst ?? [], userId,
      ]
    );
    if (r.rows.length === 0) { res.status(409).json({ error: 'A link type with this key already exists in this workspace' }); return; }
    res.status(201).json({ type: r.rows[0] });
  } catch (err) {
    werr('links POST /types error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/links/types/:id — only if no entity_links row currently uses it.
router.delete('/types/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const isAdmin = req.user?.isAdmin === true;
    const r = await query<{ id: string; workspace_id: string; key: string; created_by: string | null }>(
      `SELECT id, workspace_id, key, created_by FROM workspace_link_types WHERE id = $1`,
      [req.params.id]
    );
    const row = r.rows[0];
    if (!row || !(await userCanAccessWorkspace(userId, row.workspace_id))) {
      res.status(404).json({ error: 'Link type not found' });
      return;
    }
    if (row.created_by !== userId && !isAdmin) { res.status(403).json({ error: 'Only the creator or an admin can delete this link type' }); return; }

    const usage = await query<{ c: string }>(`SELECT COUNT(*) AS c FROM entity_links WHERE link_type = $1`, [row.key]);
    const count = Number(usage.rows[0].c);
    if (count > 0) { res.status(409).json({ error: `${count} link(s) still use this type`, count }); return; }

    await query(`DELETE FROM workspace_link_types WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) {
    werr('links DELETE /types/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
