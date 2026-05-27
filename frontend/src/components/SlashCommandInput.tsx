import { useState, useRef, useEffect, useCallback } from 'react';
import type { List } from '../types';
import Icon from './Icon';

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
  onFocus?: () => void;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

const SLASH_COMMANDS = [
  { id: 'list' as const, icon: 'format_list_bulleted', label: 'New Sublist', desc: 'Create a nested sublist', hint: '/list' },
  { id: 'link' as const, icon: 'link', label: 'Link List', desc: 'Link an existing list', hint: '/link' },
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
  onFocus,
  onBlur,
  onKeyDown,
}: SlashCommandInputProps) {
  const [menu, setMenu] = useState<MenuState>(() => initMenu(value));
  const [highlightIdx, setHighlightIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const dropdownBase: React.CSSProperties = {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    left: 0,
    zIndex: 500,
    background: '#fff',
    border: '1px solid #e8e4f0',
    borderRadius: 12,
    boxShadow: '0 8px 24px rgba(94,77,187,0.12), 0 2px 8px rgba(0,0,0,0.06)',
    overflow: 'hidden',
    animation: 'menuIn 180ms cubic-bezier(0.34,1.56,0.64,1) both',
  };

  const itemBase: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
    cursor: 'pointer', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#1c1b22',
    border: 'none', background: 'transparent', width: '100%', textAlign: 'left',
    transition: 'background 100ms',
  };

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder={placeholder}
        autoFocus={autoFocus}
        style={inputStyle}
      />

      {/* ── Slash command picker ── */}
      {menu.kind === 'slash-menu' && (
        <div style={{ ...dropdownBase, minWidth: 290 }}>
          {/* Header */}
          <div style={{ padding: '10px 14px 8px', borderBottom: '1px solid #F5F3FF', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 700, color: '#5e4dbb' }}>
              /{menu.query}
            </span>
            {!menu.query && (
              <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#c9c4d5' }}>Type to filter…</span>
            )}
          </div>

          {/* Section label */}
          <div style={{ padding: '8px 14px 3px', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10, fontWeight: 700, color: '#c9c4d5', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            List commands
          </div>

          {/* Commands */}
          {visibleCommands.length === 0 ? (
            <div style={{ padding: '10px 14px 12px', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#c9c4d5' }}>
              No commands match
            </div>
          ) : (
            visibleCommands.map((cmd, idx) => (
              <button
                key={cmd.id}
                style={{ ...itemBase, background: highlightIdx === idx ? '#F5F3FF' : 'transparent' }}
                onMouseEnter={() => setHighlightIdx(idx)}
                onMouseDown={e => { e.preventDefault(); selectSlashOption(cmd.id); }}
              >
                <div style={{ width: 32, height: 32, borderRadius: 8, background: highlightIdx === idx ? '#ede9fc' : '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 100ms' }}>
                  <Icon name={cmd.icon} size={16} color="#5e4dbb" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22' }}>{cmd.label}</div>
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584', marginTop: 1 }}>{cmd.desc}</div>
                </div>
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#c9c4d5', background: '#F5F3FF', borderRadius: 5, padding: '2px 7px', flexShrink: 0 }}>
                  {cmd.hint}
                </span>
              </button>
            ))
          )}

          {/* Footer */}
          <div style={{ padding: '7px 14px', borderTop: '1px solid #F5F3FF', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#c9c4d5' }}>Close menu</span>
            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#c9c4d5', background: '#F5F3FF', borderRadius: 5, padding: '2px 7px' }}>esc</span>
          </div>
        </div>
      )}

      {/* ── Link search ── */}
      {menu.kind === 'link-search' && (
        <div style={{ ...dropdownBase, minWidth: 260 }}>
          {searchResults.length === 0 ? (
            <div style={{ padding: '10px 14px', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#c9c4d5' }}>
              No lists found
            </div>
          ) : (
            searchResults.map((list, idx) => (
              <button
                key={list.id}
                style={{ ...itemBase, background: highlightIdx === idx ? '#F5F3FF' : 'transparent' }}
                onMouseEnter={() => setHighlightIdx(idx)}
                onMouseDown={e => { e.preventDefault(); selectLinkedList(list); }}
              >
                {list.emoji
                  ? <span style={{ fontSize: 15 }}>{list.emoji}</span>
                  : <Icon name="format_list_bulleted" size={15} color="#787584" />
                }
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{list.name}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
