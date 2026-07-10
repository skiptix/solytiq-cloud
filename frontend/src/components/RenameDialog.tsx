import { useState } from 'react';
import { createPortal } from 'react-dom';

interface RenameDialogProps {
  value: string;
  accentColor?: string;
  title?: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}

/** Quick single-field rename — shared by sidebar rows, tasks, and milestones.
 *  Full editing lives in each entity's own "More settings"/"More details" dialog. */
export default function RenameDialog({ value, accentColor = '#5e4dbb', title = 'Rename', onSave, onCancel }: RenameDialogProps) {
  const [v, setV] = useState(value);
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', backdropFilter: 'blur(4px)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 20px', animation: 'backdropIn 180ms ease both' }}
      onClick={onCancel}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '24px 28px', width: '100%', maxWidth: 360, boxShadow: '0 8px 32px rgba(0,0,0,0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22', marginBottom: 16 }}>{title}</div>
        <input
          autoFocus
          value={v}
          onChange={e => setV(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onSave(v); if (e.key === 'Escape') onCancel(); }}
          style={{ width: '100%', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, border: `1.5px solid ${accentColor}`, borderRadius: 8, outline: 'none', padding: '10px 12px', color: '#1c1b22', background: '#faf8ff', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onCancel}
            style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #e8e4f0', background: '#f7f2fc', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#787584', cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={() => onSave(v)}
            style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: accentColor, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', cursor: 'pointer' }}>
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
