// Pure layout/color helpers for the Graph Layer's Explore + Canvas views.
// Kept dependency-free and side-effect-free so they're trivially unit-testable.

import type { GraphEntityType } from '../types';

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
};

export function nodeColor(type: GraphEntityType, status?: string | null): string {
  if (type === 'task' && status === 'done') return '#10b981';
  return NODE_TYPE_COLOR[type] ?? '#9d8dff';
}

export const ENTITY_TYPE_LABEL: Record<GraphEntityType, string> = {
  task: 'Task', list: 'Board', markdownList: 'Page', timeline: 'Timeline',
  milestone: 'Milestone', meeting: 'Meeting', folder: 'Folder', file: 'File',
  section: 'Section', gpsFile: 'GPS Route',
};

export const ENTITY_TYPE_LABEL_PLURAL: Record<GraphEntityType, string> = {
  task: 'Tasks', list: 'Boards', markdownList: 'Pages', timeline: 'Timelines',
  milestone: 'Milestones', meeting: 'Meetings', folder: 'Folders', file: 'Files',
  section: 'Sections', gpsFile: 'GPS Routes',
};

export const ENTITY_TYPE_ICON: Record<GraphEntityType, string> = {
  task: 'check_box', list: 'view_kanban', markdownList: 'description', timeline: 'timeline',
  milestone: 'flag', meeting: 'event', folder: 'folder', file: 'draft',
  section: 'view_agenda', gpsFile: 'route',
};

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
