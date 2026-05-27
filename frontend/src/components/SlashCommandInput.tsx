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

type MenuState =
  | { kind: 'none' }
  | { kind: 'slash-menu' }
  | { kind: 'link-search'; query: string }
  | { kind: 'list-name'; name: string };

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
  const [menu, setMenu] = useState<MenuState>({ kind: 'none' });
  const [highlightIdx, setHighlightIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const excluded = new Set([currentListId, ...excludeListIds].filter(Boolean) as string[]);
  const filteredLists = availableLists.filter(l => !excluded.has(l.id));

  const searchResults = menu.kind === 'link-search'
    ? filteredLists.filter(l => l.name.toLowerCase().includes(menu.query.toLowerCase())).slice(0, 8)
    : [];

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    onChange(val);

    if (val === '/') {
      setMenu({ kind: 'slash-menu' });
      setHighlightIdx(0);
      return;
    }
    if (val.startsWith('/list')) {
      const after = val.slice(5);
      setMenu({ kind: 'list-name', name: after.trimStart() });
      return;
    }
    if (val.startsWith('/link')) {
      const q = val.slice(5).trimStart();
      setMenu({ kind: 'link-search', query: q });
      setHighlightIdx(0);
      return;
    }
    setMenu({ kind: 'none' });
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
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlightIdx(i => Math.min(i + 1, 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHighlightIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter') { e.preventDefault(); selectSlashOption(highlightIdx === 0 ? 'list' : 'link'); return; }
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
  }, [menu, highlightIdx, searchResults, selectSlashOption, selectLinkedList, confirmListName, onChange, onKeyDown]);

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

  const dropdownStyle: React.CSSProperties = {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    left: 0,
    zIndex: 500,
    background: '#fff',
    border: '1px solid #e8e4f0',
    borderRadius: 10,
    boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
    minWidth: 240,
    overflow: 'hidden',
    animation: 'menuIn 180ms cubic-bezier(0.34,1.56,0.64,1) both',
  };

  const itemBase: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px',
    cursor: 'pointer', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#1c1b22',
    border: 'none', background: 'transparent', width: '100%', textAlign: 'left',
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

      {menu.kind === 'slash-menu' && (
        <div style={dropdownStyle}>
          {(['list', 'link'] as const).map((opt, idx) => (
            <button
              key={opt}
              style={{ ...itemBase, background: highlightIdx === idx ? '#F5F3FF' : 'transparent' }}
              onMouseEnter={() => setHighlightIdx(idx)}
              onMouseDown={e => { e.preventDefault(); selectSlashOption(opt); }}
            >
              <Icon name={opt === 'list' ? 'format_list_bulleted' : 'link'} size={16} color="#5e4dbb" />
              <span>
                <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontWeight: 600, color: '#5e4dbb' }}>/{opt}</span>
                {'  '}
                <span style={{ color: '#787584', fontSize: 12 }}>
                  {opt === 'list' ? 'Create new sublist' : 'Link existing list'}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {menu.kind === 'link-search' && (
        <div style={dropdownStyle}>
          {searchResults.length === 0 ? (
            <div style={{ padding: '10px 14px', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe' }}>
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
