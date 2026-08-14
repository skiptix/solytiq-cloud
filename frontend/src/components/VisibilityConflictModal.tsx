import { createPortal } from 'react-dom';
import type { VisibilityConflict } from '../api/client';
import Icon from './Icon';
import ModalIn from './animate-ui/ModalIn';
import { EASE_STANDARD } from './animate-ui/motionTokens';
import MotionIn from './animate-ui/MotionIn';

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
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 10, background: 'var(--color-surface-tint)', border: '1px solid var(--color-border)' }}>
      <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--color-white)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon name={icon} size={15} color="var(--color-primary)" />
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', textTransform: 'capitalize' }}>{sublabel}</div>
      </div>
    </div>
  );
}

export default function VisibilityConflictModal({ conflict, busy, onConfirm, onCancel }: VisibilityConflictModalProps) {
  const isPromote = conflict.direction === 'promote';
  const entityLabel = ENTITY_LABEL[conflict.entityType];

  // Accent: warning amber for promote (blocked or needs action), error-ish for
  // the "this will hide things" restrict case — both within the design language.
  const accent = isPromote ? 'var(--color-warning)' : 'var(--color-primary)';
  const accentBg = isPromote ? 'var(--color-yellow-pale-1)' : 'var(--color-surface-tint)';

  const rows = isPromote ? (conflict.ancestors ?? []) : (conflict.descendants ?? []);

  const title = isPromote ? 'Permission conflict' : 'This affects other items';
  const intro = isPromote
    ? <>To make the {entityLabel} <strong style={{ color: 'var(--color-text-primary)' }}>“{conflict.entityName}”</strong> public, everything above it must be public too:</>
    : <>Making the {entityLabel} <strong style={{ color: 'var(--color-text-primary)' }}>“{conflict.entityName}”</strong> private will also make these private:</>;

  const canAct = isPromote ? conflict.canResolve : true;
  const confirmLabel = isPromote ? 'Make all public' : 'Make all private';

  return createPortal(
    <MotionIn
      onClick={onCancel}
      style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.28)', backdropFilter: 'blur(4px)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2, ease: EASE_STANDARD }}>
      <ModalIn
        duration={280}
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--color-white)', borderRadius: 18, maxWidth: 420, width: '100%', maxHeight: '86vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 40px rgba(var(--color-primary-rgb), 0.18)', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '20px 22px 16px' }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: accentBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name={isPromote ? 'lock' : 'visibility_off'} size={20} color={accent} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>{title}</div>
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: '0 22px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0, fontFamily: 'var(--font-body)', fontSize: 13.5, lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>{intro}</p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {rows.map(r => (
              <ItemRow key={`${r.type}-${r.id}`} icon={ROW_ICON[r.type] ?? 'circle'} name={r.name} sublabel={r.type} />
            ))}
          </div>

          {isPromote && !conflict.canResolve && conflict.blockedReason && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 10, background: 'var(--color-yellow-pale-1)', border: '1px solid var(--color-yellow-tint-2)' }}>
              <Icon name="info" size={15} color="var(--color-warning)" />
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, lineHeight: 1.45, color: 'var(--color-orange-deep-1)' }}>{conflict.blockedReason}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '18px 22px 20px' }}>
          <button
            onClick={onCancel}
            disabled={busy}
            style={{ padding: '9px 18px', borderRadius: 10, border: '1.5px solid var(--color-border)', background: 'var(--color-white)', cursor: busy ? 'wait' : 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
            {canAct ? 'Cancel' : 'Got it'}
          </button>
          {canAct && (
            <button
              onClick={onConfirm}
              disabled={busy}
              style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 10, border: 'none', background: 'var(--color-primary)', cursor: busy ? 'wait' : 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-white)', opacity: busy ? 0.7 : 1 }}>
              {busy && <Icon name="progress_activity" size={15} color="var(--color-white)" />}
              {confirmLabel}
            </button>
          )}
        </div>
      </ModalIn>
    </MotionIn>,
    document.body,
  );
}
