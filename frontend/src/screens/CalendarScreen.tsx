import { usePageTitle } from "../hooks/usePageTitle";
import { useState } from 'react';
import type { Task, List } from '../types';
import useAppStore, { apiCreateTask, apiAddListTask } from '../store/useAppStore';
import TaskDialog from '../components/TaskDialog';
import Icon from '../components/Icon';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const PRIORITY_COLORS: Record<string, string> = { High: '#ea580c', Medium: '#f59e0b', Low: '#787584' };

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getAllTasks(dashTasks: Task[], lists: List[]): Task[] {
  const dash = dashTasks
    .filter(t => (t._source ?? 'dash') === 'dash')
    .map(t => ({ ...t, _source: 'dash' as const, _listId: 'dashboard', _listName: 'Dashboard' }));
  const listTasks = lists.flatMap(l => l.sections.flatMap(s => s.tasks.map(t => ({ ...t, _source: 'list' as const, _listId: l.id, _listName: l.name }))));
  return [...dash, ...listTasks];
}

// ── Add-to-date modal ─────────────────────────────────────────────
interface AddToDateModalProps {
  date: string;
  lists: List[];
  onAdd: (title: string, destination: { type: 'dash' } | { type: 'list'; listId: string; sectionId: string }) => void;
  onClose: () => void;
}

