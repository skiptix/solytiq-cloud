import { usePageTitle } from '../hooks/usePageTitle';
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useMobile } from '../hooks/useBreakpoint';
import type { Task, List, MarkdownList, Timeline, Meeting, Workspace, MilestoneStatus } from '../types';
import {
  apiGetTasks, apiGetLists, apiGetMarkdownLists, apiGetTimelines, apiGetMeetings,
  apiUpdateTask, apiUpdateListTask, apiDeleteTask, apiDeleteListTask, apiAddToTrash,
} from '../api/client';
import useWorkspaceStore from '../store/useWorkspaceStore';
import useUserPrefsStore from '../store/useUserPrefsStore';
import useAuthStore from '../store/useAuthStore';
import { todayInTz, timeToMinutes } from '../utils/date';
import {
  addDaysIso, isDueToday, isDueWithinNextDays, isOverdue, countTasks,
  resolveTaskSource, sortByDeadline, sortByNewest, type TaskSource,
} from '../utils/dashboard';
import Icon from '../components/Icon';
import DonutChart from '../components/DonutChart';
import TaskDialog from '../components/TaskDialog';
import CreatorBubble from '../components/CreatorBubble';
import NotificationItem from '../components/NotificationItem';
import GraphMiniMap from '../components/graph/GraphMiniMap';
import AgentInbox from '../components/AgentInbox';
import useNotificationsStore from '../store/useNotificationsStore';
import useSyncStore from '../store/useSyncStore';
import { notificationTarget } from '../utils/notifications';
import type { AppNotification } from '../api/client';

// ── Shared style tokens ────────────────────────────────────────────
// Matches the surface used by the Folder Dashboard and Board screens.
const CARD: React.CSSProperties = {
  background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)',
  borderRadius: 16,
};
// Smooth, staggered entrance for each box when the dashboard opens.
const enterAnim = (delayMs: number): React.CSSProperties => ({
  animation: `cardIn 480ms cubic-bezier(0.22,1,0.36,1) ${delayMs}ms both`,
});
// How many rows the (deliberately non-scrolling) My Tasks box shows before the
// rest is deferred to the "All tasks" dialog.
const MY_TASKS_CAP = 8;

const PRIORITY_COLOR: Record<string, string> = {
  High: 'var(--color-orange)', Medium: 'var(--color-warning-alt)', Low: 'var(--color-text-tertiary)',
};
const STATUS_COLOR: Record<MilestoneStatus, string> = {
  upcoming: 'var(--color-accent-purple-light)', 'in-progress': 'var(--color-orange)', done: 'var(--color-success)',
};

// ── Date formatting ────────────────────────────────────────────────
function friendlyDate(iso: string | null | undefined, todayIso: string): string {
  if (!iso) return '';
  const d = iso.slice(0, 10);
  if (d === todayIso) return 'Today';
  if (d === addDaysIso(todayIso, 1)) return 'Tomorrow';
  if (d === addDaysIso(todayIso, -1)) return 'Yesterday';
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-text-quaternary)' }}>
      {children}
    </div>
  );
}

// ── Workspace badge (icon + grey source name) ──────────────────────
function WorkspaceBadge({ workspace, source }: { workspace?: Workspace; source: TaskSource }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, maxWidth: '100%' }}>
      <span style={{ width: 16, height: 16, borderRadius: 5, overflow: 'hidden', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-purple-pale-21)', flexShrink: 0 }}>
        {workspace?.image
          ? <img src={workspace.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <span style={{ fontSize: 10, lineHeight: 1 }}>{workspace?.emoji ?? '🏠'}</span>}
      </span>
      <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
        {source.name}
      </span>
    </span>
  );
}

