import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '../Icon';
import { apiGetWorkspaceGraph } from '../../api/client';
import { nodeColor, nodeSize, radialLayout } from '../../utils/graphLayout';
import useGraphStore from '../../store/useGraphStore';
import type { GraphNode, GraphEdge } from '../../types';

const VIEW_W = 100;
const VIEW_H = 90;
const PADDING = 10;

/** Live preview of a workspace's graph — embedded in the Dashboard's right
 *  column. Shares the exact radial layout FlowGraph's Explore view uses (not
 *  a cosmetic stand-in), draws real edges, and clicking a node jumps straight
 *  to it on the full Graph screen. Stretches to fill its column like every
 *  other Dashboard box. */
export default function GraphMiniMap({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const focusNode = useGraphStore((s) => s.focusNode);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGetWorkspaceGraph(workspaceId, { limit: 80 })
      .then((r) => { if (!cancelled) { setNodes(r.nodes); setEdges(r.edges); } })
      .catch(() => { if (!cancelled) { setNodes([]); setEdges([]); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const { positioned, linePoints } = useMemo(() => {
    const raw = radialLayout(nodes);
    if (raw.size === 0) return { positioned: [], linePoints: [] };

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const { x, y } of raw.values()) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const scale = Math.min((VIEW_W - PADDING * 2) / spanX, (VIEW_H - PADDING * 2) / spanY);
    const toView = (x: number, y: number) => ({
      x: PADDING + (x - minX) * scale + (VIEW_W - PADDING * 2 - spanX * scale) / 2,
      y: PADDING + (y - minY) * scale + (VIEW_H - PADDING * 2 - spanY * scale) / 2,
    });

    const positioned = nodes
      .filter((n) => raw.has(n.srn))
      .map((n) => ({ n, ...toView(raw.get(n.srn)!.x, raw.get(n.srn)!.y) }));
    const posBySrn = new Map(positioned.map((p) => [p.n.srn, p]));
    const linePoints = edges
      .filter((e) => e.linkType !== 'part_of') // structural edges hidden by default, same as the Explore view
      .map((e) => {
        const a = posBySrn.get(e.src);
        const b = posBySrn.get(e.dst);
        return a && b ? { id: e.id, x1: a.x, y1: a.y, x2: b.x, y2: b.y } : null;
      })
      .filter((l): l is { id: string; x1: number; y1: number; x2: number; y2: number } => l !== null);

    return { positioned, linePoints };
  }, [nodes, edges]);

  const openNode = (n: GraphNode) => {
    focusNode(n.srn);
    navigate('/graph');
  };

  return (
    <div style={{
      background: 'var(--color-surface-gray, #f9fafb)', borderRadius: 16, border: '1px solid var(--color-border)',
      padding: 14, display: 'flex', flexDirection: 'column', gap: 10, flex: '1 1 0%', minHeight: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13, color: 'var(--color-text-primary)' }}>Net</span>
        <button
          onClick={() => navigate('/graph')}
          style={{ background: 'none', border: 'none', color: 'var(--color-primary)', fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}
        >
          Open <Icon name="arrow_forward" size={14} />
        </button>
      </div>
      <div style={{ position: 'relative', flex: '1 1 0%', minHeight: 140, background: 'var(--color-white)', borderRadius: 10, overflow: 'hidden' }}>
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-body)', fontSize: 12 }}>
            Loading…
          </div>
        )}
        {!loading && nodes.length === 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-body)', fontSize: 12, textAlign: 'center', padding: 12 }}>
            No connections yet — link a task, board, or page to see them here.
          </div>
        )}
        <svg width="100%" height="100%" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="xMidYMid meet">
          {linePoints.map((l) => (
            <line key={l.id} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="var(--color-purple-pale-34, #f0edff)" strokeWidth={0.6} />
          ))}
          {positioned.map(({ n, x, y }) => (
            <circle
              key={n.srn} cx={x} cy={y}
              r={Math.max(nodeSize(n.degree) / 6, 1.4) * (hovered === n.srn ? 1.6 : 1)}
              fill={nodeColor(n.type, n.status)}
              opacity={hovered && hovered !== n.srn ? 0.45 : 0.9}
              style={{ cursor: 'pointer', transition: 'r 120ms, opacity 120ms' }}
              onMouseEnter={() => setHovered(n.srn)}
              onMouseLeave={() => setHovered((h) => (h === n.srn ? null : h))}
              onClick={() => openNode(n)}
            >
              <title>{n.title || 'Untitled'}</title>
            </circle>
          ))}
        </svg>
      </div>
    </div>
  );
}
