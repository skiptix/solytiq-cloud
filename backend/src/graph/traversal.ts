// ---------------------------------------------------------------------------
// Graph traversal — recursive, visibility-scoped local graph + shortest path.
// Both share the same bidirectional walk shape; a `path` array in the CTE
// prevents infinite loops on cyclic link types (relates_to, blocks).
// ---------------------------------------------------------------------------

import { query } from '../db';
import { visibleCondition } from './visibility';
import type { EntityRef } from './entityIndex';

export const MAX_LOCAL_GRAPH_DEPTH = 4;
export const MAX_SHORTEST_PATH_DEPTH = 6;
const MAX_VISITED_NODES = 5000;

export interface GraphNodeId {
  entityType: string;
  entityId: string;
  depth: number;
}

/**
 * Every node reachable from `ref` within `depth` hops (either direction),
 * scoped to what the user can see. Returns the anchor itself at depth 0.
 * `truncated: true` means the visited-node cap was hit before the walk
 * finished — callers should show a "showing partial results" banner.
 */
export async function localGraphNodeIds(
  userId: string,
  ref: EntityRef,
  opts: { depth?: number; linkTypes?: string[] } = {}
): Promise<{ nodes: GraphNodeId[]; truncated: boolean }> {
  const depth = Math.min(Math.max(opts.depth ?? 2, 1), MAX_LOCAL_GRAPH_DEPTH);
  const linkTypes = opts.linkTypes && opts.linkTypes.length > 0 ? opts.linkTypes : null;

  const r = await query<{ etype: string; eid: string; depth: number }>(
    `WITH RECURSIVE visible AS (
       SELECT e.entity_type, e.entity_id FROM entity_index e WHERE ${visibleCondition('e', 1)}
     ),
     bidirectional AS (
       SELECT el.src_type AS a_type, el.src_id AS a_id, el.dst_type AS b_type, el.dst_id AS b_id
         FROM entity_links el
         JOIN visible vs ON (vs.entity_type, vs.entity_id) = (el.src_type, el.src_id)
         JOIN visible vd ON (vd.entity_type, vd.entity_id) = (el.dst_type, el.dst_id)
        WHERE ($4::text[] IS NULL OR el.link_type = ANY($4))
       UNION ALL
       SELECT el.dst_type, el.dst_id, el.src_type, el.src_id
         FROM entity_links el
         JOIN visible vs ON (vs.entity_type, vs.entity_id) = (el.src_type, el.src_id)
         JOIN visible vd ON (vd.entity_type, vd.entity_id) = (el.dst_type, el.dst_id)
        WHERE ($4::text[] IS NULL OR el.link_type = ANY($4))
     ),
     walk AS (
       SELECT $2::varchar AS etype, $3::varchar AS eid, 0 AS depth, ARRAY[$2 || ':' || $3] AS path
        UNION ALL
       SELECT b.b_type, b.b_id, w.depth + 1, w.path || (b.b_type || ':' || b.b_id)
         FROM walk w
         JOIN bidirectional b ON (b.a_type, b.a_id) = (w.etype, w.eid)
        WHERE w.depth < $5
          AND NOT (b.b_type || ':' || b.b_id) = ANY(w.path)
     )
     SELECT DISTINCT ON (etype, eid) etype, eid, depth FROM walk ORDER BY etype, eid, depth ASC
     LIMIT ${MAX_VISITED_NODES + 1}`,
    [userId, ref.entityType, ref.entityId, linkTypes, depth]
  );

  const truncated = r.rows.length > MAX_VISITED_NODES;
  const nodes = r.rows.slice(0, MAX_VISITED_NODES).map((row) => ({
    entityType: row.etype,
    entityId: row.eid,
    depth: row.depth,
  }));
  return { nodes, truncated };
}

/** Shortest visibility-scoped path between two entities (either direction), or null if none within maxDepth. */
export async function shortestPath(
  userId: string,
  from: EntityRef,
  to: EntityRef,
  maxDepth = MAX_SHORTEST_PATH_DEPTH
): Promise<string[] | null> {
  const depth = Math.min(Math.max(maxDepth, 1), MAX_SHORTEST_PATH_DEPTH);
  const r = await query<{ path: string[] }>(
    `WITH RECURSIVE visible AS (
       SELECT e.entity_type, e.entity_id FROM entity_index e WHERE ${visibleCondition('e', 1)}
     ),
     bidirectional AS (
       SELECT el.src_type AS a_type, el.src_id AS a_id, el.dst_type AS b_type, el.dst_id AS b_id
         FROM entity_links el
         JOIN visible vs ON (vs.entity_type, vs.entity_id) = (el.src_type, el.src_id)
         JOIN visible vd ON (vd.entity_type, vd.entity_id) = (el.dst_type, el.dst_id)
       UNION ALL
       SELECT el.dst_type, el.dst_id, el.src_type, el.src_id
         FROM entity_links el
         JOIN visible vs ON (vs.entity_type, vs.entity_id) = (el.src_type, el.src_id)
         JOIN visible vd ON (vd.entity_type, vd.entity_id) = (el.dst_type, el.dst_id)
     ),
     walk AS (
       SELECT $2::varchar AS etype, $3::varchar AS eid, 0 AS depth, ARRAY[$2 || ':' || $3] AS path
        UNION ALL
       SELECT b.b_type, b.b_id, w.depth + 1, w.path || (b.b_type || ':' || b.b_id)
         FROM walk w
         JOIN bidirectional b ON (b.a_type, b.a_id) = (w.etype, w.eid)
        WHERE w.depth < $4
          AND NOT (b.b_type || ':' || b.b_id) = ANY(w.path)
     )
     SELECT path FROM walk WHERE etype = $5 AND eid = $6 ORDER BY depth ASC LIMIT 1`,
    [userId, from.entityType, from.entityId, depth, to.entityType, to.entityId]
  );
  return r.rows[0]?.path ?? null;
}

/** Node ids with zero links at all, scoped to a workspace and visibility. */
export async function findOrphans(userId: string, workspaceId: string, limit = 100): Promise<GraphNodeId[]> {
  const r = await query<{ entity_type: string; entity_id: string }>(
    `SELECT e.entity_type, e.entity_id FROM entity_index e
      WHERE ${visibleCondition('e', 1)} AND e.workspace_id = $2
        AND NOT EXISTS (SELECT 1 FROM entity_links l WHERE (l.src_type = e.entity_type AND l.src_id = e.entity_id) OR (l.dst_type = e.entity_type AND l.dst_id = e.entity_id))
      ORDER BY e.entity_updated_at DESC NULLS LAST
      LIMIT ${Math.min(Math.max(limit, 1), 500)}`,
    [userId, workspaceId]
  );
  return r.rows.map((row) => ({ entityType: row.entity_type, entityId: row.entity_id, depth: 0 }));
}