// ── One task row (checkbox + title + badge + date) ─────────────────
function TaskRow({ task, source, workspace, todayIso, onToggle, onOpen }: {
  task: Task; source: TaskSource; workspace?: Workspace; todayIso: string;
  onToggle: (t: Task) => void; onOpen: (t: Task) => void;
}) {
  const [hov, setHov] = useState(false);
  const overdue = isOverdue(task, todayIso);
  const due = isDueToday(task.deadline, todayIso);
  const dateColor = overdue ? 'var(--color-error)' : due ? 'var(--color-orange)' : 'var(--color-text-tertiary)';
  return (
    <div onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)} onClick={() => onOpen(task)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 9, background: hov ? 'var(--color-surface-tint)' : 'transparent', cursor: 'pointer', transition: 'background 150ms' }}>
      <div onClick={e => { e.stopPropagation(); onToggle(task); }}
        style={{ width: 18, height: 18, minWidth: 18, borderRadius: 5, border: '1.5px solid', borderColor: task.checked ? 'var(--color-primary)' : 'var(--color-border-strong)', background: task.checked ? 'var(--color-primary)' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 150ms' }}>
        {task.checked && <svg width="10" height="8" viewBox="0 0 11 9" fill="none"><path d="M1 4.5L4 7.5L10 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-primary)', opacity: task.checked ? 0.45 : 1, textDecoration: task.checked ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</div>
        <div style={{ marginTop: 2, display: 'flex', minWidth: 0 }}><WorkspaceBadge workspace={workspace} source={source} /></div>
      </div>
      {task.deadline && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1, flexShrink: 0 }}>
          {overdue ? (
            <>
              <span style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, color: 'var(--color-error)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Overdue</span>
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 10, color: 'var(--color-text-quaternary)' }}>{friendlyDate(task.deadline, todayIso)}</span>
            </>
          ) : (
            <>
              <span style={{ fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 600, color: dateColor }}>{friendlyDate(task.deadline, todayIso)}</span>
              {task.time && <span style={{ fontFamily: 'var(--font-body)', fontSize: 10, color: 'var(--color-text-quaternary)' }}>{task.time}</span>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── My Tasks box (left column) ─────────────────────────────────────
type TaskFilter = 'today' | 'week';

function MyTasksBox({ todayTasks, weekTasks, resolve, wsById, todayIso, onToggle, onOpen, onSeeAll }: {
  todayTasks: Task[]; weekTasks: Task[]; resolve: (t: Task) => TaskSource; wsById: Map<string, Workspace>;
  todayIso: string; onToggle: (t: Task) => void; onOpen: (t: Task) => void; onSeeAll: () => void;
}) {
  const [filter, setFilter] = useState<TaskFilter>('today');
  const active = filter === 'today' ? todayTasks : weekTasks;
  const visible = active.slice(0, MY_TASKS_CAP);
  const hidden = active.length - visible.length;

  const pill = (key: TaskFilter, label: string, count: number) => (
    <button onClick={() => setFilter(key)}
      style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 9999, padding: '5px 12px', cursor: 'pointer', background: filter === key ? 'var(--color-primary)' : 'var(--color-surface-tint-2)', color: filter === key ? 'var(--color-white)' : 'var(--color-text-tertiary)', transition: 'all 150ms' }}>
      {label}
      <span style={{ fontSize: 10.5, fontWeight: 700, borderRadius: 9999, padding: '0 6px', background: filter === key ? 'rgba(var(--color-white-rgb), 0.22)' : 'var(--color-white)', color: filter === key ? 'var(--color-white)' : 'var(--color-text-quaternary)' }}>{count}</span>
    </button>
  );

  return (
    <section style={{ ...CARD, ...enterAnim(40), padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="task_alt" size={17} color="var(--color-primary)" />
        </div>
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>My Tasks</div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {pill('today', 'Today', todayTasks.length)}
        {pill('week', 'Next 7 days', weekTasks.length)}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {visible.length === 0 ? (
          <div style={{ padding: '28px 12px', textAlign: 'center', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>
            {filter === 'today' ? 'Nothing due today. Enjoy the clear plate.' : 'No deadlines in the next 7 days.'}
          </div>
        ) : visible.map(t => (
          <TaskRow key={`${t._listId ?? 'dash'}-${t.id}`} task={t} source={resolve(t)} workspace={wsById.get(resolve(t).workspaceId ?? '')} todayIso={todayIso} onToggle={onToggle} onOpen={onOpen} />
        ))}
      </div>

      <button onClick={onSeeAll}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint)'; e.currentTarget.style.borderColor = 'var(--color-primary)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'var(--color-purple-tint-2)'; }}
        style={{ marginTop: 'auto', width: '100%', background: 'transparent', border: '1px dashed var(--color-purple-tint-2)', borderRadius: 9, padding: '10px', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, transition: 'all 160ms' }}>
        <Icon name="checklist" size={15} color="var(--color-primary)" />
        All tasks{hidden > 0 ? ` (${hidden} more)` : ''}
      </button>
    </section>
  );
}

// ── All-tasks dialog ───────────────────────────────────────────────
function AllTasksDialog({ tasks, resolve, wsById, todayIso, onClose, onToggle, onOpen }: {
  tasks: Task[]; resolve: (t: Task) => TaskSource; wsById: Map<string, Workspace>; todayIso: string;
  onClose: () => void; onToggle: (t: Task) => void; onOpen: (t: Task) => void;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'today' | 'week' | 'open' | 'completed'>('all');

  let filtered = tasks;
  if (filter === 'today') filtered = filtered.filter(t => isDueToday(t.deadline, todayIso));
  else if (filter === 'week') filtered = filtered.filter(t => isDueWithinNextDays(t.deadline, todayIso, 7));
  else if (filter === 'open') filtered = filtered.filter(t => !t.checked);
  else if (filter === 'completed') filtered = filtered.filter(t => t.checked);
  if (search.trim()) {
    const q = search.toLowerCase();
    filtered = filtered.filter(t => t.title.toLowerCase().includes(q) || resolve(t).name.toLowerCase().includes(q));
  }
  filtered = sortByDeadline(filtered);

  const pill = (key: typeof filter, label: string) => (
    <button onClick={() => setFilter(key)}
      style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 9999, padding: '5px 12px', cursor: 'pointer', background: filter === key ? 'var(--color-primary)' : 'var(--color-surface-tint-2)', color: filter === key ? 'var(--color-white)' : 'var(--color-text-tertiary)' }}>{label}</button>
  );

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--color-white)', borderRadius: 18, width: '100%', maxWidth: 640, maxHeight: '86vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px', borderBottom: '1px solid var(--color-surface-tint-2)', flexShrink: 0 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="checklist" size={18} color="var(--color-primary)" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)' }}>All tasks</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{tasks.length} total · {tasks.filter(t => !t.checked).length} open · across every workspace</div>
          </div>
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={18} color="var(--color-text-tertiary)" />
          </button>
        </div>
        <div style={{ padding: '14px 20px 8px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--color-purple-pale-11)', borderRadius: 10, padding: '8px 14px' }}>
            <Icon name="search" size={16} color="var(--color-text-tertiary)" />
            <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tasks…"
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-primary)' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {pill('all', 'All')}{pill('today', 'Today')}{pill('week', 'Next 7 days')}{pill('open', 'Open')}{pill('completed', 'Completed')}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 14px 16px' }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '32px 12px', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)', textAlign: 'center' }}>Nothing here.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {filtered.map(t => (
                <TaskRow key={`${t._listId ?? 'dash'}-${t.id}`} task={t} source={resolve(t)} workspace={wsById.get(resolve(t).workspaceId ?? '')} todayIso={todayIso} onToggle={onToggle} onOpen={onOpen} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Vertical timeline (dynamic box) ─────────────────────────────────
