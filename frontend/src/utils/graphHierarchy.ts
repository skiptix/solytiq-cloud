// ---------------------------------------------------------------------------
// Graph Layer (frontend) — structural hierarchy for the Net view.
//
// entity_links only mirrors 5 legacy hard-link mechanisms (see CLAUDE.md's
// "Graph Layer" section) — it deliberately does NOT carry section→list,
// list→folder, or folder→workspace containment, and `workspace` is
// deliberately not a graph entity type on the backend. The Net view still
// needs to show that full containment tree with a single workspace root, so
// it's built here, client-side, from data the app already has loaded
// (useAppStore's lists/folders/timelines, useMarkdownListsStore) — no new
// entity_links rows, no new entity type, nothing sent to the backend.
//
// Kept pure and dependency-free so it's trivially unit-testable, matching
// utils/graphLayout.ts's convention.
// ---------------------------------------------------------------------------

import type { GraphNode } from '../types';

/** Not a real backend entity type (see srn.ts's ENTITY_TYPES) — used only to
 *  label the synthetic workspace root node this module adds to the graph. */
export const WORKSPACE_NODE_TYPE = 'workspace' as const;

/** A GraphNode as rendered by the Net view — every real (backend) GraphNode
 *  structurally satisfies this, plus the one synthetic workspace-root node
 *  the renderer adds. Kept separate from GraphNode itself (types.ts) so the
 *  rest of the app — filters, NodeInspector, the graph store — never has to
 *  account for a type the backend doesn't actually know about. */
export type NetRenderNode = Omit<GraphNode, 'type'> & { type: GraphNode['type'] | typeof WORKSPACE_NODE_TYPE };

export function workspaceRootSrn(workspaceId: string): string {
  return `srn:workspace:${workspaceId}`;
}

export function buildWorkspaceRootNode(workspaceId: string, name: string, emoji?: string | null): NetRenderNode {
  return {
    srn: workspaceRootSrn(workspaceId), type: WORKSPACE_NODE_TYPE, id: workspaceId, title: name,
    emoji: emoji ?? null, color: null, deepLink: null, degree: 0, pagerank: 1, community: null,
    status: null, isArchived: false, workspaceId,
  };
}

/**
 * Root node for the Knowledge screen's own net. That screen shows ONE base and
 * its entries, so the base itself is the pinned centre — the same role the
 * synthetic workspace node plays in the full Net. Unlike that one this IS a
 * real backend entity, so it keeps its true SRN and deep link.
 */
export function buildKnowledgeRootNode(
  kbId: string, name: string, emoji: string | null | undefined, workspaceId: string
): NetRenderNode {
  return {
    srn: `srn:knowledgeBase:${kbId}`, type: 'knowledgeBase', id: kbId, title: name,
    emoji: emoji ?? '🧠', color: null, deepLink: '/knowledge', degree: 0, pagerank: 1,
    community: null, status: null, isArchived: false, workspaceId,
  };
}

export interface HierarchySourceList {
  id: string;
  folderId?: string | null;
  /** Set when this list is a sublist owned by a task (`lists.parent_task_id`) —
   *  takes priority over `folderId`: a sublist nests under its owning task,
   *  not the workspace/folder its task's own list happens to live in. */
  parentTaskId?: number | string | null;
  sections: Array<{ id: string; tasks: Array<{ id: number | string }> }>;
}
export interface HierarchySourceFolder { id: string }
export interface HierarchySourceTimeline {
  id: string;
  folderId?: string | null;
  milestones: Array<{ id: string }>;
}
export interface HierarchySourceMarkdownList {
  id: string;
  folderId?: string | null;
  /** The auto-managed Todo list mirroring this page's `/todo` blocks
   *  (`markdown_lists.todo_list_id`), if one has been created yet. */
  todoListId?: string | null;
}

/** The workspace's single Knowledge Base, plus the entries hanging off it. */
export interface HierarchySourceKnowledgeBase {
  id: string;
  entryIds: string[];
}

export interface HierarchySource {
  workspaceId: string;
  lists: HierarchySourceList[];
  folders: HierarchySourceFolder[];
  timelines: HierarchySourceTimeline[];
  markdownLists: HierarchySourceMarkdownList[];
  /** Dashboard tasks (source='dash') — no list/section, hang directly off the workspace root. */
  dashTaskIds: Array<number | string>;
  /** The workspace's Knowledge Base, when one has been added. */
  knowledgeBase?: HierarchySourceKnowledgeBase | null;
}

/**
 * The FULL structural parent for every entity the app knows about in this
 * workspace (not just the ones currently rendered in the graph — filtering
 * is applied later by walking up this map to the nearest still-visible
 * ancestor). Every chain terminates at the synthetic workspace root.
 */
