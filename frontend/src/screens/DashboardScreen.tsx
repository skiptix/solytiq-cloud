import { useState } from 'react';
import type { Task, List } from '../types';
import useAppStore from '../store/useAppStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import useUserPrefsStore from '../store/useUserPrefsStore';
import { apiCreateTask } from '../api/client';
import { todayInTz, futureDateInTz } from '../utils/date';
import TaskItem, { QuickAdd } from '../components/TaskItem';
import TaskDialog from '../components/TaskDialog';
import UpcomingTimelineWidget from '../components/UpcomingTimelineWidget';
import Icon from '../components/Icon';

// ── Date helpers (timezone-aware) ────────────────────────────────
// All helpers accept an IANA timezone string so the user's chosen zone is respected.
function endOfWeek(tz: string): string {
  const todayStr = todayInTz(tz);
  const d = new Date(todayStr + 'T12:00:00');
  const daysLeft = (7 - d.getDay()) % 7;
  d.setDate(d.getDate() + daysLeft);
  return d.toISOString().slice(0, 10);
}
function isDueToday(t: Task, tz: string) { return t.deadline === todayInTz(tz); }
function isDueThisWeek(t: Task, tz: string) {
  const d = t.deadline;
  const td = todayInTz(tz);
  return d ? d > td && d <= endOfWeek(tz) : false;
}
function isOverdue(t: Task, tz: string) { return t.deadline ? t.deadline < todayInTz(tz) && !t.checked : false; }
function friendlyDate(iso: string | undefined, tz: string) {
  if (!iso) return '';
  const td = todayInTz(tz);
  if (iso === td) return 'Today';
  const d = new Date(iso.slice(0, 10) + 'T12:00:00');
  const tom = futureDateInTz(tz, 1);
  if (iso === tom) return 'Tomorrow';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function getFilteredTasks(filter: string, dashTasks: Task[], lists: List[]): Task[] {
  // dashTasks from API already includes relevant list tasks
  if (filter === 'all') return dashTasks.map(t => {
    if (t._source === 'list') {
      const list = lists.find(l => l.id === t._listId);
      return { ...t, _listName: list?.name ?? t._listName };
    }
    return { ...t, _source: 'dash', _listId: 'dashboard', _listName: 'Dashboard' };
  });

  if (filter === 'local') return dashTasks.filter(t => t._source === 'dash' || !t._source).map(t => ({ ...t, _source: 'dash' as const, _listId: 'dashboard', _listName: 'Dashboard' }));

  const list = lists.find(l => l.id === filter);
  return list ? list.sections.flatMap(s => s.tasks.map(t => ({ ...t, _source: 'list' as const, _listId: list.id, _listName: list.name }))) : [];
}

function sortTasks(tasks: Task[], sort: string | null): Task[] {
  if (!sort) return tasks;
  return [...tasks].sort((a, b) => {
    if (sort === 'date-asc') return (a.deadline ?? '9999') < (b.deadline ?? '9999') ? -1 : 1;
    if (sort === 'date-desc') return (a.deadline ?? '') > (b.deadline ?? '') ? -1 : 1;
    if (sort === 'name-az') return a.title.localeCompare(b.title);
    if (sort === 'name-za') return b.title.localeCompare(a.title);
    return 0;
  });
}

// ── Stat Card ──────────────────────────────────────────────────
function StatCard({ num, label, sub, icon, iconBg, iconColor, accent }: { num: number; label: string; sub: string; icon: string; iconBg: string; iconColor: string; accent?: string }) {
  const [hov, setHov] = useState(false);
  return (
    <div onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ background: '#F9FAFB', border: `1px solid ${hov ? '#d8d0eb' : '#E5E7EB'}`, borderRadius: 12, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10, transition: 'all 180ms', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ width: 34, height: 34, borderRadius: 10, background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={icon} size={17} color={iconColor} />
        </div>
        <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10.5, fontWeight: 600, color: accent ?? '#787584', background: accent ? `${accent}14` : '#f1ecf6', borderRadius: 9999, padding: '2px 8px', textTransform: 'uppercase' as const, letterSpacing: '0.04em' }}>{sub}</span>
      </div>
      <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontWeight: 700, color: '#1c1b22', fontSize: 30, lineHeight: 1, letterSpacing: '-0.02em' }}>{num}</span>
      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552' }}>{label}</div>
    </div>
  );
}

