// Solytiq Cloud — Scheduled Screen (Calendar + Unscheduled sidebar)
// Export: window.ScheduledScreen

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const PC = { High: '#ea580c', Medium: '#f59e0b', Low: '#787584' };
const BC = { Work:{bg:'#f9e287',color:'#6e5e0d'}, Personal:{bg:'#F5F3FF',color:'#5e4dbb'}, Urgent:{bg:'#ffdad6',color:'#ba1a1a'}, Tip:{bg:'#eff6ff',color:'#1D4ED8'} };

function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ─── Task Detail Popup (shown when clicking a chip) ──────────────
function TaskDetailPopup({ task, anchor, onEdit, onGoToList, onClose }) {
  const col = PC[task.priority] || '#5e4dbb';
  const bc  = task.badge ? (BC[task.badge] || { bg:'#F5F3FF', color:'#484552' }) : null;
  const src = task._src || task._source; // dashboard uses _source, scheduled uses _src

  // Position near click point if anchor provided, otherwise center
  const POPUP_W = 320, POPUP_H = 280, PAD = 12;
  let pos;
  if (anchor) {
    let left = anchor.x + 8;
    let top  = anchor.y + 8;
    if (typeof window !== 'undefined') {
      const vw = window.innerWidth, vh = window.innerHeight;
      if (left + POPUP_W > vw - PAD) left = Math.max(PAD, anchor.x - POPUP_W - 8);
      if (top  + POPUP_H > vh - PAD) top  = Math.max(PAD, anchor.y - POPUP_H - 8);
      if (left < PAD) left = PAD;
      if (top  < PAD) top  = PAD;
    }
    pos = { top, left };
  } else {
    pos = { top: '50%', left: '50%', transform: 'translate(-50%,-50%)' };
  }

  React.useEffect(() => {
    const h = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1100, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-start', pointerEvents: 'none' }}
      onClick={onClose}>
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'all' }} onClick={onClose} />
      <div style={{ position: 'fixed', ...pos, width: 320, background: '#fff', borderRadius: 14, boxShadow: '0 8px 32px rgba(0,0,0,0.14)', animation: 'scModalIn 240ms cubic-bezier(0.34,1.56,0.64,1) both', pointerEvents: 'all', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}>

        {/* Header stripe */}
        <div style={{ height: 4, background: col }} />

        <div style={{ padding: '16px 18px 18px' }}>
          {/* Title + close */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 700, color: '#1c1b22', lineHeight: 1.3, flex: 1 }}>
              {task.title}
            </div>
            <button onClick={onClose} style={{ flexShrink: 0, width: 24, height: 24, border: 'none', background: 'transparent', borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 150ms' }}
              onMouseEnter={e => e.currentTarget.style.background='#f1ecf6'}
              onMouseLeave={e => e.currentTarget.style.background='transparent'}>
              <Icon name="close" size={14} color="#787584" />
            </button>
          </div>

          {/* Meta rows */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {task.deadline && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="calendar_today" size={13} color="#b0acbe" />
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#484552' }}>
                  {new Date(task.deadline+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'long',day:'numeric',year:'numeric'})}
                </span>
              </div>
            )}
            {task.priority && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="flag" size={13} color={col} />
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, fontWeight: 600, color: col }}>{task.priority} Priority</span>
              </div>
            )}
            {bc && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 13, height: 13, borderRadius: 3, background: bc.bg, flexShrink: 0 }} />
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#484552' }}>{task.badge}</span>
              </div>
            )}
            {task.note && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <Icon name="format_list_bulleted" size={13} color="#b0acbe" />
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', lineHeight: 1.4 }}>{task.note}</span>
              </div>
            )}
            {/* Source list */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: '#F5F3FF', borderRadius: 8, marginTop: 2 }}>
              <Icon name="format_list_bulleted" size={13} color="#9d8dff" />
              <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#5e4dbb', flex: 1 }}>{task._listName || 'Dashboard'}</span>
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => { onClose(); onEdit(task); }}
              style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#5e4dbb', border: 'none', borderRadius: 9, padding: '10px 0', cursor: 'pointer', transition: 'background 180ms' }}
              onMouseEnter={e => e.currentTarget.style.background='#5044aa'}
              onMouseLeave={e => e.currentTarget.style.background='#5e4dbb'}>
              Edit Task
            </button>
            {src === 'list' && task._listId && onGoToList && (
              <button onClick={() => { onClose(); onGoToList(task._listId, task.id); }}
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', border: '1.5px solid #e5deff', borderRadius: 9, padding: '10px 0', cursor: 'pointer', transition: 'all 180ms' }}
                onMouseEnter={e => { e.currentTarget.style.background='#ede6ff'; e.currentTarget.style.borderColor='#d4cbff'; }}
                onMouseLeave={e => { e.currentTarget.style.background='#F5F3FF'; e.currentTarget.style.borderColor='#e5deff'; }}>
                Go to task <Icon name="chevron_right" size={13} color="#5e4dbb" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Tiny scheduled chip on calendar day ─────────────────────────
function CalChip({ task, onSelect }) {
  const [hov, setHov] = React.useState(false);
  const col = PC[task.priority] || '#5e4dbb';
  return (
    <div
      onClick={e => { e.stopPropagation(); onSelect && onSelect(task, e); }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 4, background: hov ? '#ede9ff' : '#F5F3FF', borderRadius: 5, padding: '2px 6px', fontSize: 10, fontFamily: 'Inter, sans-serif', color: '#1c1b22', cursor: 'pointer', transition: 'background 120ms', overflow: 'hidden' }}>
      <div style={{ width: 5, height: 5, borderRadius: '50%', background: col, flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 }}>{task.title}</span>
    </div>
  );
}

// ─── Calendar Day Cell ────────────────────────────────────────────
function DayCell({ date, tasks, isToday, isOtherMonth, onDrop, onSelect }) {
  const [over, setOver] = React.useState(false);
  const iso = date ? toISO(date) : null;

  return (
    <div
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); onDrop && onDrop(iso); }}
      style={{
        minHeight: 96, borderRadius: 8, padding: '6px 6px 4px',
        background: over ? '#ede9ff' : isToday ? '#faf8ff' : '#fff',
        border: over ? '1.5px dashed #9d8dff' : isToday ? '1.5px solid #c8bfff' : '1px solid #f1ecf6',
        display: 'flex', flexDirection: 'column', gap: 3,
        transition: 'background 120ms, border-color 120ms',
        opacity: isOtherMonth ? 0.4 : 1,
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}>
      {date && (
        <>
          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: isToday ? 700 : 500, color: isToday ? '#5e4dbb' : '#484552', alignSelf: 'flex-end', width: 22, height: 22, borderRadius: '50%', background: isToday ? '#e5deff' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {date.getDate()}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' }}>
            {tasks.slice(0, 3).map(t => <CalChip key={t.id} task={t} onSelect={onSelect} />)}
            {tasks.length > 3 && (
              <div style={{ fontSize: 9, color: '#b0acbe', fontFamily: 'Inter, sans-serif', paddingLeft: 4 }}>+{tasks.length - 3} more</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Unscheduled Item ─────────────────────────────────────────────
function UnscheduledItem({ task, onEdit, onDragStart }) {
  const [hov, setHov] = React.useState(false);
  const bc = task.badge ? (BC[task.badge] || { bg:'#F5F3FF', color:'#484552' }) : null;

  return (
    <div
      draggable
      onDragStart={e => { e.dataTransfer.effectAllowed='move'; onDragStart && onDragStart(task); }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, background: hov ? '#F5F3FF' : 'transparent', transition: 'background 150ms', cursor: 'grab' }}>
      {/* Drag handle */}
      <div style={{ opacity: hov ? 1 : 0, transition: 'opacity 150ms', flexShrink: 0 }}>
        <Icon name="drag_indicator" size={15} color="#c9c4d5" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#1c1b22', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{task.title}</div>
        <div style={{ display: 'flex', gap: 4, marginTop: 2, flexWrap: 'wrap', alignItems: 'center' }}>
          {task._listName && <span style={{ fontSize: 9, color: '#b0acbe', fontFamily: 'Inter, sans-serif' }}>{task._listName}</span>}
          {task.priority && <span style={{ fontSize: 9, fontWeight: 600, color: PC[task.priority] }}>{task.priority}</span>}
          {bc && <span style={{ borderRadius: 9999, padding: '0 5px', fontSize: 9, fontWeight: 600, background: bc.bg, color: bc.color }}>{task.badge}</span>}
        </div>
      </div>
      {/* Edit button */}
      <button
        onClick={e => { e.stopPropagation(); onEdit && onEdit(task); }}
        style={{ opacity: hov ? 1 : 0, transition: 'opacity 150ms', flexShrink: 0, border: '1px solid #e8e4f0', background: 'transparent', borderRadius: 6, padding: '3px 8px', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10, fontWeight: 600, color: '#5e4dbb', cursor: 'pointer' }}>
        Edit
      </button>
    </div>
  );
}

// ─── Scheduled Screen ─────────────────────────────────────────────
function ScheduledScreen() {
  const { dashTasks, setDashTasks, lists, setLists, updateListTask } = React.useContext(window.AppContext);
  const today = new Date();
  const [view, setView] = React.useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [draggedOver, setDraggedOver] = React.useState(null);
  const draggingRef = React.useRef(null);
  const [sidebarW, setSidebarW] = React.useState(() => {
    const saved = parseInt(document.cookie.split(';').map(c=>c.trim()).find(c=>c.startsWith('sc_sidebar_w='))?.split('=')[1]);
    return (saved && saved >= 160 && saved <= 480) ? saved : 240;
  });

  const saveSidebarW = (w) => {
    setSidebarW(w);
    document.cookie = `sc_sidebar_w=${w};path=/;max-age=31536000`;
  };
  const [editTask, setEditTask] = React.useState(null);
  const [selectedTask, setSelectedTask] = React.useState(null);
  const [selectedAnchor, setSelectedAnchor] = React.useState(null);
  const openTask = (task, e) => {
    setSelectedTask(task);
    setSelectedAnchor(e ? { x: e.clientX, y: e.clientY } : null);
  };
  const [unschSearch, setUnschSearch] = React.useState('');

  const year = view.getFullYear();
  const month = view.getMonth();

  // Build all tasks flat
  const allTasks = React.useMemo(() => {
    const dash = dashTasks.map(t => ({ ...t, _src: 'dash', _listName: 'Dashboard' }));
    const list = lists.flatMap(l => l.sections.flatMap(s => s.tasks.map(t => ({ ...t, _src: 'list', _listId: l.id, _listName: l.name }))));
    return [...dash, ...list].filter(t => !t.checked);
  }, [dashTasks, lists]);

  const scheduled   = allTasks.filter(t => t.deadline);
  const unscheduledAll = allTasks.filter(t => !t.deadline);
  const unscheduled = unschSearch
    ? unscheduledAll.filter(t => t.title.toLowerCase().includes(unschSearch.toLowerCase()))
    : unscheduledAll;

  // Tasks by date ISO
  const tasksByDate = React.useMemo(() => {
    const map = {};
    scheduled.forEach(t => { if (!map[t.deadline]) map[t.deadline] = []; map[t.deadline].push(t); });
    return map;
  }, [scheduled]);

  // Build calendar grid
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev  = new Date(year, month, 0).getDate();
  const cells = [];
  for (let i = firstDay - 1; i >= 0; i--) cells.push({ date: new Date(year, month - 1, daysInPrev - i), other: true });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ date: new Date(year, month, d), other: false });
  while (cells.length < 42) { cells.push({ date: new Date(year, month + 1, cells.length - daysInMonth - firstDay + 1), other: true }); }

  const navBtn = { background: 'none', border: 'none', cursor: 'pointer', width: 30, height: 30, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#787584', transition: 'background 150ms' };

  // Drop onto a day
  const handleDrop = (iso) => {
    const t = draggingRef.current;
    if (!t || !iso) return;
    const { id, _src, _listId } = t;
    if (_src === 'dash') setDashTasks(ts => ts.map(t => t.id === id ? { ...t, deadline: iso } : t));
    else updateListTask(_listId, id, { deadline: iso });
    draggingRef.current = null;
    setDraggedOver(null);
  };

  // Save from edit modal
  const handleEditSave = (id, src, listId, updates) => {
    if (src === 'dash') setDashTasks(ts => ts.map(t => t.id === id ? { ...t, ...updates } : t));
    else updateListTask(listId, id, updates);
    setEditTask(null);
  };

  return (
    <div style={{ flex: 1, display: 'flex', height: '100%', overflow: 'hidden' }}>
      <style>{`@keyframes scModalIn{from{opacity:0;transform:scale(.95)}to{opacity:1;transform:scale(1)}}`}</style>

      {/* ── Main calendar area ──────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '24px 24px 16px' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <h1 style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 22, fontWeight: 700, color: '#1c1b22', letterSpacing: '-0.01em', flex: 1 }}>Scheduled</h1>
          <button style={navBtn}
            onMouseEnter={e => e.currentTarget.style.background='#f1ecf6'}
            onMouseLeave={e => e.currentTarget.style.background='none'}
            onClick={() => setView(new Date(year, month - 1, 1))}>
            <Icon name="chevron_right" size={18} color="#787584" style={{ transform: 'rotate(180deg)' }} />
          </button>
          <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 600, color: '#1c1b22', minWidth: 140, textAlign: 'center' }}>{MONTHS[month]} {year}</span>
          <button style={navBtn}
            onMouseEnter={e => e.currentTarget.style.background='#f1ecf6'}
            onMouseLeave={e => e.currentTarget.style.background='none'}
            onClick={() => setView(new Date(year, month + 1, 1))}>
            <Icon name="chevron_right" size={18} color="#787584" />
          </button>
          <button onClick={() => setView(new Date(today.getFullYear(), today.getMonth(), 1))}
            style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', border: 'none', borderRadius: 8, padding: '6px 14px', cursor: 'pointer' }}>
            Today
          </button>
        </div>

        {/* Day-of-week row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 4 }}>
          {DAYS_SHORT.map(d => (
            <div key={d} style={{ textAlign: 'center', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10, fontWeight: 700, color: '#b0acbe', letterSpacing: '0.05em', paddingBottom: 4 }}>{d}</div>
          ))}
        </div>

        {/* Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gridTemplateRows: 'repeat(6, 1fr)', gap: 4, flex: 1, overflow: 'hidden' }}>
          {cells.map((cell, i) => {
            const iso = toISO(cell.date);
            const isToday = iso === toISO(today);
            const dayTasks = tasksByDate[iso] || [];
            return (
              <DayCell key={i} date={cell.date} tasks={dayTasks} isToday={isToday} isOtherMonth={cell.other}
                onDrop={handleDrop} onSelect={openTask} />
            );
          })}
        </div>
      </div>

      {/* ── Resize handle ────────────────────────────────── */}
      <div
        onMouseDown={e => {
          e.preventDefault();
          const startX = e.clientX;
          const startW = sidebarW;
          const onMove = ev => saveSidebarW(Math.min(480, Math.max(160, startW - (ev.clientX - startX))));
          const onUp   = ()  => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); document.body.style.cursor = ''; document.body.style.userSelect = ''; };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
        }}
        style={{ width: 6, flexShrink: 0, cursor: 'col-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', transition: 'background 150ms', position: 'relative', zIndex: 2 }}
        onMouseEnter={e => e.currentTarget.style.background='rgba(94,77,187,0.12)'}
        onMouseLeave={e => e.currentTarget.style.background='transparent'}>
        <div style={{ width: 2, height: 32, borderRadius: 2, background: '#c8bfff', opacity: 0.7 }} />
      </div>

      {/* ── Unscheduled sidebar ─────────────────────────────── */}
      <div style={{ width: sidebarW, flexShrink: 0, borderLeft: '1px solid #f1ecf6', display: 'flex', flexDirection: 'column', background: '#fdf8ff', overflow: 'hidden' }}>
        <div style={{ padding: '16px 14px 10px', borderBottom: '1px solid #f1ecf6', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#b0acbe' }}>Unscheduled</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#c9c4d5' }}>{unscheduledAll.length} task{unscheduledAll.length !== 1 ? 's' : ''}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#f1ecf6', borderRadius: 8, padding: '6px 10px' }}>
            <Icon name="search" size={13} color="#b0acbe" />
            <input value={unschSearch} onChange={e => setUnschSearch(e.target.value)} placeholder="Search…"
              style={{ border: 'none', background: 'transparent', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#1c1b22', outline: 'none', flex: 1, minWidth: 0 }} />
            {unschSearch && <button onClick={() => setUnschSearch('')} style={{ border: 'none', background: 'none', cursor: 'pointer', display: 'flex', padding: 0 }}><Icon name="close" size={11} color="#b0acbe" /></button>}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 6px' }}>
          {unscheduled.length === 0 ? (
            <div style={{ padding: '24px 12px', textAlign: 'center', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#c9c4d5' }}>All tasks are scheduled 🎉</div>
          ) : (
            unscheduled.map(task => (
              <UnscheduledItem key={`${task._src}-${task.id}`} task={task}
                onEdit={setEditTask}
                onDragStart={t => { draggingRef.current = t; }} />
            ))
          )}
        </div>
      </div>

      {/* ── Task Detail Popup ───────────────────────────────── */}
      {selectedTask && (
        <TaskDetailPopup
          task={selectedTask}
          anchor={selectedAnchor}
          onEdit={t => { setSelectedTask(null); setEditTask(t); }}
          onGoToList={id => { setSelectedTask(null); window.__schedNavigate && window.__schedNavigate(id); }}
          onClose={() => setSelectedTask(null)} />
      )}

      {/* ── Edit Modal (inline, lightweight) ───────────────── */}
      {editTask && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setEditTask(null)}>
          <div style={{ background: '#fff', borderRadius: 14, width: 420, boxShadow: '0 8px 32px rgba(0,0,0,0.14)', animation: 'scModalIn 260ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'visible' }}
            onClick={e => e.stopPropagation()}>
            <SchedEditForm task={editTask} onSave={handleEditSave} onClose={() => setEditTask(null)} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Inline Edit Form (used by ScheduledScreen) ───────────────────
function SchedEditForm({ task, onSave, onClose }) {
  const [title,    setTitle]    = React.useState(task.title || '');
  const [deadline, setDeadline] = React.useState(task.deadline || '');
  const [priority, setPriority] = React.useState(task.priority || '');
  const [note,     setNote]     = React.useState(task.note || '');
  const [showCal,  setShowCal]  = React.useState(false);

  const PRIOS = ['High', 'Medium', 'Low'];
  const fl = { fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', marginBottom: 5, display: 'block' };
  const fi = { width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#1c1b22', background: 'transparent', border: 'none', borderBottom: '1.5px solid #E5E7EB', padding: '7px 0', outline: 'none', transition: 'border-color 200ms' };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px 14px', borderBottom: '1px solid #F5F3FF' }}>
        <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 700, color: '#1c1b22' }}>Edit Task</span>
        <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onMouseEnter={e => e.currentTarget.style.background='#f1ecf6'}
          onMouseLeave={e => e.currentTarget.style.background='transparent'}>
          <Icon name="close" size={15} color="#787584" />
        </button>
      </div>
      <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div><label style={fl}>Task Name</label>
          <input value={title} onChange={e => setTitle(e.target.value)} style={fi}
            onFocus={e => e.target.style.borderBottomColor='#5e4dbb'}
            onBlur={e => e.target.style.borderBottomColor='#E5E7EB'} />
        </div>
        <div><label style={fl}>Notes</label>
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} style={{ ...fi, resize: 'none', lineHeight: 1.5 }}
            onFocus={e => e.target.style.borderBottomColor='#5e4dbb'}
            onBlur={e => e.target.style.borderBottomColor='#E5E7EB'} />
        </div>
        <div style={{ position: 'relative' }}>
          <label style={fl}>Deadline</label>
          <button onClick={() => setShowCal(c => !c)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'transparent', border: 'none', borderBottom: `1.5px solid ${showCal ? '#5e4dbb' : '#E5E7EB'}`, padding: '8px 0', cursor: 'pointer', textAlign: 'left', transition: 'border-color 200ms' }}>
            <Icon name="calendar_today" size={14} color={deadline ? '#5e4dbb' : '#c9c4d5'} />
            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: deadline ? '#1c1b22' : '#c9c4d5' }}>
              {deadline ? new Date(deadline+'T12:00:00').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}) : 'Pick a date…'}
            </span>
          </button>
          {showCal && (
            <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 500 }}>
              <CalendarPicker value={deadline} onChange={d => { setDeadline(d); setShowCal(false); }} />
            </div>
          )}
        </div>
        <div>
          <label style={fl}>Priority</label>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            {PRIOS.map(p => (
              <button key={p} onClick={() => setPriority(priority === p ? '' : p)}
                style={{ flex: 1, padding: '7px 0', borderRadius: 8, border: `1.5px solid ${priority === p ? PC[p] : '#E5E7EB'}`, background: priority === p ? `${PC[p]}15` : 'transparent', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: priority === p ? PC[p] : '#787584', cursor: 'pointer', transition: 'all 150ms' }}>
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '12px 20px 18px', borderTop: '1px solid #F5F3FF' }}>
        <button onClick={onClose} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: '1px solid #E5E7EB', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}
          onMouseEnter={e => e.currentTarget.style.background='#f7f2fc'}
          onMouseLeave={e => e.currentTarget.style.background='transparent'}>Cancel</button>
        <button onClick={() => onSave(task.id, task._src, task._listId, { title, deadline, priority, note })}
          style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#5e4dbb', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer', transition: 'all 180ms' }}
          onMouseEnter={e => e.currentTarget.style.background='#5044aa'}
          onMouseLeave={e => e.currentTarget.style.background='#5e4dbb'}>Save</button>
      </div>
    </>
  );
}

Object.assign(window, { ScheduledScreen, TaskDetailPopup });
