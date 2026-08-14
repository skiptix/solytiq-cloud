import { useState } from 'react';
import { createPortal } from 'react-dom';
import ModalIn from './animate-ui/ModalIn';
import { EASE_STANDARD } from './animate-ui/motionTokens';
import MotionIn from './animate-ui/MotionIn';

interface RenameDialogProps {
  value: string;
  accentColor?: string;
  title?: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}

/** Quick single-field rename — shared by sidebar rows, tasks, and milestones.
 *  Full editing lives in each entity's own "More settings"/"More details" dialog. */
export default function RenameDialog({ value, accentColor = 'var(--color-primary)', title = 'Rename', onSave, onCancel }: RenameDialogProps) {
  const [v, setV] = useState(value);
  return createPortal(
    <MotionIn style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.18)', backdropFilter: 'blur(4px)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 20px' }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18, ease: EASE_STANDARD }}
      onClick={onCancel}>
      <ModalIn duration={280} style={{ background: 'var(--color-white)', borderRadius: 14, padding: '24px 28px', width: '100%', maxWidth: 360, boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.14)' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 16 }}>{title}</div>
        <input
          autoFocus
          value={v}
          onChange={e => setV(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onSave(v); if (e.key === 'Escape') onCancel(); }}
          style={{ width: '100%', fontFamily: 'var(--font-heading)', fontSize: 14, border: `1.5px solid ${accentColor}`, borderRadius: 8, outline: 'none', padding: '10px 12px', color: 'var(--color-text-primary)', background: 'var(--color-purple-pale-5)', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onCancel}
            style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-purple-pale-13)', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-tertiary)', cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={() => onSave(v)}
            style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: accentColor, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', cursor: 'pointer' }}>
            Save
          </button>
        </div>
      </ModalIn>
    </MotionIn>,
    document.body
  );
}
