// Solytiq Cloud — Top Navigation Bar with Global Search
// Uses window.AppContext for search data
// Export: window.TopBar, window.SyncDot

// ─── Static settings catalogue ────────────────────────────────
const SEARCH_SETTINGS = [
  { id: 's-dashboard', label: 'Dashboard',        sub: 'Today\'s overview',        icon: 'today',          action: { type: 'navigate', screen: 'dashboard'  } },
  { id: 's-scheduled', label: 'Scheduled',        sub: 'Calendar & timeline',      icon: 'calendar_month', action: { type: 'navigate', screen: 'scheduled'  } },
  { id: 's-profile',   label: 'Profile Settings', sub: 'Edit name & email',        icon: 'person',         action: { type: 'navigate', screen: 'settings'   } },
  { id: 's-sync',      label: 'Sync & Storage',   sub: 'Auto-sync, local storage', icon: 'cloud_sync',     action: { type: 'navigate', screen: 'settings'   } },
  { id: 's-completed', label: 'Completed Tasks',  sub: 'All finished items',       icon: 'check_circle',   action: { type: 'modal',    modal: 'completed'   } },
  { id: 's-trash',     label: 'Trash',            sub: 'Recover deleted items',    icon: 'delete',         action: { type: 'modal',    modal: 'trash'       } },
  { id: 's-newlist',   label: 'New List',         sub: 'Create a new list',        icon: 'playlist_add',   action: { type: 'modal',    modal: 'add-list'    } },
];

// ─── Type config ──────────────────────────────────────────────
const TYPE_CFG = {
  task:    { label: 'Task',    bg: '#F5F3FF', color: '#5e4dbb', group: '#9d8dff' },
  list:    { label: 'List',    bg: '#eff6ff', color: '#1D4ED8', group: '#60a5fa' },
  setting: { label: 'Setting', bg: '#f0fdf4', color: '#16a34a', group: '#4ade80' },
};

// ─── Match highlight ─────────────────────────────────────────
function MatchText({ text, query }) {
  if (!query) return <span>{text}</span>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, idx)}
      <mark style={{ background: '#ede9ff', color: '#5e4dbb', borderRadius: 3, padding: '0 2px', fontWeight: 700, fontStyle: 'normal' }}>
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </span>
  );
}

// ─── Single result row ────────────────────────────────────────
function SearchResultItem({ result, active, query, onHover, onClick }) {
  const tc = TYPE_CFG[result.type];
  return (
    <div
      onMouseEnter={onHover}
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 14px',
        background: active ? '#F5F3FF' : 'transparent',
        cursor: 'pointer', transition: 'background 80ms',
      }}>

      {/* Icon / emoji */}
      <div style={{
        width: 30, height: 30, borderRadius: 8, flexShrink: 0,
        background: active ? '#ede9ff' : '#f5f2fb',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background 80ms', fontSize: 15, lineHeight: 1,
      }}>
        {result.emoji
          ? result.emoji
          : <Icon name={result.icon} size={15} color={active ? '#5e4dbb' : '#9d8dff'} />}
      </div>

      {/* Label + sub */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#1c1b22', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          <MatchText text={result.title} query={query} />
        </div>
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {result.sub}
        </div>
      </div>

      {/* Type tag */}
      <span style={{
        fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 9, fontWeight: 700,
        background: tc.bg, color: tc.color,
        borderRadius: 9999, padding: '3px 8px',
        textTransform: 'uppercase', letterSpacing: '0.06em', flexShrink: 0,
      }}>{tc.label}</span>

      {/* Enter hint when active */}
      {active && (
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2, opacity: 0.5 }}>
          <Icon name="keyboard_return" size={13} color="#9d8dff" />
        </div>
      )}
    </div>
  );
}

