import { usePageTitle } from "../hooks/usePageTitle";
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task, List, Timeline, Meeting } from '../types';
import {
  apiGetTasks, apiGetLists, apiGetTimelines, apiGetMeetings,
  apiCreateTask, apiAddListTask, apiUpdateTask, apiUpdateListTask,
  apiDeleteTask, apiDeleteListTask, apiAddToTrash,
  apiCreateMeeting, apiUpdateMeeting, apiDeleteMeeting,
} from '../api/client';
import useWorkspaceStore from '../store/useWorkspaceStore';
import useUserPrefsStore from '../store/useUserPrefsStore';
import TaskDialog from '../components/TaskDialog';
import CalendarPicker from '../components/CalendarPicker';
import TimePicker from '../components/TimePicker';
import Icon from '../components/Icon';
import { useMobile } from '../hooks/useBreakpoint';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DAYS_MINI = ['S','M','T','W','T','F','S'];
const PRIORITY_COLORS: Record<string, string> = { High: '#ea580c', Medium: '#f59e0b', Low: '#787584' };

// Curated, saturated palette for meetings — readable as chip text and on-brand.
const MEETING_COLORS = ['#5e4dbb', '#3b82f6', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6'];
const DEFAULT_MEETING_COLOR = '#3b82f6';
const DEFAULT_MILESTONE_COLOR = '#0ea5e9';

const HOUR_H = 48;                 // px per hour in the Week time-grid
const HOURS = Array.from({ length: 24 }, (_, i) => i);

/** "HH:MM" → minutes since midnight, or null. */
function parseMin(t?: string | null): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return null;
  const h = Number(m[1]), mm = Number(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Light translucent tint of a hex color, for chip backgrounds. */
function tint(hex: string | null | undefined, alpha = 0.14): string {
  if (!hex || !/^#?[0-9a-fA-F]{6}$/.test(hex.replace('#', ''))) return '#F5F3FF';
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function startOfWeek(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  r.setDate(r.getDate() - r.getDay());
  return r;
}

function getAllTasks(dashTasks: Task[], lists: List[]): Task[] {
  const dash = dashTasks
    .filter(t => (t._source ?? 'dash') === 'dash')
    .map(t => ({ ...t, _source: 'dash' as const, _listId: 'dashboard', _listName: 'Dashboard' }));
  const listTasks = lists.flatMap(l =>
    l.sections.flatMap(s => s.tasks.map(t => ({
      ...t, _source: 'list' as const, _listId: l.id, _listName: l.name, workspaceId: l.workspaceId,
    })))
  );
  return [...dash, ...listTasks];
}

// ── Unified calendar chip ─────────────────────────────────────────
interface Chip {
  key: string;
  kind: 'task' | 'milestone' | 'meeting';
  date: string;
  time: string | null;
  label: string;
  accent: string;
  bg: string;
  emoji?: string | null;
  priorityColor?: string;
  subtitle?: string | null;
  allDay?: boolean;
  startMin?: number;        // set when the item has a time-of-day (Week grid)
  endMin?: number;
  dragData?: string;        // when set, the chip can be dragged to reschedule
  onClick: () => void;
}

/** Greedy column layout for overlapping timed chips within one day. */
function layoutDay(chips: Chip[]): Map<Chip, { col: number; cols: number }> {
  const result = new Map<Chip, { col: number; cols: number }>();
  const sorted = [...chips].sort((a, b) => (a.startMin! - b.startMin!) || (a.endMin! - b.endMin!));
  let cluster: Chip[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const colEnds: number[] = [];
    const colOf = new Map<Chip, number>();
    for (const ev of cluster) {
      let placed = false;
      for (let i = 0; i < colEnds.length; i++) {
        if (colEnds[i] <= ev.startMin!) { colEnds[i] = ev.endMin!; colOf.set(ev, i); placed = true; break; }
      }
      if (!placed) { colOf.set(ev, colEnds.length); colEnds.push(ev.endMin!); }
    }
    const cols = Math.max(colEnds.length, 1);
    for (const ev of cluster) result.set(ev, { col: colOf.get(ev) ?? 0, cols });
    cluster = []; clusterEnd = -1;
  };
  for (const ev of sorted) {
    if (cluster.length && ev.startMin! >= clusterEnd) flush();
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev.endMin!);
  }
  flush();
  return result;
}

// ════════════════════════════════════════════════════════════════════
// Meeting editor modal
// ════════════════════════════════════════════════════════════════════
interface MeetingModalProps {
  initial: Meeting | null;       // null = creating
  presetDate?: string;
  onSave: (data: Omit<Meeting, 'id' | 'createdAt' | 'updatedAt'>, id?: string) => void;
  onDelete?: (id: string) => void;
  onClose: () => void;
}

function MeetingModal({ initial, presetDate, onSave, onDelete, onClose }: MeetingModalProps) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [date, setDate] = useState(initial?.date ?? presetDate ?? toIso(new Date()));
  const [allDay, setAllDay] = useState(initial?.allDay ?? false);
  const [startTime, setStartTime] = useState<string>(initial?.startTime ?? '');
  const [endTime, setEndTime] = useState<string>(initial?.endTime ?? '');
  const [location, setLocation] = useState(initial?.location ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [color, setColor] = useState(initial?.color ?? DEFAULT_MEETING_COLOR);
  const [showCal, setShowCal] = useState(false);
  const [showStart, setShowStart] = useState(false);
  const [showEnd, setShowEnd] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  const canSave = title.trim().length > 0 && !!date;

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      title: title.trim(),
      date,
      allDay,
      startTime: allDay ? null : (startTime || null),
      endTime: allDay ? null : (endTime || null),
      location: location.trim() || null,
      description: description.trim() || null,
      color,
    }, initial?.id);
  };

  const friendlyDate = date
    ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    : 'Pick a date';

  const labelStyle = { fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600 as const, color: '#484552', marginBottom: 6, display: 'block' };
  const triggerStyle = (active: boolean) => ({
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 12px', borderRadius: 8,
    border: `1.5px solid ${active ? '#5e4dbb' : '#E5E7EB'}`, background: active ? '#F5F3FF' : '#fff',
    cursor: 'pointer', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#1c1b22', textAlign: 'left' as const, boxSizing: 'border-box' as const,
  });

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)', animation: 'backdropIn 180ms ease both' }}
      onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 18, width: '100%', maxWidth: 480, maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 40px rgba(94,77,187,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}
        onClick={e => e.stopPropagation()}>
        {/* Accent stripe + header */}
        <div style={{ height: 5, background: color, flexShrink: 0 }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px 12px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 34, height: 34, borderRadius: 10, background: tint(color, 0.16), display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Icon name="event" size={19} color={color} />
            </div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22' }}>
              {initial ? 'Edit Meeting' : 'New Meeting'}
            </div>
          </div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: '50%', border: 'none', background: '#f1ecf6', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={16} color="#787584" />
          </button>
        </div>

        <div style={{ padding: '4px 24px 8px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Title */}
          <div>
            <label style={labelStyle}>Title</label>
            <input autoFocus value={title} onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && canSave) handleSave(); }}
              placeholder="Meeting title"
              style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#1c1b22', background: 'transparent', border: 'none', borderBottom: '1.5px solid #E5E7EB', padding: '7px 0', outline: 'none', boxSizing: 'border-box' }}
              onFocus={e => (e.target.style.borderBottomColor = '#5e4dbb')}
              onBlur={e => (e.target.style.borderBottomColor = '#E5E7EB')} />
          </div>

          {/* Date */}
          <div style={{ position: 'relative' }}>
            <label style={labelStyle}>Date</label>
            <button onClick={() => { setShowCal(v => !v); setShowStart(false); setShowEnd(false); }} style={triggerStyle(showCal)}>
              <Icon name="calendar_today" size={15} color={date ? '#5e4dbb' : '#b0acbe'} />
              <span style={{ flex: 1 }}>{friendlyDate}</span>
            </button>
            {showCal && (
              <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 30 }}>
                <CalendarPicker value={date} onChange={v => { setDate(v); setShowCal(false); }} />
              </div>
            )}
          </div>

          {/* All-day toggle */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none' }}
            onClick={() => setAllDay(v => !v)}>
            <div style={{ width: 38, height: 22, borderRadius: 9999, background: allDay ? '#5e4dbb' : '#d8d3e6', position: 'relative', transition: 'background 180ms', flexShrink: 0 }}>
              <div style={{ position: 'absolute', top: 2, left: allDay ? 18 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left 180ms', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
            </div>
            <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#484552' }}>All-day</span>
          </label>

          {/* Times */}
          {!allDay && (
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <label style={labelStyle}>Starts</label>
                <button onClick={() => { setShowStart(v => !v); setShowEnd(false); setShowCal(false); }} style={triggerStyle(showStart)}>
                  <Icon name="schedule" size={15} color={startTime ? '#5e4dbb' : '#b0acbe'} />
                  <span style={{ flex: 1 }}>{startTime || '--:--'}</span>
                </button>
                {showStart && (
                  <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 30 }}>
                    <TimePicker value={startTime} onChange={v => { setStartTime(v); setShowStart(false); }} onClear={() => { setStartTime(''); setShowStart(false); }} />
                  </div>
                )}
              </div>
              <div style={{ position: 'relative', flex: 1 }}>
                <label style={labelStyle}>Ends</label>
                <button onClick={() => { setShowEnd(v => !v); setShowStart(false); setShowCal(false); }} style={triggerStyle(showEnd)}>
                  <Icon name="schedule" size={15} color={endTime ? '#5e4dbb' : '#b0acbe'} />
                  <span style={{ flex: 1 }}>{endTime || '--:--'}</span>
                </button>
                {showEnd && (
                  <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 30 }}>
                    <TimePicker value={endTime} onChange={v => { setEndTime(v); setShowEnd(false); }} onClear={() => { setEndTime(''); setShowEnd(false); }} />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Location */}
          <div>
            <label style={labelStyle}>Location</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1.5px solid #E5E7EB', borderRadius: 8, padding: '9px 12px' }}>
              <Icon name="location_on" size={15} color="#b0acbe" />
              <input value={location} onChange={e => setLocation(e.target.value)} placeholder="Add a location"
                style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#1c1b22', background: 'transparent', border: 'none', outline: 'none' }} />
            </div>
          </div>

          {/* Color */}
          <div>
            <label style={labelStyle}>Color</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {MEETING_COLORS.map(c => (
                <button key={c} onClick={() => setColor(c)}
                  style={{ width: 28, height: 28, borderRadius: '50%', background: c, border: color === c ? '2.5px solid #1c1b22' : '2.5px solid transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 120ms' }}>
                  {color === c && <Icon name="check" size={14} color="#fff" />}
                </button>
              ))}
            </div>
          </div>

          {/* Description */}
          <div>
            <label style={labelStyle}>Notes</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Add notes…" rows={3}
              style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#1c1b22', background: '#faf9ff', border: '1.5px solid #E5E7EB', borderRadius: 8, padding: '9px 12px', outline: 'none', resize: 'vertical', boxSizing: 'border-box' }}
              onFocus={e => (e.target.style.borderColor = '#5e4dbb')}
              onBlur={e => (e.target.style.borderColor = '#E5E7EB')} />
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 24px 20px', borderTop: '1px solid #F5F3FF', flexShrink: 0 }}>
          {initial && onDelete && (
            <button onClick={() => setShowDelete(true)}
              style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#ba1a1a', background: '#fff5f5', border: '1px solid #ffdad6', borderRadius: 8, padding: '9px 16px', cursor: 'pointer', marginRight: 'auto' }}>
              Delete
            </button>
          )}
          <button onClick={onClose} style={{ marginLeft: initial && onDelete ? 0 : 'auto', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: '1px solid #E5E7EB', borderRadius: 8, padding: '9px 20px', cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleSave} disabled={!canSave}
            style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: canSave ? '#5e4dbb' : '#c9c4d5', border: 'none', borderRadius: 8, padding: '9px 22px', cursor: canSave ? 'pointer' : 'not-allowed', transition: 'all 180ms' }}>
            {initial ? 'Save' : 'Add Meeting'}
          </button>
        </div>

        {showDelete && initial && onDelete && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.25)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'backdropIn 160ms ease both' }}
            onClick={() => setShowDelete(false)}>
            <div style={{ background: '#fff', borderRadius: 14, padding: '22px 24px', maxWidth: 320, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', animation: 'modalIn 240ms cubic-bezier(0.34,1.56,0.64,1) both' }}
              onClick={e => e.stopPropagation()}>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22', marginBottom: 6 }}>Delete this meeting?</div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', marginBottom: 18 }}>This can't be undone.</div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button onClick={() => setShowDelete(false)} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: '1px solid #E5E7EB', borderRadius: 8, padding: '8px 16px', cursor: 'pointer' }}>Cancel</button>
                <button onClick={() => { onDelete(initial.id); }} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#ba1a1a', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer' }}>Delete</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// Day "what to add" chooser
