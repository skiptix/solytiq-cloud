// ---------------------------------------------------------------------------
// /api/graph — workspace + local graph reads, shortest path, orphans, hubs,
// stats, and export. Mounted at /api/graph behind graphLimiter (see index.ts).
// Every query is scoped through graph/visibility.ts; cross-workspace edges
// that touch content the caller can't see are counted in `hidden`, never
// silently included or silently dropped (the "Monday lesson", CLAUDE.md).
// ---------------------------------------------------------------------------

import { Router, Request, Response } from 'express';
import { query } from '../db';
import { authenticate } from '../middleware';
import { userCanAccessWorkspace, werr } from '../workspaceUtil';
import { parseSrn, formatSrn, isValidEntityType, type EntityType } from '../graph/srn';
import { isEntityVisible } from '../graph/visibility';
import { localGraphNodeIds, shortestPath, findOrphans, MAX_LOCAL_GRAPH_DEPTH } from '../graph/traversal';
import { currentSyncSeq, getCachedGraph, setCachedGraph } from '../graph/cache';
import { recomputeWorkspaceMetricsNow } from '../graph/metrics';
import { listLinkTypes } from '../graph/linkTypes';

const router = Router();
router.use(authenticate);

interface GraphNodeJson {
  srn: string; type: string; id: string; title: string;
  emoji: string | null; color: string | null; deepLink: string | null;
  degree: number; pagerank: number; community: number | null;
  status: string | null; isArchived: boolean; workspaceId: string | null;
}
interface GraphEdgeJson {
  id: string; src: string; dst: string; linkType: string; origin: string;
  weight: number; sourceBlockId: string | null; crossWorkspace: boolean;
}
interface GraphPayload {
  nodes: GraphNodeJson[];
  edges: GraphEdgeJson[];
  hidden: { nodes: number; edges: number };
  truncated: boolean;
  computedAt: string;
  syncSeq: number;
}