// ── Mini Task Row ──────────────────────────────────────────────
function MiniTaskRow({ task, onToggle, onOpen, timezone }: { task: Task; onToggle: (id: number) => void; onOpen: (task: Task, e: React.MouseEvent) => void; timezone: string }) {
  const [hov, setHov] = useState(false);
  const PCOLS: Record<string, string> = { High: '#ea580c', Medium: '#f59e0b', Low: '#787584' };
  return (
    <div onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)} onClick={e => onOpen(task, e)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, background: hov ? '#F5F3FF' : 'transparent', cursor: 'pointer', transition: 'background 150ms' }}>
      <div onClick={e => { e.stopPropagation(); onToggle(task.id); }}
        style={{ width: 18, height: 18, minWidth: 18, borderRadius: 5, border: '1.5px solid', borderColor: task.checked ? '#5e4dbb' : '#c9c4d5', background: task.checked ? '#5e4dbb' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms', flexShrink: 0 }}>
        {task.checked && <svg width="10" height="8" viewBox="0 0 11 9" fill="none"><path d="M1 4.5L4 7.5L10 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#1c1b22', opacity: task.checked ? 0.4 : 1, textDecoration: task.checked ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          {task._source === 'list' && task._listName && <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10.5, color: '#787584' }}>· {task._listName}</span>}
          {task.priority && <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10.5, fontWeight: 600, color: PCOLS[task.priority] }}>{task.priority}</span>}
        </div>
      </div>
      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584', flexShrink: 0 }}>{friendlyDate(task.deadline, timezone)}</span>
    </div>
  );
}