// ─── Global search component ──────────────────────────────────
function GlobalSearch({ onNavigate, onOpenModal }) {
  const ctx = React.useContext(window.AppContext);
  const [query,     setQuery]     = React.useState('');
  const [open,      setOpen]      = React.useState(false);
  const [activeIdx, setActiveIdx] = React.useState(-1);
  const inputRef = React.useRef(null);
  const wrapRef  = React.useRef(null);

  const dashTasks = ctx?.dashTasks || [];
  const lists     = ctx?.lists     || [];

  // ── Build results ──────────────────────────────────────────
  const results = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    // Tasks — dashboard
    const tasks = [];
    dashTasks.forEach(t => {
      if ([t.title, t.badge, t.note].some(v => v && v.toLowerCase().includes(q))) {
        tasks.push({
          type: 'task', id: `dt-${t.id}`,
          title: t.title,
          sub: `Dashboard${t.deadline ? ' · ' + t.deadline : ''}`,
          icon: 'today', emoji: null,
          action: { type: 'navigate', screen: 'dashboard' },
        });
      }
    });
    // Tasks — lists
    lists.forEach(l => {
      l.sections.forEach(s => {
        s.tasks.forEach(t => {
          if ([t.title, t.note].some(v => v && v.toLowerCase().includes(q))) {
            tasks.push({
              type: 'task', id: `lt-${t.id}`,
              title: t.title,
              sub: `${l.name}${t.deadline ? ' · ' + t.deadline : ''}`,
              icon: 'format_list_bulleted', emoji: l.emoji || null,
              action: { type: 'navigate', screen: 'list', listId: l.id },
            });
          }
        });
      });
    });

    // Lists
    const listMatches = lists
      .filter(l => l.name.toLowerCase().includes(q))
      .map(l => {
        const all  = l.sections.flatMap(s => s.tasks);
        const done = all.filter(t => t.checked).length;
        return {
          type: 'list', id: `l-${l.id}`,
          title: l.name,
          sub: `${done} / ${all.length} tasks done`,
          icon: 'format_list_bulleted', emoji: l.emoji || null,
          action: { type: 'navigate', screen: 'list', listId: l.id },
        };
      });

    // Settings
    const settingMatches = SEARCH_SETTINGS
      .filter(s => [s.label, s.sub].some(v => v.toLowerCase().includes(q)))
      .map(s => ({
        type: 'setting', id: s.id,
        title: s.label, sub: s.sub,
        icon: s.icon, emoji: null,
        action: s.action,
      }));

    return [
      ...tasks.slice(0, 5),
      ...listMatches.slice(0, 3),
      ...settingMatches.slice(0, 3),
    ];
  }, [query, dashTasks, lists]);

  React.useEffect(() => setActiveIdx(-1), [results]);

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;
    const h = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  // ⌘K / Ctrl+K shortcut
  React.useEffect(() => {
    const h = e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);

  // Activate a result
  const activate = r => {
    const a = r.action;
    if (a.type === 'modal')       onOpenModal && onOpenModal(a.modal);
    else if (a.screen === 'list') onNavigate  && onNavigate('list', { listId: a.listId });
    else                          onNavigate  && onNavigate(a.screen);
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  };

  const handleKey = e => {
    if (e.key === 'ArrowDown')  { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Escape')    { setOpen(false); setQuery(''); inputRef.current?.blur(); }
    else if (e.key === 'Enter' && activeIdx >= 0 && results[activeIdx]) {
      e.preventDefault(); activate(results[activeIdx]);
    }
  };

  const showDropdown = open && query.trim().length > 0;
  const hasResults   = results.length > 0;

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', maxWidth: 440 }}>

      {/* ── Input ──────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        background: open ? '#fff' : '#ebe6f0',
        borderRadius: showDropdown && hasResults ? '12px 12px 0 0' : '24px',
        padding: '8px 14px',
        border: open ? '1.5px solid #c8bfff' : '1.5px solid transparent',
        borderBottomColor: showDropdown && hasResults ? '#f0ecf8' : undefined,
        boxShadow: open
          ? '0 0 0 4px rgba(94,77,187,0.08), 0 2px 6px rgba(0,0,0,0.04)'
          : '0 1px 2px rgba(0,0,0,0.04)',
        transition: 'background 180ms, box-shadow 180ms, border-color 180ms',
      }}>
        <Icon name="search" size={17} color={open ? '#5e4dbb' : '#787584'} />
        <input
          ref={inputRef}
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKey}
          placeholder="Search lists, tasks, settings…"
          style={{
            border: 'none', background: 'transparent',
            fontFamily: 'Inter, sans-serif', fontSize: 13.5, color: '#1c1b22',
            outline: 'none', flex: 1, minWidth: 0,
          }}
        />
        {query ? (
          <button
            onMouseDown={e => e.preventDefault()}
            onClick={() => { setQuery(''); setActiveIdx(-1); inputRef.current?.focus(); }}
            style={{
              background: '#f0ecf8', border: 'none', cursor: 'pointer',
              padding: '3px', borderRadius: 6, display: 'flex', flexShrink: 0,
              transition: 'background 140ms',
            }}
            onMouseEnter={e => e.currentTarget.style.background = '#e5dff5'}
            onMouseLeave={e => e.currentTarget.style.background = '#f0ecf8'}>
            <Icon name="close" size={13} color="#787584" />
          </button>
        ) : (
          <kbd style={{
            fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#c9c4d5',
            background: 'rgba(0,0,0,0.03)', borderRadius: 5, padding: '2px 6px',
            border: '1px solid #e8e4f0', flexShrink: 0,
            opacity: open ? 0 : 1, transition: 'opacity 180ms',
            pointerEvents: 'none',
          }}>⌘K</kbd>
        )}
      </div>

      {/* ── Dropdown ───────────────────────────────────────── */}
      {showDropdown && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0,
          background: '#fff',
          border: '1.5px solid #c8bfff', borderTop: 'none',
          borderRadius: '0 0 14px 14px',
          boxShadow: '0 14px 40px rgba(94,77,187,0.13)',
          zIndex: 200, overflow: 'hidden',
          animation: 'gsIn 140ms cubic-bezier(0.34,1.56,0.64,1) both',
        }}>
          <style>{`
            @keyframes gsIn {
              from { opacity: 0; transform: translateY(-5px); }
              to   { opacity: 1; transform: translateY(0); }
            }
          `}</style>

          {!hasResults ? (
            /* Empty state */
            <div style={{ padding: '20px 16px', textAlign: 'center' }}>
              <Icon name="search_off" size={24} color="#d8d0eb" />
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', marginTop: 8 }}>
                No results for <strong style={{ color: '#484552', fontWeight: 600 }}>"{query}"</strong>
              </div>
            </div>
          ) : (
            <>
              {/* Grouped results */}
              {(() => {
                const rows = [];
                let lastType = null;
                results.forEach((r, i) => {
                  if (r.type !== lastType) {
                    const tc = TYPE_CFG[r.type];
                    rows.push(
                      <div key={`g-${r.type}`} style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '7px 14px 3px',
                        borderTop: lastType ? '1px solid #f5f0fc' : 'none',
                      }}>
                        <span style={{
                          fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 9, fontWeight: 700,
                          textTransform: 'uppercase', letterSpacing: '0.08em', color: tc.group,
                        }}>{tc.label}s</span>
                        <div style={{ flex: 1, height: 1, background: '#f5f0fc' }} />
                      </div>
                    );
                    lastType = r.type;
                  }
                  rows.push(
                    <SearchResultItem
                      key={r.id}
                      result={r}
                      active={activeIdx === i}
                      query={query}
                      onHover={() => setActiveIdx(i)}
                      onClick={() => activate(r)}
                    />
                  );
                });
                return rows;
              })()}

              {/* Footer */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '5px 14px 8px', borderTop: '1px solid #f5f0fc',
              }}>
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#c9c4d5' }}>
                  {results.length} result{results.length !== 1 ? 's' : ''}
                </span>
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#c9c4d5' }}>
                  ↑↓ navigate · ↵ open · Esc
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── SyncDot ──────────────────────────────────────────────────
function SyncDot() {
  return (
    <span style={{ position: 'relative', width: 8, height: 8, display: 'inline-flex', flexShrink: 0 }}>
      <style>{`@keyframes tb-ping{0%{transform:scale(1);opacity:.75}100%{transform:scale(2.5);opacity:0}}`}</style>
      <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: '#10B981', animation: 'tb-ping 2s ease-in-out infinite' }} />
      <span style={{ position: 'relative', borderRadius: '50%', background: '#10B981', width: 8, height: 8, display: 'inline-block' }} />
    </span>
  );
}