function AddToDateModal({ date, lists, onAdd, onClose }: AddToDateModalProps) {
  const [title, setTitle] = useState('');
  const [dest, setDest] = useState<'dash' | string>('dash');
  const friendly = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const canSubmit = title.trim().length > 0;

  const handleAdd = () => {
    if (!canSubmit) return;
    if (dest === 'dash') {
      onAdd(title.trim(), { type: 'dash' });
    } else {
      const list = lists.find(l => l.id === dest);
      const sectionId = list?.sections[0]?.id;
      if (!sectionId) return;
      onAdd(title.trim(), { type: 'list', listId: dest, sectionId });
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 420, boxShadow: '0 8px 32px rgba(0,0,0,0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px 14px', borderBottom: '1px solid #F5F3FF' }}>
          <div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>Add Task</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2 }}>{friendly}</div>
          </div>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={16} color="#787584" />
          </button>
        </div>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div>
            <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', marginBottom: 5, display: 'block' }}>Task Name</label>
            <input
              autoFocus
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && canSubmit) handleAdd(); }}
              placeholder="What needs to be done?"
              style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#1c1b22', background: 'transparent', border: 'none', borderBottom: '1.5px solid #E5E7EB', padding: '7px 0', outline: 'none', boxSizing: 'border-box', transition: 'border-color 200ms' }}
              onFocus={e => (e.target.style.borderBottomColor = '#5e4dbb')}
              onBlur={e => (e.target.style.borderBottomColor = '#E5E7EB')}
            />
          </div>
          <div>
            <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', marginBottom: 8, display: 'block' }}>Add to</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
              {/* Dashboard option */}
              <button
                onClick={() => setDest('dash')}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 8, border: `1.5px solid ${dest === 'dash' ? '#5e4dbb' : '#E5E7EB'}`, background: dest === 'dash' ? '#F5F3FF' : 'transparent', cursor: 'pointer', textAlign: 'left', transition: 'all 150ms' }}>
                <div style={{ width: 20, height: 20, borderRadius: '50%', background: dest === 'dash' ? '#5e4dbb' : '#E5E7EB', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 150ms' }}>
                  {dest === 'dash' && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#fff' }} />}
                </div>
                <Icon name="today" size={15} color={dest === 'dash' ? '#5e4dbb' : '#787584'} />
                <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: dest === 'dash' ? '#5e4dbb' : '#484552' }}>Dashboard</span>
              </button>
              {/* List options */}
              {lists.map(list => (
                <button key={list.id}
                  onClick={() => setDest(list.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 8, border: `1.5px solid ${dest === list.id ? '#5e4dbb' : '#E5E7EB'}`, background: dest === list.id ? '#F5F3FF' : 'transparent', cursor: 'pointer', textAlign: 'left', transition: 'all 150ms' }}>
                  <div style={{ width: 20, height: 20, borderRadius: '50%', background: dest === list.id ? '#5e4dbb' : '#E5E7EB', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 150ms' }}>
                    {dest === list.id && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#fff' }} />}
                  </div>
                  {list.emoji
                    ? <span style={{ fontSize: 15, lineHeight: 1 }}>{list.emoji}</span>
                    : <Icon name="format_list_bulleted" size={15} color={dest === list.id ? '#5e4dbb' : '#787584'} />}
                  <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: dest === list.id ? '#5e4dbb' : '#484552', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{list.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '14px 24px 20px', borderTop: '1px solid #F5F3FF' }}>
          <button onClick={onClose} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: '1px solid #E5E7EB', borderRadius: 8, padding: '9px 20px', cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleAdd} disabled={!canSubmit}
            style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: canSubmit ? '#5e4dbb' : '#c9c4d5', border: 'none', borderRadius: 8, padding: '9px 20px', cursor: canSubmit ? 'pointer' : 'not-allowed', transition: 'all 180ms' }}>
            Add Task
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CalendarScreen() {
  usePageTitle("Calendar");
  const { dashTasks, lists, updateDashTask, updateListTask, setDashTasks, setLists, addToTrash, deleteListTask } = useAppStore();
  const today = new Date(); today.setHours(0,0,0,0);
  const [viewDate, setViewDate] = useState({ year: today.getFullYear(), month: today.getMonth() });
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [search, setSearch] = useState('');
  const [dragTaskId, setDragTaskId] = useState<number | null>(null);
  const [addingToDate, setAddingToDate] = useState<string | null>(null);

  const allTasks = getAllTasks(dashTasks, lists);

  const saveTask = (id: number, updates: Partial<Task>) => {
    const t = allTasks.find(t => t.id === id);
    if (!t) return;
    if (t._source === 'dash') updateDashTask(id, updates);
    else if (t._listId) updateListTask(t._listId, id, updates);
  };

  const deleteTask = (id: number) => {
    const t = allTasks.find(t => t.id === id);
    if (!t) return;
    addToTrash(t, { src: t._source ?? 'dash', listId: t._listId, listName: t._listName });
    if (t._source === 'dash') setDashTasks(ts => ts.filter(x => x.id !== id));
    else if (t._listId) deleteListTask(t._listId, id);
  };
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

  const handleAddToDate = async (title: string, destination: { type: 'dash' } | { type: 'list'; listId: string; sectionId: string }) => {
    const deadline = addingToDate ?? undefined;
    setAddingToDate(null);
    if (destination.type === 'dash') {
      const tempId = Date.now();
      const tempTask: Task = { id: tempId, title, checked: false, deadline };
      setDashTasks(ts => [...ts, tempTask]);
      try {
        const res = await apiCreateTask({ title, deadline });
        setDashTasks(ts => ts.map(t => t.id === tempId ? { ...tempTask, id: Number(res.task.id) } : t));
      } catch {
        setDashTasks(ts => ts.filter(t => t.id !== tempId));
      }
    } else {
      const { listId, sectionId } = destination;
      const tempId = Date.now();
      const tempTask: Task = { id: tempId, title, checked: false, deadline };
      setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, sections: l.sections.map(s => s.id !== sectionId ? s : { ...s, tasks: [...s.tasks, tempTask] }) }));
      try {
        const res = await apiAddListTask(listId, sectionId, { title, deadline });
        const saved: Task = { ...res.task, id: Number(res.task.id) };
        setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, sections: l.sections.map(s => s.id !== sectionId ? s : { ...s, tasks: s.tasks.map(t => t.id === tempId ? saved : t) }) }));
      } catch {
        setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, sections: l.sections.map(s => s.id !== sectionId ? s : { ...s, tasks: s.tasks.filter(t => t.id !== tempId) }) }));
      }
    }
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
                  onDrop={e => { e.preventDefault(); if (!cell.current) return; const id = Number(e.dataTransfer.getData('text/plain')); if (id) { assignDeadline(id, iso); setDragTaskId(null); } }}
                  onClick={() => { if (cell.current) setAddingToDate(iso); }}
                  style={{ minHeight: 96, border: isTodayCell ? '1.5px solid #c8bfff' : '1px solid #f1ecf6', background: isTodayCell ? '#faf8ff' : cell.current ? '#fff' : '#fafafa', borderRadius: 6, padding: 4, transition: 'background 150ms', cursor: cell.current ? 'pointer' : 'default', position: 'relative' }}
                  className="cal-cell">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, padding: '0 2px' }}>
                    <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: isTodayCell ? 700 : 400, color: isTodayCell ? '#5e4dbb' : cell.current ? '#1c1b22' : '#c9c4d5' }}>
                      {cell.date.getDate()}
                    </div>
                    {cell.current && (
                      <div className="cal-add-btn" style={{ width: 16, height: 16, borderRadius: '50%', background: '#5e4dbb', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0, transition: 'opacity 150ms', flexShrink: 0 }}>
                        <Icon name="add" size={11} color="#fff" />
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {visible.map(t => (
                      <div key={t.id} onClick={e => { e.stopPropagation(); setSelectedTask(t); }}
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
                onDragStart={e => { e.dataTransfer.setData('text/plain', String(t.id)); e.dataTransfer.effectAllowed = 'move'; setDragTaskId(t.id); }}
                onDragEnd={() => setDragTaskId(null)}
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
        <TaskDialog
          task={selectedTask}
          onUpdate={saveTask}
          onDelete={deleteTask}
          onClose={() => setSelectedTask(null)}
        />
      )}
      {addingToDate && (
        <AddToDateModal date={addingToDate} lists={lists} onAdd={handleAddToDate} onClose={() => setAddingToDate(null)} />
      )}
      <style>{`
        .cal-cell:hover .cal-add-btn { opacity: 1 !important; }
      `}</style>
    </div>
  );
}
