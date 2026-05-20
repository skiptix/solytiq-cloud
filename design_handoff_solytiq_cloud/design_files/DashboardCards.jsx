// Solytiq Cloud — Dashboard Screen
// Uses window.AppContext for shared state
// Export: window.DashboardScreen

// ─── Date helpers ─────────────────────────────────────────────────
function dashIso(d) { const x = new Date(d); x.setHours(0,0,0,0); return x.toISOString().slice(0,10); }
function dashToday() { return dashIso(new Date()); }
function dashEndOfWeek() {
  const t = new Date(); t.setHours(0,0,0,0);
  const day = t.getDay(); // 0 Sun .. 6 Sat
  const daysUntilSun = (7 - day) % 7;
  const end = new Date(t); end.setDate(t.getDate() + daysUntilSun);
  return dashIso(end);
}
function isDueToday(t)    { return t.deadline && t.deadline === dashToday(); }
function isDueThisWeek(t) {
  if (!t.deadline) return false;
  const today = dashToday(), eow = dashEndOfWeek();
  return t.deadline > today && t.deadline <= eow;
}
function isOverdue(t)     { return t.deadline && t.deadline < dashToday() && !t.checked; }
function friendlyDate(iso) {
  if (!iso) return '';
  if (iso === dashToday()) return 'Today';
  const d = new Date(iso + 'T12:00:00');
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  if (dashIso(tomorrow) === iso) return 'Tomorrow';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// ─── Helpers ────────────────────────────────────────────────────
function flattenListTasks(lists) {
  return lists.flatMap(l =>
    l.sections.flatMap(s =>
      s.tasks.map(t => ({ ...t, _source: 'list', _listId: l.id, _listName: l.name }))
    )
  );
}

function getFilteredTasks(filter, dashTasks, lists) {
  const dash = dashTasks.map(t => ({ ...t, _source: 'dash', _listId: 'dashboard', _listName: 'Dashboard' }));
  const all  = flattenListTasks(lists);
  if (filter === 'all')   return [...dash, ...all];
  if (filter === 'local') return dash;
  const list = lists.find(l => l.id === filter);
  return list ? list.sections.flatMap(s => s.tasks.map(t => ({ ...t, _source: 'list', _listId: list.id, _listName: list.name }))) : [];
}

// ─── List Dropdown ───────────────────────────────────────────────
function ListDropdown({ lists, selectedId, onSelect }) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const selected = lists.find(l => l.id === selectedId);
  const filtered = lists.filter(l => l.name.toLowerCase().includes(search.toLowerCase()));

  React.useEffect(() => {
    if (!open) return;
    const h = e => setOpen(false);
    setTimeout(() => document.addEventListener('click', h), 0);
    return () => document.removeEventListener('click', h);
  }, [open]);

  const btnStyle = { fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, border: 'none', borderRadius: 9999, padding: '4px 10px', cursor: 'pointer', transition: 'all 150ms', display: 'flex', alignItems: 'center', gap: 4 };

  return (
    <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
      <button
        style={{ ...btnStyle, background: selectedId && selectedId !== 'all' && selectedId !== 'local' ? '#5e4dbb' : '#f1ecf6', color: selectedId && selectedId !== 'all' && selectedId !== 'local' ? '#fff' : '#787584' }}
        onClick={() => setOpen(o => !o)}>
        {selected ? `${selected.emoji || ''} ${selected.name}` : 'List'}
        <Icon name="chevron_right" size={10} color={selected ? '#fff' : '#787584'} style={{ transform: open ? 'rotate(90deg)' : 'rotate(90deg)', transition: 'transform 150ms' }} />
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 300, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.10)', minWidth: 180, padding: 8, animation: 'menuIn 160ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
          <input
            autoFocus
            placeholder="Search lists…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 12, border: 'none', borderBottom: '1px solid #f1ecf6', padding: '4px 6px 8px', outline: 'none', color: '#1c1b22', background: 'transparent', marginBottom: 4 }}
          />
          {filtered.length === 0 && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', padding: '6px 6px' }}>No lists found</div>}
          {filtered.map(l => (
            <button key={l.id}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: selectedId === l.id ? '#F5F3FF' : 'transparent', border: 'none', borderRadius: 7, padding: '7px 8px', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: selectedId === l.id ? '#5e4dbb' : '#1c1b22', cursor: 'pointer', transition: 'background 120ms' }}
              onClick={() => { onSelect(l.id); setOpen(false); setSearch(''); }}>
              <span>{l.emoji}</span>{l.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Sort Menu ───────────────────────────────────────────────────
const SORT_OPTIONS = [
  { key: 'date-asc',  label: 'Date',  sub: 'Ascending',  iconName: 'arrow_up2'  },
  { key: 'date-desc', label: 'Date',  sub: 'Descending', iconName: 'arrow_down' },
  { key: 'name-az',   label: 'Name',  sub: 'A → Z',      iconName: 'arrow_down' },
  { key: 'name-za',   label: 'Name',  sub: 'Z → A',      iconName: 'arrow_up2'  },
];

function SortMenu({ current, onSelect, onClose }) {
  React.useEffect(() => {
    const h = () => onClose();
    const t = setTimeout(() => document.addEventListener('click', h), 0);
    return () => { clearTimeout(t); document.removeEventListener('click', h); };
  }, []);

  return (
    <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 300, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.10)', minWidth: 168, overflow: 'hidden', animation: 'menuIn 180ms cubic-bezier(0.34,1.56,0.64,1) both', transformOrigin: 'top right' }}
      onClick={e => e.stopPropagation()}>
      <style>{`@keyframes menuIn{from{opacity:0;transform:scale(.88) translateY(-6px)}to{opacity:1;transform:scale(1) translateY(0)}} @keyframes menuItemIn{from{opacity:0;transform:translateX(6px)}to{opacity:1;transform:translateX(0)}}`}</style>
      <div style={{ padding: '6px 8px 4px', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#b0acbe' }}>Sort by</div>
      {SORT_OPTIONS.map((opt, i) => {
        const active = current === opt.key;
        return (
          <button key={opt.key}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '8px 12px', background: active ? '#F5F3FF' : 'transparent', border: 'none', cursor: 'pointer', transition: 'background 120ms', animation: `menuItemIn 160ms ${50 + i * 40}ms ease both`, borderBottom: i < SORT_OPTIONS.length - 1 ? '1px solid #f7f4fc' : 'none' }}
            onMouseEnter={e => { if (!active) e.currentTarget.style.background='#faf9ff'; }}
            onMouseLeave={e => { if (!active) e.currentTarget.style.background='transparent'; }}
            onClick={() => onSelect(active ? null : opt.key)}>
            <Icon name={opt.iconName} size={13} color={active ? '#5e4dbb' : '#c9c4d5'} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: active ? 600 : 500, color: active ? '#5e4dbb' : '#1c1b22' }}>{opt.label}</div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: active ? '#9d8dff' : '#b0acbe', marginTop: 1 }}>{opt.sub}</div>
            </div>
            {active && <Icon name="check" size={13} color="#5e4dbb" />}
          </button>
        );
      })}
    </div>
  );
}

