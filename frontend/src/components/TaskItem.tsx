import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task, List } from '../types';
import Icon from './Icon';
import CalendarPicker from './CalendarPicker';
import RingProgress from './RingProgress';
import SlashCommandInput from './SlashCommandInput';
import type { SlashCommandResult } from './SlashCommandInput';

const BADGE_COLORS: Record<string, { bg: string; color: string }> = {
  Work:     { bg: '#f9e287', color: '#6e5e0d' },
  Personal: { bg: '#F5F3FF', color: '#5e4dbb' },
  Urgent:   { bg: '#ffdad6', color: '#ba1a1a' },
  Tip:      { bg: '#eff6ff', color: '#1D4ED8' },
};
const PRIORITIES = ['High', 'Medium', 'Low'] as const;
const PRIORITY_COLORS: Record<string, string> = { High: '#ea580c', Medium: '#f59e0b', Low: '#787584' };
const TAGS = ['Work', 'Personal', 'Urgent', 'Tip'] as const;

function Checkmark() {
  return <svg width="11" height="9" viewBox="0 0 11 9" fill="none"><path d="M1 4.5L4 7.5L10 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function friendlyDate(iso?: string) {
  if (!iso) return '';
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(iso.slice(0, 10) + 'T12:00:00');
  if (iso === localIso(today)) return 'Today';
  const tom = new Date(today); tom.setDate(tom.getDate()+1);
  if (iso === localIso(tom)) return 'Tomorrow';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// ── Edit Modal ──────────────────────────────────────────────────────
interface EditModalProps {
  task?: Partial<Task>;
  mode?: 'edit' | 'create';
  onSave: (updates: Partial<Task>) => void;
  onClose: () => void;
  availableLists?: List[];
  currentListId?: string;
}

export function EditModal({ task = {}, mode = 'edit', onSave, onClose, availableLists = [] }: EditModalProps) {
  const [title, setTitle] = useState(task.title ?? '');
  const [notes, setNotes] = useState(task.note ?? '');
  const [deadline, setDeadline] = useState(task.deadline ?? '');
  const [priority, setPriority] = useState<string>(task.priority ?? '');
  const [tag, setTag] = useState(task.badge ?? '');
  const [showCal, setShowCal] = useState(false);
  const [linkedListId, setLinkedListId] = useState<string | null>(task.linkedListId ?? null);
  const [linkedListType, setLinkedListType] = useState<'sublist' | 'link' | null>(task.linkedListType ?? null);
  const isCreate = mode === 'create';
  const canSubmit = title.trim().length > 0;

  const linkedList = linkedListId ? availableLists.find(l => l.id === linkedListId) : null;

  const fl: CSSProperties = { fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', marginBottom: 5, display: 'block' };
  const fi: CSSProperties = { width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#1c1b22', background: 'transparent', border: 'none', borderBottom: '1.5px solid #E5E7EB', padding: '7px 0', outline: 'none', transition: 'border-color 200ms' };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', backdropFilter: 'blur(4px)', zIndex: 1500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 440, boxShadow: '0 8px 32px rgba(0,0,0,0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px 16px', borderBottom: '1px solid #F5F3FF' }}>
          <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>{isCreate ? 'New Task' : 'Edit Task'}</span>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={16} color="#787584" />
          </button>
        </div>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <label style={fl}>Task Name</label>
            <input value={title} onChange={e => setTitle(e.target.value)} style={fi}
              onFocus={e => (e.target.style.borderBottomColor = '#5e4dbb')}
              onBlur={e => (e.target.style.borderBottomColor = '#E5E7EB')} />
          </div>
          <div>
            <label style={fl}>Notes</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
              style={{ ...fi, resize: 'none', lineHeight: 1.5 }}
              onFocus={e => (e.target.style.borderBottomColor = '#5e4dbb')}
              onBlur={e => (e.target.style.borderBottomColor = '#E5E7EB')} />
          </div>
          <div style={{ position: 'relative' }}>
            <label style={fl}>Deadline</label>
            <button onClick={() => setShowCal(c => !c)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'transparent', border: 'none', borderBottom: `1.5px solid ${showCal ? '#5e4dbb' : '#E5E7EB'}`, padding: '8px 0', cursor: 'pointer', textAlign: 'left' }}>
              <Icon name="calendar_today" size={14} color={deadline ? '#5e4dbb' : '#c9c4d5'} />
              <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: deadline ? '#1c1b22' : '#c9c4d5' }}>
                {deadline ? new Date(deadline.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'Pick a date…'}
              </span>
            </button>
            {showCal && (
              <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 500, animation: 'menuIn 200ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
                <CalendarPicker value={deadline} onChange={d => { setDeadline(d); setShowCal(false); }} onClear={() => { setDeadline(''); setShowCal(false); }} />
              </div>
            )}
          </div>
          <div>
            <label style={fl}>Priority</label>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              {PRIORITIES.map(p => (
                <button key={p} onClick={() => setPriority(priority === p ? '' : p)}
                  style={{ flex: 1, padding: '7px 0', borderRadius: 8, border: `1.5px solid ${priority === p ? PRIORITY_COLORS[p] : '#E5E7EB'}`, background: priority === p ? `${PRIORITY_COLORS[p]}15` : 'transparent', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: priority === p ? PRIORITY_COLORS[p] : '#787584', cursor: 'pointer', transition: 'all 150ms' }}>
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={fl}>Tag</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              {TAGS.map(t => {
                const bc = BADGE_COLORS[t] ?? { bg: '#F5F3FF', color: '#484552' };
                const active = tag === t;
                return (
                  <button key={t} onClick={() => setTag(active ? '' : t)}
                    style={{ borderRadius: 9999, padding: '4px 12px', border: `1.5px solid ${active ? bc.color : '#E5E7EB'}`, background: active ? bc.bg : 'transparent', fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 600, color: active ? bc.color : '#787584', cursor: 'pointer', transition: 'all 150ms' }}>
                    {t}
                  </button>
                );
              })}
            </div>
          </div>
          {linkedList && (
            <div>
              <label style={fl}>Linked List</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#F5F3FF', border: '1px solid #c4b5fd', borderRadius: 8, padding: '6px 12px', flex: 1 }}>
                  <Icon name="format_list_bulleted" size={14} color="#5e4dbb" />
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#5e4dbb', fontWeight: 500 }}>
                    {linkedListType === 'sublist' ? 'Sublist: ' : 'Linked: '}
                    {linkedList.name}
                  </span>
                </div>
                <button onClick={() => { setLinkedListId(null); setLinkedListType(null); }}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer' }}>
                  <Icon name="close" size={14} color="#787584" />
                </button>
              </div>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '14px 24px 20px', borderTop: '1px solid #F5F3FF' }}>
          <button onClick={onClose} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: '1px solid #E5E7EB', borderRadius: 8, padding: '9px 20px', cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => onSave({ title, note: notes, deadline: deadline || undefined, priority: (priority as Task['priority']) || undefined, badge: tag || undefined, linkedListId, linkedListType })}
            disabled={!canSubmit}
            style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: canSubmit ? '#5e4dbb' : '#c9c4d5', border: 'none', borderRadius: 8, padding: '9px 20px', cursor: canSubmit ? 'pointer' : 'not-allowed', transition: 'all 180ms' }}>
            {isCreate ? 'Add Task' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Delete Confirm Modal ──────────────────────────────────────────
interface DeleteConfirmProps {
  task: Task;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteConfirmModal({ task, onConfirm, onCancel }: DeleteConfirmProps) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', backdropFilter: 'blur(4px)', zIndex: 1500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={onCancel}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 380, width: '100%', boxShadow: '0 8px 32px rgba(0,0,0,0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#ffdad6', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
          <Icon name="delete" size={20} color="#ba1a1a" />
        </div>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22', marginBottom: 8 }}>Delete task?</div>
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', lineHeight: 1.5, marginBottom: 24 }}>
          "<span style={{ color: '#1c1b22', fontWeight: 500 }}>{task.title}</span>" will be moved to trash.
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: '1px solid #E5E7EB', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Cancel</button>
          <button onClick={onConfirm} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#ba1a1a', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Delete</button>
        </div>
      </div>
    </div>
  );
}

// ── TaskItem ──────────────────────────────────────────────────────
interface TaskItemProps {
  task: Task;
  onToggle?: (id: number) => void;
  onDelete?: (id: number) => void;
  onUpdate?: (id: number, updates: Partial<Task>) => void;
  onRowClick?: (task: Task, e: React.MouseEvent) => void;
  onDragStart?: (id: number) => void;
  onDragEnd?: () => void;
  onDragOver?: (id: number) => void;
  onDrop?: (id: number) => void;
  isDragging?: boolean;
  isDragOver?: boolean;
  hideListBadge?: boolean;
  availableLists?: List[];
  currentListId?: string;
}

export default function TaskItem({ task, onToggle, onRowClick, onDragStart, onDragEnd, onDragOver, onDrop, isDragging, isDragOver, hideListBadge, availableLists = [] }: TaskItemProps) {
  const [hovered, setHovered] = useState(false);
  const navigate = useNavigate();
  const { title, note, priority, badge, checked, deadline, time, linkedListId } = task;
  const bc = badge ? (BADGE_COLORS[badge] ?? { bg: '#F5F3FF', color: '#484552' }) : null;
  const priorityColor = priority ? PRIORITY_COLORS[priority] : '#787584';

  // Find linked list for ring progress
  const linkedList = linkedListId ? availableLists.find(l => l.id === linkedListId) : null;
  const ringProgress = linkedList?.linkedProgress ?? { total: 0, completed: 0 };
  const isLinkedComplete = linkedList && ringProgress.total > 0 && ringProgress.completed === ringProgress.total;

  return (
    <>
      <div
        draggable={!!(onDragStart)}
        onDragStart={e => {
          e.dataTransfer.effectAllowed = 'move';
          if (!task._source || task._source === 'dash') {
            e.dataTransfer.setData('dashtaskid', task.id.toString());
          }
          onDragStart?.(task.id);
        }}
        onDragOver={e => { e.preventDefault(); onDragOver?.(task.id); }}
        onDrop={e => { e.preventDefault(); onDrop?.(task.id); }}
        onDragEnd={() => onDragEnd?.()}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8,
          background: hovered && !isDragging ? '#F5F3FF' : 'transparent',
          opacity: isDragging ? 0.35 : 1,
          borderTop: isDragOver ? '2px solid #9d8dff' : '2px solid transparent',
          transition: 'background 200ms, opacity 150ms, border-color 120ms',
          position: 'relative',
        }}>
        {linkedListId ? (
          <RingProgress
            total={ringProgress.total}
            completed={ringProgress.completed}
            color={linkedList?.color ?? '#5e4dbb'}
          />
        ) : (
          <div style={{ width: 20, height: 20, minWidth: 20, borderRadius: 5, border: '1.5px solid', borderColor: checked ? '#5e4dbb' : '#c9c4d5', background: checked ? '#5e4dbb' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms', flexShrink: 0 }}
            onClick={e => { e.stopPropagation(); onToggle?.(task.id); }}>
            {checked && <Checkmark />}
          </div>
        )}

        <div style={{ flex: 1, minWidth: 0, cursor: onRowClick || linkedListId ? 'pointer' : 'default' }}
          onClick={e => {
            if (linkedListId) { e.stopPropagation(); navigate(`/list/${linkedListId}`); return; }
            onRowClick?.(task, e);
          }}>
          <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: linkedListId ? (linkedList?.color ?? '#5e4dbb') : '#1c1b22', lineHeight: 1.4, opacity: (checked || isLinkedComplete) ? 0.4 : 1, textDecoration: (checked || isLinkedComplete) ? 'line-through' : 'none', textUnderlineOffset: linkedListId ? 2 : undefined }}>{title}</div>
          {note && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2 }}>{note}</div>}
          {(deadline || time || priority || badge || (task._listName && !hideListBadge)) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
              {task._listName && !hideListBadge && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 9999, padding: '1px 8px', fontSize: 10, fontWeight: 600, background: task._source === 'dash' ? '#F5F3FF' : '#eef0fb', color: task._source === 'dash' ? '#5e4dbb' : '#3d4a8f' }}>
                  <Icon name={task._source === 'dash' ? 'today' : 'format_list_bulleted'} size={10} color={task._source === 'dash' ? '#5e4dbb' : '#3d4a8f'} />
                  {task._listName}
                </span>
              )}
              {(deadline || time) && (
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584', display: 'flex', alignItems: 'center', gap: 3 }}>
                  <Icon name="calendar_today" size={12} color="#787584" />{friendlyDate(deadline) || time}
                </span>
              )}
              {priority && (
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: priorityColor, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 3 }}>
                  <Icon name="flag" size={12} color={priorityColor} />{priority}
                </span>
              )}
              {bc && <span style={{ display: 'inline-flex', alignItems: 'center', borderRadius: 9999, padding: '1px 8px', fontSize: 10, fontWeight: 600, background: bc.bg, color: bc.color }}>{badge}</span>}
            </div>
          )}
        </div>

        <div style={{ width: 16, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: hovered ? 1 : 0, transition: 'opacity 150ms', cursor: 'grab' }}>
          <Icon name="drag_indicator" size={16} color="#c9c4d5" />
        </div>
      </div>
    </>
  );
}

