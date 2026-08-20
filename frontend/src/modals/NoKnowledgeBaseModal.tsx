import { createPortal } from 'react-dom';
import Icon from '../components/Icon';
import ModalIn from '../components/animate-ui/ModalIn';
import { EASE_STANDARD } from '../components/animate-ui/motionTokens';
import MotionIn from '../components/animate-ui/MotionIn';

interface NoKnowledgeBaseModalProps {
  busy?: boolean;
  /** Create the workspace's Knowledge Base, then proceed with turning Quick Add on. */
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Quick Add has nowhere to keep what it learns without a Knowledge Base — its
 * suggestions live in the board's own KB bubble (see backend/src/quickAdd/kbBubble.ts).
 * Turning Quick Add on in a workspace with no base yet stops here rather than
 * silently creating one, so the user knows a Knowledge Base is about to appear
 * in their sidebar.
 */
export default function NoKnowledgeBaseModal({ busy, onConfirm, onCancel }: NoKnowledgeBaseModalProps) {
  return createPortal(
    <MotionIn
      onClick={onCancel}
      style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.28)', backdropFilter: 'blur(4px)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2, ease: EASE_STANDARD }}>
      <ModalIn
        duration={280}
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--color-white)', borderRadius: 18, maxWidth: 420, width: '100%', boxShadow: '0 8px 40px rgba(var(--color-primary-rgb), 0.18)', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '20px 22px 16px' }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--color-purple-pale-21)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="neurology" size={20} color="var(--color-primary)" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>Quick Add needs a Knowledge Base</div>
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: '0 22px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ margin: 0, fontFamily: 'var(--font-body)', fontSize: 13.5, lineHeight: 1.55, color: 'var(--color-text-secondary)' }}>
            This workspace doesn't have a Knowledge Base yet — it's where Quick Add keeps what it learns about which
            section each item belongs in. <strong style={{ color: 'var(--color-text-primary)' }}>Without one, there's no Quick Add.</strong>
          </p>
          <p style={{ margin: 0, fontFamily: 'var(--font-body)', fontSize: 12.5, lineHeight: 1.5, color: 'var(--color-text-tertiary)' }}>
            Creating one adds a small "Knowledge" entry to this workspace's sidebar — it costs nothing to have and
            every future board can share it too.
          </p>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '18px 22px 20px' }}>
          <button
            onClick={onCancel}
            disabled={busy}
            style={{ padding: '9px 18px', borderRadius: 10, border: '1.5px solid var(--color-border)', background: 'var(--color-white)', cursor: busy ? 'wait' : 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 10, border: 'none', background: 'var(--color-primary)', cursor: busy ? 'wait' : 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-white)', opacity: busy ? 0.7 : 1 }}>
            {busy && <Icon name="progress_activity" size={15} color="var(--color-white)" />}
            Create Knowledge Base
          </button>
        </div>
      </ModalIn>
    </MotionIn>,
    document.body,
  );
}