function parseCsv(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

interface NodeRow {
  entity_type: string; entity_id: string; workspace_id: string | null; title: string;
  emoji: string | null; color: string | null; deep_link: string | null; status: string | null;
  is_archived: boolean; degree: number; pagerank: number; community_id: number | null;
}

// GET /api/graph/workspace/:workspaceId
router.get('/workspace/:workspaceId', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { workspaceId } = req.params;
    if (!(await userCanAccessWorkspace(userId, workspaceId))) { res.status(403).json({ error: 'Forbidden' }); return; }

    const seq = await currentSyncSeq(workspaceId);
    const etag = `W/"${workspaceId}-${seq}"`;
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }

    const cacheKey = `${workspaceId}:${JSON.stringify(req.query)}`;
    const cached = getCachedGraph<GraphPayload>(cacheKey, seq);
    if (cached) { res.json(cached); return; }

    const types = parseCsv(req.query.types);
    const linkTypes = parseCsv(req.query.linkTypes);
    const includeTrashed = req.query.includeTrashed === 'true';
    const minDegree = req.query.minDegree ? Number(req.query.minDegree) : 0;
    const limit = Math.min(Math.max(Number(req.query.limit) || 2000, 1), 5000);

    const nodeParams: unknown[] = [workspaceId];
    let nodeFilter = includeTrashed ? '' : ' AND e.is_trashed = false';
    if (types) { nodeParams.push(types); nodeFilter += ` AND e.entity_type = ANY($${nodeParams.length}::text[])`; }
    if (minDegree > 0) nodeFilter += ` AND (COALESCE(m.degree_in,0) + COALESCE(m.degree_out,0)) >= ${minDegree}`;

    const nodesRes = await query<NodeRow>(
      `SELECT e.entity_type, e.entity_id, e.workspace_id, e.title, e.emoji, e.color, e.deep_link, e.status, e.is_archived,
              (COALESCE(m.degree_in,0) + COALESCE(m.degree_out,0)) AS degree, COALESCE(m.pagerank,0) AS pagerank, m.community_id
         FROM entity_index e
         LEFT JOIN entity_graph_metrics m ON (m.entity_type, m.entity_id) = (e.entity_type, e.entity_id)
        WHERE e.workspace_id = $1 ${nodeFilter}
        ORDER BY COALESCE(m.pagerank, 0) DESC
        LIMIT ${limit + 1}`,
      nodeParams
    );
    const truncated = nodesRes.rows.length > limit;
    const nodeRows = nodesRes.rows.slice(0, limit);
    const nodeKeySet = new Set(nodeRows.map((r) => `${r.entity_type}:${r.entity_id}`));

    const linkParams: unknown[] = [workspaceId];
    let linkFilter = '';
    if (linkTypes) { linkParams.push(linkTypes); linkFilter = ` AND link_type = ANY($${linkParams.length}::text[])`; }
    const edgesRes = await query<{
      id: string; src_type: string; src_id: string; dst_type: string; dst_id: string;
      link_type: string; origin: string; weight: number; source_block_id: string | null; is_cross_workspace: boolean;
    }>(
      `SELECT id, src_type, src_id, dst_type, dst_id, link_type, origin, weight, source_block_id, is_cross_workspace
         FROM entity_links WHERE workspace_id = $1 ${linkFilter}`,
      linkParams
    );

    const nodes: GraphNodeJson[] = nodeRows.map((r) => ({
      srn: formatSrn(r.entity_type as EntityType, r.entity_id),
      type: r.entity_type, id: r.entity_id, title: r.title,
      emoji: r.emoji, color: r.color, deepLink: r.deep_link,
      degree: Number(r.degree), pagerank: Number(r.pagerank), community: r.community_id,
      status: r.status, isArchived: r.is_archived, workspaceId: r.workspace_id,
    }));

    const edges: GraphEdgeJson[] = [];
    let hiddenEdges = 0;
    for (const e of edgesRes.rows) {
      const srcKey = `${e.src_type}:${e.src_id}`;
      const dstKey = `${e.dst_type}:${e.dst_id}`;
      const srcIn = nodeKeySet.has(srcKey);
      const dstIn = nodeKeySet.has(dstKey);
      if (srcIn && dstIn) {
        edges.push({
          id: e.id, src: formatSrn(e.src_type as EntityType, e.src_id), dst: formatSrn(e.dst_type as EntityType, e.dst_id),
          linkType: e.link_type, origin: e.origin, weight: e.weight, sourceBlockId: e.source_block_id,
          crossWorkspace: e.is_cross_workspace,
        });
      } else if (e.is_cross_workspace) {
        // One endpoint lives outside this workspace's node set (filtered out
        // above, or genuinely invisible to this user) — count it, don't leak it.
        hiddenEdges++;
      }
    }

    const payload: GraphPayload = {
      nodes, edges,
      hidden: { nodes: 0, edges: hiddenEdges },
      truncated,
      computedAt: new Date().toISOString(),
      syncSeq: seq,
    };
    setCachedGraph(cacheKey, seq, payload);
    res.json(payload);
  } catch (err) {
    werr('graph GET /workspace error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/graph/local/:type/:id?depth=2&linkTypes=a,b
router.get('/local/:type/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { type, id } = req.params;
    if (!isValidEntityType(type)) { res.status(400).json({ error: 'Invalid entity type' }); return; }
    if (!(await isEntityVisible(query, userId, type, id))) { res.status(404).json({ error: 'Entity not found' }); return; }

    const depthRaw = req.query.depth ? Number(req.query.depth) : 2;
    if (!Number.isFinite(depthRaw) || depthRaw < 1 || depthRaw > MAX_LOCAL_GRAPH_DEPTH) {
      res.status(400).json({ error: `depth must be between 1 and ${MAX_LOCAL_GRAPH_DEPTH}` });
      return;
    }
    const linkTypes = parseCsv(req.query.linkTypes);
    const { nodes: nodeIds, truncated } = await localGraphNodeIds(userId, { entityType: type, entityId: id }, { depth: depthRaw, linkTypes });

    if (nodeIds.length === 0) { res.json({ nodes: [], edges: [], hidden: { nodes: 0, edges: 0 }, truncated: false, computedAt: new Date().toISOString() }); return; }

    const types = nodeIds.map((n) => n.entityType);
    const ids = nodeIds.map((n) => n.entityId);
    const nodesRes = await query<NodeRow>(
      `SELECT e.entity_type, e.entity_id, e.workspace_id, e.title, e.emoji, e.color, e.deep_link, e.status, e.is_archived,
              (COALESCE(m.degree_in,0) + COALESCE(m.degree_out,0)) AS degree, COALESCE(m.pagerank,0) AS pagerank, m.community_id
         FROM entity_index e
         LEFT JOIN entity_graph_metrics m ON (m.entity_type, m.entity_id) = (e.entity_type, e.entity_id)
         JOIN unnest($1::text[], $2::text[]) AS want(entity_type, entity_id)
           ON e.entity_type = want.entity_type AND e.entity_id = want.entity_id`,
      [types, ids]
    );
    const depthByKey = new Map(nodeIds.map((n) => [`${n.entityType}:${n.entityId}`, n.depth]));
    const nodeKeySet = new Set(nodeIds.map((n) => `${n.entityType}:${n.entityId}`));

    const edgesRes = await query<{
      id: string; src_type: string; src_id: string; dst_type: string; dst_id: string;
      link_type: string; origin: string; weight: number; source_block_id: string | null; is_cross_workspace: boolean;
    }>(
      `SELECT el.id, el.src_type, el.src_id, el.dst_type, el.dst_id, el.link_type, el.origin, el.weight, el.source_block_id, el.is_cross_workspace
         FROM entity_links el
         JOIN unnest($1::text[], $2::text[]) AS a(t, i) ON el.src_type = a.t AND el.src_id = a.i
         JOIN unnest($1::text[], $2::text[]) AS b(t, i) ON el.dst_type = b.t AND el.dst_id = b.i`,
      [types, ids]
    );

    const nodes = nodesRes.rows.map((r) => ({
      srn: formatSrn(r.entity_type as EntityType, r.entity_id),
      type: r.entity_type, id: r.entity_id, title: r.title,
      emoji: r.emoji, color: r.color, deepLink: r.deep_link,
      degree: Number(r.degree), pagerank: Number(r.pagerank), community: r.community_id,
      status: r.status, isArchived: r.is_archived, workspaceId: r.workspace_id,
      depth: depthByKey.get(`${r.entity_type}:${r.entity_id}`) ?? 0,
    }));
    const edges = edgesRes.rows
      .filter((e) => nodeKeySet.has(`${e.src_type}:${e.src_id}`) && nodeKeySet.has(`${e.dst_type}:${e.dst_id}`))
      .map((e) => ({
        id: e.id, src: formatSrn(e.src_type as EntityType, e.src_id), dst: formatSrn(e.dst_type as EntityType, e.dst_id),
        linkType: e.link_type, origin: e.origin, weight: e.weight, sourceBlockId: e.source_block_id, crossWorkspace: e.is_cross_workspace,
      }));

    res.json({ nodes, edges, hidden: { nodes: 0, edges: 0 }, truncated, computedAt: new Date().toISOString() });
  } catch (err) {
    werr('graph GET /local error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/graph/path?from=srn:...&to=srn:...&maxDepth=6
router.get('/path', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const fromRaw = typeof req.query.from === 'string' ? req.query.from : undefined;
    const toRaw = typeof req.query.to === 'string' ? req.query.to : undefined;
    if (!fromRaw || !toRaw) { res.status(400).json({ error: 'from and to are required' }); return; }
    const from = parseSrn(fromRaw);
    const to = parseSrn(toRaw);
    if (!from || !to) { res.status(400).json({ error: 'Invalid SRN' }); return; }
    if (!(await isEntityVisible(query, userId, from.entityType, from.entityId))) { res.status(404).json({ error: 'Source entity not found' }); return; }
    if (!(await isEntityVisible(query, userId, to.entityType, to.entityId))) { res.status(404).json({ error: 'Destination entity not found' }); return; }

    const maxDepth = req.query.maxDepth ? Number(req.query.maxDepth) : 6;
    const path = await shortestPath(userId, from, to, maxDepth);
    res.json({ path, found: path !== null });
  } catch (err) {
    werr('graph GET /path error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/graph/orphans/:workspaceId
router.get('/orphans/:workspaceId', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { workspaceId } = req.params;
    if (!(await userCanAccessWorkspace(userId, workspaceId))) { res.status(403).json({ error: 'Forbidden' }); return; }
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const orphans = await findOrphans(userId, workspaceId, limit);
    res.json({ orphans: orphans.map((o) => ({ srn: formatSrn(o.entityType as EntityType, o.entityId), type: o.entityType, id: o.entityId })) });
  } catch (err) {
    werr('graph GET /orphans error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/graph/hubs/:workspaceId
router.get('/hubs/:workspaceId', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { workspaceId } = req.params;
    if (!(await userCanAccessWorkspace(userId, workspaceId))) { res.status(403).json({ error: 'Forbidden' }); return; }
    const limit = Math.min(Math.max(req.query.limit ? Number(req.query.limit) : 20, 1), 100);
    const r = await query<NodeRow>(
      `SELECT e.entity_type, e.entity_id, e.workspace_id, e.title, e.emoji, e.color, e.deep_link, e.status, e.is_archived,
              (COALESCE(m.degree_in,0) + COALESCE(m.degree_out,0)) AS degree, COALESCE(m.pagerank,0) AS pagerank, m.community_id
         FROM entity_index e JOIN entity_graph_metrics m ON (m.entity_type, m.entity_id) = (e.entity_type, e.entity_id)
        WHERE e.workspace_id = $1 AND e.is_trashed = false
        ORDER BY m.pagerank DESC LIMIT ${limit}`,
      [workspaceId]
    );
    res.json({
      hubs: r.rows.map((row) => ({
        srn: formatSrn(row.entity_type as EntityType, row.entity_id), type: row.entity_type, id: row.entity_id,
        title: row.title, pagerank: Number(row.pagerank), degree: Number(row.degree),
      })),
    });
  } catch (err) {
    werr('graph GET /hubs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/graph/stats/:workspaceId
router.get('/stats/:workspaceId', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { workspaceId } = req.params;
    if (!(await userCanAccessWorkspace(userId, workspaceId))) { res.status(403).json({ error: 'Forbidden' }); return; }

    const [nodeCounts, edgeCounts, cacheAge] = await Promise.all([
      query<{ entity_type: string; c: string }>(
        `SELECT entity_type, COUNT(*) AS c FROM entity_index WHERE workspace_id = $1 AND is_trashed = false GROUP BY entity_type`,
        [workspaceId]
      ),
      query<{ link_type: string; c: string }>(
        `SELECT link_type, COUNT(*) AS c FROM entity_links WHERE workspace_id = $1 GROUP BY link_type`,
        [workspaceId]
      ),
      query<{ computed_at: string | null }>(
        `SELECT MIN(computed_at) AS computed_at FROM entity_graph_metrics WHERE workspace_id = $1`,
        [workspaceId]
      ),
    ]);
    const nodeTotal = nodeCounts.rows.reduce((sum, r) => sum + Number(r.c), 0);
    const edgeTotal = edgeCounts.rows.reduce((sum, r) => sum + Number(r.c), 0);
    const maxPossibleEdges = nodeTotal > 1 ? nodeTotal * (nodeTotal - 1) : 1;
    res.json({
      nodesByType: Object.fromEntries(nodeCounts.rows.map((r) => [r.entity_type, Number(r.c)])),
      edgesByType: Object.fromEntries(edgeCounts.rows.map((r) => [r.link_type, Number(r.c)])),
      nodeTotal, edgeTotal,
      density: nodeTotal > 0 ? edgeTotal / maxPossibleEdges : 0,
      metricsComputedAt: cacheAge.rows[0]?.computed_at ?? null,
    });
  } catch (err) {
    werr('graph GET /stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/graph/recompute/:workspaceId — force a synchronous metrics recompute (owner/admin only)
router.post('/recompute/:workspaceId', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const isAdmin = req.user?.isAdmin === true;
    const { workspaceId } = req.params;
    if (!isAdmin) {
      const owns = await query<{ owner_id: string }>(`SELECT owner_id FROM workspaces WHERE id = $1`, [workspaceId]);
      if (owns.rows[0]?.owner_id !== userId) { res.status(403).json({ error: 'Only the workspace owner or an admin can force a recompute' }); return; }
    }
    await recomputeWorkspaceMetricsNow(workspaceId);
    res.json({ ok: true, computedAt: new Date().toISOString() });
  } catch (err) {
    werr('graph POST /recompute error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/graph/workspace/:workspaceId/export?format=json|graphml|markdown
// SVG is deliberately not implemented: it requires client-supplied layout
// coordinates (see the design doc §8.6), which don't fit a stateless GET —
// that needs its own POST-based endpoint, tracked as follow-up.
router.get('/workspace/:workspaceId/export', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { workspaceId } = req.params;
    if (!(await userCanAccessWorkspace(userId, workspaceId))) { res.status(403).json({ error: 'Forbidden' }); return; }
    const format = typeof req.query.format === 'string' ? req.query.format : 'json';
    if (!['json', 'graphml', 'markdown'].includes(format)) {
      res.status(400).json({ error: 'format must be json, graphml, or markdown (svg is not yet supported)' });
      return;
    }

    const nodesRes = await query<{ entity_type: string; entity_id: string; title: string; deep_link: string | null }>(
      `SELECT entity_type, entity_id, title, deep_link FROM entity_index WHERE workspace_id = $1 AND is_trashed = false`,
      [workspaceId]
    );
    const edgesRes = await query<{ src_type: string; src_id: string; dst_type: string; dst_id: string; link_type: string }>(
      `SELECT src_type, src_id, dst_type, dst_id, link_type FROM entity_links WHERE workspace_id = $1`,
      [workspaceId]
    );
    const nodeKeySet = new Set(nodesRes.rows.map((r) => `${r.entity_type}:${r.entity_id}`));
    const visibleEdges = edgesRes.rows.filter((e) => nodeKeySet.has(`${e.src_type}:${e.src_id}`) && nodeKeySet.has(`${e.dst_type}:${e.dst_id}`));

    if (format === 'json') {
      res.json({
        nodes: nodesRes.rows.map((n) => ({ srn: formatSrn(n.entity_type as EntityType, n.entity_id), title: n.title, deepLink: n.deep_link })),
        edges: visibleEdges.map((e) => ({ src: formatSrn(e.src_type as EntityType, e.src_id), dst: formatSrn(e.dst_type as EntityType, e.dst_id), linkType: e.link_type })),
      });
      return;
    }

    if (format === 'graphml') {
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const nodeXml = nodesRes.rows.map((n) => {
        const id = `${n.entity_type}:${n.entity_id}`;
        return `    <node id="${esc(id)}"><data key="d0">${esc(n.title)}</data></node>`;
      }).join('\n');
      const edgeXml = visibleEdges.map((e, i) => {
        const src = `${e.src_type}:${e.src_id}`;
        const dst = `${e.dst_type}:${e.dst_id}`;
        return `    <edge id="e${i}" source="${esc(src)}" target="${esc(dst)}"><data key="d1">${esc(e.link_type)}</data></edge>`;
      }).join('\n');
      const graphml = `<?xml version="1.0" encoding="UTF-8"?>\n<graphml xmlns="http://graphml.graphdrawing.org/xmlns">\n  <key id="d0" for="node" attr.name="title" attr.type="string"/>\n  <key id="d1" for="edge" attr.name="linkType" attr.type="string"/>\n  <graph id="${esc(workspaceId)}" edgedefault="directed">\n${nodeXml}\n${edgeXml}\n  </graph>\n</graphml>\n`;
      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', `attachment; filename="${workspaceId}.graphml"`);
      res.send(graphml);
      return;
    }

    // markdown: one file per entity with [[type:id|title]] links — an
    // Obsidian-vault-compatible export, concatenated (a real multi-file zip is
    // a follow-up; this is the reimportable data, just packaged as one file).
    const byKey = new Map(nodesRes.rows.map((n) => [`${n.entity_type}:${n.entity_id}`, n]));
    const outgoingByNode = new Map<string, string[]>();
    for (const e of visibleEdges) {
      const srcKey = `${e.src_type}:${e.src_id}`;
      const dstNode = byKey.get(`${e.dst_type}:${e.dst_id}`);
      if (!dstNode) continue;
      const link = `[[${e.dst_type}:${e.dst_id}|${dstNode.title}]] (${e.link_type})`;
      (outgoingByNode.get(srcKey) ?? outgoingByNode.set(srcKey, []).get(srcKey)!).push(link);
    }
    const sections = nodesRes.rows.map((n) => {
      const key = `${n.entity_type}:${n.entity_id}`;
      const links = outgoingByNode.get(key) ?? [];
      return `# ${n.title}\n\n<!-- srn:${n.entity_type}:${n.entity_id} -->\n${links.length ? `\n## Links\n\n${links.map((l) => `- ${l}`).join('\n')}\n` : ''}`;
    });
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="${workspaceId}.md"`);
    res.send(sections.join('\n---\n\n'));
  } catch (err) {
    werr('graph GET /export error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/graph/types?workspaceId= — convenience passthrough (legend for the graph UI)
router.get('/types', async (req: Request, res: Response) => {
  try {
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
    if (workspaceId && !(await userCanAccessWorkspace(req.userId!, workspaceId))) { res.status(403).json({ error: 'Forbidden' }); return; }
    res.json({ types: await listLinkTypes(workspaceId ?? null) });
  } catch (err) {
    werr('graph GET /types error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
