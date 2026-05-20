import { useState } from 'react';
import type { Task, List } from '../types';
import useAppStore from '../store/useAppStore';
import TaskDetailPopup from '../components/TaskDetailPopup';
import Icon from '../components/Icon';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const PRIORITY_COLORS: Record<string, string> = { High: '#ea580c', Medium: '#f59e0b', Low: '#787584' };

function toIso(d: Date): string { const x = new Date(d); x.setHours(0,0,0,0); return x.toISOString().slice(0,10); }

function getAllTasks(dashTasks: Task[], lists: List[]): Task[] {
  const dash = dashTasks.map(t => ({ ...t, _source: 'dash' as const, _listId: 'dashboard', _listName: 'Dashboard' }));
  const listTasks = lists.flatMap(l => l.sections.flatMap(s => s.tasks.map(t => ({ ...t, _source: 'list' as const, _listId: l.id, _listName: l.name }))));
  return [...dash, ...listTasks];
}

export default function ScheduledScreen() {
  const { dashTasks, lists, updateDashTask, updateListTask } = useAppStore();
  const today = new Date(); today.setHours(0,0,0,0);
  const [viewDate, setViewDate] = useState({ year: today.getFullYear(), month: today.getMonth() });
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [selectedAnchor, setSelectedAnchor] = useState<{ x: number; y: number } | null>(null);
  const [search, setSearch] = useState('');
  const [dragTaskId, setDragTaskId] = useState<number | null>(null);

  const allTasks = getAllTasks(dashTasks, lists);
  const scheduledTasks = allTasks.filter(t => t.deadline);
  const unscheduled = allTasks.filter(t => !t.deadline && !t.checked);
  const filteredUnscheduled = search.trim() ? unscheduled.filter(t => t.title.toLowerCase().includes(search.toLowerCase())) : unscheduled;

  // Build calendar cells
  const firstDay = new Date(viewDate.year, viewDate.month, 1).getDay();
  const daysInMonth = new Date(viewDate.year, viewDate.month + 1, 0).getDate();
  const cells: Array<{ date: Date; current: boolean }> = [];
  const daysInPrev = new Date(viewDate.year, viewDate.month, 0).getDate();
  for (let i = firstDay - 1; i >= 0; i--) cells.push({ date: new Date(viewDate.year, viewDate.month - 1, daysInPrev - i), current: false });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ date: new Date(viewDate.year, viewDate.month, d), current: true });
  while (cells.length < 42) cells.push({ date: new Date(viewDate.year, viewDate.month + 1, cells.length - daysInMonth - firstDay + 1), current: false });

  const assignDeadline = (taskId: number, iso: string) => {
    const t = allTasks.find(t => t.id === taskId);
    if (!t) return;
    if (t._source === 'dash') updateDashTask(taskId, { deadline: iso });
    else if (t._listId) updateListTask(t._listId, taskId, { deadline: iso });
  };

  const prevMonth = () => setViewDate(v => v.month === 0 ? { year: v.year - 1, month: 11 } : { year: v.year, month: v.month - 1 });
  const nextMonth = () => setViewDate(v => v.month === 11 ? { year: v.year + 1, month: 0 } : { year: v.year, month: v.month + 1 });

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      {/* Calendar */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Month nav */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 24px', borderBottom: '1px solid #E5E7EB', flexShrink: 0 }}>
          <button onClick={prevMonth} style={{ background: 'none', border: '1px solid #e8e4f0', borderRadius: 8, cursor: 'pointer', padding: '6px 10px', display: 'flex', alignItems: 'center' }}>
            <Icon name="chevron_left" size={18} color="#787584" />
          </button>
          <h2 style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 18, fontWeight: 700, color: '#1c1b22', minWidth: 200, textAlign: 'center' }}>
            {MONTHS[viewDate.month]} {viewDate.year}
          </h2>
          <button onClick={nextMonth} style={{ background: 'none', border: '1px solid #e8e4f0', borderRadius: 8, cursor: 'pointer', padding: '6px 10px', display: 'flex', alignItems: 'center' }}>
            <Icon name="chevron_right" size={18} color="#787584" />
          </button>
          <button onClick={() => setViewDate({ year: today.getFullYear(), month: today.getMonth() })}
            style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', border: 'none', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', marginLeft: 8 }}>
            Today
          </button>
        </div>

        {/* Grid */}
        <div style={{ flex: 1, overflow: 'auto', padding: '0 16px 16px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 }}>
            {DAYS_SHORT.map(d => (
              <div key={d} style={{ textAlign: 'center', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 700, color: '#b0acbe', padding: '10px 0' }}>{d}</div>
            ))}
            {cells.map((cell, i) => {
              const iso = toIso(cell.date);
              const isTodayCell = iso === toIso(today);
              const cellTasks = scheduledTasks.filter(t => t.deadline === iso);
              const visible = cellTasks.slice(0, 3);
              const overflow = cellTasks.length - visible.length;
              return (
                <div key={i}
                  onDragOver={e => { if (cell.current) e.preventDefault(); }}
                  onDrop={e => { e.preventDefault(); if (cell.current && dragTaskId) { assignDeadline(dragTaskId, iso); setDragTaskId(null); } }}
                  style={{ minHeight: 96, border: isTodayCell ? '1.5px solid #c8bfff' : '1px solid #f1ecf6', background: isTodayCell ? '#faf8ff' : cell.current ? '#fff' : '#fafafa', borderRadius: 6, padding: 4, transition: 'background 150ms' }}>
                  <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: isTodayCell ? 700 : 400, color: isTodayCell ? '#5e4dbb' : cell.current ? '#1c1b22' : '#c9c4d5', marginBottom: 4, textAlign: 'right', padding: '0 2px' }}>
                    {cell.date.getDate()}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {visible.map(t => (
                      <div key={t.id} onClick={e => { setSelectedTask(t); setSelectedAnchor({ x: e.clientX, y: e.clientY }); }}
                        style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#F5F3FF', borderRadius: 4, padding: '2px 5px', cursor: 'pointer', transition: 'background 120ms' }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#ede9ff')}
                        onMouseLeave={e => (e.currentTarget.style.background = '#F5F3FF')}>
                        {t.priority && <div style={{ width: 5, height: 5, borderRadius: '50%', background: PRIORITY_COLORS[t.priority], flexShrink: 0 }} />}
                        <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#5e4dbb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{t.title}</span>
                      </div>
                    ))}
                    {overflow > 0 && (
                      <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#787584', paddingLeft: 5 }}>+{overflow} more</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Unscheduled sidebar */}
      <div style={{ width: 240, borderLeft: '1px solid #E5E7EB', background: '#f7f2fc', display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}>
        <div style={{ padding: '16px 12px 10px', borderBottom: '1px solid #e8e4f0', flexShrink: 0 }}>
          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#b0acbe', marginBottom: 8 }}>Unscheduled</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', borderRadius: 8, padding: '6px 10px', border: '1px solid #e8e4f0' }}>
            <Icon name="search" size={13} color="#787584" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
              style={{ background: 'transparent', border: 'none', outline: 'none', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#1c1b22', flex: 1 }} />
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
          {filteredUnscheduled.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px 8px', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe' }}>All tasks scheduled!</div>
          ) : (
            filteredUnscheduled.map(t => (
              <div key={`${t._listId}-${t.id}`} draggable
                onDragStart={() => setDragTaskId(t.id)} onDragEnd={() => setDragTaskId(null)}
                style={{ padding: '8px 10px', borderRadius: 8, background: '#fff', border: '1px solid #e8e4f0', marginBottom: 4, cursor: 'grab', transition: 'all 150ms', opacity: dragTaskId === t.id ? 0.4 : 1 }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = '#9d8dff')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = '#e8e4f0')}>
                <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12.5, color: '#1c1b22', fontWeight: 400, marginBottom: 2 }}>{t.title}</div>
                {t._listName && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#787584' }}>{t._listName}</div>}
              </div>
            ))
          )}
        </div>
      </div>

      {selectedTask && (
        <TaskDetailPopup task={selectedTask} anchor={selectedAnchor}
          onEdit={() => setSelectedTask(null)}
          onClose={() => setSelectedTask(null)} />
      )}
    </div>
  );
}