// ─── Tasks Detail Modal ─────────────────────────────────────────
function TasksDetailModal({ title, icon, accent, accentBg, tasks, onClose, onToggle, onDelete, onUpdate, onRowClick }) {
  const [search, setSearch] = React.useState('');
  const [filter, setFilter] = React.useState('all'); // all | open | completed
  const [sort, setSort] = React.useState(null);
  const [sortMenuOpen, setSortMenuOpen] = React.useState(false);
  const [searchFocus, setSearchFocus] = React.useState(false);

  let filtered = tasks;
  if (search.trim()) {
    const q = search.toLowerCase();
    filtered = filtered.filter(t =>
      t.title.toLowerCase().includes(q) ||
      (t._listName || '').toLowerCase().includes(q) ||
      (t.badge || '').toLowerCase().includes(q) ||
      (t.note || '').toLowerCase().includes(q)
    );
  }
  if (filter === 'open')      filtered = filtered.filter(t => !t.checked);
  if (filter === 'completed') filtered = filtered.filter(t =>  t.checked);

  if (sort) {
    filtered = [...filtered].sort((a, b) => {
      if (sort === 'date-asc')  return (a.deadline || '9999') < (b.deadline || '9999') ? -1 : 1;
      if (sort === 'date-desc') return (a.deadline || '') > (b.deadline || '') ? -1 : 1;
      if (sort === 'name-az')   return a.title.localeCompare(b.title);
      if (sort === 'name-za')   return b.title.localeCompare(a.title);
      return 0;
    });
  }

  React.useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const filterPillStyle = (active) => ({ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 9999, padding: '5px 12px', cursor: 'pointer', transition: 'all 150ms', background: active ? '#5e4dbb' : '#f1ecf6', color: active ? '#fff' : '#787584' });

  const openCount      = tasks.filter(t => !t.checked).length;
  const completedCount = tasks.filter(t =>  t.checked).length;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 620, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}>
        <style>{`@keyframes modalIn{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:scale(1)}}`}</style>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px', borderBottom: '1px solid #f1ecf6', flexShrink: 0 }}>
          {icon && (
            <div style={{ width: 36, height: 36, borderRadius: 10, background: accentBg || '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Icon name={icon} size={18} color={accent || '#5e4dbb'} />
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22' }}>{title}</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2 }}>
              {tasks.length} total · {openCount} open · {completedCount} completed
            </div>
          </div>
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 150ms', flexShrink: 0 }}
            onMouseEnter={e => e.currentTarget.style.background = '#f1ecf6'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
            <Icon name="close" size={18} color="#787584" />
          </button>
        </div>

        {/* Controls: search + filter pills + sort */}
        <div style={{ padding: '14px 20px 8px', display: 'flex', flexDirection: 'column', gap: 12, flexShrink: 0 }}>
          {/* Search */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#f7f4fc', borderRadius: 10, padding: '8px 14px', border: `1.5px solid ${searchFocus ? '#5e4dbb' : 'transparent'}`, transition: 'border-color 180ms' }}>
            <Icon name="search" size={16} color="#787584" />
            <input
              autoFocus
              value={search} onChange={e => setSearch(e.target.value)}
              onFocus={() => setSearchFocus(true)} onBlur={() => setSearchFocus(false)}
              placeholder="Search tasks, lists, tags…"
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontFamily: 'Inter, sans-serif', fontSize: 13.5, color: '#1c1b22' }} />
            {search && (
              <button onClick={() => setSearch('')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', padding: 0 }}>
                <Icon name="close" size={14} color="#787584" />
              </button>
            )}
          </div>

          {/* Filter pills + sort */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button onClick={() => setFilter('all')}       style={filterPillStyle(filter === 'all')}>All</button>
              <button onClick={() => setFilter('open')}      style={filterPillStyle(filter === 'open')}>Open</button>
              <button onClick={() => setFilter('completed')} style={filterPillStyle(filter === 'completed')}>Completed</button>
            </div>
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setSortMenuOpen(o => !o)}
                title="Sort"
                style={{ display: 'flex', alignItems: 'center', gap: 5, height: 28, borderRadius: 8, border: sort ? '1.5px solid #5e4dbb' : '1.5px solid #e8e4f0', background: sort ? '#F5F3FF' : 'transparent', cursor: 'pointer', transition: 'all 150ms', padding: '0 10px', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: sort ? '#5e4dbb' : '#787584' }}>
                <Icon name="sort" size={14} color={sort ? '#5e4dbb' : '#787584'} />
                Sort
              </button>
              {sortMenuOpen && <SortMenu current={sort} onSelect={s => { setSort(s); setSortMenuOpen(false); }} onClose={() => setSortMenuOpen(false)} />}
            </div>
          </div>
        </div>

        {/* Task list (scrollable) */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 14px 16px' }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '32px 12px', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', textAlign: 'center' }}>
              {search ? `No tasks match “${search}”.` : 'Nothing here.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {filtered.map(task => (
                <TaskItem key={`${task._listId}-${task.id}`} task={task}
                  onToggle={onToggle} onDelete={onDelete} onUpdate={onUpdate} onRowClick={onRowClick} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Stat Card ─────────────────────────────────────────────────
function StatCard({ num, label, sub, icon, iconBg, iconColor, accent }) {
  const [hov, setHov] = React.useState(false);
  return (
    <div
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ background: '#F9FAFB', border: `1px solid ${hov ? '#d8d0eb' : '#E5E7EB'}`, borderRadius: 12, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10, transition: 'all 180ms', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ width: 34, height: 34, borderRadius: 10, background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon name={icon} size={17} color={iconColor} />
        </div>
        {sub && <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10.5, fontWeight: 600, color: accent || '#787584', background: accent ? `${accent}14` : '#f1ecf6', borderRadius: 9999, padding: '2px 8px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{sub}</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontWeight: 700, color: '#1c1b22', fontSize: 30, lineHeight: 1, letterSpacing: '-0.02em' }}>{num}</span>
      </div>
      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552' }}>{label}</div>
    </div>
  );
}

// ─── Mini task row (for observer panels) ────────────────────────
function MiniTaskRow({ task, onToggle, onOpen }) {
  const [hov, setHov] = React.useState(false);
  const pri = task.priority;
  const priorityColors = { High: '#ea580c', Medium: '#f59e0b', Low: '#787584' };
  return (
    <div
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      onClick={(e) => onOpen && onOpen(task, e)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, background: hov ? '#F5F3FF' : 'transparent', cursor: 'pointer', transition: 'background 150ms' }}>
      <div
        onClick={e => { e.stopPropagation(); onToggle && onToggle(task.id); }}
        style={{ width: 18, height: 18, minWidth: 18, borderRadius: 5, border: '1.5px solid #c9c4d5', background: task.checked ? '#5e4dbb' : 'transparent', borderColor: task.checked ? '#5e4dbb' : '#c9c4d5', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms' }}>
        {task.checked && <svg width="10" height="8" viewBox="0 0 11 9" fill="none"><path d="M1 4.5L4 7.5L10 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#1c1b22', opacity: task.checked ? 0.4 : 1, textDecoration: task.checked ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          {task._listName && task._source === 'list' && (
            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10.5, color: '#787584' }}>· {task._listName}</span>
          )}
          {pri && <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10.5, fontWeight: 600, color: priorityColors[pri] || '#787584' }}>{pri}</span>}
        </div>
      </div>
      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584', flexShrink: 0 }}>{friendlyDate(task.deadline)}</span>
    </div>
  );
}

// ─── Observer Panel (Due Today / Due This Week) ──────────────────
function ObserverPanel({ title, icon, accent, accentBg, tasks, emptyText, onToggle, onSeeMore, onOpen }) {
  const visible = tasks.slice(0, 5);
  const more = Math.max(0, tasks.length - visible.length);
  const [moreHov, setMoreHov] = React.useState(false);
  return (
    <div style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 14, padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px 6px' }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: accentBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon name={icon} size={15} color={accent} />
        </div>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 700, color: '#1c1b22' }}>{title}</div>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 700, color: accent, background: accentBg, borderRadius: 9999, padding: '2px 9px' }}>{tasks.length}</span>
      </div>
      {tasks.length === 0 ? (
        <div style={{ padding: '24px 12px', textAlign: 'center', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe' }}>{emptyText}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {visible.map(t => <MiniTaskRow key={`${t._listId}-${t.id}`} task={t} onToggle={onToggle} onOpen={onOpen} />)}
          {more > 0 && (
            <button
              onClick={onSeeMore}
              onMouseEnter={() => setMoreHov(true)}
              onMouseLeave={() => setMoreHov(false)}
              style={{ marginTop: 4, width: '100%', background: moreHov ? `${accent}14` : 'transparent', border: `1px dashed ${moreHov ? accent : '#d8d0eb'}`, borderRadius: 8, padding: '8px 10px', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: accent, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, transition: 'all 160ms' }}>
              + {more} more
              <Icon name="chevron_right" size={12} color={accent} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Bento Card ──────────────────────────────────────────────────
function BentoCard({ num, label, sub, icon, iconBg, iconColor, hero, span2, onClick }) {
  const [hovered, setHovered] = React.useState(false);
  return (
    <div
      style={{
        background: hero ? 'linear-gradient(145deg,#F5F3FF 0%,#fdf8ff 100%)' : (hovered ? '#faf9ff' : '#F9FAFB'),
        border: `1px solid ${hovered ? '#9d8dff' : '#E5E7EB'}`,
        borderRadius: 12, padding: hero ? '20px' : '16px',
        cursor: 'pointer', transition: 'all 180ms',
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 10,
        gridColumn: (hero || span2) ? 'span 2' : 'span 1',
        gridRow: hero ? 'span 2' : 'span 1',
        overflow: 'hidden', minWidth: 0
      }}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onClick={onClick}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ width: 34, height: 34, borderRadius: '50%', background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon name={icon} size={18} color={iconColor} />
        </div>
        <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontWeight: 700, color: hero ? '#5e4dbb' : '#1c1b22', fontSize: hero ? 32 : 20, lineHeight: 1 }}>{num}</span>
      </div>
      <div>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: hero ? 15 : 13, fontWeight: hero ? 600 : 500, color: '#1c1b22', marginBottom: 2 }}>{label}</div>
        {sub && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584' }}>{sub}</div>}
      </div>
    </div>
  );
}

// ─── Dashboard Screen ────────────────────────────────────────────
function DashboardScreen({ onNavigateToList }) {
  const { dashTasks, setDashTasks, lists, updateListTask, deleteListTask, addToTrash } = React.useContext(window.AppContext);

  const [draggedId, setDraggedId] = React.useState(null);
  const [dragOverId, setDragOverId] = React.useState(null);
  const [filter, setFilter] = React.useState('all');
  const [sort, setSort] = React.useState(null);
  const [sortMenuOpen, setSortMenuOpen] = React.useState(false);
  const [detailModal, setDetailModal] = React.useState(null); // {source: 'today'|'week'|'todos', title, icon, accent, accentBg}
  const [selectedTask, setSelectedTask] = React.useState(null);
  const [selectedAnchor, setSelectedAnchor] = React.useState(null);
  const [editingTask, setEditingTask] = React.useState(null);
  const openTask = (task, e) => {
    setSelectedTask(task);
    setSelectedAnchor(e ? { x: e.clientX, y: e.clientY } : null);
  };

  const sortedTasks = (tasks) => {
    if (!sort) return tasks;
    return [...tasks].sort((a, b) => {
      if (sort === 'date-asc')  return (a.deadline || '9999') < (b.deadline || '9999') ? -1 : 1;
      if (sort === 'date-desc') return (a.deadline || '') > (b.deadline || '') ? -1 : 1;
      if (sort === 'name-az')   return a.title.localeCompare(b.title);
      if (sort === 'name-za')   return b.title.localeCompare(a.title);
      return 0;
    });
  };

  const visibleTasks = sortedTasks(getFilteredTasks(filter, dashTasks, lists));

  // All tasks across all sources for stats
  const allTasks       = getFilteredTasks('all', dashTasks, lists);
  const totalCount     = allTasks.length;
  const completedCount = allTasks.filter(t => t.checked).length;
  const openCount      = totalCount - completedCount;
  const completionPct  = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const dueTodayTasks  = allTasks.filter(t => isDueToday(t) && !t.checked);
  const dueWeekTasks   = allTasks.filter(t => isDueThisWeek(t) && !t.checked);
  const overdueTasks   = allTasks.filter(isOverdue);
  const scheduledCount = allTasks.filter(t => t.deadline).length;
  const flaggedCount   = allTasks.filter(t => t.priority === 'High').length;

  // Unified toggle/delete/update that routes to correct source
  const toggle = (id) => {
    const t = visibleTasks.find(t => t.id === id);
    if (!t) return;
    if (t._source === 'dash') setDashTasks(ts => ts.map(x => x.id === id ? { ...x, checked: !x.checked } : x));
    else updateListTask(t._listId, id, { checked: !t.checked });
  };

  const deleteTask = (id) => {
    const t = visibleTasks.find(t => t.id === id);
    if (!t) return;
    addToTrash(t, { src: t._source, listId: t._listId, listName: t._listName });
    if (t._source === 'dash') setDashTasks(ts => ts.filter(x => x.id !== id));
    else deleteListTask(t._listId, id);
  };

  const updateTask = (id, updates) => {
    const t = visibleTasks.find(t => t.id === id);
    if (!t) return;
    if (t._source === 'dash') setDashTasks(ts => ts.map(x => x.id === id ? { ...x, ...updates } : x));
    else updateListTask(t._listId, id, updates);
  };

  // Drag-to-reorder (only within dashTasks for simplicity; list tasks are read-only in this view)
  const handleDrop = (targetId) => {
    if (!draggedId || draggedId === targetId) return;
    if (filter !== 'local' && filter !== 'all') return; // only reorder dash tasks
    setDashTasks(prev => {
      const arr = [...prev];
      const from = arr.findIndex(t => t.id === draggedId);
      const to   = arr.findIndex(t => t.id === targetId);
      if (from === -1 || to === -1) return prev;
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      return arr;
    });
    setDraggedId(null); setDragOverId(null);
  };

  const filterPill = (key, label) => {
    const active = filter === key;
    return (
      <button onClick={() => setFilter(key)}
        style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, border: 'none', borderRadius: 9999, padding: '4px 10px', cursor: 'pointer', transition: 'all 150ms', background: active ? '#5e4dbb' : '#f1ecf6', color: active ? '#fff' : '#787584' }}>
        {label}
      </button>
    );
  };

  return (
    <div style={{ flex: 1, height: '100%', overflowY: 'auto' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '32px 32px 48px', display: 'flex', flexDirection: 'column', gap: 24, width: '100%' }}>

        {/* Greeting */}
        <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#9d8dff', marginBottom: 4 }}>
              {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            </div>
            <h1 style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 28, fontWeight: 700, color: '#1c1b22', letterSpacing: '-0.02em', lineHeight: 1.15 }}>
              Dashboard
            </h1>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13.5, color: '#787584', marginTop: 6 }}>
              {dueTodayTasks.length > 0
                ? <>You have <strong style={{ color: '#5e4dbb', fontWeight: 700 }}>{dueTodayTasks.length} task{dueTodayTasks.length === 1 ? '' : 's'}</strong> due today{dueWeekTasks.length > 0 && <> and <strong style={{ color: '#1c1b22', fontWeight: 600 }}>{dueWeekTasks.length}</strong> more this week</>}.</>
                : dueWeekTasks.length > 0
                  ? <>Nothing due today — <strong style={{ color: '#1c1b22', fontWeight: 600 }}>{dueWeekTasks.length}</strong> task{dueWeekTasks.length === 1 ? '' : 's'} ahead this week.</>
                  : <>All clear. No deadlines on the horizon.</>}
            </div>
          </div>
          {overdueTasks.length > 0 && (
            <div style={{ background: '#fff5f5', border: '1px solid #ffdad6', borderRadius: 9999, padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="warning" size={14} color="#ba1a1a" />
              <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#ba1a1a' }}>{overdueTasks.length} overdue</span>
            </div>
          )}
        </header>

        {/* Stats row */}
        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <StatCard
            num={openCount}
            label="Open Tasks"
            sub={`${totalCount} total`}
            icon="inventory_2" iconBg="#F5F3FF" iconColor="#5e4dbb" />
          <StatCard
            num={completedCount}
            label="Completed"
            sub={completedCount > 0 ? `${completionPct}%` : 'Get started'}
            icon="check_circle" iconBg="rgba(16,185,129,0.10)" iconColor="#10B981"
            accent="#10B981" />
          <StatCard
            num={dueTodayTasks.length}
            label="Due Today"
            sub={dueTodayTasks.length > 0 ? 'Focus' : 'Clear'}
            icon="today" iconBg="#fff7ed" iconColor="#ea580c"
            accent={dueTodayTasks.length > 0 ? '#ea580c' : undefined} />
          <StatCard
            num={dueWeekTasks.length}
            label="Due This Week"
            sub="Upcoming"
            icon="calendar_month" iconBg="#eff6ff" iconColor="#1D4ED8" />
        </section>

        {/* Completion progress bar */}
        <section style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 12, padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552' }}>This week's progress</div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, color: '#787584' }}>
              <strong style={{ color: '#1c1b22', fontWeight: 700 }}>{completedCount}</strong> done · <strong style={{ color: '#1c1b22', fontWeight: 700 }}>{openCount}</strong> open
            </div>
          </div>
          <div style={{ height: 8, background: '#ebe6f0', borderRadius: 9999, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${completionPct}%`, background: completionPct === 100 ? '#10B981' : 'linear-gradient(90deg,#9d8dff 0%,#5e4dbb 100%)', borderRadius: 9999, transition: 'width 600ms ease-in-out' }} />
          </div>
        </section>

        {/* Observer panels: Due Today + Due This Week */}
        <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <ObserverPanel
            title="Due Today" icon="today"
            accent="#ea580c" accentBg="#fff7ed"
            tasks={dueTodayTasks}
            emptyText="Nothing on your plate today."
            onToggle={toggle}
            onOpen={openTask}
            onSeeMore={() => setDetailModal({ source: 'today', title: 'Due Today', icon: 'today', accent: '#ea580c', accentBg: '#fff7ed' })} />
          <ObserverPanel
            title="This Week" icon="calendar_month"
            accent="#1D4ED8" accentBg="#eff6ff"
            tasks={dueWeekTasks}
            emptyText="No deadlines this week."
            onToggle={toggle}
            onOpen={openTask}
            onSeeMore={() => setDetailModal({ source: 'week', title: 'Due This Week', icon: 'calendar_month', accent: '#1D4ED8', accentBg: '#eff6ff' })} />
        </section>

        {/* Quick Add */}
        <section>
          <div style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 12, overflow: 'hidden' }}>
            <QuickAdd onAdd={data => {
              const newTask = { id: Date.now(), checked: false, ...data };
              setDashTasks(ts => [newTask, ...ts]);
            }} />
          </div>
        </section>

        {/* Today's Focus with filter */}
        <section>
          <div style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 12, padding: '16px 12px 8px' }}>

            {/* Header + filters + sort */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, padding: '0 4px', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#b0acbe' }}>Todos</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {filterPill('all', 'All')}
                {filterPill('local', 'Dashboard')}
                <ListDropdown lists={lists} selectedId={filter !== 'all' && filter !== 'local' ? filter : null} onSelect={id => setFilter(id)} />

                {/* Sort button */}
                <div style={{ position: 'relative' }}>
                  <button
                    onClick={() => setSortMenuOpen(o => !o)}
                    title="Sort"
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, border: sort ? '1.5px solid #5e4dbb' : '1.5px solid #e8e4f0', background: sort ? '#F5F3FF' : 'transparent', cursor: 'pointer', transition: 'all 150ms' }}>
                    <Icon name="sort" size={15} color={sort ? '#5e4dbb' : '#787584'} />
                  </button>
                  {sortMenuOpen && <SortMenu current={sort} onSelect={s => { setSort(s); setSortMenuOpen(false); }} onClose={() => setSortMenuOpen(false)} />}
                </div>
              </div>
            </div>

            {/* Task list — capped at 5 */}
            {visibleTasks.length === 0 ? (
              <div style={{ padding: '16px 10px', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', textAlign: 'center' }}>No tasks here yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {visibleTasks.slice(0, 5).map(task => (
                  <TaskItem key={`${task._listId}-${task.id}`} task={task}
                    onToggle={toggle} onDelete={deleteTask} onUpdate={updateTask}
                    onRowClick={openTask}
                    onDragStart={id => setDraggedId(id)}
                    onDragOver={id => setDragOverId(id)}
                    onDrop={handleDrop}
                    onDragEnd={() => { setDraggedId(null); setDragOverId(null); }}
                    isDragging={draggedId === task.id}
                    isDragOver={dragOverId === task.id && draggedId !== task.id} />
                ))}
                {visibleTasks.length > 5 && (
                  <button
                    onClick={() => setDetailModal({ source: 'todos', title: 'All Todos', icon: 'inventory_2', accent: '#5e4dbb', accentBg: '#F5F3FF' })}
                    onMouseEnter={e => { e.currentTarget.style.background = '#F5F3FF'; e.currentTarget.style.borderColor = '#5e4dbb'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = '#d8d0eb'; }}
                    style={{ marginTop: 6, width: '100%', background: 'transparent', border: '1px dashed #d8d0eb', borderRadius: 8, padding: '9px 10px', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, color: '#5e4dbb', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, transition: 'all 160ms' }}>
                    + {visibleTasks.length - 5} more
                    <Icon name="chevron_right" size={12} color="#5e4dbb" />
                  </button>
                )}
              </div>
            )}
          </div>
        </section>

      </div>

      {detailModal && (
        <TasksDetailModal
          title={detailModal.title}
          icon={detailModal.icon}
          accent={detailModal.accent}
          accentBg={detailModal.accentBg}
          tasks={detailModal.source === 'today' ? dueTodayTasks
               : detailModal.source === 'week'  ? dueWeekTasks
               : visibleTasks}
          onClose={() => setDetailModal(null)}
          onToggle={toggle}
          onDelete={deleteTask}
          onUpdate={updateTask}
          onRowClick={openTask} />
      )}

      {selectedTask && window.TaskDetailPopup && (
        <window.TaskDetailPopup
          task={selectedTask}
          anchor={selectedAnchor}
          onEdit={t => { setSelectedTask(null); setEditingTask(t); }}
          onGoToList={id => { setSelectedTask(null); onNavigateToList && onNavigateToList(id); }}
          onClose={() => setSelectedTask(null)} />
      )}

      {editingTask && window.EditModal && (
        <window.EditModal
          task={editingTask}
          onSave={updates => { updateTask(editingTask.id, updates); setEditingTask(null); }}
          onClose={() => setEditingTask(null)} />
      )}
    </div>
  );
}

Object.assign(window, { DashboardScreen });
