// ---------------------------------------------------------------------------
// Automation Hub — graph validation.
//
// V1 automations are intentionally linear: exactly one trigger node feeding
// one or more action nodes chained in a single simple path (no branching, no
// merging, no cycles). This is enforced HERE, server-side, on every save —
// regardless of what the client sends — since the editor's UI affordances
// are only a courtesy, not the actual guarantee. This is what makes "V1 is
// linear-only" a real invariant rather than a UI convention.
// ---------------------------------------------------------------------------

import { getTriggerDef, getActionDef } from './automationTypes';
import { QueryExec } from './workspaceUtil';

export interface AutomationNode {
  id: string;
  kind: 'trigger' | 'action';
  type: string;
  position: { x: number; y: number };
  params: Record<string, unknown>;
}

export interface AutomationEdge {
  id: string;
  source: string;
  target: string;
}

export interface AutomationGraph {
  version: 1;
  nodes: AutomationNode[];
  edges: AutomationEdge[];
}

export interface NormalizedAutomation {
  graph: AutomationGraph;
  triggerType: string;
  triggerScope: Record<string, unknown>;
  orderedActionIds: string[];
}

export type NormalizeResult =
  | { ok: true; value: NormalizedAutomation }
  | { ok: false; error: string };

export function normalizeAutomationGraph(raw: unknown): NormalizeResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'graph must be an object' };
  const g = raw as Partial<AutomationGraph>;
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) {
    return { ok: false, error: 'graph.nodes and graph.edges must be arrays' };
  }
  const nodes = g.nodes as AutomationNode[];
  const edges = g.edges as AutomationEdge[];
  if (nodes.length === 0) return { ok: false, error: 'graph must contain a trigger node' };

  const seenIds = new Set<string>();
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string' || !n.id) return { ok: false, error: 'every node needs a non-empty string id' };
    if (seenIds.has(n.id)) return { ok: false, error: `duplicate node id "${n.id}"` };
    seenIds.add(n.id);
    if (n.kind !== 'trigger' && n.kind !== 'action') return { ok: false, error: `node "${n.id}" has an invalid kind` };
    if (typeof n.type !== 'string' || !n.type) return { ok: false, error: `node "${n.id}" is missing a type` };
    if (!n.params || typeof n.params !== 'object' || Array.isArray(n.params)) {
      return { ok: false, error: `node "${n.id}" is missing a params object` };
    }
  }

  const triggerNodes = nodes.filter((n) => n.kind === 'trigger');
  if (triggerNodes.length !== 1) return { ok: false, error: 'graph must contain exactly one trigger node' };
  const triggerNode = triggerNodes[0];
  const actionNodes = nodes.filter((n) => n.kind === 'action');
  if (actionNodes.length === 0) return { ok: false, error: 'graph must contain at least one action node' };

  const triggerDef = getTriggerDef(triggerNode.type);
  if (!triggerDef) return { ok: false, error: `unknown trigger type "${triggerNode.type}"` };
  const triggerParamError = triggerDef.validate(triggerNode.params);
  if (triggerParamError) return { ok: false, error: `trigger: ${triggerParamError}` };

  for (const an of actionNodes) {
    const actionDef = getActionDef(an.type);
    if (!actionDef) return { ok: false, error: `unknown action type "${an.type}"` };
    const paramError = actionDef.validate(an.params);
    if (paramError) return { ok: false, error: `action "${actionDef.label}": ${paramError}` };
    if (actionDef.requiresTriggerTask && !triggerDef.providesTask) {
      return { ok: false, error: `action "${actionDef.label}" needs a task, but trigger "${triggerDef.label}" doesn't provide one` };
    }
    if (actionDef.requiresTriggerList && !triggerDef.providesList) {
      return { ok: false, error: `action "${actionDef.label}" needs a list, but trigger "${triggerDef.label}" doesn't provide one` };
    }
  }

  // A single simple chain: trigger --edge--> action --edge--> action ... .
  // nodes.length - 1 edges, trigger has out=1/in=0, every action has in=1
  // and out<=1 (0 only for the last one) — this is what actually rejects
  // branching/merging/cycles, not just the UI.
  if (edges.length !== nodes.length - 1) {
    return { ok: false, error: 'graph must be a single chain (branching/merging is not supported in V1)' };
  }
  const outDegree = new Map<string, number>();
  const inDegree = new Map<string, number>();
  for (const n of nodes) { outDegree.set(n.id, 0); inDegree.set(n.id, 0); }
  for (const e of edges) {
    if (!seenIds.has(e.source) || !seenIds.has(e.target)) return { ok: false, error: 'edge references an unknown node' };
    outDegree.set(e.source, (outDegree.get(e.source) ?? 0) + 1);
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }
  if ((outDegree.get(triggerNode.id) ?? 0) !== 1 || (inDegree.get(triggerNode.id) ?? 0) !== 0) {
    return { ok: false, error: 'the trigger node must have exactly one outgoing edge and no incoming edges' };
  }
  for (const an of actionNodes) {
    if ((inDegree.get(an.id) ?? 0) !== 1) return { ok: false, error: `action node "${an.id}" must have exactly one incoming edge` };
    if ((outDegree.get(an.id) ?? 0) > 1) return { ok: false, error: `action node "${an.id}" must have at most one outgoing edge` };
  }

  const nextOf = new Map<string, string>();
  for (const e of edges) nextOf.set(e.source, e.target);

  const orderedActionIds: string[] = [];
  const visited = new Set<string>([triggerNode.id]);
  let cursor = nextOf.get(triggerNode.id);
  while (cursor) {
    if (visited.has(cursor)) return { ok: false, error: 'graph contains a cycle' };
    visited.add(cursor);
    orderedActionIds.push(cursor);
    cursor = nextOf.get(cursor);
  }
  if (orderedActionIds.length !== actionNodes.length) {
    return { ok: false, error: 'graph is not a single connected chain from the trigger through every action node' };
  }

  return {
    ok: true,
    value: {
      graph: { version: 1, nodes, edges },
      triggerType: triggerNode.type,
      triggerScope: triggerNode.params,
      orderedActionIds,
    },
  };
}

/**
 * Defense in depth against IDOR: any node param naming a list (trigger scope
 * `listId`, or an action's `targetListId`) must belong to the SAME workspace
 * as the automation itself — otherwise a crafted graph could reach into a
 * list the automation's workspace has no business touching. Called at save
 * time (routes/automations.ts); execution time re-checks again via
 * automationTypes.ts's assertListInWorkspace, since a list can move/be
 * deleted after the automation was saved.
 */
export async function assertGraphListsInWorkspace(exec: QueryExec, graph: AutomationGraph, workspaceId: string): Promise<string | null> {
  const listIds = new Set<string>();
  for (const n of graph.nodes) {
    for (const key of ['listId', 'targetListId']) {
      const v = n.params?.[key];
      if (typeof v === 'string' && v) listIds.add(v);
    }
  }
  for (const listId of listIds) {
    const r = await exec('SELECT workspace_id FROM lists WHERE id = $1', [listId]);
    if (r.rows.length === 0) return `List ${listId} does not exist`;
    if ((r.rows[0] as { workspace_id: string | null }).workspace_id !== workspaceId) {
      return `List ${listId} is not in this automation's workspace`;
    }
  }
  return null;
}

export function orderedActionNodes(graph: AutomationGraph, orderedActionIds: string[]): AutomationNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return orderedActionIds.map((id) => byId.get(id)).filter((n): n is AutomationNode => !!n);
}
