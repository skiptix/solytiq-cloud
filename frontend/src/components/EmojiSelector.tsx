import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import ModalIn from './animate-ui/ModalIn';

const EMOJI_GROUPS = [
  { label: 'Work', emojis: ['📋','📁','💼','🗂️','📊','📈','✅','🎯','🔖','📌'] },
  { label: 'Personal', emojis: ['🏠','❤️','⭐','🌟','💡','🎉','🎨','📚','🏃','🍎'] },
  { label: 'Time', emojis: ['📅','⏰','🗓️','⏳','🔔','🌅','🌙','⚡','🚀','🔥'] },
  { label: 'Other', emojis: ['🔧','💰','🎮','🌍','🤝','🧠','💪','🎵','🛒','🌱'] },
];

export const POPUP_WIDTH = 278;

// The grid of curated emoji groups. Rendered inside the EmojiSelector popup,
// or inside a caller's own floating popup (e.g. WorkspaceSettingsModal, where
// a custom avatar tile is the trigger instead of EmojiSelector's own button).
export function EmojiGrid({ value, onSelect, onRemove }: { value?: string; onSelect: (emoji: string) => void; onRemove?: () => void }) {
  return (
    <div style={{ width: POPUP_WIDTH - 20 }}>
      {value && onRemove && (
        <button
          onClick={onRemove}
          style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', marginBottom: 8, padding: '4px 6px', border: 'none', borderRadius: 6, background: 'var(--color-red-pale-6)', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-error)', fontWeight: 500 }}
        >
          <Icon name="close" size={12} color="var(--color-error)" /> Remove emoji
        </button>
      )}
      {EMOJI_GROUPS.map(group => (
        <div key={group.label} style={{ marginBottom: 8 }}>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{group.label}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 24px)', gap: 2, justifyContent: 'space-between' }}>
            {group.emojis.map(em => (
              <button key={em} onClick={() => onSelect(em)}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 4, border: 'none', background: value === em ? 'var(--color-surface-tint-alt)' : 'transparent', cursor: 'pointer', fontSize: 15, transition: 'background 100ms, transform 120ms cubic-bezier(0.34,1.56,0.64,1)' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint)'; e.currentTarget.style.transform = 'scale(1.25)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = value === em ? 'var(--color-surface-tint-alt)' : 'transparent'; e.currentTarget.style.transform = 'scale(1)'; }}
              >{em}</button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

interface EmojiSelectorProps {
  value: string;
  onChange: (emoji: string) => void;
  direction?: 'up' | 'down';
  size?: number;
  allowRemove?: boolean;
}

// Standard emoji selector: a square trigger button that opens the curated
// emoji popup. The popup is position: fixed so it escapes overflow/scroll
// clipping inside modals, and mousedown is prevented from stealing focus so
// adjacent inputs with blur-commit behavior (section rename) keep working.
export default function EmojiSelector({ value, onChange, direction = 'down', size = 36, allowRemove = true }: EmojiSelectorProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        popRef.current && !popRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = () => {
    if (!open) {
      const rect = btnRef.current?.getBoundingClientRect();
      if (rect) {
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - POPUP_WIDTH - 8));
        // Flip away from the nearer viewport edge when the preferred side lacks room.
        const spaceBelow = window.innerHeight - rect.bottom - 12;
        const spaceAbove = rect.top - 12;
        let dir = direction;
        if (dir === 'down' && spaceBelow < 380 && spaceAbove > spaceBelow) dir = 'up';
        else if (dir === 'up' && spaceAbove < 380 && spaceBelow > spaceAbove) dir = 'down';
        setPos(dir === 'up'
          ? { left, bottom: window.innerHeight - rect.top + 6 }
          : { left, top: rect.bottom + 6 });
      }
    }
    setOpen(o => !o);
  };

  return (
    <div style={{ display: 'inline-flex', flexShrink: 0 }} onMouseDown={e => e.preventDefault()}>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        title="Choose emoji"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, borderRadius: 8, border: `1.5px solid ${open ? 'var(--color-primary)' : 'var(--color-purple-pale-42)'}`, background: open ? 'var(--color-surface-tint)' : 'var(--color-purple-pale-7)', cursor: 'pointer', fontSize: size / 2, transition: 'all 150ms' }}
      >
        {value || <Icon name="tag" size={size * 0.45} color="var(--color-text-quaternary)" />}
      </button>
      {open && pos && createPortal(
        // Portaled to <body>: ancestors with backdrop-filter (modal overlays)
        // hijack position: fixed and their overflow: hidden clips the popup.
        <ModalIn
          ref={popRef}
          duration={180}
          onMouseDown={e => e.preventDefault()}
          style={{ position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom, zIndex: 1600, background: 'var(--color-white)', borderRadius: 12, boxShadow: '0 4px 24px rgba(var(--color-black-rgb), 0.13)', border: '1px solid var(--color-border)', padding: '10px', width: POPUP_WIDTH, boxSizing: 'border-box', maxHeight: 'calc(100vh - 24px)', overflowY: 'auto' }}
        >
          <EmojiGrid
            value={value}
            onSelect={em => { onChange(em); setOpen(false); }}
            onRemove={allowRemove ? () => { onChange(''); setOpen(false); } : undefined}
          />
        </ModalIn>,
        document.body
      )}
    </div>
  );
}
