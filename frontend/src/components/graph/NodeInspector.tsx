import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ResolvedLink } from '../../types';
import type { NetRenderNode } from '../../utils/graphHierarchy';
import Icon from '../Icon';
import { apiGetEntityLinks } from '../../api/client';
import { nodeColor } from '../../utils/graphLayout';

export default function NodeInspector({ node, onClose, onFocus }: { node: NetRenderNode; onClose: () => void; onFocus: (srn: string) => void }) {
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
      padding: 16, background: 'var(--color-white)', borderRadius: 14, border: '1px solid var(--color-border)',
      boxShadow: '0 1px 2px rgba(var(--color-black-rgb), 0.04)', maxHeight: '100%', overflowY: 'auto',
      animation: 'cardIn 240ms cubic-bezier(0.34,1.56,0.64,1) both',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 12, height: 12, borderRadius: 6, background: nodeColor(node.type, node.status), flexShrink: 0 }} />
          <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 14.5, color: 'var(--color-text-primary)' }}>{node.title || 'Untitled'}</span>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', display: 'flex', padding: 2, transition: 'color 150ms' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-tertiary)'; }}>
          <Icon name="close" size={18} />
        </button>
      </div>

      <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>{node.type} · degree {node.degree}</div>

      <div style={{ display: 'flex', gap: 8 }}>
        {node.deepLink && (
          <button
            onClick={() => navigate(node.deepLink!)}
            style={{ flex: 1, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--color-primary)', background: 'var(--color-surface-tint)', color: 'var(--color-primary)', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', transition: 'background 150ms' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-purple-pale-13, #ece7fa)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
          >
            Open
          </button>
        )}
        <button
          onClick={() => onFocus(node.srn)}
          style={{ flex: 1, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-white)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', transition: 'all 150ms' }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.color = 'var(--color-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--color-border)'; e.currentTarget.style.color = 'var(--color-text-secondary)'; }}
        >
          Focus in graph
        </button>
      </div>

      <div style={{ borderTop: '1px solid var(--color-divider)', paddingTop: 10 }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 700, marginBottom: 8, color: 'var(--color-text-primary)' }}>Relations</div>
        {loading && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>Loading…</div>}
        {!loading && linksByType && Object.keys(linksByType).length === 0 && (
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>No connections yet.</div>
        )}
        {!loading && linksByType && Object.entries(linksByType).map(([type, links]) => (
          <div key={type} style={{ marginBottom: 8 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{type} ({links.length})</div>
            {links.map((l) => (
              <button
                key={l.id}
                onClick={() => l.neighbor && onFocus(l.neighbor.srn)}
                disabled={!l.neighbor}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
                  padding: '4px 6px', borderRadius: 6, border: 'none', background: 'transparent', cursor: l.neighbor ? 'pointer' : 'default',
                  fontFamily: 'var(--font-body)', fontSize: 12.5, color: l.neighbor ? 'var(--color-text-primary)' : 'var(--color-text-quaternary)', transition: 'background 120ms',
                }}
                onMouseEnter={(e) => { if (l.neighbor) e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
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
