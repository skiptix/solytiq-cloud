// Pure layout/color helpers for the Graph Layer's Explore + Canvas views.
// Kept dependency-free and side-effect-free so they're trivially unit-testable.

import type { GraphEntityType, GraphNode } from '../types';

// Node colors strictly from the existing design tokens (CLAUDE.md's "Graph must
// use these tokens" rule) — no bespoke graph palette.
export const NODE_TYPE_COLOR: Record<GraphEntityType, string> = {
  markdownList: '#5e4dbb',
  list: '#9d8dff',
  task: '#787584',
  timeline: '#d97706',
  milestone: '#f59e0b',
  meeting: '#ea580c',
  file: '#b0acbe',
  gpsFile: '#b0acbe',
  folder: '#c9c4d5',
  section: '#e8e4f0',
  // The Knowledge Base is the workspace's semantic hub — primary purple, the
  // same weight the synthetic workspace root carries, so it reads as a second
  // centre of gravity rather than as one more leaf.
  knowledgeBase: '#5e4dbb',
  knowledgeEntry: '#7c6ae0',
};

export const NODE_TYPE_SHAPE: Record<GraphEntityType, 'circle' | 'roundedSquare' | 'diamond' | 'hexagon' | 'square' | 'folder'> = {
  markdownList: 'circle',
  list: 'roundedSquare',
  task: 'circle',
  timeline: 'diamond',
  milestone: 'diamond',
  meeting: 'hexagon',
  file: 'square',
  gpsFile: 'square',
  folder: 'folder',
  section: 'square',
  knowledgeBase: 'hexagon',
  knowledgeEntry: 'circle',
};

export function nodeColor(type: GraphEntityType | 'workspace', status?: string | null): string {
  if (type === 'workspace') return '#5e4dbb'; // primary — the hub every workspace's Net is rooted at
  if (type === 'task' && status === 'done') return '#10b981';
  return NODE_TYPE_COLOR[type] ?? '#9d8dff';
}

export const ENTITY_TYPE_LABEL: Record<GraphEntityType, string> = {
  task: 'Task', list: 'Board', markdownList: 'Page', timeline: 'Timeline',
  milestone: 'Milestone', meeting: 'Meeting', folder: 'Folder', file: 'File',
  section: 'Section', gpsFile: 'GPS Route',
  knowledgeBase: 'Knowledge', knowledgeEntry: 'Entry',
};

export const ENTITY_TYPE_LABEL_PLURAL: Record<GraphEntityType, string> = {
  task: 'Tasks', list: 'Boards', markdownList: 'Pages', timeline: 'Timelines',
  milestone: 'Milestones', meeting: 'Meetings', folder: 'Folders', file: 'Files',
  section: 'Sections', gpsFile: 'GPS Routes',
  knowledgeBase: 'Knowledge', knowledgeEntry: 'Entries',
};

export const ENTITY_TYPE_ICON: Record<GraphEntityType, string> = {
  task: 'check_box', list: 'view_kanban', markdownList: 'description', timeline: 'timeline',
  milestone: 'flag', meeting: 'event', folder: 'folder', file: 'draft',
  section: 'view_agenda', gpsFile: 'route',
  knowledgeBase: 'neurology', knowledgeEntry: 'menu_book',
};

/** Small subtle glyph shown inside a Net dot — extends ENTITY_TYPE_ICON with
 *  the synthetic workspace-root node, which isn't a real backend entity type
 *  (see graphHierarchy.ts) so it can't live in the Record above without
 *  widening it for every other caller. */
export function nodeIcon(type: GraphEntityType | 'workspace'): string {
  if (type === 'workspace') return 'hub';
  return ENTITY_TYPE_ICON[type] ?? 'circle';
}

const MIN_NODE_SIZE = 4;
const NODE_SIZE_SCALE = 3;
const MAX_NODE_SIZE = 24;

/** Obsidian's degree-proportional sizing convention: 4 + sqrt(degree) * 3, capped at 24px. */
export function nodeSize(degree: number): number {
  const size = MIN_NODE_SIZE + Math.sqrt(Math.max(degree, 0)) * NODE_SIZE_SCALE;
  return Math.min(size, MAX_NODE_SIZE);
}

/** Above this many nodes, the Explore view switches from React Flow to the WebGL Sigma renderer. */
export const SIGMA_THRESHOLD_NODES = 300;

export function shouldUseSigma(nodeCount: number): boolean {
  return nodeCount > SIGMA_THRESHOLD_NODES;
}

export const EDGE_STYLE_DASH: Record<'solid' | 'dashed' | 'dotted', string | undefined> = {
  solid: undefined,
  dashed: '6 4',
  dotted: '2 3',
};

// ── hierarchy spring lengths ───────────────────────────────────────────
// A parent's children are laid out on concentric shells around it rather than
// on one circle at a fixed rest length. With a fixed length every sibling set —
// 3 children or 300 — gets pulled onto the same small circle, so a hub like a
// Knowledge Base with a hundred terms collapses into an unreadable ring of
// overlapping dots and labels. Sizing the ring from the sibling count (arc
// length per child) and spilling into further shells past MAX_PER_SHELL keeps
// on-screen density roughly constant however wide the graph gets.

/** Arc length each child is given on its shell, world units. */
const SIBLING_ARC = 46;
/** Past this many children on one shell, open another one further out. */
const MAX_PER_SHELL = 20;
/** Radial gap between consecutive shells, world units. */
const SHELL_GAP = 64;
/** Floor for a shell's radius, so small sibling sets keep their compact look. */
const HIERARCHY_BASE_DISTANCE = 58;

export interface HierarchyLinkSpec {
  /** Radius of the parent dot, world units — the ring starts outside it. */
  parentRadius: number;
  /** This child's stable slot among its siblings. */
  siblingIndex: number;
  /** How many children the parent has in total. */
  siblingCount: number;
  /** The child's depth from the root; deeper levels get slightly more room. */
  depth: number;
}

/** Spring rest length for one parent→child hierarchy edge. */
export function hierarchyLinkDistance({ parentRadius, siblingIndex, siblingCount, depth }: HierarchyLinkSpec): number {
  const shells = Math.max(1, Math.ceil(Math.max(siblingCount, 1) / MAX_PER_SHELL));
  const perShell = Math.ceil(Math.max(siblingCount, 1) / shells);
  // Interleaved (index % shells) rather than blocked, so the shells fill evenly
  // instead of the innermost one saturating first.
  const shell = siblingIndex % shells;
  const circumferenceFit = (perShell * SIBLING_ARC) / (2 * Math.PI);
  const ring = Math.max(HIERARCHY_BASE_DISTANCE + Math.min(depth, 4) * 10, circumferenceFit) + parentRadius;
  return ring + shell * SHELL_GAP;
}

export type LayoutPositions = Map<string, { x: number; y: number }>;

/** Simple deterministic radial layout — the Dashboard's live mini-map preview's layout basis (NeuralGraph.tsx uses a live force simulation instead, see utils/forceSimulation.ts). */
export function radialLayout(nodes: GraphNode[]): LayoutPositions {
  const positions: LayoutPositions = new Map();
  const sorted = [...nodes].sort((a, b) => b.pagerank - a.pagerank);
  const ringSize = 12;
  sorted.forEach((n, i) => {
    const ring = Math.floor(i / ringSize);
    const idxInRing = i % ringSize;
    const countInRing = Math.min(ringSize, sorted.length - ring * ringSize);
    const angle = (idxInRing / Math.max(countInRing, 1)) * Math.PI * 2;
    const radius = 90 + ring * 180;
    positions.set(n.srn, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  });
  return positions;
}
