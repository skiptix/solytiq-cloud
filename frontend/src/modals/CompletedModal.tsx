import { useState } from 'react';
import type { Task, List } from '../types';
import useAppStore from '../store/useAppStore';
import Icon from '../components/Icon';

const PRIORITY_COLORS: Record<string, string> = { High: 'var(--color-orange)', Medium: 'var(--color-warning-alt)', Low: 'var(--color-text-tertiary)' };

function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function friendlyDate(iso?: string) {
  if (!iso) return '';
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(iso.slice(0, 10) + 'T12:00:00');
  if (iso === localIso(today)) return 'Today';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getAllCompleted(dashTasks: Task[], lists: List[]): Task[] {
  const dash = dashTasks
    .filter(t => t.checked)
    .map(t => ({ ...t, _source: 'dash' as const, _listId: 'dashboard', _listName: 'Dashboard' }));
  const listTasks = lists.flatMap(l =>
    l.sections.flatMap(s =>
      s.tasks.filter(t => t.checked).map(t => ({ ...t, _source: 'list' as const, _listId: l.id, _listName: l.name }))
    )
  );
  return [...dash, ...listTasks];
}

interface CompletedModalProps {
  onClose: () => void;
}

export default function CompletedModal({ onClose }: CompletedModalProps) {
  const { dashTasks, lists, setDashTasks, updateListTask, addToTrash, deleteListTask } = useAppStore();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'dash' | 'list'>('all');

  const allCompleted = getAllCompleted(dashTasks, lists);
  let visible = allCompleted;
  if (search.trim()) {
    const q = search.toLowerCase();
    visible = visible.filter(t => t.title.toLowerCase().includes(q) || (t._listName ?? '').toLowerCase().includes(q));
  }
  if (filter === 'dash') visible = visible.filter(t => t._source === 'dash');
  if (filter === 'list') visible = visible.filter(t => t._source === 'list');

  const uncomplete = (task: Task) => {
    if (task._source === 'dash') {
      setDashTasks(ts => ts.map(x => x.id === task.id ? { ...x, checked: false } : x));
    } else if (task._listId) {
      updateListTask(task._listId, task.id, { checked: false });
    }
  };

  const deleteCompleted = (task: Task) => {
    addToTrash(task, { src: task._source ?? 'dash', listId: task._listId, listName: task._listName });
    if (task._source === 'dash') {
      setDashTasks(ts => ts.filter(x => x.id !== task.id));
    } else if (task._listId) {
      deleteListTask(task._listId, task.id);
    }
  };

  const clearAll = () => {
    visible.forEach(t => deleteCompleted(t));
  };

  const pill = (key: typeof filter, label: string) => (
    <button
      onClick={() => setFilter(key)}
      style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 9999, padding: '5px 12px', cursor: 'pointer', background: filter === key ? 'var(--color-primary)' : 'var(--color-surface-tint-2)', color: filter === key ? 'var(--color-white)' : 'var(--color-text-tertiary)', transition: 'all 150ms' }}>
      {label}
    </button>
  );

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        style={{ background: 'var(--color-white)', borderRadius: 16, width: '100%', maxWidth: 580, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px', borderBottom: '1px solid var(--color-surface-tint-2)', flexShrink: 0 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(var(--color-success-rgb), 0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="check_circle" size={18} color="var(--color-success)" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)' }}>Completed Tasks</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{allCompleted.length} completed task{allCompleted.length !== 1 ? 's' : ''}</div>
          </div>
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={18} color="var(--color-text-tertiary)" />
          </button>
        </div>

        {/* Toolbar */}
        <div style={{ padding: '12px 20px 8px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--color-purple-pale-11)', borderRadius: 10, padding: '8px 14px', marginBottom: 10 }}>
            <Icon name="search" size={16} color="var(--color-text-tertiary)" />
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search completed tasks…"
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-primary)' }} />
            {search && (
              <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex' }}>
                <Icon name="close" size={14} color="var(--color-text-tertiary)" />
              </button>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {pill('all', 'All')} {pill('dash', 'Dashboard')} {pill('list', 'Boards')}
            {visible.length > 0 && (
              <button
                onClick={clearAll}
                style={{ marginLeft: 'auto', fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-error)', background: 'var(--color-error-bg-alt)', border: '1px solid var(--color-error-bg)', borderRadius: 8, padding: '5px 12px', cursor: 'pointer', transition: 'all 150ms' }}>
                Clear All
              </button>
            )}
          </div>
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 14px 16px' }}>
          {visible.length === 0 ? (
            <div style={{ padding: '48px 12px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(var(--color-success-rgb), 0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="check_circle" size={28} color="var(--color-success)" />
              </div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)', textAlign: 'center' }}>
                {search ? 'No matching completed tasks.' : 'No completed tasks yet.'}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {visible.map(task => (
                <CompletedRow key={`${task._listId}-${task.id}`} task={task} onUncomplete={uncomplete} onDelete={deleteCompleted} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CompletedRow({ task, onUncomplete, onDelete }: { task: Task; onUncomplete: (t: Task) => void; onDelete: (t: Task) => void }) {
  const [hov, setHov] = useState(false);

  return (
    <div
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, background: hov ? 'var(--color-surface-neutral)' : 'transparent', transition: 'background 150ms' }}>
      <button
        onClick={() => onUncomplete(task)}
        title="Mark as incomplete"
        style={{ width: 20, height: 20, minWidth: 20, borderRadius: 5, border: '1.5px solid var(--color-primary)', background: 'var(--color-primary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms', flexShrink: 0 }}>
        <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
          <path d="M1 4.5L4 7.5L10 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-tertiary)', textDecoration: 'line-through', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          {task._listName && (
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-text-quaternary)' }}>{task._listName}</span>
          )}
          {task.priority && (
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, fontWeight: 600, color: PRIORITY_COLORS[task.priority] }}>{task.priority}</span>
          )}
          {task.deadline && (
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-text-quaternary)' }}>{friendlyDate(task.deadline)}</span>
          )}
        </div>
      </div>
      <button
        onClick={() => onDelete(task)}
        title="Delete"
        style={{ opacity: hov ? 1 : 0, width: 26, height: 26, borderRadius: 6, border: 'none', background: 'var(--color-error-bg-alt)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'opacity 150ms', flexShrink: 0 }}>
        <Icon name="delete" size={14} color="var(--color-error)" />
      </button>
    </div>
  );
}
