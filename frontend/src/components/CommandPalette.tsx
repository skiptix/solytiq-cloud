import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import Icon from './Icon';
import useAuthStore from '../store/useAuthStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import { apiGlobalSearch, type GlobalSearchResult } from '../api/client';

// These two open in-app affordances rather than a route — Profile Settings is
// the account modal (not the admin /settings screen), and Sign Out ends the
// session — so they carry an `action` instead of a `path`.
const SETTINGS_RESULTS = [
  { label: 'Profile Settings', sub: 'Edit your name and email', icon: 'manage_accounts', action: 'account-settings' as const },
  { label: 'Sign Out', sub: 'End your session', icon: 'logout', action: 'sign-out' as const },
];

type Result = GlobalSearchResult | { type: 'setting'; label: string; sub: string; icon: string; action: 'account-settings' | 'sign-out' };

const GROUP_COLORS: Record<string, string> = { task: 'var(--color-primary)', list: 'var(--color-blue-mid-7)', setting: 'var(--color-success)', timeline: 'var(--color-pink-mid-1)', milestone: 'var(--color-warning-alt)', meeting: 'var(--color-red-mid-2)', workspace: 'var(--color-purple-mid-3)' };
const GROUP_LABELS: Record<string, string> = { task: 'Tasks', list: 'To-Dos', setting: 'Settings', timeline: 'Timelines', milestone: 'Milestones', meeting: 'Meetings', workspace: 'Workspaces' };
const GROUP_ICONS: Record<string, string> = { task: 'check_circle', list: 'format_list_bulleted', timeline: 'timeline', milestone: 'flag', meeting: 'event', workspace: 'workspaces' };

function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: 'var(--color-surface-tint-4)', color: 'var(--color-primary)', fontWeight: 700, borderRadius: 2 }}>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

interface CommandPaletteProps {
  onClose: () => void;
  onNavigate: (path: string) => void;
  onOpenAccountSettings: () => void;
}

