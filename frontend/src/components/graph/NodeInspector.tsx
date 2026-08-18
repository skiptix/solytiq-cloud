// ---------------------------------------------------------------------------
// The Net view's node-details popup — floats anchored to the clicked node
// (see NeuralGraph.tsx's `selectedAnchor`, live-tracked each frame) rather
// than a fixed side panel, so it reads as "details about the thing you just
// clicked" instead of a separate, disconnected pane.
//
// Relations are shown with their human label (from the link-type registry's
// `label`/`inverseLabel`, matching the direction) and structural types
// (`showInGraph: false` — currently just `part_of`) are hidden entirely:
// that containment is already drawn as the hierarchy tree itself, so
// surfacing the raw internal type name again here would just be jargon.
// ---------------------------------------------------------------------------

import { useNavigate } from 'react-router-dom';
import type { ResolvedLink, LinkTypeDef } from '../../types';
import type { NetRenderNode } from '../../utils/graphHierarchy';
import Icon from '../Icon';
import { apiGetEntityLinks, apiGetLinkTypes } from '../../api/client';
import { nodeColor, nodeIcon, ENTITY_TYPE_LABEL } from '../../utils/graphLayout';
import { EASE_SETTLE } from '../animate-ui/motionTokens';
import MotionIn from '../animate-ui/MotionIn';
import MotionButton from '../animate-ui/MotionButton';
import useAsyncData from '../../hooks/useAsyncData';

const POPUP_W = 292;
const MAX_H = 400;

function prettifyLinkType(key: string): string {
  return key.replace(/^x_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function StatusPill({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      fontFamily: 'var(--font-heading)', fontSize: 10, fontWeight: 700, color, background: `${color}18`,
      borderRadius: 9999, padding: '2px 7px', textTransform: 'uppercase', letterSpacing: '0.03em',
    }}>
      {label}
    </span>
  );
}

interface NodeInspectorProps {
  node: NetRenderNode;
  /** Root -> ... -> node, inclusive (the node itself is the last entry). */
  breadcrumb: NetRenderNode[];
  anchor: { x: number; y: number };
  containerSize: { w: number; h: number };
  workspaceId: string;
  onClose: () => void;
  onCenter: () => void;
  onBreadcrumbClick: (node: NetRenderNode) => void;
}

/** Stable identity — returned as `data`, so an inline literal would be a new reference every render. */
const EMPTY_LINK_TYPES: Record<string, LinkTypeDef> = {};