// ════════════════════════════════════════════════════════════════════
function DayAddChooser({ date, onTask, onMeeting, onClose }: { date: string; onTask: () => void; onMeeting: () => void; onClose: () => void }) {
  const friendly = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const opt = (icon: string, title: string, sub: string, onClick: () => void) => (
    <button onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 12, border: '1.5px solid #E5E7EB', background: '#fff', cursor: 'pointer', textAlign: 'left', transition: 'all 150ms', width: '100%' }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = '#5e4dbb'; e.currentTarget.style.background = '#F5F3FF'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = '#E5E7EB'; e.currentTarget.style.background = '#fff'; }}>
      <div style={{ width: 38, height: 38, borderRadius: 10, background: '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon name={icon} size={20} color="#5e4dbb" />
      </div>
      <div>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 700, color: '#1c1b22' }}>{title}</div>
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 1 }}>{sub}</div>
      </div>
    </button>
  );
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)', animation: 'backdropIn 180ms ease both' }}
      onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 380, boxShadow: '0 8px 32px rgba(0,0,0,0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px 8px' }}>
          <div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>Add to calendar</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2 }}>{friendly}</div>
          </div>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: '#f1ecf6', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={15} color="#787584" />
          </button>
        </div>
        <div style={{ padding: '8px 22px 22px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {opt('task_alt', 'Task', 'A to-do with a deadline', onTask)}
          {opt('event', 'Meeting', 'A standalone calendar event', onMeeting)}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// Add task to date modal (Dashboard or a list)
// ════════════════════════════════════════════════════════════════════
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
    if (dest === 'dash') { onAdd(title.trim(), { type: 'dash' }); return; }
    const list = lists.find(l => l.id === dest);
    const sectionId = list?.sections[0]?.id;
    if (!sectionId) return;
    onAdd(title.trim(), { type: 'list', listId: dest, sectionId });
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
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
            <input autoFocus value={title} onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && canSubmit) handleAdd(); }}
              placeholder="What needs to be done?"
              style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#1c1b22', background: 'transparent', border: 'none', borderBottom: '1.5px solid #E5E7EB', padding: '7px 0', outline: 'none', boxSizing: 'border-box', transition: 'border-color 200ms' }}
              onFocus={e => (e.target.style.borderBottomColor = '#5e4dbb')}
              onBlur={e => (e.target.style.borderBottomColor = '#E5E7EB')} />
          </div>
          <div>
            <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', marginBottom: 8, display: 'block' }}>Add to</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
              <button onClick={() => setDest('dash')}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 8, border: `1.5px solid ${dest === 'dash' ? '#5e4dbb' : '#E5E7EB'}`, background: dest === 'dash' ? '#F5F3FF' : 'transparent', cursor: 'pointer', textAlign: 'left', transition: 'all 150ms' }}>
                <div style={{ width: 20, height: 20, borderRadius: '50%', background: dest === 'dash' ? '#5e4dbb' : '#E5E7EB', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {dest === 'dash' && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#fff' }} />}
                </div>
                <Icon name="today" size={15} color={dest === 'dash' ? '#5e4dbb' : '#787584'} />
                <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: dest === 'dash' ? '#5e4dbb' : '#484552' }}>Dashboard</span>
              </button>
              {lists.map(list => (
                <button key={list.id} onClick={() => setDest(list.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 8, border: `1.5px solid ${dest === list.id ? '#5e4dbb' : '#E5E7EB'}`, background: dest === list.id ? '#F5F3FF' : 'transparent', cursor: 'pointer', textAlign: 'left', transition: 'all 150ms' }}>
                  <div style={{ width: 20, height: 20, borderRadius: '50%', background: dest === list.id ? '#5e4dbb' : '#E5E7EB', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {dest === list.id && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#fff' }} />}
                  </div>
                  {list.emoji ? <span style={{ fontSize: 15, lineHeight: 1 }}>{list.emoji}</span> : <Icon name="format_list_bulleted" size={15} color={dest === list.id ? '#5e4dbb' : '#787584'} />}
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

// ════════════════════════════════════════════════════════════════════
// Compact chip (month / year) & card (week)
// ════════════════════════════════════════════════════════════════════
function ChipCompact({ chip }: { chip: Chip }) {
  return (
    <div onClick={e => { e.stopPropagation(); chip.onClick(); }}
      title={chip.label}
      draggable={!!chip.dragData}
      onDragStart={chip.dragData ? e => { e.dataTransfer.setData('text/plain', chip.dragData!); e.dataTransfer.effectAllowed = 'move'; e.stopPropagation(); } : undefined}
      style={{ display: 'flex', alignItems: 'center', gap: 4, background: chip.bg, borderRadius: 4, padding: '2px 5px', cursor: chip.dragData ? 'grab' : 'pointer', transition: 'filter 120ms' }}
      onMouseEnter={e => (e.currentTarget.style.filter = 'brightness(0.96)')}
      onMouseLeave={e => (e.currentTarget.style.filter = 'none')}>
      {chip.priorityColor
        ? <div style={{ width: 5, height: 5, borderRadius: '50%', background: chip.priorityColor, flexShrink: 0 }} />
        : chip.emoji
          ? <span style={{ fontSize: 10, lineHeight: 1, flexShrink: 0 }}>{chip.emoji}</span>
          : <div style={{ width: 5, height: 5, borderRadius: '50%', background: chip.accent, flexShrink: 0 }} />}
      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: chip.accent, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, fontWeight: 500 }}>{chip.label}</span>
    </div>
  );
}

function ChipCard({ chip }: { chip: Chip }) {
  return (
    <div onClick={chip.onClick}
      draggable={!!chip.dragData}
      onDragStart={chip.dragData ? e => { e.dataTransfer.setData('text/plain', chip.dragData!); e.dataTransfer.effectAllowed = 'move'; e.stopPropagation(); } : undefined}
      style={{ display: 'flex', gap: 7, background: chip.bg, borderRadius: 8, padding: '7px 9px', cursor: chip.dragData ? 'grab' : 'pointer', borderLeft: `3px solid ${chip.accent}`, transition: 'filter 120ms' }}
      onMouseEnter={e => (e.currentTarget.style.filter = 'brightness(0.97)')}
      onMouseLeave={e => (e.currentTarget.style.filter = 'none')}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          {chip.priorityColor && <div style={{ width: 6, height: 6, borderRadius: '50%', background: chip.priorityColor, flexShrink: 0 }} />}
          {chip.emoji && <span style={{ fontSize: 12, lineHeight: 1, flexShrink: 0 }}>{chip.emoji}</span>}
          <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, color: chip.accent, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{chip.label}</span>
        </div>
        {(chip.allDay || chip.time || chip.subtitle) && (
          <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 10.5, color: '#787584', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {chip.allDay ? 'All day' : chip.time ? chip.time : ''}{chip.subtitle ? `${chip.allDay || chip.time ? ' · ' : ''}${chip.subtitle}` : ''}
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// Calendar screen
// ════════════════════════════════════════════════════════════════════
export default function CalendarScreen() {
  usePageTitle("Calendar");
  const isMobile = useMobile();
  const navigate = useNavigate();
  const workspaces = useWorkspaceStore(s => s.workspaces);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayIso = toIso(today);

  // ── Independent, all-workspace data (the calendar is not workspace-scoped) ──
  const [dashTasks, setDashTasks] = useState<Task[]>([]);
  const [lists, setLists] = useState<List[]>([]);
  const [timelines, setTimelines] = useState<Timeline[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);

  // View + workspace filter persist (localStorage) until logout / cache clear.
  const view = useUserPrefsStore(s => s.calendarView);
  const setView = useUserPrefsStore(s => s.setCalendarView);
  const hiddenWsArr = useUserPrefsStore(s => s.calendarHiddenWorkspaces);
  const hiddenWs = useMemo(() => new Set(hiddenWsArr), [hiddenWsArr]);
  const setHiddenWs = useCallback((next: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const cur = new Set(useUserPrefsStore.getState().calendarHiddenWorkspaces);
    const result = typeof next === 'function' ? next(cur) : next;
    useUserPrefsStore.getState().setCalendarHiddenWorkspaces([...result]);
  }, []);
  const [anchor, setAnchor] = useState<Date>(today);
  const [showFilter, setShowFilter] = useState(false);

  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [editingMeeting, setEditingMeeting] = useState<Meeting | null>(null);
  const [creatingMeeting, setCreatingMeeting] = useState<{ date: string } | null>(null);
  const [dayChooser, setDayChooser] = useState<string | null>(null);
  const [addingTaskDate, setAddingTaskDate] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [dragTaskId, setDragTaskId] = useState<number | null>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [showUnscheduled, setShowUnscheduled] = useState(false);
  const [mobileScheduleTask, setMobileScheduleTask] = useState<Task | null>(null);

  const filterRef = useRef<HTMLDivElement>(null);
  const unschedRef = useRef<HTMLDivElement>(null);
  const weekScrollRef = useRef<HTMLDivElement>(null);

  // ── Data loading ───────────────────────────────────────────────
  const loadData = useCallback(async () => {
    const [t, l, tl, m] = await Promise.all([
      apiGetTasks().catch(() => null),
      apiGetLists().catch(() => null),
      apiGetTimelines().catch(() => null),
      apiGetMeetings().catch(() => null),
    ]);
    if (t) setDashTasks(t.tasks.map(x => ({ ...x, id: Number(x.id) })));
    if (l) setLists(l.lists.map(li => ({ ...li, sections: li.sections.map(s => ({ ...s, tasks: s.tasks.map(tk => ({ ...tk, id: Number(tk.id) })) })) })));
    if (tl) setTimelines(tl.timelines.map(x => ({ ...x, milestones: x.milestones ?? [] })));
    if (m) setMeetings(m.meetings);
  }, []);

  // loadData only setStates after awaits (not synchronously), so the
  // set-state-in-effect heuristic is a false positive here.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadData(); }, [loadData]);

  // Revalidate on tab focus so changes made elsewhere show up.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') loadData(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadData]);

  // Close filter on outside click.
  useEffect(() => {
    if (!showFilter) return;
    const onClick = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setShowFilter(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showFilter]);

  // Close unscheduled popover on outside click.
  useEffect(() => {
    if (!showUnscheduled) return;
    const onClick = (e: MouseEvent) => {
      if (unschedRef.current && !unschedRef.current.contains(e.target as Node)) setShowUnscheduled(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showUnscheduled]);

  // Auto-scroll the Week time-grid to the morning when it opens.
  useEffect(() => {
    if (view === 'week' && weekScrollRef.current) {
      weekScrollRef.current.scrollTop = 7 * HOUR_H;
    }
  }, [view, anchor]);

  const wsVisible = useCallback((wsId?: string) => !wsId || !hiddenWs.has(wsId), [hiddenWs]);
  const toggleWs = (id: string) => setHiddenWs(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const allTasks = useMemo(() => getAllTasks(dashTasks, lists), [dashTasks, lists]);

  // ── Build chips per date ───────────────────────────────────────
  const chipsByDate = useMemo(() => {
    const map: Record<string, Chip[]> = {};
    const push = (d: string, c: Chip) => { (map[d] = map[d] || []).push(c); };

    for (const t of allTasks) {
      if (!t.deadline || t.checked) continue;
      if (!wsVisible(t.workspaceId)) continue;
      const s = parseMin(t.time);
      push(t.deadline, {
        key: `t-${t._listId}-${t.id}`, kind: 'task', date: t.deadline, time: t.time ?? null,
        label: t.title, accent: '#5e4dbb', bg: '#F5F3FF',
        priorityColor: t.priority ? PRIORITY_COLORS[t.priority] : undefined,
        subtitle: t._listName && t._listName !== 'Dashboard' ? t._listName : null,
        startMin: s ?? undefined, endMin: s != null ? s + 30 : undefined,
        dragData: String(t.id),
        onClick: () => setSelectedTask(t),
      });
    }

    for (const tl of timelines) {
      if (!wsVisible(tl.workspaceId)) continue;
      const accent = tl.color || DEFAULT_MILESTONE_COLOR;
      for (const m of tl.milestones) {
        if (!m.date || m.status === 'done') continue;
        const s = parseMin(m.time);
        push(m.date, {
          key: `m-${m.id}`, kind: 'milestone', date: m.date, time: m.time ?? null,
          label: m.title, accent, bg: tint(accent),
          emoji: m.emoji || tl.emoji || null, subtitle: tl.name,
          startMin: s ?? undefined, endMin: s != null ? s + 30 : undefined,
          onClick: () => navigate(`/timeline/${tl.id}`),
        });
      }
    }

    for (const mt of meetings) {
      const accent = mt.color || DEFAULT_MEETING_COLOR;
      const s = mt.allDay ? null : parseMin(mt.startTime);
      const e = mt.allDay ? null : (parseMin(mt.endTime) ?? (s != null ? s + 60 : null));
      push(mt.date, {
        key: `e-${mt.id}`, kind: 'meeting', date: mt.date, time: mt.allDay ? null : (mt.startTime ?? null),
        label: mt.title, accent, bg: tint(accent), allDay: mt.allDay, subtitle: mt.location || null,
        startMin: s ?? undefined, endMin: e ?? undefined,
        dragData: `meeting:${mt.id}`,
        onClick: () => setEditingMeeting(mt),
      });
    }

    for (const k in map) {
      map[k].sort((a, b) => {
        const ta = a.time ?? '', tb = b.time ?? '';
        if (ta === tb) return 0;
        if (!ta) return -1;
        if (!tb) return 1;
        return ta < tb ? -1 : 1;
      });
    }
    return map;
  }, [allTasks, timelines, meetings, wsVisible, navigate]);

  // ── Unscheduled tasks (panel) ──────────────────────────────────
  const unscheduled = allTasks.filter(t => !t.deadline && !t.checked && wsVisible(t.workspaceId));
  const filteredUnscheduled = search.trim() ? unscheduled.filter(t => t.title.toLowerCase().includes(search.toLowerCase())) : unscheduled;

  // ── Task mutations (direct API; mirrors store behavior, local state) ──
  const updateTaskLocal = (id: number, updates: Partial<Task>, source: 'dash' | 'list', listId?: string) => {
    if (source === 'dash') {
      setDashTasks(ts => ts.map(t => t.id === id ? { ...t, ...updates } : t));
    } else if (listId) {
      setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, sections: l.sections.map(s => ({ ...s, tasks: s.tasks.map(t => t.id === id ? { ...t, ...updates } : t) })) }));
    }
  };

  const saveTask = (id: number, updates: Partial<Task>) => {
    const t = allTasks.find(x => x.id === id);
    if (!t) return;
    updateTaskLocal(id, updates, t._source ?? 'dash', t._listId);
    if (t._source === 'dash') apiUpdateTask(id, updates).catch(() => loadData());
    else if (t._listId) apiUpdateListTask(t._listId, id, updates).catch(() => loadData());
  };

  const deleteTask = (id: number) => {
    const t = allTasks.find(x => x.id === id);
    if (!t) return;
    // Soft-delete: push a trash record, then remove the live row.
    apiAddToTrash(t.id, t, { src: t._source ?? 'dash', listId: t._listId, listName: t._listName }).catch(() => {});
    if (t._source === 'dash') {
      setDashTasks(ts => ts.filter(x => x.id !== id));
      apiDeleteTask(id).catch(() => loadData());
    } else if (t._listId) {
      const listId = t._listId;
      setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, sections: l.sections.map(s => ({ ...s, tasks: s.tasks.filter(x => x.id !== id) })) }));
      apiDeleteListTask(listId, id).catch(() => loadData());
    }
  };

  const assignDeadline = (taskId: number, iso: string) => saveTask(taskId, { deadline: iso });

  // Drop a task or meeting onto a day → set its date (date only, per design).
  const handleDayDrop = (iso: string, e: React.DragEvent) => {
    e.preventDefault();
    const data = e.dataTransfer.getData('text/plain');
    if (!data) return;
    if (data.startsWith('meeting:')) rescheduleMeeting(data.slice('meeting:'.length), iso);
    else { const id = Number(data); if (id) assignDeadline(id, iso); }
    setDragTaskId(null);
  };

  const handleAddToDate = async (title: string, destination: { type: 'dash' } | { type: 'list'; listId: string; sectionId: string }) => {
    const deadline = addingTaskDate ?? undefined;
    setAddingTaskDate(null);
    if (destination.type === 'dash') {
      const tempId = Date.now();
      const tempTask: Task = { id: tempId, title, checked: false, deadline };
      setDashTasks(ts => [...ts, tempTask]);
      try {
        const res = await apiCreateTask({ title, deadline });
        setDashTasks(ts => ts.map(t => t.id === tempId ? { ...tempTask, id: Number(res.task.id), workspaceId: res.task.workspaceId } : t));
      } catch { setDashTasks(ts => ts.filter(t => t.id !== tempId)); }
    } else {
      const { listId, sectionId } = destination;
      const list = lists.find(l => l.id === listId);
      const tempId = Date.now();
      const tempTask: Task = { id: tempId, title, checked: false, deadline, workspaceId: list?.workspaceId };
      setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, sections: l.sections.map(s => s.id !== sectionId ? s : { ...s, tasks: [...s.tasks, tempTask] }) }));
      try {
        const res = await apiAddListTask(listId, sectionId, { title, deadline });
        const saved: Task = { ...res.task, id: Number(res.task.id), workspaceId: list?.workspaceId };
        setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, sections: l.sections.map(s => s.id !== sectionId ? s : { ...s, tasks: s.tasks.map(t => t.id === tempId ? saved : t) }) }));
      } catch { setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, sections: l.sections.map(s => s.id !== sectionId ? s : { ...s, tasks: s.tasks.filter(t => t.id !== tempId) }) })); }
    }
  };

  // ── Meeting mutations ──────────────────────────────────────────
  const saveMeeting = async (data: Omit<Meeting, 'id' | 'createdAt' | 'updatedAt'>, id?: string) => {
    setEditingMeeting(null);
    setCreatingMeeting(null);
    if (id) {
      setMeetings(ms => ms.map(m => m.id === id ? { ...m, ...data } : m));
      apiUpdateMeeting(id, data).catch(() => loadData());
    } else {
      const tempId = `tmp_${Date.now()}`;
      const temp: Meeting = { id: tempId, ...data };
      setMeetings(ms => [...ms, temp]);
      try {
        const res = await apiCreateMeeting(data);
        setMeetings(ms => ms.map(m => m.id === tempId ? res.meeting : m));
      } catch { setMeetings(ms => ms.filter(m => m.id !== tempId)); }
    }
  };

  const deleteMeeting = (id: string) => {
    setEditingMeeting(null);
    setMeetings(ms => ms.filter(m => m.id !== id));
    apiDeleteMeeting(id).catch(() => loadData());
  };

  // Move a meeting to another day (keeps its time). Sends the full object
  // because the backend PUT replaces nullable fields.
  const rescheduleMeeting = (id: string, date: string) => {
    const m = meetings.find(x => x.id === id);
    if (!m || m.date === date) return;
    setMeetings(ms => ms.map(x => x.id === id ? { ...x, date } : x));
    apiUpdateMeeting(id, {
      title: m.title, date, allDay: m.allDay,
      startTime: m.startTime, endTime: m.endTime,
      location: m.location, description: m.description, color: m.color,
    }).catch(() => loadData());
  };

  // ── Period navigation ──────────────────────────────────────────
  const go = (dir: number) => setAnchor(a => {
    const d = new Date(a);
    if (view === 'month') d.setMonth(d.getMonth() + dir);
    else if (view === 'week') d.setDate(d.getDate() + dir * 7);
    else d.setFullYear(d.getFullYear() + dir);
    return d;
  });

  const periodLabel = (() => {
    if (view === 'month') return `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`;
    if (view === 'year') return String(anchor.getFullYear());
    const ws = startOfWeek(anchor);
    const we = new Date(ws); we.setDate(we.getDate() + 6);
    const sameMonth = ws.getMonth() === we.getMonth();
    return sameMonth
      ? `${MONTHS_SHORT[ws.getMonth()]} ${ws.getDate()} – ${we.getDate()}, ${we.getFullYear()}`
      : `${MONTHS_SHORT[ws.getMonth()]} ${ws.getDate()} – ${MONTHS_SHORT[we.getMonth()]} ${we.getDate()}, ${we.getFullYear()}`;
  })();

  const showPanel = view !== 'year';

  // ════════════════════════════════════════════════════════════════
  // Views
  // ════════════════════════════════════════════════════════════════
  const renderMonth = () => {
    const y = anchor.getFullYear(), mo = anchor.getMonth();
    const firstDay = new Date(y, mo, 1).getDay();
    const daysInMonth = new Date(y, mo + 1, 0).getDate();
    const daysInPrev = new Date(y, mo, 0).getDate();
    const cells: Array<{ date: Date; current: boolean }> = [];
    for (let i = firstDay - 1; i >= 0; i--) cells.push({ date: new Date(y, mo - 1, daysInPrev - i), current: false });
    for (let d = 1; d <= daysInMonth; d++) cells.push({ date: new Date(y, mo, d), current: true });
    while (cells.length < 42) cells.push({ date: new Date(y, mo + 1, cells.length - daysInMonth - firstDay + 1), current: false });

    return (
      <div style={{ flex: 1, overflow: 'auto', padding: '0 16px 16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 }}>
          {DAYS_SHORT.map(d => (
            <div key={d} style={{ textAlign: 'center', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 700, color: '#b0acbe', padding: '10px 0' }}>{d}</div>
          ))}
          {cells.map((cell, i) => {
            const iso = toIso(cell.date);
            const isToday = iso === todayIso;
            const chips = cell.current ? (chipsByDate[iso] ?? []) : [];
            const visible = chips.slice(0, 3);
            const overflow = chips.length - visible.length;
            return (
              <div key={i}
                onDragOver={e => { if (cell.current) e.preventDefault(); }}
                onDrop={e => { if (cell.current) handleDayDrop(iso, e); }}
                onClick={() => { if (cell.current) setDayChooser(iso); }}
                style={{ minHeight: isMobile ? 76 : 100, border: isToday ? '1.5px solid #c8bfff' : '1px solid #f1ecf6', background: isToday ? '#faf8ff' : cell.current ? '#fff' : '#fafafa', borderRadius: 6, padding: 4, transition: 'background 150ms', cursor: cell.current ? 'pointer' : 'default', position: 'relative' }}
                className="cal-cell">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, padding: '0 2px' }}>
                  <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: isToday ? 700 : 400, color: isToday ? '#5e4dbb' : cell.current ? '#1c1b22' : '#c9c4d5' }}>{cell.date.getDate()}</div>
                  {cell.current && (
                    <div className="cal-add-btn" style={{ width: 16, height: 16, borderRadius: '50%', background: '#5e4dbb', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0, transition: 'opacity 150ms', flexShrink: 0 }}>
                      <Icon name="add" size={11} color="#fff" />
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {visible.map(c => <ChipCompact key={c.key} chip={c} />)}
                  {overflow > 0 && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#787584', paddingLeft: 5 }}>+{overflow} more</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const renderWeek = () => {
    const ws = startOfWeek(anchor);
    const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(ws); d.setDate(d.getDate() + i); return d; });
    const gutter = isMobile ? 42 : 56;
    const gridCols = `${gutter}px repeat(7, 1fr)`;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();

    const dayData = days.map(d => {
      const iso = toIso(d);
      const chips = chipsByDate[iso] ?? [];
      const timed = chips.filter(c => c.startMin != null);
      const untimed = chips.filter(c => c.startMin == null);
      return { d, iso, isToday: iso === todayIso, timed, untimed, layout: layoutDay(timed) };
    });

    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Day headers */}
        <div style={{ display: 'grid', gridTemplateColumns: gridCols, borderBottom: '1px solid #f1ecf6', flexShrink: 0 }}>
          <div />
          {dayData.map(({ d, iso, isToday }) => (
            <div key={iso} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 4px', borderLeft: '1px solid #f4f1f9' }}>
              <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10.5, fontWeight: 700, color: '#b0acbe', textTransform: 'uppercase' }}>{DAYS_SHORT[d.getDay()]}</span>
              <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 700, color: isToday ? '#fff' : '#1c1b22', background: isToday ? '#5e4dbb' : 'transparent', borderRadius: '50%', width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{d.getDate()}</span>
            </div>
          ))}
        </div>

        {/* All-day / untimed row */}
        <div style={{ display: 'grid', gridTemplateColumns: gridCols, borderBottom: '1px solid #e8e4f0', flexShrink: 0, maxHeight: 132, overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', padding: '6px 6px 0', fontFamily: 'Inter, sans-serif', fontSize: 9, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase' }}>all-day</div>
          {dayData.map(({ iso, untimed }) => (
            <div key={iso}
              onDragOver={e => e.preventDefault()}
              onDrop={e => handleDayDrop(iso, e)}
              style={{ borderLeft: '1px solid #f4f1f9', padding: 4, display: 'flex', flexDirection: 'column', gap: 3, minHeight: 30 }}>
              {untimed.map(c => <ChipCard key={c.key} chip={c} />)}
            </div>
          ))}
        </div>

        {/* Time grid */}
        <div ref={weekScrollRef} style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: gridCols }}>
            {/* Hour gutter */}
            <div style={{ position: 'relative', height: 24 * HOUR_H }}>
              {HOURS.map(h => h === 0 ? null : (
                <div key={h} style={{ position: 'absolute', top: h * HOUR_H - 6, right: 6, fontFamily: 'Inter, sans-serif', fontSize: 9.5, color: '#b0acbe' }}>
                  {String(h).padStart(2, '0')}:00
                </div>
              ))}
            </div>
            {/* Day columns */}
            {dayData.map(({ iso, isToday, timed, layout }) => (
              <div key={iso}
                onClick={() => setDayChooser(iso)}
                onDragOver={e => e.preventDefault()}
                onDrop={e => handleDayDrop(iso, e)}
                style={{ position: 'relative', height: 24 * HOUR_H, borderLeft: '1px solid #f4f1f9', background: isToday ? '#fbfaff' : '#fff', cursor: 'pointer' }}>
                {HOURS.map(h => (
                  <div key={h} style={{ position: 'absolute', top: h * HOUR_H, left: 0, right: 0, borderTop: '1px solid #f4f1f9' }} />
                ))}
                {isToday && (
                  <div style={{ position: 'absolute', top: (nowMin / 60) * HOUR_H, left: 0, right: 0, height: 2, background: '#ef4444', zIndex: 3 }}>
                    <div style={{ position: 'absolute', left: -3, top: -3, width: 7, height: 7, borderRadius: '50%', background: '#ef4444' }} />
                  </div>
                )}
                {timed.map(c => {
                  const lay = layout.get(c) ?? { col: 0, cols: 1 };
                  const top = (c.startMin! / 60) * HOUR_H;
                  const height = Math.max(((c.endMin! - c.startMin!) / 60) * HOUR_H, 18);
                  const wPct = 100 / lay.cols;
                  return (
                    <div key={c.key}
                      onClick={e => { e.stopPropagation(); c.onClick(); }}
                      draggable={!!c.dragData}
                      onDragStart={c.dragData ? e => { e.dataTransfer.setData('text/plain', c.dragData!); e.dataTransfer.effectAllowed = 'move'; e.stopPropagation(); } : undefined}
                      title={c.label}
                      style={{ position: 'absolute', top: top + 1, height: height - 2, left: `calc(${lay.col * wPct}% + 2px)`, width: `calc(${wPct}% - 4px)`, background: c.bg, borderLeft: `3px solid ${c.accent}`, borderRadius: 5, padding: '2px 5px', overflow: 'hidden', cursor: c.dragData ? 'grab' : 'pointer', zIndex: 2 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        {c.priorityColor && <div style={{ width: 5, height: 5, borderRadius: '50%', background: c.priorityColor, flexShrink: 0 }} />}
                        {c.emoji && <span style={{ fontSize: 10, lineHeight: 1, flexShrink: 0 }}>{c.emoji}</span>}
                        <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: c.accent, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
                      </div>
                      {height > 30 && c.time && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 9.5, color: '#787584' }}>{c.time}</div>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const renderYear = () => {
    const y = anchor.getFullYear();
    return (
      <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 16 }}>
          {MONTHS.map((monthName, mo) => {
            const firstDay = new Date(y, mo, 1).getDay();
            const daysInMonth = new Date(y, mo + 1, 0).getDate();
            const cells: Array<Date | null> = [];
            for (let i = 0; i < firstDay; i++) cells.push(null);
            for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(y, mo, d));
            return (
              <div key={mo} style={{ border: '1px solid #f1ecf6', borderRadius: 12, padding: 10, background: '#fff' }}>
                <button onClick={() => { setAnchor(new Date(y, mo, 1)); setView('month'); }}
                  style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 700, color: '#5e4dbb', background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 0 8px', textAlign: 'left' }}>
                  {monthName}
                </button>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
                  {DAYS_MINI.map((d, i) => <div key={i} style={{ textAlign: 'center', fontFamily: 'Inter, sans-serif', fontSize: 9, fontWeight: 600, color: '#c9c4d5' }}>{d}</div>)}
                  {cells.map((d, i) => {
                    if (!d) return <div key={i} />;
                    const iso = toIso(d);
                    const isToday = iso === todayIso;
                    const chips = chipsByDate[iso] ?? [];
                    const dots = chips.slice(0, 3);
                    return (
                      <button key={i} onClick={() => { setAnchor(d); setView('month'); }}
                        style={{ aspectRatio: '1', border: 'none', background: isToday ? '#5e4dbb' : 'transparent', borderRadius: 6, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, padding: 0, transition: 'background 120ms' }}
                        onMouseEnter={e => { if (!isToday) e.currentTarget.style.background = '#F5F3FF'; }}
                        onMouseLeave={e => { if (!isToday) e.currentTarget.style.background = 'transparent'; }}>
                        <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10.5, fontWeight: isToday ? 700 : 400, color: isToday ? '#fff' : '#484552' }}>{d.getDate()}</span>
                        <div style={{ display: 'flex', gap: 1.5, height: 4, alignItems: 'center' }}>
                          {dots.map(c => <div key={c.key} style={{ width: 3.5, height: 3.5, borderRadius: '50%', background: isToday ? 'rgba(255,255,255,0.85)' : c.accent }} />)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ── View switcher segmented control ────────────────────────────
  const viewBtn = (v: typeof view, label: string) => (
    <button key={v} onClick={() => setView(v)}
      style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, color: view === v ? '#5e4dbb' : '#787584', background: view === v ? '#fff' : 'transparent', border: 'none', borderRadius: 7, padding: '6px 14px', cursor: 'pointer', boxShadow: view === v ? '0 1px 4px rgba(94,77,187,0.18)' : 'none', transition: 'all 150ms' }}>
      {label}
    </button>
  );

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: isMobile ? '12px 14px' : '14px 24px', borderBottom: '1px solid #E5E7EB', flexShrink: 0, flexWrap: 'wrap' }}>
          {/* Navigation */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={() => go(-1)} style={{ background: 'none', border: '1px solid #e8e4f0', borderRadius: 8, cursor: 'pointer', padding: '6px 9px', display: 'flex', alignItems: 'center' }}>
              <Icon name="chevron_left" size={18} color="#787584" />
            </button>
            <button onClick={() => go(1)} style={{ background: 'none', border: '1px solid #e8e4f0', borderRadius: 8, cursor: 'pointer', padding: '6px 9px', display: 'flex', alignItems: 'center' }}>
              <Icon name="chevron_right" size={18} color="#787584" />
            </button>
            <button onClick={() => setAnchor(new Date())}
              style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', border: 'none', borderRadius: 8, padding: '6px 14px', cursor: 'pointer' }}>
              Today
            </button>
          </div>
          <h2 style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: isMobile ? 15 : 18, fontWeight: 700, color: '#1c1b22', margin: 0 }}>{periodLabel}</h2>

          {/* Right cluster */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
            {/* View switcher */}
            <div style={{ display: 'flex', gap: 2, background: '#f1ecf6', borderRadius: 9, padding: 3 }}>
              {viewBtn('week', 'Week')}
              {viewBtn('month', 'Month')}
              {viewBtn('year', 'Year')}
            </div>

            {/* Workspace filter */}
            <div ref={filterRef} style={{ position: 'relative' }}>
              <button onClick={() => setShowFilter(v => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, color: hiddenWs.size > 0 ? '#5e4dbb' : '#787584', background: hiddenWs.size > 0 ? '#F5F3FF' : 'transparent', border: `1px solid ${hiddenWs.size > 0 ? '#c4b8f0' : '#e8e4f0'}`, borderRadius: 8, padding: '7px 12px', cursor: 'pointer', transition: 'all 150ms' }}>
                <Icon name="filter_list" size={16} color={hiddenWs.size > 0 ? '#5e4dbb' : '#787584'} />
                {!isMobile && 'Workspaces'}
                {hiddenWs.size > 0 && <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 700, color: '#fff', background: '#5e4dbb', borderRadius: 9999, padding: '1px 6px' }}>{Math.max(workspaces.length - hiddenWs.size, 0)}/{workspaces.length}</span>}
              </button>
              {showFilter && (
                <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 250, maxHeight: 360, overflowY: 'auto', background: '#fff', borderRadius: 14, border: '1px solid #E5E7EB', boxShadow: '0 8px 32px rgba(94,77,187,0.14)', zIndex: 400, animation: 'menuIn 160ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px 8px' }}>
                    <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#b0acbe' }}>Workspaces</span>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => setHiddenWs(new Set())} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#5e4dbb', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}>All</button>
                      <button onClick={() => setHiddenWs(new Set(workspaces.map(w => w.id)))} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#787584', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}>None</button>
                    </div>
                  </div>
                  <div style={{ padding: '0 8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {workspaces.length === 0 && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe', padding: '8px 8px 4px' }}>No workspaces</div>}
                    {workspaces.map(w => {
                      const on = !hiddenWs.has(w.id);
                      return (
                        <button key={w.id} onClick={() => toggleWs(w.id)}
                          style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 8px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', transition: 'background 120ms' }}
                          onMouseEnter={e => (e.currentTarget.style.background = '#F5F3FF')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          <div style={{ width: 18, height: 18, borderRadius: 5, border: `1.5px solid ${on ? '#5e4dbb' : '#cbc6d8'}`, background: on ? '#5e4dbb' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 120ms' }}>
                            {on && <Icon name="check" size={13} color="#fff" />}
                          </div>
                          {w.emoji && <span style={{ fontSize: 15, lineHeight: 1 }}>{w.emoji}</span>}
                          <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Unscheduled tasks — lightning popover (desktop) / bottom sheet (mobile) */}
            {showPanel && (
              <div ref={unschedRef} style={{ position: 'relative' }}>
                <button onClick={() => { if (isMobile) setMobileSidebarOpen(true); else setShowUnscheduled(v => !v); }}
                  title="Unscheduled tasks"
                  style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, color: showUnscheduled ? '#5e4dbb' : '#787584', background: showUnscheduled ? '#F5F3FF' : 'transparent', border: `1px solid ${showUnscheduled ? '#c4b8f0' : '#e8e4f0'}`, borderRadius: 8, padding: '7px 12px', cursor: 'pointer', transition: 'all 150ms' }}>
                  <Icon name="bolt" size={16} color={showUnscheduled ? '#5e4dbb' : '#787584'} />
                  {!isMobile && 'Unscheduled'}
                  {unscheduled.length > 0 && <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 700, color: '#fff', background: '#5e4dbb', borderRadius: 9999, padding: '1px 6px' }}>{unscheduled.length}</span>}
                </button>
                {!isMobile && showUnscheduled && (
                  <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 280, maxHeight: '60vh', display: 'flex', flexDirection: 'column', background: '#fff', borderRadius: 14, border: '1px solid #E5E7EB', boxShadow: '0 8px 32px rgba(94,77,187,0.14)', zIndex: 400, animation: 'menuIn 160ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}>
                    <div style={{ padding: '12px 14px 8px', borderBottom: '1px solid #f0ecf8', flexShrink: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                        <Icon name="bolt" size={15} color="#5e4dbb" />
                        <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#b0acbe' }}>Unscheduled</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#faf9ff', borderRadius: 8, padding: '6px 10px', border: '1px solid #e8e4f0' }}>
                        <Icon name="search" size={13} color="#787584" />
                        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
                          style={{ background: 'transparent', border: 'none', outline: 'none', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#1c1b22', flex: 1 }} />
                      </div>
                      <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 10.5, color: '#b0acbe', marginTop: 7 }}>Drag a task onto a day to schedule it.</div>
                    </div>
                    <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px' }}>
                      {filteredUnscheduled.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '20px 8px', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe' }}>All tasks scheduled!</div>
                      ) : (
                        filteredUnscheduled.map(t => (
                          <div key={`${t._listId}-${t.id}`} draggable
                            onDragStart={e => { e.dataTransfer.setData('text/plain', String(t.id)); e.dataTransfer.effectAllowed = 'move'; setDragTaskId(t.id); }}
                            onDragEnd={() => setDragTaskId(null)}
                            onClick={() => setSelectedTask(t)}
                            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, background: '#fff', border: '1px solid #e8e4f0', marginBottom: 4, cursor: 'grab', transition: 'all 150ms', opacity: dragTaskId === t.id ? 0.4 : 1 }}
                            onMouseEnter={e => (e.currentTarget.style.borderColor = '#9d8dff')}
                            onMouseLeave={e => (e.currentTarget.style.borderColor = '#e8e4f0')}>
                            <Icon name="drag_indicator" size={15} color="#c9c4d5" />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12.5, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
                              {t._listName && t._listName !== 'Dashboard' && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#787584' }}>{t._listName}</div>}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* New meeting */}
            <button onClick={() => setCreatingMeeting({ date: view === 'year' ? todayIso : toIso(anchor) })}
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, color: '#fff', background: '#5e4dbb', border: 'none', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', boxShadow: '0 2px 8px rgba(94,77,187,0.25)', transition: 'background 150ms' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#4d3da8')}
              onMouseLeave={e => (e.currentTarget.style.background = '#5e4dbb')}>
              <Icon name="add" size={16} color="#fff" />
              {isMobile ? 'Meeting' : 'New Meeting'}
            </button>
          </div>
        </div>

        {/* Body */}
        {view === 'month' ? renderMonth() : view === 'week' ? renderWeek() : renderYear()}
      </div>

      {/* Unscheduled tasks — mobile bottom sheet (opened from the ⚡ toolbar button) */}
      {isMobile && showPanel && mobileSidebarOpen && (
        <>
          <div onClick={() => setMobileSidebarOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.28)', backdropFilter: 'blur(2px)', animation: 'backdropIn 180ms ease both' }} />
          <div className="safe-bottom" style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 201, background: '#f7f2fc', borderRadius: '16px 16px 0 0', maxHeight: '65vh', display: 'flex', flexDirection: 'column', animation: 'slideUp 260ms cubic-bezier(0.22,1,0.36,1) both', boxShadow: '0 -4px 24px rgba(0,0,0,0.12)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 16px 10px', borderBottom: '1px solid #e8e4f0', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name="bolt" size={15} color="#5e4dbb" />
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#b0acbe' }}>Unscheduled</div>
              </div>
              <button onClick={() => setMobileSidebarOpen(false)} style={{ width: 30, height: 30, borderRadius: '50%', background: '#f1ecf6', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="close" size={15} color="#484552" />
              </button>
            </div>
            <div style={{ padding: '8px 12px 6px', borderBottom: '1px solid #e8e4f0', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', borderRadius: 8, padding: '6px 10px', border: '1px solid #e8e4f0' }}>
                <Icon name="search" size={13} color="#787584" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
                  style={{ background: 'transparent', border: 'none', outline: 'none', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#1c1b22', flex: 1 }} />
              </div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', marginTop: 7 }}>Tap a task to schedule it.</div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
              {filteredUnscheduled.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '24px 8px', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe' }}>All tasks scheduled!</div>
              ) : filteredUnscheduled.map(t => (
                <div key={`${t._listId}-${t.id}`} onClick={() => setMobileScheduleTask(t)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 8, background: '#fff', border: '1px solid #e8e4f0', marginBottom: 6, cursor: 'pointer' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#1c1b22', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
                    {t._listName && t._listName !== 'Dashboard' && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584' }}>{t._listName}</div>}
                  </div>
                  <Icon name="event_available" size={17} color="#5e4dbb" />
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Mobile: pick a date to schedule a tapped task */}
      {mobileScheduleTask && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)', animation: 'backdropIn 180ms ease both' }}
          onClick={() => setMobileScheduleTask(null)}>
          <div onClick={e => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <div style={{ background: '#fff', borderRadius: 12, padding: '10px 16px', boxShadow: '0 4px 16px rgba(0,0,0,0.12)', maxWidth: 280 }}>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 700, color: '#1c1b22', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Schedule “{mobileScheduleTask.title}”</div>
            </div>
            <CalendarPicker value={mobileScheduleTask.deadline}
              onChange={d => { assignDeadline(mobileScheduleTask.id, d); setMobileScheduleTask(null); }} />
          </div>
        </div>
      )}

      {/* Modals */}
      {selectedTask && (
        <TaskDialog task={selectedTask} onUpdate={saveTask} onDelete={deleteTask} onClose={() => setSelectedTask(null)} />
      )}
      {dayChooser && (
        <DayAddChooser date={dayChooser}
          onTask={() => { setAddingTaskDate(dayChooser); setDayChooser(null); }}
          onMeeting={() => { setCreatingMeeting({ date: dayChooser }); setDayChooser(null); }}
          onClose={() => setDayChooser(null)} />
      )}
      {addingTaskDate && (
        <AddToDateModal date={addingTaskDate} lists={lists} onAdd={handleAddToDate} onClose={() => setAddingTaskDate(null)} />
      )}
      {(creatingMeeting || editingMeeting) && (
        <MeetingModal
          initial={editingMeeting}
          presetDate={creatingMeeting?.date}
          onSave={saveMeeting}
          onDelete={editingMeeting ? deleteMeeting : undefined}
          onClose={() => { setCreatingMeeting(null); setEditingMeeting(null); }} />
      )}

      <style>{`.cal-cell:hover .cal-add-btn { opacity: 1 !important; }`}</style>
    </div>
  );
}
