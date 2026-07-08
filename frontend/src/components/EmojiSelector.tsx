import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';

const EMOJI_GROUPS = [
  { label: 'Work', emojis: ['📋','📁','💼','🗂️','📊','📈','✅','🎯','🔖','📌'] },
  { label: 'Personal', emojis: ['🏠','❤️','⭐','🌟','💡','🎉','🎨','📚','🏃','🍎'] },
  { label: 'Time', emojis: ['📅','⏰','🗓️','⏳','🔔','🌅','🌙','⚡','🚀','🔥'] },
  { label: 'Other', emojis: ['🔧','💰','🎮','🌍','🤝','🧠','💪','🎵','🛒','🌱'] },
];

const POPUP_WIDTH = 278;

// The grid of curated emoji groups. Rendered inside the EmojiSelector popup,
// or inline (e.g. in the workspace modals where the avatar tile is the trigger).
export function EmojiGrid({ value, onSelect, onRemove }: { value?: string; onSelect: (emoji: string) => void; onRemove?: () => void }) {
  return (
    <div style={{ width: POPUP_WIDTH - 20 }}>
      {value && onRemove && (
        <button
          onClick={onRemove}
          style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', marginBottom: 8, padding: '4px 6px', border: 'none', borderRadius: 6, background: '#ffeaea', cursor: 'pointer', fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#ba1a1a', fontWeight: 500 }}
        >
          <Icon name="close" size={12} color="#ba1a1a" /> Remove emoji
        </button>
      )}
      {EMOJI_GROUPS.map(group => (
        <div key={group.label} style={{ marginBottom: 8 }}>
          <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{group.label}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 24px)', gap: 2, justifyContent: 'space-between' }}>
            {group.emojis.map(em => (
              <button key={em} onClick={() => onSelect(em)}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 4, border: 'none', background: value === em ? '#f0edff' : 'transparent', cursor: 'pointer', fontSize: 15, transition: 'background 100ms, transform 120ms cubic-bezier(0.34,1.56,0.64,1)' }}
                onMouseEnter={e => { e.currentTarget.style.background = '#f5f3ff'; e.currentTarget.style.transform = 'scale(1.25)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = value === em ? '#f0edff' : 'transparent'; e.currentTarget.style.transform = 'scale(1)'; }}
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
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, borderRadius: 8, border: `1.5px solid ${open ? '#5e4dbb' : '#e2dff0'}`, background: open ? '#f5f3ff' : '#faf9fc', cursor: 'pointer', fontSize: size / 2, transition: 'all 150ms' }}
      >
        {value || <Icon name="tag" size={size * 0.45} color="#b0acbe" />}
      </button>
      {open && pos && createPortal(
        // Portaled to <body>: ancestors with backdrop-filter (modal overlays)
        // hijack position: fixed and their overflow: hidden clips the popup.
        <div
          ref={popRef}
          onMouseDown={e => e.preventDefault()}
          style={{ position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom, zIndex: 1600, background: '#fff', borderRadius: 12, boxShadow: '0 4px 24px rgba(0,0,0,0.13)', border: '1px solid #e8e4f0', padding: '10px', width: POPUP_WIDTH, boxSizing: 'border-box', maxHeight: 'calc(100vh - 24px)', overflowY: 'auto', animation: 'modalIn 180ms cubic-bezier(0.34,1.56,0.64,1) both' }}
        >
          <EmojiGrid
            value={value}
            onSelect={em => { onChange(em); setOpen(false); }}
            onRemove={allowRemove ? () => { onChange(''); setOpen(false); } : undefined}
          />
        </div>,
        document.body
      )}
    </div>
  );
}
