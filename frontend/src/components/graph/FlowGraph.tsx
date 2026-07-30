import { useMemo, useCallback } from 'react';
import {
  ReactFlow, Background, Controls, Handle, Position,
  type Node as RFNode, type Edge as RFEdge, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { GraphNode, GraphEdge } from '../../types';
import Icon from '../Icon';
import { nodeColor, nodeSize, localLayout, radialLayout } from '../../utils/graphLayout';

export const TYPE_ICON: Record<string, string> = {
  task: 'check_circle', list: 'view_kanban', markdownList: 'description', timeline: 'timeline',
  milestone: 'flag', meeting: 'event', folder: 'folder', file: 'draft', gpsFile: 'route', section: 'segment',
};

export function EntityNode({ data }: NodeProps) {
  const node = data as unknown as { node: GraphNode; focused?: boolean; onRemove?: () => void; onOpen?: () => void };
  const n = node.node;
  const size = Math.max(nodeSize(n.degree), 28);
  return (
    <div
      style={{
        position: 'relative', width: size + 60, padding: '6px 10px', borderRadius: 10, display: 'flex', alignItems: 'center', gap: 6,
        background: node.focused ? 'var(--color-surface-tint)' : '#fff',
        border: `2px solid ${node.focused ? 'var(--color-primary)' : nodeColor(n.type, n.status)}`,
        boxShadow: '0 2px 8px rgba(0,0,0,0.06)', fontSize: 12, cursor: 'grab',
        opacity: n.isArchived ? 0.5 : 1,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Icon name={TYPE_ICON[n.type] ?? 'circle'} size={14} color={nodeColor(n.type, n.status)} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{n.title || 'Untitled'}</span>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      {/* Canvas-only actions — Explore's nodes never pass these, so nothing renders there. `nodrag`/`nopan` (XYFlow convention) keep a click on these from starting a node drag or canvas pan. */}
      {node.onOpen && (
        <button
          className="nodrag nopan"
          onClick={(e) => { e.stopPropagation(); node.onOpen!(); }}
          title="Open"
          style={{ position: 'absolute', top: -8, right: node.onRemove ? 14 : -8, width: 18, height: 18, borderRadius: '50%', border: '1px solid var(--color-border)', background: 'var(--color-white)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}
        >
          <Icon name="open_in_new" size={11} color="var(--color-primary)" />
        </button>
      )}
      {node.onRemove && (
        <button
          className="nodrag nopan"
          onClick={(e) => { e.stopPropagation(); node.onRemove!(); }}
          title="Remove from canvas"
          style={{ position: 'absolute', top: -8, right: -8, width: 18, height: 18, borderRadius: '50%', border: '1px solid var(--color-border)', background: 'var(--color-white)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}
        >
          <Icon name="close" size={11} color="var(--color-text-tertiary)" />
        </button>
      )}
    </div>
  );
}

export const RF_NODE_TYPES = { entity: EntityNode };

export default function FlowGraph({
  nodes, edges, focusSrn, mode, onNodeClick, positionOverrides, onNodeDragStop,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  focusSrn?: string | null;
  mode: 'local' | 'explore';
  onNodeClick: (node: GraphNode) => void;
  /** Manually-dragged positions (srn -> {x,y}) layered on top of the auto-computed layout. */
  positionOverrides?: Record<string, { x: number; y: number }>;
  /** When provided, nodes become draggable and this fires (srn, x, y) once a drag ends. */
  onNodeDragStop?: (srn: string, x: number, y: number) => void;
}) {
  const positions = useMemo(
    () => (mode === 'local' ? localLayout(nodes, edges, focusSrn ?? null) : radialLayout(nodes)),
    [nodes, edges, focusSrn, mode]
  );

  const rfNodes: RFNode[] = useMemo(() => nodes.map((n) => ({
    id: n.srn,
    type: 'entity',
    position: positionOverrides?.[n.srn] ?? positions.get(n.srn) ?? { x: 0, y: 0 },
    data: { node: n, focused: n.srn === focusSrn } as unknown as Record<string, unknown>,
  })), [nodes, positions, focusSrn, positionOverrides]);

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

  const handleNodeDragStop = useCallback((_: unknown, rfNode: RFNode) => {
    onNodeDragStop?.(rfNode.id, rfNode.position.x, rfNode.position.y);
  }, [onNodeDragStop]);

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={RF_NODE_TYPES}
      onNodeClick={handleNodeClick}
      onNodeDragStop={onNodeDragStop ? handleNodeDragStop : undefined}
      nodesConnectable={false}
      nodesDraggable={!!onNodeDragStop}
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={18} color="var(--color-purple-pale-34, #f0edff)" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
