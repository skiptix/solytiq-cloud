import { create } from 'zustand';
import type { GraphNode, GraphEdge, GraphEntityType } from '../types';
import { apiGetWorkspaceGraph, apiGetLocalGraph } from '../api/client';

export interface GraphFilters {
  entityTypes: GraphEntityType[];
  linkTypes: string[];
  showCompleted: boolean;
  showOrphans: boolean;
  depth: number;
}

// The Net view always renders every entity in the workspace, connected
// hierarchically up to the workspace root (see hooks/useGraphHierarchy.ts) —
// there's no such thing as a structurally disconnected node anymore, so
// `showOrphans` defaults to true. It still narrows out entities that have no
// EXPLICIT entity_links relation (real cross-links, not the structural
// containment tree) for someone who wants to see just the "interesting"
// connections. Structural `part_of` edges stay hidden from the relation
// rendering by default (CLAUDE.md's "not the Hairball" rule) — the
// hierarchy tree supersedes them visually.
const DEFAULT_FILTERS: GraphFilters = {
  entityTypes: [],
  linkTypes: [],
  showCompleted: true,
  showOrphans: true,
  depth: 2,
};

interface GraphState {
  workspaceId: string | null;
  allNodes: GraphNode[];
  allEdges: GraphEdge[];
  hidden: { nodes: number; edges: number };
  truncated: boolean;
  loading: boolean;
  loaded: boolean;
  filters: GraphFilters;
  focusSrn: string | null;
  selectedSrn: string | null;
  dirty: boolean;

  loadWorkspaceGraph: (workspaceId: string) => Promise<void>;
  loadLocalGraph: (srn: string, depth?: number) => Promise<void>;
  setFilter: <K extends keyof GraphFilters>(key: K, value: GraphFilters[K]) => void;
  resetFilters: () => void;
  focusNode: (srn: string | null) => void;
  selectNode: (srn: string | null) => void;
  markDirty: () => void;

  /** Filtered, render-ready node/edge lists — computed client-side, no network. */
  visibleNodes: () => GraphNode[];
  visibleEdges: () => GraphEdge[];
}

const PART_OF = 'part_of';

const useGraphStore = create<GraphState>()((set, get) => ({
  workspaceId: null,
  allNodes: [],
  allEdges: [],
  hidden: { nodes: 0, edges: 0 },
  truncated: false,
  loading: false,
  loaded: false,
  filters: { ...DEFAULT_FILTERS },
  focusSrn: null,
  selectedSrn: null,
  dirty: false,

  loadWorkspaceGraph: async (workspaceId) => {
    set({ loading: true, workspaceId });
    try {
      const payload = await apiGetWorkspaceGraph(workspaceId);
      set({
        allNodes: payload.nodes, allEdges: payload.edges, hidden: payload.hidden,
        truncated: payload.truncated, loading: false, loaded: true, dirty: false,
      });
    } catch (err) {
      set({ loading: false });
      throw err;
    }
  },

  loadLocalGraph: async (srn, depth) => {
    const [type, id] = srn.replace('srn:', '').split(':');
    set({ loading: true, focusSrn: srn });
    try {
      const payload = await apiGetLocalGraph(type, id, depth ?? get().filters.depth);
      set({
        allNodes: payload.nodes, allEdges: payload.edges, hidden: payload.hidden,
        truncated: payload.truncated, loading: false, loaded: true, dirty: false,
      });
    } catch (err) {
      set({ loading: false });
      throw err;
    }
  },

  setFilter: (key, value) => set((s) => ({ filters: { ...s.filters, [key]: value } })),
  resetFilters: () => set({ filters: { ...DEFAULT_FILTERS } }),
  focusNode: (srn) => set({ focusSrn: srn }),
  selectNode: (srn) => set({ selectedSrn: srn }),
  markDirty: () => set({ dirty: true }),

  visibleNodes: () => {
    const { allNodes, allEdges, filters } = get();
    let nodes = allNodes;
    if (filters.entityTypes.length > 0) nodes = nodes.filter((n) => filters.entityTypes.includes(n.type));
    if (!filters.showCompleted) {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      nodes = nodes.filter((n) => !(n.type === 'task' && n.status === 'done'));
      void cutoff; // completed-age filtering needs updatedAt on the node — reserved for a follow-up refinement
    }
    if (!filters.showOrphans) {
      // Only real relations count here — a node touched only by a hidden,
      // structural part_of edge is still an "orphan" for this filter's
      // purpose (it has no explicit relation), even though the Net view
      // will still draw it into the hierarchy tree regardless.
      const connected = new Set<string>();
      for (const e of allEdges) { if (e.linkType === PART_OF) continue; connected.add(e.src); connected.add(e.dst); }
      nodes = nodes.filter((n) => connected.has(n.srn));
    }
    return nodes;
  },

  visibleEdges: () => {
    const { allEdges, filters } = get();
    const visibleSrns = new Set(get().visibleNodes().map((n) => n.srn));
    let edges = allEdges.filter((e) => visibleSrns.has(e.src) && visibleSrns.has(e.dst));
    if (filters.linkTypes.length > 0) edges = edges.filter((e) => filters.linkTypes.includes(e.linkType));
    else edges = edges.filter((e) => e.linkType !== PART_OF); // structural edges hidden by default
    return edges;
  },
}));

export default useGraphStore;
