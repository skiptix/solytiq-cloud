import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '../Icon';
import { apiGetWorkspaceGraph } from '../../api/client';
import { nodeColor, nodeSize } from '../../utils/graphLayout';
import type { GraphNode } from '../../types';

/** Compact, read-only preview of a workspace's graph — embedded in the
 *  Dashboard's right column, links out to the full Graph screen. */
export default function GraphMiniMap({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGetWorkspaceGraph(workspaceId, { limit: 60 })
      .then((r) => { if (!cancelled) setNodes(r.nodes); })
      .catch(() => { if (!cancelled) setNodes([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const top = [...nodes].sort((a, b) => b.pagerank - a.pagerank).slice(0, 20);
  // Deterministic scatter, purely cosmetic (this is a preview, not the real graph).
  const positioned = top.map((n, i) => {
    const angle = (i / Math.max(top.length, 1)) * Math.PI * 2;
    const radius = 20 + (i % 3) * 22;
    return { n, x: 50 + Math.cos(angle) * radius, y: 45 + Math.sin(angle) * radius };
  });

  return (
    <div style={{
      background: 'var(--color-surface-gray, #f9fafb)', borderRadius: 16, border: '1px solid var(--color-border)',
      padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13 }}>Net</span>
        <button
          onClick={() => navigate('/graph')}
          style={{ background: 'none', border: 'none', color: 'var(--color-primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}
        >
          Open <Icon name="arrow_forward" size={14} />
        </button>
      </div>
      <div style={{ position: 'relative', height: 200, background: '#fff', borderRadius: 10, overflow: 'hidden' }}>
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-quaternary)', fontSize: 12 }}>
            Loading…
          </div>
        )}
        {!loading && nodes.length === 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-quaternary)', fontSize: 12, textAlign: 'center', padding: 12 }}>
            No connections yet — link a task, board, or page to see them here.
          </div>
        )}
        <svg width="100%" height="100%" viewBox="0 0 100 90" preserveAspectRatio="xMidYMid meet">
          {positioned.map(({ n, x, y }) => (
            <circle key={n.srn} cx={x} cy={y} r={Math.max(nodeSize(n.degree) / 6, 1.2)} fill={nodeColor(n.type, n.status)} opacity={0.85} />
          ))}
        </svg>
      </div>
    </div>
  );
}
