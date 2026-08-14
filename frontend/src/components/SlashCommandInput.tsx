import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import type { List } from '../types';
import Icon from './Icon';
import PopIn from './animate-ui/PopIn';
import MotionButton from './animate-ui/MotionButton';
import { motion } from './animate-ui/motion';
import type { TargetAndTransition, Transition } from './animate-ui/motion';

export interface SlashCommandResult {
  type: 'list' | 'link';
  newListName?: string;
  linkedListId?: string;
  linkedListType: 'sublist' | 'link';
}

interface SlashCommandInputProps {
  value: string;
  onChange: (val: string) => void;
  onCommand: (cmd: SlashCommandResult) => void;
  placeholder?: string;
  availableLists: List[];
  currentListId?: string;
  excludeListIds?: string[];
  autoFocus?: boolean;
  inputStyle?: React.CSSProperties;
  /** Motion target for the inner input — the host owns the animated state
   *  (focus ring, padding shift) since only it knows what drives them. */
  inputAnimate?: TargetAndTransition;
  inputTransition?: Transition;
  onFocus?: () => void;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

const SLASH_COMMANDS = [
  { id: 'list' as const, icon: 'format_list_bulleted', label: 'New Sublist', desc: 'Create a nested sublist', hint: '/list' },
  { id: 'link' as const, icon: 'link', label: 'Link Board', desc: 'Link an existing board', hint: '/link' },
];

type MenuState =
  | { kind: 'none' }
  | { kind: 'slash-menu'; query: string }
  | { kind: 'link-search'; query: string }
  | { kind: 'list-name'; name: string };

function initMenu(value: string): MenuState {
  if (!value.startsWith('/')) return { kind: 'none' };
  if (value.startsWith('/list ') && value.length > 6) return { kind: 'list-name', name: value.slice(6) };
  if (value.startsWith('/link ') && value.length > 6) return { kind: 'link-search', query: value.slice(6) };
  return { kind: 'slash-menu', query: value.slice(1) };
}

export default function SlashCommandInput({
  value,
  onChange,
  onCommand,
  placeholder,
  availableLists,
  currentListId,
  excludeListIds = [],
  autoFocus,
  inputStyle,
  inputAnimate,
  inputTransition,
  onFocus,
  onBlur,
  onKeyDown,
}: SlashCommandInputProps) {
  const [menu, setMenu] = useState<MenuState>(() => initMenu(value));
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const updatePos = useCallback(() => {
    const rect = inputRef.current?.getBoundingClientRect();
    if (rect) setDropdownPos({ top: rect.bottom + 6, left: rect.left, width: rect.width });
  }, []);

  useLayoutEffect(() => {
    if (menu.kind === 'none') { setDropdownPos(null); return; }
    updatePos();
    window.addEventListener('scroll', updatePos, true);
    window.addEventListener('resize', updatePos);
    return () => {
      window.removeEventListener('scroll', updatePos, true);
      window.removeEventListener('resize', updatePos);
    };
  }, [menu.kind, updatePos]);

  const excluded = new Set([currentListId, ...excludeListIds].filter(Boolean) as string[]);
  const filteredLists = availableLists.filter(l => !excluded.has(l.id));

  const visibleCommands = menu.kind === 'slash-menu'
    ? SLASH_COMMANDS.filter(c =>
        !menu.query ||
        c.id.startsWith(menu.query.toLowerCase()) ||
        c.label.toLowerCase().includes(menu.query.toLowerCase())
      )
    : [];

  const searchResults = menu.kind === 'link-search'
    ? filteredLists.filter(l => l.name.toLowerCase().includes(menu.query.toLowerCase())).slice(0, 8)
    : [];

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    onChange(val);

    if (!val.startsWith('/')) { setMenu({ kind: 'none' }); return; }
    if (val.startsWith('/list ') && val.length > 6) { setMenu({ kind: 'list-name', name: val.slice(6) }); return; }
    if (val.startsWith('/link ') && val.length > 6) { setMenu({ kind: 'link-search', query: val.slice(6) }); setHighlightIdx(0); return; }

    setMenu({ kind: 'slash-menu', query: val.slice(1) });
    setHighlightIdx(0);
  }, [onChange]);

  const selectSlashOption = useCallback((type: 'list' | 'link') => {
    if (type === 'list') {
      onChange('/list ');
      setMenu({ kind: 'list-name', name: '' });
    } else {
      onChange('/link ');
      setMenu({ kind: 'link-search', query: '' });
      setHighlightIdx(0);
    }
    inputRef.current?.focus();
  }, [onChange]);

  const confirmListName = useCallback(() => {
    if (menu.kind !== 'list-name') return;
    const name = menu.name.trim();
    if (!name) { setMenu({ kind: 'none' }); return; }
    onCommand({ type: 'list', newListName: name, linkedListType: 'sublist' });
    setMenu({ kind: 'none' });
  }, [menu, onCommand]);

  const selectLinkedList = useCallback((list: List) => {
    onChange(list.name);
    onCommand({ type: 'link', linkedListId: list.id, linkedListType: 'link' });
    setMenu({ kind: 'none' });
  }, [onChange, onCommand]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (menu.kind === 'slash-menu') {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlightIdx(i => Math.min(i + 1, visibleCommands.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHighlightIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter' && visibleCommands[highlightIdx]) { e.preventDefault(); selectSlashOption(visibleCommands[highlightIdx].id); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMenu({ kind: 'none' }); onChange(''); return; }
    }
    if (menu.kind === 'link-search') {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlightIdx(i => Math.min(i + 1, searchResults.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHighlightIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter' && searchResults[highlightIdx]) { e.preventDefault(); selectLinkedList(searchResults[highlightIdx]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMenu({ kind: 'none' }); onChange(''); return; }
    }
    if (menu.kind === 'list-name') {
      if (e.key === 'Enter') { e.preventDefault(); confirmListName(); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMenu({ kind: 'none' }); onChange(''); return; }
    }
    onKeyDown?.(e);
  }, [menu, highlightIdx, visibleCommands, searchResults, selectSlashOption, selectLinkedList, confirmListName, onChange, onKeyDown]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setMenu({ kind: 'none' });
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const dropdownBase: React.CSSProperties = dropdownPos ? {
    position: 'fixed',
    top: dropdownPos.top,
    left: dropdownPos.left,
    minWidth: Math.max(dropdownPos.width, 290),
    zIndex: 9000,
    background: 'var(--color-white)',
    border: '1px solid var(--color-border)',
    borderRadius: 12,
    boxShadow: '0 8px 24px rgba(var(--color-primary-rgb), 0.12), 0 2px 8px rgba(var(--color-black-rgb), 0.06)',
    overflow: 'hidden',
  } : { display: 'none' };

  const itemBase: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
    cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)',
    border: 'none', width: '100%', textAlign: 'left',
  };

  return (
    <div ref={containerRef}>
      <motion.input
        ref={inputRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder={placeholder}
        autoFocus={autoFocus}
        animate={inputAnimate}
        transition={inputTransition}
        style={inputStyle}
      />

      {/* ── Slash command picker ── */}
      {menu.kind === 'slash-menu' && dropdownPos && (
        <PopIn duration={180} ease="spring" style={dropdownBase}>
          {/* Header */}
          <div style={{ padding: '10px 14px 8px', borderBottom: '1px solid var(--color-surface-tint)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 700, color: 'var(--color-primary)' }}>
              /{menu.query}
            </span>
            {!menu.query && (
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-border-strong)' }}>Type to filter…</span>
            )}
          </div>

          {/* Section label */}
          <div style={{ padding: '8px 14px 3px', fontFamily: 'var(--font-heading)', fontSize: 10, fontWeight: 700, color: 'var(--color-border-strong)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Board commands
          </div>

          {/* Commands */}
          {visibleCommands.length === 0 ? (
            <div style={{ padding: '10px 14px 12px', fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-border-strong)' }}>
              No commands match
            </div>
          ) : (
            visibleCommands.map((cmd, idx) => (
              <MotionButton
                key={cmd.id}
                style={itemBase}
                animate={{ background: highlightIdx === idx ? 'var(--color-surface-tint)' : 'transparent' }}
                transition={{ duration: 0.1 }}
                onMouseEnter={() => setHighlightIdx(idx)}
                onMouseDown={e => { e.preventDefault(); selectSlashOption(cmd.id); }}
              >
                <motion.div
                  animate={{ background: highlightIdx === idx ? 'var(--color-purple-pale-26)' : 'var(--color-surface-tint)' }}
                  transition={{ duration: 0.1 }}
                  style={{ width: 32, height: 32, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Icon name={cmd.icon} size={16} color="var(--color-primary)" />
                </motion.div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{cmd.label}</div>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 1 }}>{cmd.desc}</div>
                </div>
                <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-border-strong)', background: 'var(--color-surface-tint)', borderRadius: 5, padding: '2px 7px', flexShrink: 0 }}>
                  {cmd.hint}
                </span>
              </MotionButton>
            ))
          )}

          {/* Footer */}
          <div style={{ padding: '7px 14px', borderTop: '1px solid var(--color-surface-tint)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-border-strong)' }}>Close menu</span>
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-border-strong)', background: 'var(--color-surface-tint)', borderRadius: 5, padding: '2px 7px' }}>esc</span>
          </div>
        </PopIn>
      )}

      {/* ── Link search ── */}
      {menu.kind === 'link-search' && dropdownPos && (
        <PopIn duration={180} ease="spring" style={dropdownBase}>
          {searchResults.length === 0 ? (
            <div style={{ padding: '10px 14px', fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-border-strong)' }}>
              No boards found
            </div>
          ) : (
            searchResults.map((list, idx) => (
              <MotionButton
                key={list.id}
                style={itemBase}
                animate={{ background: highlightIdx === idx ? 'var(--color-surface-tint)' : 'transparent' }}
                transition={{ duration: 0.1 }}
                onMouseEnter={() => setHighlightIdx(idx)}
                onMouseDown={e => { e.preventDefault(); selectLinkedList(list); }}
              >
                {list.emoji
                  ? <span style={{ fontSize: 15 }}>{list.emoji}</span>
                  : <Icon name="format_list_bulleted" size={15} color="var(--color-text-tertiary)" />
                }
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{list.name}</span>
              </MotionButton>
            ))
          )}
        </PopIn>
      )}
    </div>
  );
}