export default function NodeInspector({ node, breadcrumb, anchor, containerSize, workspaceId, onClose, onCenter, onBreadcrumbClick }: NodeInspectorProps) {
  const navigate = useNavigate();
  const isWorkspace = node.type === 'workspace';

  // The synthetic workspace root is not a real entity and has no links to
  // fetch — expressed as "nothing to load" rather than a guard that clears
  // state after the fact.
  const { data: linksByType, loading } = useAsyncData(
    isWorkspace ? null : { type: node.type, id: node.id },
    async () => (await apiGetEntityLinks(node.type, node.id)).linksByType,
    null as Record<string, ResolvedLink[]> | null,
  );

  const { data: linkTypeDefs } = useAsyncData(
    workspaceId,
    async () => Object.fromEntries((await apiGetLinkTypes(workspaceId)).types.map((t) => [t.key, t])),
    EMPTY_LINK_TYPES,
  );

  const relationGroups = Object.entries(linksByType ?? {})
    .filter(([key]) => linkTypeDefs[key]?.showInGraph !== false)
    .map(([key, links]) => {
      const def = linkTypeDefs[key];
      return { key, links, outLabel: def?.label ?? prettifyLinkType(key), inLabel: def?.inverseLabel ?? prettifyLinkType(key) };
    });
  const totalRelations = relationGroups.reduce((s, r) => s + r.links.length, 0);

  let left = anchor.x + 24;
  if (left + POPUP_W + 12 > containerSize.w) left = anchor.x - 24 - POPUP_W;
  left = Math.max(10, Math.min(left, containerSize.w - POPUP_W - 10));
  let top = anchor.y - 96;
  top = Math.max(56, Math.min(top, containerSize.h - MAX_H - 10));

  const color = nodeColor(node.type, node.status);
  const muted: React.CSSProperties = { fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' };

  return (
    <MotionIn
      initial={{ opacity: 0, y: 12, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.2, ease: EASE_SETTLE }} style={{
        position: 'absolute', left, top, width: POPUP_W, maxHeight: MAX_H, overflowY: 'auto', zIndex: 8,
        display: 'flex', flexDirection: 'column', gap: 10, padding: 14,
        background: 'var(--color-white)', borderRadius: 14, border: '1px solid var(--color-border)',
        boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.2)',
        // The canvas disables text selection so drags don't highlight node
        // labels — undo that inherited rule here, this is a normal panel.
        userSelect: 'text', WebkitUserSelect: 'text',
      }}
    >
      {breadcrumb.length > 1 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, fontFamily: 'var(--font-body)', fontSize: 11 }}>
          {breadcrumb.slice(0, -1).map((crumb) => (
            <span key={crumb.srn} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <MotionButton
                onClick={() => onBreadcrumbClick(crumb)}
                style={{
                  background: 'none', border: 'none', padding: '2px 2px', cursor: 'pointer', color: 'var(--color-text-tertiary)',
                  font: 'inherit', maxWidth: 92, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
                whileHover={{ color: 'var(--color-primary)' }}
                transition={{ duration: 0.15 }}
              >
                {crumb.emoji ? `${crumb.emoji} ` : ''}{crumb.title || (crumb.type === 'workspace' ? 'Workspace' : 'Untitled')}
              </MotionButton>
              <Icon name="chevron_right" size={11} color="var(--color-text-quaternary)" />
            </span>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ width: 30, height: 30, borderRadius: '50%', background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon name={nodeIcon(node.type)} size={16} color="#fff" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 14.5, color: 'var(--color-text-primary)', wordBreak: 'break-word' }}>
            {node.title || (isWorkspace ? 'Workspace' : 'Untitled')}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 3 }}>
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
              {node.type === 'workspace' ? 'Workspace' : ENTITY_TYPE_LABEL[node.type]}
            </span>
            {node.type === 'task' && node.status === 'done' && <StatusPill label="Done" color="var(--color-success)" />}
            {node.isArchived && <StatusPill label="Archived" color="var(--color-text-quaternary)" />}
          </div>
        </div>
        <MotionButton
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', display: 'flex', padding: 2 }}
          whileHover={{ color: 'var(--color-text-primary)' }}
          transition={{ duration: 0.15 }}
        >
          <Icon name="close" size={17} />
        </MotionButton>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        {node.deepLink && (
          <MotionButton
            onClick={() => navigate(node.deepLink!)}
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '7px 10px', borderRadius: 8, border: 'none', background: 'var(--color-primary)', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
            whileHover={{ scale: 1.02 }}
            transition={{ duration: 0.15 }}
          >
            <Icon name="open_in_new" size={14} color="var(--color-white)" /> Open
          </MotionButton>
        )}
        <MotionButton
          onClick={onCenter}
          title="Re-center the view on this item"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-white)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
          whileHover={{ borderColor: 'var(--color-primary)', color: 'var(--color-primary)' }}
          transition={{ duration: 0.15 }}
        >
          <Icon name="filter_center_focus" size={14} />
        </MotionButton>
      </div>

      {!isWorkspace && (
        <div style={{ borderTop: '1px solid var(--color-divider)', paddingTop: 10 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, marginBottom: 6, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Connections{totalRelations > 0 ? ` (${totalRelations})` : ''}
          </div>
          {loading && <div style={muted}>Loading…</div>}
          {!loading && totalRelations === 0 && (
            <div style={muted}>Not connected to anything else yet.</div>
          )}
          {!loading && relationGroups.map(({ key, links, outLabel, inLabel }) => (
            <div key={key}>
              {links.map((l) => (
                <button
                  key={l.id}
                  onClick={() => l.neighbor?.deepLink && navigate(l.neighbor.deepLink)}
                  disabled={!l.neighbor?.deepLink}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                    padding: '5px 6px', borderRadius: 8, border: 'none', background: 'transparent',
                    cursor: l.neighbor?.deepLink ? 'pointer' : 'default', marginBottom: 2,
                  }}
                  onMouseEnter={(e) => { if (l.neighbor?.deepLink) e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={{
                    width: 20, height: 20, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: l.neighbor ? nodeColor(l.neighbor.entityType) : 'var(--color-purple-tint-3, #c4b8f0)',
                  }}>
                    <Icon name={l.neighbor ? nodeIcon(l.neighbor.entityType) : 'lock'} size={11} color="#fff" />
                  </span>
                  <span style={{
                    flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    fontFamily: 'var(--font-body)', fontSize: 12.5, fontWeight: 500,
                    color: l.neighbor ? 'var(--color-text-primary)' : 'var(--color-text-quaternary)',
                  }}>
                    {l.neighbor?.title ?? 'Restricted item'}
                  </span>
                  <span style={{ flexShrink: 0, fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-text-quaternary)' }}>
                    {l.direction === 'out' ? outLabel : inLabel}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </MotionIn>
  );
}