// A Cmd+K-style command palette: opened from the topbar's search trigger or the
// ⌘K/Ctrl+K shortcut, it hovers centered over the full viewport (sidebar and
// topbar included) with everything behind it blurred, matching the chrome of
// every other overlay in the app. The parent only mounts this component while
// open, so each open starts with fresh state — no reset-on-prop-change effect
// needed.
export default function CommandPalette({ onClose, onNavigate, onOpenAccountSettings }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { signOut } = useAuthStore();
  const { setCurrentWorkspace } = useWorkspaceStore();
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [serverResults, setServerResults] = useState<GlobalSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  const q = query.trim().toLowerCase();

  useEffect(() => {
    if (!q || q.length < 2) {
      setServerResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const ac = new AbortController();
    const timer = setTimeout(() => {
      apiGlobalSearch(q, ac.signal)
        .then(res => setServerResults(res.results))
        .catch(err => { if (err.name !== 'AbortError') console.error(err); })
        .finally(() => setLoading(false));
    }, 250);
    return () => { clearTimeout(timer); ac.abort(); };
  }, [q]);

  const allResults: Result[] = useMemo(() => {
    const settingsResults = q ? SETTINGS_RESULTS.filter(s => s.label.toLowerCase().includes(q)).slice(0, 3) : [];
    return [
      ...serverResults,
      ...settingsResults.map(s => ({ type: 'setting' as const, label: s.label, sub: s.sub, icon: s.icon, action: s.action })),
    ];
  }, [q, serverResults]);

  useEffect(() => { setActiveIdx(0); }, [query, serverResults]);

  const goTo = useCallback((result: Result) => {
    onClose();
    if (result.type === 'setting') {
      if (result.action === 'account-settings') onOpenAccountSettings();
      else { signOut(); navigate('/login'); }
      return;
    }
    if (result.type === 'workspace') {
      const match = result.path.match(/workspace=([^&]+)/);
      if (match) setCurrentWorkspace(match[1]);
    }
    const targetPath = result.type === 'workspace' ? '/dashboard' : result.path;
    navigate(targetPath);
    onNavigate(targetPath);
  }, [navigate, onNavigate, onClose, onOpenAccountSettings, signOut, setCurrentWorkspace]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, allResults.length - 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
      if (e.key === 'Enter' && allResults[activeIdx]) { e.preventDefault(); goTo(allResults[activeIdx]); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [allResults, activeIdx, goTo, onClose]);

  let renderedGroups: string[] = [];

  return createPortal(
    <div
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1500, background: 'rgba(var(--color-black-rgb), 0.32)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'clamp(12px, 5vw, 24px)', animation: 'backdropIn 180ms ease both' }}
    >
      <div
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 'min(600px, 100%)', maxHeight: '68vh', background: 'var(--color-white)', borderRadius: 18, boxShadow: '0 24px 60px rgba(var(--color-black-rgb), 0.25)', display: 'flex', flexDirection: 'column', overflow: 'hidden', animation: 'modalIn 220ms cubic-bezier(0.34,1.56,0.64,1) both' }}
      >
        {/* Input row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '1px solid var(--color-divider)', flexShrink: 0 }}>
          <Icon name="search" size={20} color="var(--color-primary)" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search tasks, lists, timelines, workspaces…"
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontFamily: 'var(--font-body)', fontSize: 16, color: 'var(--color-text-primary)' }}
          />
          {query && (
            <button onClick={() => setQuery('')} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 4 }}>
              <Icon name="close" size={16} color="var(--color-text-tertiary)" />
            </button>
          )}
          <button
            onClick={onClose}
            style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', background: 'var(--color-purple-pale-11)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', flexShrink: 0 }}
          >
            Esc
          </button>
        </div>

        {/* Results */}
        <div style={{ flex: 1, overflowY: 'auto', padding: allResults.length > 0 ? '8px' : 0 }}>
          {q.length > 0 && q.length < 2 && (
            <div style={{ padding: '32px 20px', textAlign: 'center', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>Keep typing…</div>
          )}
          {q.length === 0 && (
            <div style={{ padding: '40px 20px', textAlign: 'center' }}>
              <Icon name="travel_explore" size={28} color="var(--color-border-strong)" />
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)', marginTop: 10 }}>
                Search everything you have access to — tasks, lists, timelines, milestones, meetings, and workspaces.
              </div>
            </div>
          )}
          {q.length >= 2 && !loading && allResults.length === 0 && (
            <div style={{ padding: '32px 20px', textAlign: 'center', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>No results for "{query}"</div>
          )}
          {allResults.map((r, i) => {
            const isNewGroup = !renderedGroups.includes(r.type);
            if (isNewGroup) renderedGroups = [...renderedGroups, r.type];
            return (
              <div key={`${r.type}-${i}`}>
                {isNewGroup && (
                  <div style={{ padding: '10px 12px 4px', fontFamily: 'var(--font-heading)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: GROUP_COLORS[r.type] }}>
                    {GROUP_LABELS[r.type]}
                  </div>
                )}
                <div
                  onMouseEnter={() => setActiveIdx(i)}
                  onMouseDown={() => goTo(r)}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 10, background: i === activeIdx ? 'var(--color-surface-tint)' : 'transparent', cursor: 'pointer', transition: 'background 100ms' }}
                >
                  <div style={{ width: 32, height: 32, borderRadius: 9, background: `${GROUP_COLORS[r.type]}12`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Icon name={r.type === 'setting' ? (r.icon ?? 'settings') : GROUP_ICONS[r.type]} size={15} color={GROUP_COLORS[r.type]} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{highlight(r.label, query)}</div>
                    {r.sub && <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 1 }}>{r.sub}</div>}
                  </div>
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 9.5, fontWeight: 600, color: GROUP_COLORS[r.type], background: `${GROUP_COLORS[r.type]}12`, borderRadius: 9999, padding: '2px 7px', textTransform: 'uppercase', flexShrink: 0 }}>{r.type}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer hint bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 20px', borderTop: '1px solid var(--color-divider)', flexShrink: 0, background: 'var(--color-surface-tint-3)' }}>
          {[['keyboard_arrow_up', 'keyboard_arrow_down', 'Navigate'], ['keyboard_return', null, 'Select'], ['close', null, 'Close']].map(([i1, i2, label], idx) => (
            <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Icon name={i1 as string} size={12} color="var(--color-text-quaternary)" />
              {i2 && <Icon name={i2 as string} size={12} color="var(--color-text-quaternary)" />}
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)' }}>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