// ── Observer Panel ─────────────────────────────────────────────
function ObserverPanel({ title, icon, accent, accentBg, tasks, emptyText, onToggle, onOpen, onSeeMore, timezone }: { title: string; icon: string; accent: string; accentBg: string; tasks: Task[]; emptyText: string; onToggle: (id: number) => void; onOpen: (t: Task, e: React.MouseEvent) => void; onSeeMore: () => void; timezone: string }) {
  const visible = tasks.slice(0, 5);
  const more = Math.max(0, tasks.length - visible.length);
  const [moreHov, setMoreHov] = useState(false);
  return (
    <div style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 14, padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px 6px' }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: accentBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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
          {visible.map(t => <MiniTaskRow key={`${t._listId}-${t.id}`} task={t} onToggle={onToggle} onOpen={onOpen} timezone={timezone} />)}
          {more > 0 && (
            <button onClick={onSeeMore} onMouseEnter={() => setMoreHov(true)} onMouseLeave={() => setMoreHov(false)}
              style={{ marginTop: 4, width: '100%', background: moreHov ? `${accent}14` : 'transparent', border: `1px dashed ${moreHov ? accent : '#d8d0eb'}`, borderRadius: 8, padding: '8px 10px', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: accent, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, transition: 'all 160ms' }}>
              + {more} more <Icon name="chevron_right" size={12} color={accent} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Tasks Detail Modal ─────────────────────────────────────────
function TasksDetailModal({ title, icon, accent, accentBg, tasks, onClose, onToggle, onDelete, onUpdate, onRowClick }: { title: string; icon: string; accent: string; accentBg: string; tasks: Task[]; onClose: () => void; onToggle: (id: number) => void; onDelete: (id: number) => void; onUpdate: (id: number, u: Partial<Task>) => void; onRowClick: (t: Task, e: React.MouseEvent) => void }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'open' | 'completed'>('all');
  const [sort, setSort] = useState<string | null>(null);

  let filtered = tasks;
  if (search.trim()) { const q = search.toLowerCase(); filtered = filtered.filter(t => t.title.toLowerCase().includes(q) || (t._listName ?? '').toLowerCase().includes(q)); }
  if (filter === 'open') filtered = filtered.filter(t => !t.checked);
  if (filter === 'completed') filtered = filtered.filter(t => t.checked);
  filtered = sortTasks(filtered, sort);

  const pill = (key: typeof filter, label: string) => (
    <button onClick={() => setFilter(key)} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 9999, padding: '5px 12px', cursor: 'pointer', background: filter === key ? '#5e4dbb' : '#f1ecf6', color: filter === key ? '#fff' : '#787584' }}>{label}</button>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 620, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px', borderBottom: '1px solid #f1ecf6', flexShrink: 0 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: accentBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={icon} size={18} color={accent} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22' }}>{title}</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2 }}>{tasks.length} total · {tasks.filter(t => !t.checked).length} open</div>
          </div>
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={18} color="#787584" />
          </button>
        </div>
        <div style={{ padding: '14px 20px 8px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#f7f4fc', borderRadius: 10, padding: '8px 14px', marginBottom: 10 }}>
            <Icon name="search" size={16} color="#787584" />
            <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tasks…"
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontFamily: 'Inter, sans-serif', fontSize: 13.5, color: '#1c1b22' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {pill('all', 'All')} {pill('open', 'Open')} {pill('completed', 'Completed')}
            <div style={{ flex: 1 }} />
            <select value={sort ?? ''} onChange={e => setSort(e.target.value || null)}
              style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '4px 8px', background: '#fff', color: '#787584', cursor: 'pointer' }}>
              <option value="">Sort</option>
              <option value="date-asc">Date ↑</option>
              <option value="date-desc">Date ↓</option>
              <option value="name-az">Name A-Z</option>
              <option value="name-za">Name Z-A</option>
            </select>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 14px 16px' }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '32px 12px', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', textAlign: 'center' }}>Nothing here.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {filtered.map(task => (
                <TaskItem key={`${task._listId}-${task.id}`} task={task} onToggle={onToggle} onDelete={onDelete} onUpdate={onUpdate} onRowClick={onRowClick} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Dashboard Screen ───────────────────────────────────────────
export default function DashboardScreen() {
  const { dashTasks, setDashTasks, lists, updateDashTask, updateListTask, deleteListTask, addToTrash } = useAppStore();
  const timezone = useUserPrefsStore(s => s.timezone);

  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState<string | null>(null);
  const [detailModal, setDetailModal] = useState<null | { source: 'today' | 'week' | 'todos'; title: string; icon: string; accent: string; accentBg: string }>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);

  const openTask = (task: Task) => setSelectedTask(task);

  const allTasks = getFilteredTasks('all', dashTasks, lists);
  const visibleTasks = sortTasks(getFilteredTasks(filter, dashTasks, lists), sort).filter(t => !t.checked);
  const totalCount = allTasks.length;
  const completedCount = allTasks.filter(t => t.checked).length;
  const openCount = totalCount - completedCount;
  const pct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const dueTodayTasks = allTasks.filter(t => isDueToday(t, timezone) && !t.checked);
  const dueWeekTasks = allTasks.filter(t => isDueThisWeek(t, timezone) && !t.checked);
  const overdueTasks = allTasks.filter(t => isOverdue(t, timezone));

  const toggle = (id: number) => {
    const t = allTasks.find(t => t.id === id);
    if (!t) return;
    const newChecked = !t.checked;
    if (t._source === 'dash') {
      updateDashTask(id, { checked: newChecked });
    } else if (t._listId) {
      updateListTask(t._listId, id, { checked: newChecked });
      // Keep dashTasks in sync so the dashboard view reflects the change immediately
      setDashTasks(ts => ts.map(x => x.id === id ? { ...x, checked: newChecked } : x));
    }
  };

  const deleteTask = (id: number) => {
    const t = allTasks.find(t => t.id === id);
    if (!t) return;
    addToTrash(t, { src: t._source ?? 'dash', listId: t._listId, listName: t._listName });
    if (t._source === 'dash') setDashTasks(ts => ts.filter(x => x.id !== id));
    else if (t._listId) deleteListTask(t._listId, id);
  };

  const updateTask = (id: number, updates: Partial<Task>) => {
    const t = allTasks.find(t => t.id === id);
    if (!t) return;
    if (t._source === 'dash') updateDashTask(id, updates);
    else if (t._listId) updateListTask(t._listId, id, updates);
  };

  const handleDrop = (targetId: number) => {
    if (!draggedId || draggedId === targetId) return;
    setDashTasks(prev => {
      const arr = [...prev];
      const from = arr.findIndex(t => t.id === draggedId);
      const to = arr.findIndex(t => t.id === targetId);
      if (from === -1 || to === -1) return prev;
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      return arr;
    });
    setDraggedId(null); setDragOverId(null);
  };

  const pill = (key: string, label: string) => (
    <button onClick={() => setFilter(key)} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, border: 'none', borderRadius: 9999, padding: '4px 10px', cursor: 'pointer', background: filter === key ? '#5e4dbb' : '#f1ecf6', color: filter === key ? '#fff' : '#787584' }}>{label}</button>
  );

  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div style={{ flex: 1, height: '100%', overflowY: 'auto' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '32px 32px 48px', display: 'flex', flexDirection: 'column', gap: 24, width: '100%' }}>

        <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#9d8dff', marginBottom: 4 }}>{dateStr}</div>
            <h1 style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 28, fontWeight: 700, color: '#1c1b22', letterSpacing: '-0.02em', lineHeight: 1.15 }}>Dashboard</h1>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13.5, color: '#787584', marginTop: 6 }}>
              {dueTodayTasks.length > 0 ? <>You have <strong style={{ color: '#5e4dbb' }}>{dueTodayTasks.length} task{dueTodayTasks.length === 1 ? '' : 's'}</strong> due today{dueWeekTasks.length > 0 && <> and <strong style={{ color: '#1c1b22' }}>{dueWeekTasks.length}</strong> more this week</>}.</> : dueWeekTasks.length > 0 ? <>Nothing due today — <strong style={{ color: '#1c1b22' }}>{dueWeekTasks.length}</strong> task{dueWeekTasks.length === 1 ? '' : 's'} ahead this week.</> : 'All clear. No deadlines on the horizon.'}
            </div>
          </div>
          {overdueTasks.length > 0 && (
            <div style={{ background: '#fff5f5', border: '1px solid #ffdad6', borderRadius: 9999, padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="warning" size={14} color="#ba1a1a" />
              <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#ba1a1a' }}>{overdueTasks.length} overdue</span>
            </div>
          )}
        </header>

        <UpcomingTimelineWidget accent="#5e4dbb" />

        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <StatCard num={openCount} label="Open Tasks" sub={`${totalCount} total`} icon="inventory_2" iconBg="#F5F3FF" iconColor="#5e4dbb" />
          <StatCard num={completedCount} label="Completed" sub={completedCount > 0 ? `${pct}%` : 'Get started'} icon="check_circle" iconBg="rgba(16,185,129,0.10)" iconColor="#10B981" accent="#10B981" />
          <StatCard num={dueTodayTasks.length} label="Due Today" sub={dueTodayTasks.length > 0 ? 'Focus' : 'Clear'} icon="today" iconBg="#fff7ed" iconColor="#ea580c" accent={dueTodayTasks.length > 0 ? '#ea580c' : undefined} />
          <StatCard num={dueWeekTasks.length} label="Due This Week" sub="Upcoming" icon="calendar_month" iconBg="#eff6ff" iconColor="#1D4ED8" />
        </section>

        <section style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 12, padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552' }}>This week's progress</div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, color: '#787584' }}><strong style={{ color: '#1c1b22' }}>{completedCount}</strong> done · <strong style={{ color: '#1c1b22' }}>{openCount}</strong> open</div>
          </div>
          <div style={{ height: 8, background: '#ebe6f0', borderRadius: 9999, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: pct === 100 ? '#10B981' : 'linear-gradient(90deg,#9d8dff 0%,#5e4dbb 100%)', borderRadius: 9999, transition: 'width 600ms ease-in-out' }} />
          </div>
        </section>

        <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <ObserverPanel title="Due Today" icon="today" accent="#ea580c" accentBg="#fff7ed" tasks={dueTodayTasks} emptyText="Nothing on your plate today." onToggle={toggle} onOpen={openTask} timezone={timezone} onSeeMore={() => setDetailModal({ source: 'today', title: 'Due Today', icon: 'today', accent: '#ea580c', accentBg: '#fff7ed' })} />
          <ObserverPanel title="This Week" icon="calendar_month" accent="#1D4ED8" accentBg="#eff6ff" tasks={dueWeekTasks} emptyText="No deadlines this week." onToggle={toggle} onOpen={openTask} timezone={timezone} onSeeMore={() => setDetailModal({ source: 'week', title: 'Due This Week', icon: 'calendar_month', accent: '#1D4ED8', accentBg: '#eff6ff' })} />
        </section>

        <section>
          <div style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 12, overflow: 'hidden' }}>
            <QuickAdd onAdd={async data => {
              const { currentWorkspaceId } = useWorkspaceStore.getState();
              const tempId = Date.now();
              const tempTask: Task = { id: tempId, checked: false, ...data };
              setDashTasks(ts => [tempTask, ...ts]);
              try {
                const res = await apiCreateTask({ ...data, workspaceId: currentWorkspaceId ?? undefined });
                setDashTasks(ts => ts.map(t => t.id === tempId ? { ...tempTask, id: Number(res.task.id) } : t));
              } catch (e) {
                console.error('createTask failed', e);
                setDashTasks(ts => ts.filter(t => t.id !== tempId));
              }
            }} />
          </div>
        </section>

        <section>
          <div style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 12, padding: '16px 12px 8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, padding: '0 4px', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#b0acbe' }}>Todos</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {pill('all', 'All')} {pill('local', 'Dashboard')}
                {lists.length > 0 && (
                  <select value={!['all','local'].includes(filter) ? filter : ''} onChange={e => { if (e.target.value) setFilter(e.target.value); }}
                    style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, border: 'none', borderRadius: 9999, padding: '4px 10px', cursor: 'pointer', background: !['all','local'].includes(filter) ? '#5e4dbb' : '#f1ecf6', color: !['all','local'].includes(filter) ? '#fff' : '#787584' }}>
                    <option value="">List ▾</option>
                    {lists.map(l => <option key={l.id} value={l.id}>{l.emoji} {l.name}</option>)}
                  </select>
                )}
                <select value={sort ?? ''} onChange={e => setSort(e.target.value || null)}
                  style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '4px 8px', background: sort ? '#F5F3FF' : '#fff', color: sort ? '#5e4dbb' : '#787584', cursor: 'pointer' }}>
                  <option value="">Sort</option>
                  <option value="date-asc">Date ↑</option>
                  <option value="date-desc">Date ↓</option>
                  <option value="name-az">Name A-Z</option>
                  <option value="name-za">Name Z-A</option>
                </select>
              </div>
            </div>
            {visibleTasks.length === 0 ? (
              <div style={{ padding: '16px 10px', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', textAlign: 'center' }}>No open tasks here yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {visibleTasks.slice(0, 5).map(task => (
                  <TaskItem key={`${task._listId}-${task.id}`} task={task}
                    onToggle={toggle} onDelete={deleteTask} onUpdate={updateTask} onRowClick={openTask}
                    onDragStart={id => setDraggedId(id)} onDragOver={id => setDragOverId(id)}
                    onDrop={handleDrop} onDragEnd={() => { setDraggedId(null); setDragOverId(null); }}
                    isDragging={draggedId === task.id} isDragOver={dragOverId === task.id && draggedId !== task.id} />
                ))}
                {visibleTasks.length > 5 && (
                  <button onClick={() => setDetailModal({ source: 'todos', title: 'All Todos', icon: 'inventory_2', accent: '#5e4dbb', accentBg: '#F5F3FF' })}
                    onMouseEnter={e => { e.currentTarget.style.background = '#F5F3FF'; e.currentTarget.style.borderColor = '#5e4dbb'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = '#d8d0eb'; }}
                    style={{ marginTop: 6, width: '100%', background: 'transparent', border: '1px dashed #d8d0eb', borderRadius: 8, padding: '9px 10px', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, color: '#5e4dbb', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, transition: 'all 160ms' }}>
                    + {visibleTasks.length - 5} more <Icon name="chevron_right" size={12} color="#5e4dbb" />
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      </div>

      {detailModal && (
        <TasksDetailModal title={detailModal.title} icon={detailModal.icon} accent={detailModal.accent} accentBg={detailModal.accentBg}
          tasks={detailModal.source === 'today' ? dueTodayTasks : detailModal.source === 'week' ? dueWeekTasks : visibleTasks}
          onClose={() => setDetailModal(null)} onToggle={toggle} onDelete={deleteTask} onUpdate={updateTask} onRowClick={openTask} />
      )}
      {selectedTask && (
        <TaskDialog
          task={selectedTask}
          onUpdate={updateTask}
          onDelete={deleteTask}
          onClose={() => setSelectedTask(null)}
        />
      )}
    </div>
  );
}