// ─── TopBar ───────────────────────────────────────────────────
function TopBar({ onSettings, onNavigate, onOpenModal }) {
  const [settingsHov, setSettingsHov] = React.useState(false);

  return (
    <header style={{
      position: 'sticky', top: 0, zIndex: 50,
      display: 'flex', alignItems: 'center',
      padding: '10px 32px', gap: 16,
      background: 'rgba(253,248,255,0.92)',
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      borderBottom: '1px solid rgba(229,231,235,0.5)',
    }}>
      <div style={{ flex: 1 }} />

      <GlobalSearch onNavigate={onNavigate} onOpenModal={onOpenModal} />

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12 }}>
        <button
          style={{
            width: 36, height: 36, borderRadius: 9999, border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: settingsHov ? '#F5F3FF' : 'transparent',
            transition: 'background 200ms', flexShrink: 0,
          }}
          onMouseEnter={() => setSettingsHov(true)}
          onMouseLeave={() => setSettingsHov(false)}
          onClick={onSettings}>
          <Icon name="settings" size={20} color="#484552" />
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(16,185,129,0.10)', borderRadius: 9999, padding: '5px 12px', flexShrink: 0 }}>
          <SyncDot />
          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 700, color: '#10B981', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Synced</span>
        </div>
      </div>
    </header>
  );
}

Object.assign(window, { TopBar, SyncDot });