export function buildParentIndex(src: HierarchySource): Map<string, string> {
  const root = workspaceRootSrn(src.workspaceId);
  const parent = new Map<string, string>();

  for (const f of src.folders) parent.set(`srn:folder:${f.id}`, root);

  for (const l of src.lists) {
    const listSrn = `srn:list:${l.id}`;
    // A sublist nests under the task that owns it, not the folder/root its
    // own row happens to carry (`lists.folder_id` is typically unset for a
    // sublist anyway, but a task-owned parent always wins when present).
    const ownerTaskSrn = l.parentTaskId != null ? `srn:task:${l.parentTaskId}` : null;
    parent.set(listSrn, ownerTaskSrn ?? (l.folderId ? `srn:folder:${l.folderId}` : root));
    for (const s of l.sections) {
      const sectionSrn = `srn:section:${s.id}`;
      parent.set(sectionSrn, listSrn);
      for (const t of s.tasks) parent.set(`srn:task:${t.id}`, sectionSrn);
    }
  }

  for (const tl of src.timelines) {
    const timelineSrn = `srn:timeline:${tl.id}`;
    parent.set(timelineSrn, tl.folderId ? `srn:folder:${tl.folderId}` : root);
    for (const m of tl.milestones) parent.set(`srn:milestone:${m.id}`, timelineSrn);
  }

  for (const md of src.markdownLists) {
    parent.set(`srn:markdownList:${md.id}`, md.folderId ? `srn:folder:${md.folderId}` : root);
    // The auto-managed Todo list mirroring this page's `/todo` blocks nests
    // under the page itself, overriding whatever folder/root the list loop
    // above assigned it — it's the page's content, not a sibling of it.
    if (md.todoListId) parent.set(`srn:list:${md.todoListId}`, `srn:markdownList:${md.id}`);
  }

  for (const id of src.dashTaskIds) parent.set(`srn:task:${id}`, root);

  // The Knowledge Base hangs off the workspace root as a second hub, with every
  // entry beneath it. Structurally this mirrors folder -> workspace: the base is
  // a container, not a leaf, and an entry never belongs to a folder.
  if (src.knowledgeBase) {
    const kbSrn = `srn:knowledgeBase:${src.knowledgeBase.id}`;
    parent.set(kbSrn, root);
    for (const entryId of src.knowledgeBase.entryIds) parent.set(`srn:knowledgeEntry:${entryId}`, kbSrn);
  }

  return parent;
}

export interface HierarchyEdge { id: string; src: string; dst: string; depth: number }

export interface GraphHierarchy {
  /** srn -> immediate rendered parent (nearest visible ancestor, or the workspace root). */
  parentOf: Map<string, string>;
  /** srn -> number of direct rendered children (workspace root included). */
  childCount: Map<string, number>;
  /** parent -> child edges to render (thin, subtle "containment" lines), one per rendered node. */
  edges: HierarchyEdge[];
  /** Every node's depth from the workspace root (root = 0). */
  depthOf: Map<string, number>;
}

/**
 * Resolves each rendered node's nearest ancestor that's ALSO rendered
 * (skipping over anything hidden by the current entity-type/orphan filters),
 * so the tree never has a dangling branch — a task whose section got
 * filtered out still draws a line straight to its list, or the workspace
 * root if the whole chain is filtered.
 */
export function buildRenderedHierarchy(
  nodes: GraphNode[],
  fullParentIndex: Map<string, string>,
  /** SRN of the node every chain terminates at. The full Net passes
   *  workspaceRootSrn(workspaceId); the Knowledge screen passes its base's own
   *  SRN, since there the base IS the centre. */
  rootSrn: string
): GraphHierarchy {
  const root = rootSrn;
  const present = new Set(nodes.map((n) => n.srn));
  present.add(root);

  const parentOf = new Map<string, string>();
  const resolveCache = new Map<string, string>();

  const resolve = (srn: string): string => {
    if (srn === root) return root;
    const cached = resolveCache.get(srn);
    if (cached) return cached;
    let cur = fullParentIndex.get(srn) ?? root;
    const seen = new Set([srn]);
    while (cur !== root && !present.has(cur)) {
      if (seen.has(cur)) { cur = root; break; } // cycle guard, should never happen
      seen.add(cur);
      cur = fullParentIndex.get(cur) ?? root;
    }
    resolveCache.set(srn, cur);
    return cur;
  };

  for (const n of nodes) parentOf.set(n.srn, resolve(n.srn));

  const childCount = new Map<string, number>();
  for (const p of parentOf.values()) childCount.set(p, (childCount.get(p) ?? 0) + 1);

  const depthOf = new Map<string, number>([[root, 0]]);
  const depthOfNode = (srn: string): number => {
    const cached = depthOf.get(srn);
    if (cached !== undefined) return cached;
    const d = 1 + depthOfNode(parentOf.get(srn) ?? root);
    depthOf.set(srn, d);
    return d;
  };
  for (const n of nodes) depthOfNode(n.srn);

  const edges: HierarchyEdge[] = [];
  for (const [child, p] of parentOf) {
    edges.push({ id: `hier:${p}->${child}`, src: p, dst: child, depth: depthOf.get(child) ?? 1 });
  }

  return { parentOf, childCount, edges, depthOf };
}
