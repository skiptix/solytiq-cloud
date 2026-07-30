// React Flow node type shared by the Canvas view (GraphScreen.tsx's
// CanvasView renders <ReactFlow> directly with this nodeTypes map — drag,
// pan, and connect-to-create-a-link are native XYFlow interactions that fit
// a curated canvas better than the Explore view's own force simulation, see
// components/graph/NeuralGraph.tsx). Styled as a small icon dot to match the
// Net view's node language rather than a boxed label.
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { GraphNode } from '../../types';
import Icon from '../Icon';
import { nodeColor, nodeIcon, nodeSize } from '../../utils/graphLayout';

export function EntityNode({ data }: NodeProps) {
  const node = data as unknown as { node: GraphNode; focused?: boolean; onRemove?: () => void; onOpen?: () => void };
  const n = node.node;
  const dotSize = Math.max(nodeSize(n.degree), 26);
  const color = nodeColor(n.type, n.status);
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, cursor: 'grab', opacity: n.isArchived ? 0.5 : 1 }}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div
        style={{
          width: dotSize, height: dotSize, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: color, border: `2px solid ${node.focused ? 'var(--color-text-primary)' : 'rgba(255,255,255,0.6)'}`,
          boxShadow: node.focused ? `0 0 0 3px ${color}33, 0 4px 14px rgba(0,0,0,0.16)` : '0 2px 8px rgba(0,0,0,0.12)',
          transition: 'box-shadow 150ms',
        }}
      >
        <Icon name={nodeIcon(n.type)} size={Math.round(dotSize * 0.52)} color="#fff" />
      </div>
      <span style={{
        maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center',
        fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 11.5, color: 'var(--color-text-primary)',
      }}>
        {n.title || 'Untitled'}
      </span>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      {/* Canvas-only actions — `nodrag`/`nopan` (XYFlow convention) keep a click on these from starting a node drag or canvas pan. */}
      {node.onOpen && (
        <button
          className="nodrag nopan"
          onClick={(e) => { e.stopPropagation(); node.onOpen!(); }}
          title="Open"
          style={{ position: 'absolute', top: -4, right: node.onRemove ? 18 : -4, width: 18, height: 18, borderRadius: '50%', border: '1px solid var(--color-border)', background: 'var(--color-white)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}
        >
          <Icon name="open_in_new" size={11} color="var(--color-primary)" />
        </button>
      )}
      {node.onRemove && (
        <button
          className="nodrag nopan"
          onClick={(e) => { e.stopPropagation(); node.onRemove!(); }}
          title="Remove from canvas"
          style={{ position: 'absolute', top: -4, right: -4, width: 18, height: 18, borderRadius: '50%', border: '1px solid var(--color-border)', background: 'var(--color-white)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}
        >
          <Icon name="close" size={11} color="var(--color-text-tertiary)" />
        </button>
      )}
    </div>
  );
}

export const RF_NODE_TYPES = { entity: EntityNode };