// ── QuickAdd ──────────────────────────────────────────────────────
interface QuickAddProps {
  placeholder?: string;
  onAdd: (data: Partial<Task> & { title: string }) => void;
  availableLists?: List[];
  currentListId?: string;
}

export function QuickAdd({ placeholder = 'Add a new task…', onAdd, availableLists = [], currentListId }: QuickAddProps) {
  const [val, setVal] = useState('');
  const [focused, setFocused] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Pending slash command state (for /list — needs a name modal)
  const [pendingSublist, setPendingSublist] = useState<{ taskTitle: string; sublistName: string } | null>(null);

  const hasText = val.trim().length > 0;
  const isSlash = val.startsWith('/');

  const submit = (data?: Partial<Task>) => {
    const payload = { title: (data?.title ?? val).trim(), note: data?.note, deadline: data?.deadline, priority: data?.priority, badge: data?.badge };
    if (!payload.title) return;
    onAdd(payload as Partial<Task> & { title: string });
    setVal('');
    setAdvancedOpen(false);
  };

  const handleSlashCommand = (cmd: SlashCommandResult) => {
    if (cmd.type === 'list' && cmd.newListName) {
      const taskTitle = cmd.newListName;
      // Store pending sublist creation; pass special signal to onAdd
      const payload = {
        title: taskTitle,
        linkedListType: 'sublist' as const,
        linkedListId: '__pending__',
        __sublistName: cmd.newListName,
      };
      onAdd(payload as unknown as Partial<Task> & { title: string });
      setVal('');
    } else if (cmd.type === 'link' && cmd.linkedListId) {
      const linkedList = availableLists.find(l => l.id === cmd.linkedListId);
      const payload = {
        title: linkedList?.name ?? 'Linked list',
        linkedListType: 'link' as const,
        linkedListId: cmd.linkedListId,
      };
      onAdd(payload as Partial<Task> & { title: string });
      setVal('');
    }
  };

  if (isSlash && availableLists.length > 0) {
    return (
      <div style={{ position: 'relative' }}>
        <div style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', width: 18, height: 18, borderRadius: 4, border: `1.5px solid ${focused ? '#5e4dbb' : '#c9c4d5'}`, pointerEvents: 'none', transition: 'border-color 200ms' }} />
        <SlashCommandInput
          value={val}
          onChange={setVal}
          onCommand={handleSlashCommand}
          placeholder={placeholder}
          availableLists={availableLists}
          currentListId={currentListId}
          autoFocus
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={e => { if (e.key === 'Enter' && hasText && !val.startsWith('/')) { e.preventDefault(); submit(); } }}
          inputStyle={{ width: '100%', background: '#fff', border: 'none', borderRadius: 10, padding: `13px ${hasText ? 86 : 48}px 13px 42px`, fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#484552', outline: focused ? '2px solid rgba(94,77,187,0.18)' : 'none', outlineOffset: -1, transition: 'outline 200ms, padding 180ms' }}
        />
        <button onMouseDown={e => e.preventDefault()} onClick={() => setVal('')}
          style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', width: 28, height: 28, borderRadius: '50%', background: '#F5F3FF', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 200ms' }}>
          <Icon name="close" size={16} color="#5e4dbb" />
        </button>
        {pendingSublist && (
          <EditModal mode="create" task={{ title: pendingSublist.taskTitle }}
            onSave={d => {
              onAdd({ title: d.title ?? pendingSublist.taskTitle, linkedListType: 'sublist', linkedListId: '__pending__', __sublistName: pendingSublist.sublistName } as unknown as Partial<Task> & { title: string });
              setPendingSublist(null); setVal('');
            }}
            onClose={() => setPendingSublist(null)} />
        )}
      </div>
    );
  }

  return (
    <>
      <div style={{ position: 'relative' }}>
        <div style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', width: 18, height: 18, borderRadius: 4, border: `1.5px solid ${focused ? '#5e4dbb' : '#c9c4d5'}`, pointerEvents: 'none', transition: 'border-color 200ms' }} />
        <input value={val} onChange={e => setVal(e.target.value)}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          onKeyDown={e => { if (e.key === 'Enter' && hasText) { e.preventDefault(); submit(); } }}
          placeholder={placeholder}
          style={{ width: '100%', background: '#fff', border: 'none', borderRadius: 10, padding: `13px ${hasText ? 86 : 48}px 13px 42px`, fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#484552', outline: focused ? '2px solid rgba(94,77,187,0.18)' : 'none', outlineOffset: -1, transition: 'outline 200ms, padding 180ms' }} />
        {hasText && (
          <button onMouseDown={e => e.preventDefault()} onClick={() => setAdvancedOpen(true)}
            style={{ position: 'absolute', right: 46, top: '50%', transform: 'translateY(-50%)', width: 28, height: 28, borderRadius: '50%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'qaPencilIn 200ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <Icon name="edit" size={15} color="#5e4dbb" />
          </button>
        )}
        <button onMouseDown={e => e.preventDefault()} onClick={() => submit()} disabled={!hasText}
          style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', width: 28, height: 28, borderRadius: '50%', background: hasText ? '#5e4dbb' : '#F5F3FF', border: 'none', cursor: hasText ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 200ms' }}>
          <Icon name="arrow_upward" size={16} color={hasText ? '#fff' : '#5e4dbb'} />
        </button>
      </div>
      {advancedOpen && <EditModal mode="create" task={{ title: val }} onSave={submit} onClose={() => setAdvancedOpen(false)} availableLists={availableLists} currentListId={currentListId} />}
    </>
  );
}
