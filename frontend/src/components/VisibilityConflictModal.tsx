import { createPortal } from 'react-dom';
import type { VisibilityConflict } from '../api/client';
import Icon from './Icon';

interface VisibilityConflictModalProps {
  conflict: VisibilityConflict;
  busy?: boolean;
  /** Run the cascade (promote ancestors / restrict descendants). */
  onConfirm: () => void;
  onCancel: () => void;
}

const ENTITY_LABEL: Record<VisibilityConflict['entityType'], string> = {
  workspace: 'workspace',
  folder: 'folder',
  list: 'list',
  timeline: 'timeline',
};

const ROW_ICON: Record<string, string> = {
  workspace: 'workspaces',
  folder: 'folder',
  list: 'format_list_bulleted',
  timeline: 'timeline',
};

// A small icon + name row for an affected ancestor/descendant.
function ItemRow({ icon, name, sublabel }: { icon: string; name: string; sublabel: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 10, background: '#F5F3FF', border: '1px solid #e8e4f0' }}>
      <div style={{ width: 28, height: 28, borderRadius: 8, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon name={icon} size={15} color="#5e4dbb" />
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', textTransform: 'capitalize' }}>{sublabel}</div>
      </div>
    </div>
  );
}

export default function VisibilityConflictModal({ conflict, busy, onConfirm, onCancel }: VisibilityConflictModalProps) {
  const isPromote = conflict.direction === 'promote';
  const entityLabel = ENTITY_LABEL[conflict.entityType];

  // Accent: warning amber for promote (blocked or needs action), error-ish for
  // the "this will hide things" restrict case — both within the design language.
  const accent = isPromote ? '#d97706' : '#5e4dbb';
  const accentBg = isPromote ? '#fffbeb' : '#F5F3FF';

  const rows = isPromote ? (conflict.ancestors ?? []) : (conflict.descendants ?? []);

  const title = isPromote ? 'Permission conflict' : 'This affects other items';
  const intro = isPromote
    ? <>To make the {entityLabel} <strong style={{ color: '#1c1b22' }}>“{conflict.entityName}”</strong> public, everything above it must be public too:</>
    : <>Making the {entityLabel} <strong style={{ color: '#1c1b22' }}>“{conflict.entityName}”</strong> private will also make these private:</>;

  const canAct = isPromote ? conflict.canResolve : true;
  const confirmLabel = isPromote ? 'Make all public' : 'Make all private';

  return createPortal(
    <div
      onClick={onCancel}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)', backdropFilter: 'blur(4px)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'backdropIn 200ms ease both' }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 18, maxWidth: 420, width: '100%', maxHeight: '86vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 40px rgba(94,77,187,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '20px 22px 16px' }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: accentBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name={isPromote ? 'lock' : 'visibility_off'} size={20} color={accent} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>{title}</div>
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: '0 22px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0, fontFamily: 'Inter, sans-serif', fontSize: 13.5, lineHeight: 1.5, color: '#484552' }}>{intro}</p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {rows.map(r => (
              <ItemRow key={`${r.type}-${r.id}`} icon={ROW_ICON[r.type] ?? 'circle'} name={r.name} sublabel={r.type} />
            ))}
          </div>

          {isPromote && !conflict.canResolve && conflict.blockedReason && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 10, background: '#fffbeb', border: '1px solid #fde68a' }}>
              <Icon name="info" size={15} color="#d97706" />
              <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12.5, lineHeight: 1.45, color: '#92400e' }}>{conflict.blockedReason}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '18px 22px 20px' }}>
          <button
            onClick={onCancel}
            disabled={busy}
            style={{ padding: '9px 18px', borderRadius: 10, border: '1.5px solid #e8e4f0', background: '#fff', cursor: busy ? 'wait' : 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 600, color: '#484552' }}>
            {canAct ? 'Cancel' : 'Got it'}
          </button>
          {canAct && (
            <button
              onClick={onConfirm}
              disabled={busy}
              style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 10, border: 'none', background: '#5e4dbb', cursor: busy ? 'wait' : 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 600, color: '#fff', opacity: busy ? 0.7 : 1 }}>
              {busy && <Icon name="progress_activity" size={15} color="#fff" />}
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
