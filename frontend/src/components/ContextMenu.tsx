import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';

export interface ContextMenuItem {
  key: string;
  label: string;
  icon: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}
export type ContextMenuEntry = ContextMenuItem | { key: string; divider: true };

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onClose: () => void;
  minWidth?: number;
}

/** The app's one custom right-click / "..." dropdown menu — replaces the
 *  browser's native context menu wherever it's wired up (onContextMenu with
 *  e.preventDefault()), and doubles as the target for "..." button triggers
 *  so both entry points render identical, cursor/anchor-positioned menus. */
export default function ContextMenu({ x, y, items, onClose, minWidth = 190 }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: y, left: x, visible: false });

  // Clamp to the viewport after the first paint, once we know the menu's real size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let left = x, top = y;
    if (left + rect.width + margin > window.innerWidth) left = Math.max(margin, window.innerWidth - rect.width - margin);
    if (top + rect.height + margin > window.innerHeight) top = Math.max(margin, window.innerHeight - rect.height - margin);
    setPos({ top, left, visible: true });
  }, [x, y]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const handleScroll = () => onClose();
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('contextmenu', handleClick);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('contextmenu', handleClick);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      onContextMenu={e => e.preventDefault()}
      style={{
        position: 'fixed', top: pos.top, left: pos.left, zIndex: 2000,
        background: 'var(--color-white)', borderRadius: 10, boxShadow: '0 4px 20px rgba(var(--color-black-rgb), 0.13)',
        border: '1px solid var(--color-border)', minWidth, padding: '4px 0',
        animation: 'menuIn 140ms ease both', transformOrigin: 'top left',
        visibility: pos.visible ? 'visible' : 'hidden',
      }}
    >
      {items.map((item, i) =>
        'divider' in item ? (
          <div key={item.key} style={{ height: 1, background: 'var(--color-divider)', margin: '3px 0' }} />
        ) : (
          <button
            key={item.key}
            disabled={item.disabled}
            onClick={() => { if (!item.disabled) { item.onClick(); onClose(); } }}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px',
              border: 'none', background: 'transparent', cursor: item.disabled ? 'default' : 'pointer',
              fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500,
              color: item.disabled ? 'var(--color-border-strong)' : (item.danger ? 'var(--color-error)' : 'var(--color-text-primary)'),
              textAlign: 'left', opacity: item.disabled ? 0.6 : 1,
              animation: 'menuItemIn 160ms ease both', animationDelay: `${i * 20}ms`,
            }}
            onMouseEnter={e => { if (!item.disabled) e.currentTarget.style.background = item.danger ? 'var(--color-red-pale-5)' : 'var(--color-surface-tint)'; }}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Icon name={item.icon} size={15} color={item.disabled ? 'var(--color-border-strong)' : (item.danger ? 'var(--color-error)' : 'var(--color-text-tertiary)')} />
            {item.label}
          </button>
        )
      )}
    </div>,
    document.body
  );
}
