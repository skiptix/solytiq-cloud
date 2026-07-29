import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GraphNode, ResolvedLink } from '../../types';
import Icon from '../Icon';
import { apiGetEntityLinks } from '../../api/client';
import { nodeColor } from '../../utils/graphLayout';

export default function NodeInspector({ node, onClose, onFocus }: { node: GraphNode; onClose: () => void; onFocus: (srn: string) => void }) {
  const navigate = useNavigate();
  const [linksByType, setLinksByType] = useState<Record<string, ResolvedLink[]> | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLinksByType(null);
    apiGetEntityLinks(node.type, node.id)
      .then((r) => { if (!cancelled) setLinksByType(r.linksByType); })
      .catch(() => { if (!cancelled) setLinksByType({}); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [node.type, node.id]);

  return (
    <div style={{
      width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12,
      padding: 16, background: '#fff', borderRadius: 14, border: '1px solid var(--color-border)',
      maxHeight: '100%', overflowY: 'auto',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 12, height: 12, borderRadius: 6, background: nodeColor(node.type, node.status), flexShrink: 0 }} />
          <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 14.5 }}>{node.title || 'Untitled'}</span>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)' }}>
          <Icon name="close" size={18} />
        </button>
      </div>

      <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{node.type} · degree {node.degree}</div>

      <div style={{ display: 'flex', gap: 8 }}>
        {node.deepLink && (
          <button
            onClick={() => navigate(node.deepLink!)}
            style={{ flex: 1, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--color-primary)', background: 'var(--color-surface-tint)', color: 'var(--color-primary)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
          >
            Open
          </button>
        )}
        <button
          onClick={() => onFocus(node.srn)}
          style={{ flex: 1, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--color-border)', background: '#fff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
        >
          Focus in graph
        </button>
      </div>

      <div style={{ borderTop: '1px solid var(--color-divider)', paddingTop: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, fontFamily: 'var(--font-heading)' }}>Relations</div>
        {loading && <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Loading…</div>}
        {!loading && linksByType && Object.keys(linksByType).length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>No connections yet.</div>
        )}
        {!loading && linksByType && Object.entries(linksByType).map(([type, links]) => (
          <div key={type} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 3 }}>{type} ({links.length})</div>
            {links.map((l) => (
              <button
                key={l.id}
                onClick={() => l.neighbor && onFocus(l.neighbor.srn)}
                disabled={!l.neighbor}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
                  padding: '4px 6px', borderRadius: 6, border: 'none', background: 'transparent', cursor: l.neighbor ? 'pointer' : 'default',
                  fontSize: 12.5, color: l.neighbor ? 'var(--color-text-primary)' : 'var(--color-text-quaternary)',
                }}
              >
                <Icon name={l.direction === 'out' ? 'arrow_forward' : 'arrow_back'} size={13} color="var(--color-text-quaternary)" />
                {l.neighbor?.title ?? '(restricted)'}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
