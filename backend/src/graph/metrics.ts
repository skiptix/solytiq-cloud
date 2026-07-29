// ---------------------------------------------------------------------------
// Graph metrics — entity_graph_metrics (degree_in/degree_out/pagerank).
// degree_* is maintained incrementally by a DB trigger on entity_links (see
// runMigrations() in index.ts) — cheap, exact, always current. `pagerank` is
// too expensive to recompute per-write, so it's a debounced, per-workspace
// batch job: any workspace touched by a 'link' sync_log event is marked
// dirty (see syncLog.ts), and a 5-minute sweep (registered in index.ts's
// start()) recomputes it in one pass. A plain TypeScript power-iteration
// (no new backend dependency) rather than SQL recursion — the doc's own
// recommended option, and the graph comfortably fits in process memory at
// per-workspace scale.
// ---------------------------------------------------------------------------

import { pool, query } from '../db';

const dirtyWorkspaces = new Set<string>();

/** Called from syncLog.ts whenever an entity_links mutation is observed. */
export function markWorkspaceGraphDirty(workspaceId: string | null): void {
  if (workspaceId) dirtyWorkspaces.add(workspaceId);
}

const DAMPING = 0.85;
const ITERATIONS = 20;

async function recomputeWorkspacePagerank(workspaceId: string): Promise<void> {
  const nodesRes = await query<{ entity_type: string; entity_id: string }>(
    `SELECT entity_type, entity_id FROM entity_index WHERE workspace_id = $1 AND is_trashed = false`,
    [workspaceId]
  );
  const nodeIds = nodesRes.rows.map((r) => `${r.entity_type}:${r.entity_id}`);
  const n = nodeIds.length;
  if (n === 0) return;

  const edgesRes = await query<{ src: string; dst: string }>(
    `SELECT (src_type || ':' || src_id) AS src, (dst_type || ':' || dst_id) AS dst
       FROM entity_links WHERE workspace_id = $1`,
    [workspaceId]
  );

  const outDegree = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const id of nodeIds) {
    outDegree.set(id, 0);
    incoming.set(id, []);
  }
  for (const e of edgesRes.rows) {
    // An edge touching a node outside this workspace snapshot (cross-workspace,
    // or the other endpoint is in a different workspace) doesn't participate —
    // pagerank is computed per-workspace, not globally.
    if (!outDegree.has(e.src) || !incoming.has(e.dst)) continue;
    outDegree.set(e.src, (outDegree.get(e.src) ?? 0) + 1);
    incoming.get(e.dst)!.push(e.src);
  }

  let rank = new Map<string, number>(nodeIds.map((id) => [id, 1 / n]));
  for (let iter = 0; iter < ITERATIONS; iter++) {
    let danglingMass = 0;
    for (const id of nodeIds) {
      if ((outDegree.get(id) ?? 0) === 0) danglingMass += rank.get(id) ?? 0;
    }
    const next = new Map<string, number>();
    for (const id of nodeIds) {
      let sum = 0;
      for (const src of incoming.get(id) ?? []) {
        const deg = outDegree.get(src) ?? 0;
        if (deg > 0) sum += (rank.get(src) ?? 0) / deg;
      }
      next.set(id, (1 - DAMPING) / n + DAMPING * (sum + danglingMass / n));
    }
    rank = next;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const id of nodeIds) {
      const sep = id.indexOf(':');
      const entityType = id.slice(0, sep);
      const entityId = id.slice(sep + 1);
      await client.query(
        `INSERT INTO entity_graph_metrics (entity_type, entity_id, workspace_id, pagerank, computed_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (entity_type, entity_id) DO UPDATE
           SET pagerank = EXCLUDED.pagerank, workspace_id = EXCLUDED.workspace_id, computed_at = NOW()`,
        [entityType, entityId, workspaceId, rank.get(id) ?? 0]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Sweep every workspace marked dirty since the last run. Registered on a 5-minute interval. */
export async function sweepGraphMetrics(): Promise<void> {
  const workspaces = [...dirtyWorkspaces];
  dirtyWorkspaces.clear();
  for (const ws of workspaces) {
    try {
      await recomputeWorkspacePagerank(ws);
    } catch (err) {
      console.error('📊 graph metrics sweep failed for workspace', ws, err);
    }
  }
}

/** Force a synchronous recompute for one workspace (used by POST /api/graph/recompute/:id). */
export async function recomputeWorkspaceMetricsNow(workspaceId: string): Promise<void> {
  await recomputeWorkspacePagerank(workspaceId);
}