interface TimelineItem { id: string; title: string; sub: string; dateLabel: string; emoji?: string | null; color: string; onClick: () => void; }

function VerticalTimeline({ items, emptyText }: { items: TimelineItem[]; emptyText: string }) {
  if (items.length === 0) {
    return <div style={{ padding: '28px 12px', textAlign: 'center', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>{emptyText}</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {items.map((it, i) => (
        <button key={it.id} onClick={it.onClick}
          style={{ display: 'flex', alignItems: 'stretch', gap: 12, padding: '2px 6px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', width: '100%' }}>
          {/* Axis + dot, connected down to the next row */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
            <div style={{ width: 12, height: 12, marginTop: 5, borderRadius: '50%', background: it.color, border: '2.5px solid var(--color-white)', boxShadow: `0 0 0 1.5px ${it.color}`, flexShrink: 0 }} />
            {i < items.length - 1 && <div style={{ flex: 1, width: 2, minHeight: 14, background: 'var(--color-border)' }} />}
          </div>
          {/* Title + source + date */}
          <div style={{ flex: 1, minWidth: 0, paddingBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                {it.emoji ? `${it.emoji} ` : ''}{it.title}
              </div>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 700, color: 'var(--color-text-secondary)', flexShrink: 0 }}>{it.dateLabel}</div>
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-text-quaternary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.sub}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

// ── Custom dropdown (replaces the native <select>) ──────────────────
type DynamicMode = 'milestones' | 'newest';

const MODE_OPTIONS: { key: DynamicMode; label: string; icon: string }[] = [
  { key: 'newest', label: 'Newest tasks', icon: 'fiber_new' },
  { key: 'milestones', label: 'Milestones', icon: 'flag' },
];

function ModeDropdown({ mode, setMode }: { mode: DynamicMode; setMode: (m: DynamicMode) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = MODE_OPTIONS.find(o => o.key === mode) ?? MODE_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const toggle = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 4, left: Math.max(8, rect.right - 172) });
    setOpen(o => !o);
  };

  return (
    <>
      <button ref={btnRef} onClick={toggle}
        style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, border: '1.5px solid var(--color-border)', borderRadius: 9, padding: '5px 8px 5px 10px', background: open ? 'var(--color-surface-tint)' : 'var(--color-white)', color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
        {current.label}
        <Icon name="unfold_more" size={14} color="var(--color-accent-purple-light)" />
      </button>
      {open && pos && createPortal(
        <div ref={menuRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 500, background: 'var(--color-white)', borderRadius: 10, boxShadow: '0 4px 20px rgba(var(--color-black-rgb), 0.13)', border: '1px solid var(--color-border)', minWidth: 172, padding: '4px 0', animation: 'menuIn 140ms ease both' }}>
          {MODE_OPTIONS.map(opt => (
            <button key={opt.key} onClick={() => { setMode(opt.key); setOpen(false); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: opt.key === mode ? 'var(--color-surface-tint)' : 'transparent', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: opt.key === mode ? 600 : 500, color: opt.key === mode ? 'var(--color-primary)' : 'var(--color-text-primary)', textAlign: 'left' }}
              onMouseEnter={e => { if (opt.key !== mode) e.currentTarget.style.background = 'var(--color-purple-pale-11)'; }}
              onMouseLeave={e => { if (opt.key !== mode) e.currentTarget.style.background = 'transparent'; }}>
              <Icon name={opt.icon} size={15} color={opt.key === mode ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
              <span style={{ flex: 1 }}>{opt.label}</span>
              {opt.key === mode && <Icon name="check" size={14} color="var(--color-primary)" />}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}

// ── Dynamic box (milestones | newest tasks) ────────────────────────
function DynamicBox({ mode, setMode, milestoneItems, taskItems }: {
  mode: DynamicMode; setMode: (m: DynamicMode) => void; milestoneItems: TimelineItem[]; taskItems: TimelineItem[];
}) {
  return (
    <section style={{ ...CARD, ...enterAnim(200), flex: 1, minHeight: 0, padding: '16px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--color-blue-pale-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="timeline" size={17} color="var(--color-blue-mid-7)" />
        </div>
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)' }}>
          {mode === 'milestones' ? 'Upcoming milestones' : 'Newest tasks'}
        </div>
        <div style={{ flex: 1 }} />
        <ModeDropdown mode={mode} setMode={setMode} />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <VerticalTimeline
          items={mode === 'milestones' ? milestoneItems : taskItems}
          emptyText={mode === 'milestones' ? 'No milestones scheduled yet.' : 'No tasks created yet.'}
        />
      </div>
    </section>
  );
}

// ── My Meetings + Notifications (right column) ──────────────────────
function MeetingRow({ meeting, currentUserId, onOpen }: { meeting: Meeting; currentUserId: string | null; onOpen: () => void }) {
  const [hov, setHov] = useState(false);
  const color = meeting.color || 'var(--color-primary)';
  const time = meeting.allDay ? 'All day' : (meeting.startTime ? `${meeting.startTime}${meeting.endTime ? ' – ' + meeting.endTime : ''}` : 'Any time');
  const others = (meeting.attendeeIds ?? []).filter(id => id !== currentUserId);
  const shown = others.slice(0, 3);
  const extra = others.length - shown.length;
  return (
    <div onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)} onClick={onOpen}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 9, background: hov ? 'var(--color-surface-tint)' : 'transparent', cursor: 'pointer', transition: 'background 150ms' }}>
      <div style={{ width: 3, alignSelf: 'stretch', minHeight: 30, borderRadius: 2, background: color, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meeting.title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-primary)' }}>{time}</span>
          {meeting.location && <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· {meeting.location}</span>}
        </div>
      </div>
      {others.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          {shown.map((id, i) => (
            <div key={id} style={{ marginLeft: i === 0 ? 0 : -6 }}><CreatorBubble creatorId={id} taskHovered /></div>
          ))}
          {extra > 0 && <span style={{ marginLeft: 3, fontFamily: 'var(--font-heading)', fontSize: 10.5, fontWeight: 700, color: 'var(--color-text-tertiary)' }}>+{extra}</span>}
        </div>
      )}
    </div>
  );
}

function RightColumn({ meetings, currentUserId, onSeeCalendar }: { meetings: Meeting[]; currentUserId: string | null; onSeeCalendar: () => void }) {
  const navigate = useNavigate();
  const notifications = useNotificationsStore(s => s.items);
  const unreadCount = useNotificationsStore(s => s.unreadCount);
  const loaded = useNotificationsStore(s => s.loaded);
  const load = useNotificationsStore(s => s.load);
  const markRead = useNotificationsStore(s => s.markRead);
  const dismiss = useNotificationsStore(s => s.dismiss);
  const setPanelOpen = useNotificationsStore(s => s.setPanelOpen);
  const setCurrentWorkspace = useWorkspaceStore(s => s.setCurrentWorkspace);
  const notifRev = useSyncStore(s => s.entityRevisions.notification ?? 0);

  // Load the feed for the dashboard, and keep it fresh on live signals.
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (notifRev > 0) void load(); }, [notifRev, load]);

  const activateNotification = (n: AppNotification) => {
    void markRead(n.id);
    const target = notificationTarget(n);
    const ws = useWorkspaceStore.getState();
    if (target.workspaceId && target.workspaceId !== ws.currentWorkspaceId && ws.workspaces.some(w => w.id === target.workspaceId)) {
      setCurrentWorkspace(target.workspaceId);
    }
    navigate(target.path);
  };

  const feed = notifications.slice(0, 4);

  const sorted = [...meetings].sort((a, b) => {
    const ka = a.allDay ? -1 : (timeToMinutes(a.startTime) ?? 9999);
    const kb = b.allDay ? -1 : (timeToMinutes(b.startTime) ?? 9999);
    return ka - kb;
  });
  return (
    <section style={{ ...CARD, ...enterAnim(120), display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Notifications feed (Top) */}
      <div style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="notifications" size={17} color="var(--color-primary)" />
          </div>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>Notifications</div>
          <div style={{ flex: 1 }} />
          {unreadCount > 0 && (
            <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 700, color: 'var(--color-white)', background: 'var(--color-primary)', borderRadius: 9999, padding: '2px 9px' }}>{unreadCount > 99 ? '99+' : unreadCount}</span>
          )}
        </div>
        {feed.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '18px 12px', textAlign: 'center' }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--color-surface-tint-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={loaded ? 'notifications_off' : 'notifications'} size={20} color="var(--color-text-quaternary)" />
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-quaternary)', maxWidth: 220, lineHeight: 1.5 }}>
              {loaded ? "You're all caught up — mentions, invites and reminders will show up here." : 'Loading…'}
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {feed.map(n => (
                <NotificationItem key={n.id} notification={n} onActivate={activateNotification} onDismiss={(x) => void dismiss(x.id)} compact />
              ))}
            </div>
            <button
              onClick={() => setPanelOpen(true)}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              style={{ width: '100%', background: 'transparent', border: 'none', borderRadius: 8, padding: '6px', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, transition: 'background 140ms' }}
            >
              View all notifications
              <Icon name="arrow_forward" size={13} color="var(--color-primary)" />
            </button>
          </>
        )}
      </div>

      <div style={{ height: 1, background: 'var(--color-divider)', margin: '0 16px' }} />

      {/* My Meetings — fills the rest, "See all" pinned to the bottom. */}
      <div style={{ flex: 1, minHeight: 0, padding: '18px 16px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="event" size={17} color="var(--color-primary)" />
          </div>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>My Meetings</div>
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 700, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', borderRadius: 9999, padding: '2px 9px' }}>{sorted.length}</span>
        </div>
        <SectionLabel>Today</SectionLabel>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {sorted.length === 0 ? (
            <div style={{ padding: '20px 12px', textAlign: 'center', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>No meetings today.</div>
          ) : sorted.map(m => <MeetingRow key={m.id} meeting={m} currentUserId={currentUserId} onOpen={onSeeCalendar} />)}
        </div>
        <button onClick={onSeeCalendar}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint)'; e.currentTarget.style.borderColor = 'var(--color-primary)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'var(--color-purple-tint-2)'; }}
          style={{ marginTop: 'auto', width: '100%', background: 'transparent', border: '1px dashed var(--color-purple-tint-2)', borderRadius: 9, padding: '10px', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, transition: 'all 160ms' }}>
          <Icon name="calendar_month" size={15} color="var(--color-primary)" />
          See all meetings
        </button>
      </div>
    </section>
  );
}

// ── Dashboard screen ───────────────────────────────────────────────
export default function DashboardScreen() {
  usePageTitle('Dashboard');
  const navigate = useNavigate();
  const isMobile = useMobile();
  const timezone = useUserPrefsStore(s => s.timezone);
  const workspaces = useWorkspaceStore(s => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore(s => s.currentWorkspaceId);
  const currentUserId = useAuthStore(s => s.userId);
  const todayIso = todayInTz(timezone);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [lists, setLists] = useState<List[]>([]);
  const [mdLists, setMdLists] = useState<MarkdownList[]>([]);
  const [timelines, setTimelines] = useState<Timeline[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [dynamicMode, setDynamicMode] = useState<DynamicMode>('newest');

  const refresh = useCallback(async () => {
    try {
      const today = todayInTz(timezone);
      const [tk, ls, md, tl, mt] = await Promise.all([
        apiGetTasks(), apiGetLists(), apiGetMarkdownLists(), apiGetTimelines(),
        apiGetMeetings({ from: today, to: today }),
      ]);
      // `apiGetLists` is membership-scoped, so the accessible list set is the real
      // access boundary for list tasks (the tasks endpoint is broader).
      const accessible = new Set(ls.lists.map(l => l.id));
      const scoped = tk.tasks.filter(t => t._source !== 'list' || (t._listId != null && accessible.has(t._listId)));
      setTasks(scoped);
      setLists(ls.lists);
      setMdLists(md.markdownLists);
      setTimelines(tl.timelines);
      setMeetings(mt.meetings);
    } catch {
      /* transient — a later focus/interval refresh recovers */
    } finally {
      setLoading(false);
    }
  }, [timezone]);

  useEffect(() => {
    // refresh() only setStates after awaiting the network, so it can't cascade
    // synchronously — the rule can't see through the async useCallback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh, workspaces]);

  // Light freshness: re-pull on regaining focus (throttled) so a change made
  // elsewhere shows up without a manual reload. The dashboard reads across all
  // workspaces, so it doesn't ride the workspace-scoped sync store.
  useEffect(() => {
    let last = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - last < 15_000) return;
      last = Date.now();
      void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  // ── Lookups ──
  const wsById = useMemo(() => new Map(workspaces.map(w => [w.id, w])), [workspaces]);
  const listById = useMemo(() => new Map(lists.map(l => [l.id, l])), [lists]);
  const mdByTodoListId = useMemo(() => {
    const m = new Map<string, MarkdownList>();
    for (const md of mdLists) if (md.todoListId) m.set(md.todoListId, md);
    return m;
  }, [mdLists]);
  const resolve = useCallback((t: Task) => resolveTaskSource(t, listById, mdByTodoListId), [listById, mdByTodoListId]);

  // ── Derived task sets ──
  // Both "Today" and "Next 7 days" also surface overdue open tasks — they sort to
  // the top (earlier dates first) and carry an "Overdue" label, so nothing due in
  // the past slips out of view.
  const todayTasks = useMemo(() => sortByDeadline(tasks.filter(t => !t.checked && (isOverdue(t, todayIso) || isDueToday(t.deadline, todayIso)))), [tasks, todayIso]);
  const weekTasks = useMemo(() => sortByDeadline(tasks.filter(t => !t.checked && (isOverdue(t, todayIso) || isDueWithinNextDays(t.deadline, todayIso, 7)))), [tasks, todayIso]);
  const allCounts = useMemo(() => countTasks(tasks), [tasks]);
  const weekCounts = useMemo(() => countTasks(tasks.filter(t => isDueWithinNextDays(t.deadline, todayIso, 7))), [tasks, todayIso]);
  const overdueCount = useMemo(() => tasks.filter(t => isOverdue(t, todayIso)).length, [tasks, todayIso]);

  // ── Dynamic-box items ──
  const milestoneItems = useMemo<TimelineItem[]>(() => {
    const all: Array<{ id: string; title: string; date: string; sub: string; emoji?: string | null; color: string; timelineId: string }> = [];
    for (const tl of timelines) {
      for (const m of tl.milestones ?? []) {
        if (!m.date) continue;
        all.push({ id: m.id, title: m.title, date: m.date.slice(0, 10), sub: tl.name, emoji: m.emoji ?? tl.emoji, color: m.color ?? tl.color ?? STATUS_COLOR[m.status], timelineId: tl.id });
      }
    }
    const upcoming = all.filter(x => x.date >= todayIso).sort((a, b) => a.date < b.date ? -1 : 1);
    const past = all.filter(x => x.date < todayIso).sort((a, b) => a.date > b.date ? -1 : 1);
    return [...upcoming, ...past].slice(0, 5)
      .sort((a, b) => a.date < b.date ? -1 : 1)
      .map(x => ({ id: x.id, title: x.title, sub: x.sub, dateLabel: friendlyDate(x.date, todayIso), emoji: x.emoji, color: x.color, onClick: () => navigate(`/timeline/${x.timelineId}`) }));
  }, [timelines, todayIso, navigate]);

  const taskItems = useMemo<TimelineItem[]>(() => {
    return sortByNewest(tasks).slice(0, 5)
      .sort((a, b) => (a.createdAt ?? '') < (b.createdAt ?? '') ? -1 : 1)
      .map(t => {
        const src = resolve(t);
        return {
          id: `${t._listId ?? 'dash'}-${t.id}`, title: t.title, sub: src.name,
          dateLabel: friendlyDate(t.createdAt, todayIso),
          color: (t.priority && PRIORITY_COLOR[t.priority]) || 'var(--color-primary)',
          onClick: () => setSelectedTask(t),
        };
      });
  }, [tasks, resolve, todayIso]);

  // ── Mutations (optimistic + persist) ──
  const applyLocal = (id: number, updates: Partial<Task>) => setTasks(ts => ts.map(t => t.id === id ? { ...t, ...updates } : t));

  const toggle = useCallback((task: Task) => {
    const checked = !task.checked;
    applyLocal(task.id, { checked, completedAt: checked ? new Date().toISOString() : null });
    if (task._source === 'list' && task._listId) apiUpdateListTask(task._listId, task.id, { checked }).catch(() => void refresh());
    else apiUpdateTask(task.id, { checked }).catch(() => void refresh());
  }, [refresh]);

  const updateTask = useCallback((id: number, updates: Partial<Task>) => {
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    applyLocal(id, updates);
    if (task._source === 'list' && task._listId) apiUpdateListTask(task._listId, id, updates).catch(() => void refresh());
    else apiUpdateTask(id, updates).catch(() => void refresh());
    setSelectedTask(s => s && s.id === id ? { ...s, ...updates } : s);
  }, [tasks, refresh]);

  const deleteTask = useCallback((id: number) => {
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    setTasks(ts => ts.filter(t => t.id !== id));
    // Preserve the same soft-delete-to-Trash behaviour the list/dashboard screens use.
    apiAddToTrash(id, task, { src: task._source ?? 'dash', listId: task._listId, listName: resolve(task).name }).catch(() => { /* best effort */ });
    if (task._source === 'list' && task._listId) apiDeleteListTask(task._listId, id).catch(() => void refresh());
    else apiDeleteTask(id).catch(() => void refresh());
  }, [tasks, resolve, refresh]);

  // Desktop only — three equal-height columns that fill the viewport, so every
  // box reads as full-height even with little content. Mobile renders its own
  // simplified, reordered stack below instead of reusing this grid.
  const gridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(0, 1.05fr) minmax(0, 1.3fr) minmax(0, 0.95fr)', gridTemplateRows: 'minmax(0, 1fr)', gap: 16, alignItems: 'stretch', flex: 1, minHeight: 0 };

  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div style={{ flex: 1, height: '100%', overflowY: 'auto' }}>
      <div style={{ maxWidth: 1440, margin: '0 auto', padding: isMobile ? '20px 16px 90px' : '28px 28px 48px', display: 'flex', flexDirection: 'column', gap: 20, width: '100%', minHeight: '100%', height: isMobile ? undefined : '100%', boxSizing: 'border-box' }}>

        {isMobile ? (
          // Mobile: just the page name, centered under the TopBar — the date,
          // the "tasks left" summary line, and the overdue pill are all
          // desktop-only context that doesn't earn its space on a small screen.
          <header style={{ textAlign: 'center' }}>
            <h1 style={{ fontFamily: 'var(--font-heading)', fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.02em' }}>Dashboard</h1>
          </header>
        ) : (
          <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-accent-purple-light)', marginBottom: 4 }}>{dateStr}</div>
              <h1 style={{ fontFamily: 'var(--font-heading)', fontSize: 27, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.02em', lineHeight: 1.15 }}>Dashboard</h1>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-tertiary)', marginTop: 6 }}>
                {loading ? 'Gathering everything across your workspaces…'
                  : todayTasks.length > 0 ? <>You have <strong style={{ color: 'var(--color-primary)' }}>{todayTasks.length} task{todayTasks.length === 1 ? '' : 's'}</strong> on your plate today across {workspaces.length} workspace{workspaces.length === 1 ? '' : 's'}.</>
                  : <>Nothing due today. <strong style={{ color: 'var(--color-text-primary)' }}>{weekTasks.length}</strong> ahead in the next 7 days.</>}
              </div>
            </div>
            {overdueCount > 0 && (
              <div style={{ background: 'var(--color-error-bg-alt)', border: '1px solid var(--color-error-bg)', borderRadius: 9999, padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="warning" size={14} color="var(--color-error)" />
                <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-error)' }}>{overdueCount} overdue</span>
              </div>
            )}
          </header>
        )}

        {isMobile ? (
          // Mobile: charts first, then My Tasks — Notifications/Meetings and
          // the Net mini-map are desktop-only (see RightColumn/GraphMiniMap).
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ ...CARD, ...enterAnim(40), flex: '1 1 45%', minWidth: 0, padding: '16px 16px' }}>
                <DonutChart title="All tasks" subtitle={`${allCounts.total} total`} completed={allCounts.completed} open={allCounts.open} />
              </div>
              <div style={{ ...CARD, ...enterAnim(80), flex: '1 1 45%', minWidth: 0, padding: '16px 16px' }}>
                <DonutChart title="Next 7 days" subtitle={`${weekCounts.total} due`} completed={weekCounts.completed} open={weekCounts.open} />
              </div>
            </div>
            <MyTasksBox todayTasks={todayTasks} weekTasks={weekTasks} resolve={resolve} wsById={wsById} todayIso={todayIso}
              onToggle={toggle} onOpen={setSelectedTask} onSeeAll={() => setShowAll(true)} />
            <DynamicBox mode={dynamicMode} setMode={setDynamicMode} milestoneItems={milestoneItems} taskItems={taskItems} />
            {activeWorkspaceId && <AgentInbox workspaceId={activeWorkspaceId} />}
          </div>
        ) : (
          <div style={gridStyle}>
            {/* Left — My Tasks */}
            <MyTasksBox todayTasks={todayTasks} weekTasks={weekTasks} resolve={resolve} wsById={wsById} todayIso={todayIso}
              onToggle={toggle} onOpen={setSelectedTask} onSeeAll={() => setShowAll(true)} />

            {/* Middle — charts + dynamic timeline */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <div style={{ ...CARD, ...enterAnim(100), flex: '1 1 220px', minWidth: 0, padding: '16px 16px' }}>
                  <DonutChart title="All tasks" subtitle={`${allCounts.total} total`} completed={allCounts.completed} open={allCounts.open} />
                </div>
                <div style={{ ...CARD, ...enterAnim(140), flex: '1 1 220px', minWidth: 0, padding: '16px 16px' }}>
                  <DonutChart title="Next 7 days" subtitle={`${weekCounts.total} due`} completed={weekCounts.completed} open={weekCounts.open} />
                </div>
              </div>
              <DynamicBox mode={dynamicMode} setMode={setDynamicMode} milestoneItems={milestoneItems} taskItems={taskItems} />
            </div>

            {/* Right — notifications + meetings; "See all" deep-links to a meetings-only Calendar */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, minHeight: 0, overflowY: 'auto' }}>
              <RightColumn meetings={meetings} currentUserId={currentUserId} onSeeCalendar={() => navigate('/calendar?show=meetings')} />
              {activeWorkspaceId && <AgentInbox workspaceId={activeWorkspaceId} />}
              {activeWorkspaceId && <GraphMiniMap workspaceId={activeWorkspaceId} />}
            </div>
          </div>
        )}
      </div>

      {showAll && (
        <AllTasksDialog tasks={sortByDeadline(tasks)} resolve={resolve} wsById={wsById} todayIso={todayIso}
          onClose={() => setShowAll(false)} onToggle={toggle} onOpen={t => { setShowAll(false); setSelectedTask(t); }} />
      )}
      {selectedTask && (
        <TaskDialog task={selectedTask} onUpdate={updateTask} onDelete={deleteTask} onClose={() => setSelectedTask(null)} />
      )}
    </div>
  );
}
