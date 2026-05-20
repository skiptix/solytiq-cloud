// Solytiq Cloud — Completed & Trash Modal
// Export: window.CompletedTrashModal

// ─── Sort helpers (same as dashboard) ────────────────────────────
const CT_SORT_OPTIONS = [
  { key: 'date-asc',  label: 'Date',  sub: 'Ascending',  icon: 'arrow_up2'  },
  { key: 'date-desc', label: 'Date',  sub: 'Descending', icon: 'arrow_down' },
  { key: 'name-az',   label: 'Name',  sub: 'A → Z',      icon: 'arrow_down' },
  { key: 'name-za',   label: 'Name',  sub: 'Z → A',      icon: 'arrow_up2'  },
];

function ctSortTasks(tasks, sort) {
  if (!sort) return tasks;
  return [...tasks].sort((a, b) => {
    if (sort === 'date-asc')  return (a.deadline || '9999') < (b.deadline || '9999') ? -1 : 1;
    if (sort === 'date-desc') return (a.deadline || '') > (b.deadline || '') ? -1 : 1;
    if (sort === 'name-az')   return a.title.localeCompare(b.title);
    if (sort === 'name-za')   return b.title.localeCompare(a.title);
    return 0;
  });
}

// ─── Mini Sort Menu ───────────────────────────────────────────────
function CTSortMenu({ current, onSelect, onClose }) {
  React.useEffect(() => {
    const h = () => onClose();
    const t = setTimeout(() => document.addEventListener('click', h), 0);
    return () => { clearTimeout(t); document.removeEventListener('click', h); };
  }, []);

  return (
    <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 600, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.10)', minWidth: 168, overflow: 'hidden', animation: 'menuIn 180ms cubic-bezier(0.34,1.56,0.64,1) both', transformOrigin: 'top right' }}
      onClick={e => e.stopPropagation()}>
      <style>{`@keyframes menuIn{from{opacity:0;transform:scale(.88) translateY(-6px)}to{opacity:1;transform:scale(1) translateY(0)}} @keyframes menuItemIn{from{opacity:0;transform:translateX(6px)}to{opacity:1;transform:translateX(0)}}`}</style>
      <div style={{ padding: '6px 8px 4px', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#b0acbe' }}>Sort by</div>
      {CT_SORT_OPTIONS.map((opt, i) => {
        const active = current === opt.key;
        return (
          <button key={opt.key}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '8px 12px', background: active ? '#F5F3FF' : 'transparent', border: 'none', cursor: 'pointer', transition: 'background 120ms', animation: `menuItemIn 160ms ${50 + i * 40}ms ease both`, borderBottom: i < CT_SORT_OPTIONS.length - 1 ? '1px solid #f7f4fc' : 'none' }}
            onMouseEnter={e => { if (!active) e.currentTarget.style.background='#faf9ff'; }}
            onMouseLeave={e => { if (!active) e.currentTarget.style.background='transparent'; }}
            onClick={() => onSelect(active ? null : opt.key)}>
            <Icon name={opt.icon} size={13} color={active ? '#5e4dbb' : '#c9c4d5'} />
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

// ─── Task Row (read-only, with action buttons) ────────────────────
function CTTaskRow({ task, actions }) {
  const [hov, setHov] = React.useState(false);
  const bc = task.badge ? ({ Work:{bg:'#f9e287',color:'#6e5e0d'}, Personal:{bg:'#F5F3FF',color:'#5e4dbb'}, Urgent:{bg:'#ffdad6',color:'#ba1a1a'}, Tip:{bg:'#eff6ff',color:'#1D4ED8'} }[task.badge] || {bg:'#F5F3FF',color:'#484552'}) : null;
  const pc = { High:'#ea580c', Medium:'#f59e0b', Low:'#787584' }[task.priority];

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 8, background: hov ? '#faf9ff' : 'transparent', transition: 'background 150ms' }}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}>

      {/* Status dot */}
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: task._deletedAt ? '#c9c4d5' : '#10B981', flexShrink: 0 }} />

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#1c1b22', opacity: task._deletedAt ? 0.6 : 1, textDecoration: task.checked && !task._deletedAt ? 'line-through' : 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {task.title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, flexWrap: 'wrap' }}>
          {task._listName && (
            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#b0acbe' }}>{task._listName}</span>
          )}
          {task.deadline && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 2, fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#787584' }}>
              <Icon name="calendar_today" size={10} color="#c9c4d5" />{task.deadline}
            </span>
          )}
          {task.priority && <span style={{ fontSize: 10, fontWeight: 600, color: pc }}>{task.priority}</span>}
          {bc && <span style={{ borderRadius: 9999, padding: '0 6px', fontSize: 9, fontWeight: 600, background: bc.bg, color: bc.color }}>{task.badge}</span>}
          {task._deletedAt && (() => {
            const days = Math.max(0, 30 - Math.floor((Date.now() - new Date(task._deletedAt)) / 86400000));
            return <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: days < 5 ? '#ea580c' : '#b0acbe' }}>{days}d left</span>;
          })()}
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 6, opacity: hov ? 1 : 0, transition: 'opacity 150ms', flexShrink: 0 }}>
        {actions.map(a => (
          <button key={a.label} onClick={a.onClick}
            style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, border: `1px solid ${a.danger ? 'rgba(186,26,26,0.2)' : '#e8e4f0'}`, background: 'transparent', color: a.danger ? '#ba1a1a' : '#5e4dbb', cursor: 'pointer', transition: 'all 120ms' }}
            onMouseEnter={e => e.currentTarget.style.background = a.danger ? '#fff5f5' : '#F5F3FF'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Main Modal ───────────────────────────────────────────────────
function CompletedTrashModal({ initialTab = 'completed', onClose }) {
  const { dashTasks, setDashTasks, lists, setLists, trashTasks, setTrashTasks } = React.useContext(window.AppContext);

  const [tab, setTab] = React.useState(initialTab);
  const [search, setSearch] = React.useState('');
  const [sort, setSort] = React.useState(null);
  const [sortOpen, setSortOpen] = React.useState(false);

  // ── Completed tasks: all checked tasks from all sources ──────────
  const completedTasks = React.useMemo(() => {
    const dash = dashTasks.filter(t => t.checked).map(t => ({ ...t, _listName: 'Dashboard', _src: 'dash' }));
    const list = lists.flatMap(l => l.sections.flatMap(s => s.tasks.filter(t => t.checked).map(t => ({ ...t, _listName: l.name, _listId: l.id, _src: 'list' }))));
    return [...dash, ...list];
  }, [dashTasks, lists]);

  // ── Trash tasks: deleted within last 30 days ─────────────────────
  const trashVisible = React.useMemo(() => {
    const cutoff = Date.now() - 30 * 86400000;
    return trashTasks.filter(t => new Date(t._deletedAt).getTime() > cutoff);
  }, [trashTasks]);

  const raw = tab === 'completed' ? completedTasks : trashVisible;
  const filtered = ctSortTasks(
    raw.filter(t => !search || t.title.toLowerCase().includes(search.toLowerCase())),
    sort
  );

  // ── Actions ────────────────────────────────────────────────────────
  const uncheck = (task) => {
    if (task._src === 'dash') setDashTasks(ts => ts.map(t => t.id === task.id ? { ...t, checked: false } : t));
    else setLists(prev => prev.map(l => l.id !== task._listId ? l : { ...l, sections: l.sections.map(s => ({ ...s, tasks: s.tasks.map(t => t.id === task.id ? { ...t, checked: false } : t) })) }));
  };

  const restore = (task) => {
    setTrashTasks(prev => prev.filter(t => !(t.id === task.id && t._deletedAt === task._deletedAt)));
    if (task._src === 'list' && task._listId) {
      setLists(prev => prev.map(l => l.id !== task._listId ? l : { ...l, sections: l.sections.map((s, i) => i === 0 ? { ...s, tasks: [...s.tasks, { id: task.id, title: task.title, note: task.note, deadline: task.deadline, priority: task.priority, badge: task.badge, checked: false }] } : s) }));
    } else {
      setDashTasks(prev => [...prev, { id: task.id, title: task.title, note: task.note, deadline: task.deadline, priority: task.priority, badge: task.badge, checked: false }]);
    }
  };

  const deletePermanent = (task) => {
    setTrashTasks(prev => prev.filter(t => !(t.id === task.id && t._deletedAt === task._deletedAt)));
  };

  const emptyTrash = () => setTrashTasks([]);

  const tabBtn = (key, label, count) => {
    const active = tab === key;
    return (
      <button onClick={() => setTab(key)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: active ? 600 : 500, color: active ? '#5e4dbb' : '#787584', background: 'none', border: 'none', borderBottom: `2px solid ${active ? '#5e4dbb' : 'transparent'}`, cursor: 'pointer', transition: 'all 150ms' }}>
        {label}
        <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 700, background: active ? '#e5deff' : '#f1ecf6', color: active ? '#5e4dbb' : '#787584', borderRadius: 9999, padding: '1px 7px', transition: 'all 150ms' }}>{count}</span>
      </button>
    );
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(6px)', zIndex: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}>
      <style>{`@keyframes ctModalIn{from{opacity:0;transform:scale(.95) translateY(12px)}to{opacity:1;transform:scale(1) translateY(0)}}`}</style>

      <div style={{ width: '70vw', height: '70vh', background: '#fff', borderRadius: 16, boxShadow: '0 12px 48px rgba(0,0,0,0.16)', display: 'flex', flexDirection: 'column', overflow: 'hidden', animation: 'ctModalIn 300ms cubic-bezier(0.34,1.56,0.64,1) both' }}
        onClick={e => e.stopPropagation()}>

        {/* ── Header ───────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', borderBottom: '1px solid #f1ecf6' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {tabBtn('completed', 'Completed', completedTasks.length)}
            {tabBtn('trash', 'Trash', trashVisible.length)}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {tab === 'trash' && trashVisible.length > 0 && (
              <button onClick={emptyTrash} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 500, color: '#ba1a1a', background: 'transparent', border: '1px solid rgba(186,26,26,0.2)', borderRadius: 7, padding: '5px 12px', cursor: 'pointer', transition: 'all 150ms' }}
                onMouseEnter={e => e.currentTarget.style.background='#fff5f5'}
                onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                Empty Trash
              </button>
            )}
            <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#787584', transition: 'background 150ms' }}
              onMouseEnter={e => e.currentTarget.style.background='#f1ecf6'}
              onMouseLeave={e => e.currentTarget.style.background='transparent'}>
              <Icon name="close" size={16} color="#787584" />
            </button>
          </div>
        </div>

        {/* ── Toolbar: search + sort ───────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderBottom: '1px solid #f7f4fc' }}>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, background: '#f7f2fc', borderRadius: 9999, padding: '8px 14px' }}>
            <Icon name="search" size={15} color="#b0acbe" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder={`Search ${tab}…`}
              style={{ flex: 1, border: 'none', background: 'transparent', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#1c1b22', outline: 'none' }} />
            {search && (
              <button onClick={() => setSearch('')} style={{ border: 'none', background: 'none', cursor: 'pointer', display: 'flex' }}>
                <Icon name="close" size={13} color="#b0acbe" />
              </button>
            )}
          </div>
          <div style={{ position: 'relative' }}>
            <button onClick={() => setSortOpen(o => !o)} title="Sort"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 9, border: sort ? '1.5px solid #5e4dbb' : '1.5px solid #e8e4f0', background: sort ? '#F5F3FF' : 'transparent', cursor: 'pointer', transition: 'all 150ms' }}>
              <Icon name="sort" size={16} color={sort ? '#5e4dbb' : '#787584'} />
            </button>
            {sortOpen && <CTSortMenu current={sort} onSelect={s => { setSort(s); setSortOpen(false); }} onClose={() => setSortOpen(false)} />}
          </div>
        </div>

        {/* ── Task list ────────────────────────────────────────── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px' }}>
          {filtered.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12 }}>
              <Icon name={tab === 'completed' ? 'check_circle' : 'delete'} size={40} color="#e8e4f0" />
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 500, color: '#b0acbe' }}>
                {search ? 'No matches found' : tab === 'completed' ? 'No completed tasks yet' : 'Trash is empty'}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {filtered.map((task, i) => (
                <CTTaskRow key={`${task.id}-${i}`} task={task}
                  actions={tab === 'completed'
                    ? [{ label: 'Uncheck', onClick: () => uncheck(task) }]
                    : [{ label: 'Restore', onClick: () => restore(task) }, { label: 'Delete Forever', onClick: () => deletePermanent(task), danger: true }]
                  } />
              ))}
            </div>
          )}
        </div>

        {/* ── Footer ───────────────────────────────────────────── */}
        <div style={{ padding: '10px 20px', borderTop: '1px solid #f7f4fc', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe' }}>
            {tab === 'trash' ? 'Items are permanently deleted after 30 days' : `${completedTasks.length} completed task${completedTasks.length !== 1 ? 's' : ''}`}
          </span>
          {filtered.length > 0 && <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe' }}>{filtered.length} item{filtered.length !== 1 ? 's' : ''}</span>}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { CompletedTrashModal });
