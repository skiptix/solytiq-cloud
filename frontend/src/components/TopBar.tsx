import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task, List } from '../types';
import Icon from './Icon';

interface TopBarProps {
  tasks: Task[];
  lists: List[];
  synced: boolean;
  lastSynced: string | null;
  onNavigate: (path: string) => void;
}

const SETTINGS_RESULTS = [
  { label: 'Profile Settings', sub: 'Edit your name and email', path: '/settings', icon: 'manage_accounts' },
  { label: 'Sync Settings', sub: 'Cloud sync preferences', path: '/settings', icon: 'cloud_sync' },
  { label: 'Sign Out', sub: 'End your session', path: '/settings', icon: 'logout' },
];

function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: '#ede9ff', color: '#5e4dbb', fontWeight: 700, borderRadius: 2 }}>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export default function TopBar({ tasks, lists, synced, onNavigate }: TopBarProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();
  const showDrop = focused && q.length > 0;

  const taskResults = q ? tasks.filter(t => t.title.toLowerCase().includes(q)).slice(0, 5) : [];
  const listResults = q ? lists.filter(l => l.name.toLowerCase().includes(q)).slice(0, 3) : [];
  const settingsResults = q ? SETTINGS_RESULTS.filter(s => s.label.toLowerCase().includes(q)).slice(0, 3) : [];

  const allResults: Array<{ type: 'task' | 'list' | 'setting'; label: string; sub?: string; path: string; icon?: string; task?: Task; list?: List }> = [
    ...taskResults.map(t => ({ type: 'task' as const, label: t.title, sub: t._listName ?? 'Dashboard', path: t._source === 'list' && t._listId ? `/list/${t._listId}` : '/dashboard', task: t })),
    ...listResults.map(l => ({ type: 'list' as const, label: l.name, sub: `${l.sections.flatMap(s => s.tasks).length} tasks`, path: `/list/${l.id}`, list: l })),
    ...settingsResults.map(s => ({ type: 'setting' as const, label: s.label, sub: s.sub, path: s.path, icon: s.icon })),
  ];

  useEffect(() => { setActiveIdx(0); }, [query]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); inputRef.current?.focus(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const goTo = useCallback((path: string) => {
    setQuery(''); setFocused(false);
    navigate(path);
    onNavigate(path);
  }, [navigate, onNavigate]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setFocused(false); setQuery(''); }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, allResults.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    if (e.key === 'Enter' && allResults[activeIdx]) goTo(allResults[activeIdx].path);
  };

  const GROUP_COLORS: Record<string, string> = { task: '#5e4dbb', list: '#1D4ED8', setting: '#10B981' };
  const GROUP_LABELS: Record<string, string> = { task: 'Tasks', list: 'Lists', setting: 'Settings' };

  let renderedGroups: string[] = [];

  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 50, background: 'rgba(253,248,255,0.92)', backdropFilter: 'blur(12px)', borderBottom: '1px solid #e8e4f0', display: 'flex', alignItems: 'center', gap: 16, padding: '10px 24px', height: 56 }}>
      <div style={{ flex: 1, maxWidth: 440, margin: '0 auto', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: focused ? '#fff' : '#f7f4fc', borderRadius: focused ? 10 : 9999, border: `1.5px solid ${focused ? '#5e4dbb' : 'transparent'}`, padding: '7px 14px', transition: 'all 200ms', boxShadow: focused ? '0 0 0 4px rgba(94,77,187,0.12)' : 'none' }}>
          <Icon name="search" size={16} color="#787584" />
          <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)}
            onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 150)}
            onKeyDown={handleKey}
            placeholder="Search tasks, lists… ⌘K"
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontFamily: 'Inter, sans-serif', fontSize: 13.5, color: '#1c1b22' }} />
          {query && <button onClick={() => setQuery('')} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 0 }}><Icon name="close" size={14} color="#787584" /></button>}
        </div>

        {showDrop && allResults.length > 0 && (
          <div ref={dropRef} style={{ position: 'absolute', top: 'calc(100% + 8px)', left: 0, right: 0, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.14)', overflow: 'hidden', zIndex: 300, animation: 'menuIn 160ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            {allResults.map((r, i) => {
              const isNewGroup = !renderedGroups.includes(r.type);
              if (isNewGroup) renderedGroups = [...renderedGroups, r.type];
              return (
                <div key={i}>
                  {isNewGroup && (
                    <div style={{ padding: '8px 14px 4px', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: GROUP_COLORS[r.type] }}>
                      {GROUP_LABELS[r.type]}
                    </div>
                  )}
                  <div onMouseDown={() => goTo(r.path)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', background: i === activeIdx ? '#F5F3FF' : 'transparent', cursor: 'pointer', transition: 'background 120ms' }}>
                    <div style={{ width: 28, height: 28, borderRadius: 8, background: `${GROUP_COLORS[r.type]}12`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {r.type === 'task' && <Icon name="check_circle" size={14} color={GROUP_COLORS.task} />}
                      {r.type === 'list' && <span style={{ fontSize: 14 }}>{(r.list?.emoji) ?? ''}</span>}
                      {r.type === 'setting' && <Icon name={r.icon ?? 'settings'} size={14} color={GROUP_COLORS.setting} />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22' }}>{highlight(r.label, query)}</div>
                      {r.sub && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584', marginTop: 1 }}>{r.sub}</div>}
                    </div>
                    <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 9.5, fontWeight: 600, color: GROUP_COLORS[r.type], background: `${GROUP_COLORS[r.type]}12`, borderRadius: 9999, padding: '2px 7px', textTransform: 'uppercase' }}>{r.type}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
        {synced && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ position: 'relative', width: 8, height: 8 }}>
              <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: '#10B981' }} />
              <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: '#10B981', animation: 'ping 2s ease-in-out infinite' }} />
            </div>
            <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10, fontWeight: 700, color: '#10B981', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Synced</span>
          </div>
        )}
        <button onClick={() => onNavigate('/settings')}
          style={{ width: 32, height: 32, borderRadius: '50%', background: 'transparent', border: '1px solid #e8e4f0', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms' }}
          onMouseEnter={e => { e.currentTarget.style.background = '#F5F3FF'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
          <Icon name="settings" size={16} color="#787584" />
        </button>
      </div>
    </header>
  );
}
