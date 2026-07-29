import { useMemo, useCallback } from 'react';
import {
  ReactFlow, Background, Controls, Handle, Position,
  type Node as RFNode, type Edge as RFEdge, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { GraphNode, GraphEdge } from '../../types';
import Icon from '../Icon';
import { nodeColor, nodeSize } from '../../utils/graphLayout';

const TYPE_ICON: Record<string, string> = {
  task: 'check_circle', list: 'view_kanban', markdownList: 'description', timeline: 'timeline',
  milestone: 'flag', meeting: 'event', folder: 'folder', file: 'draft', gpsFile: 'route', section: 'segment',
};

function EntityNode({ data }: NodeProps) {
  const node = data as unknown as { node: GraphNode; focused?: boolean };
  const n = node.node;
  const size = Math.max(nodeSize(n.degree), 28);
  return (
    <div
      style={{
        width: size + 60, padding: '6px 10px', borderRadius: 10, display: 'flex', alignItems: 'center', gap: 6,
        background: node.focused ? 'var(--color-surface-tint)' : '#fff',
        border: `2px solid ${node.focused ? 'var(--color-primary)' : nodeColor(n.type, n.status)}`,
        boxShadow: '0 2px 8px rgba(0,0,0,0.06)', fontSize: 12, cursor: 'pointer',
        opacity: n.isArchived ? 0.5 : 1,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Icon name={TYPE_ICON[n.type] ?? 'circle'} size={14} color={nodeColor(n.type, n.status)} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{n.title || 'Untitled'}</span>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const RF_NODE_TYPES = { entity: EntityNode };

/** Deterministic 3-column layout for a local/focused graph: backlinks left, focus center, outgoing right — one extra column per depth level. */
function localLayout(nodes: GraphNode[], edges: GraphEdge[], focusSrn: string | null): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (!focusSrn) return positions;
  const incoming = new Set(edges.filter((e) => e.dst === focusSrn).map((e) => e.src));
  const outgoing = new Set(edges.filter((e) => e.src === focusSrn).map((e) => e.dst));

  positions.set(focusSrn, { x: 0, y: 0 });
  const columnGapX = 260;
  const rowGapY = 70;

  const byDepth = new Map<number, GraphNode[]>();
  for (const n of nodes) {
    if (n.srn === focusSrn) continue;
    const depth = n.depth ?? 1;
    (byDepth.get(depth) ?? byDepth.set(depth, []).get(depth)!).push(n);
  }

  for (const [depth, group] of byDepth) {
    // depth-1 nodes split left (incoming/backlinks) vs right (outgoing); deeper
    // levels keep whichever side their depth-1 ancestor was on by simple
    // left/right split based on which set they first touched.
    const left = group.filter((n) => incoming.has(n.srn) && !outgoing.has(n.srn));
    const right = group.filter((n) => !left.includes(n));
    left.forEach((n, i) => positions.set(n.srn, { x: -columnGapX * depth, y: (i - (left.length - 1) / 2) * rowGapY }));
    right.forEach((n, i) => positions.set(n.srn, { x: columnGapX * depth, y: (i - (right.length - 1) / 2) * rowGapY }));
  }
  return positions;
}

/** Simple deterministic radial layout for the unfocused Explore graph (no force simulation dependency). */
function radialLayout(nodes: GraphNode[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
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

export default function FlowGraph({
  nodes, edges, focusSrn, mode, onNodeClick,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  focusSrn?: string | null;
  mode: 'local' | 'explore';
  onNodeClick: (node: GraphNode) => void;
}) {
  const positions = useMemo(
    () => (mode === 'local' ? localLayout(nodes, edges, focusSrn ?? null) : radialLayout(nodes)),
    [nodes, edges, focusSrn, mode]
  );

  const rfNodes: RFNode[] = useMemo(() => nodes.map((n) => ({
    id: n.srn,
    type: 'entity',
    position: positions.get(n.srn) ?? { x: 0, y: 0 },
    data: { node: n, focused: n.srn === focusSrn } as unknown as Record<string, unknown>,
  })), [nodes, positions, focusSrn]);

  const rfEdges: RFEdge[] = useMemo(() => edges.map((e) => ({
    id: e.id,
    source: e.src,
    target: e.dst,
    animated: false,
    style: { stroke: e.crossWorkspace ? 'var(--color-warning)' : 'var(--color-purple-tint-3, #c4b8f0)', strokeWidth: 1.5 },
  })), [edges]);

  const handleNodeClick = useCallback((_: unknown, rfNode: RFNode) => {
    const n = nodes.find((x) => x.srn === rfNode.id);
    if (n) onNodeClick(n);
  }, [nodes, onNodeClick]);

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={RF_NODE_TYPES}
      onNodeClick={handleNodeClick}
      nodesConnectable={false}
      nodesDraggable={false}
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={18} color="var(--color-purple-pale-34, #f0edff)" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
