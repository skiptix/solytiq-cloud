import { usePageTitle } from "../hooks/usePageTitle";
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { Task, List, Timeline, Meeting, MeetingRecurrenceRule } from '../types';
import {
  apiGetTasks, apiGetLists, apiGetTimelines, apiGetMeetings,
  apiCreateTask, apiAddListTask, apiUpdateTask, apiUpdateListTask,
  apiDeleteTask, apiDeleteListTask, apiAddToTrash,
  apiCreateMeeting, apiUpdateMeeting, apiDeleteMeeting, apiLeaveMeeting,
} from '../api/client';
import useWorkspaceStore from '../store/useWorkspaceStore';
import useUserPrefsStore from '../store/useUserPrefsStore';
import useSyncStore from '../store/useSyncStore';
import useMembersStore from '../store/useMembersStore';
import useAuthStore from '../store/useAuthStore';
import TaskDialog from '../components/TaskDialog';
import CalendarPicker from '../components/CalendarPicker';
import TimePicker from '../components/TimePicker';
import NotesEditor from '../components/NotesEditor';
import MarkdownView from '../components/MarkdownView';
import Icon from '../components/Icon';
import ContextMenu, { type ContextMenuEntry } from '../components/ContextMenu';
import { useMobile } from '../hooks/useBreakpoint';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// Indexed by JS getDay() (0 = Sunday) — used to label a column from its real weekday.
const DAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
// Header rows, in Monday-first display order (weeks start on Monday).
const WEEK_HEADER = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const DAYS_MINI = ['M','T','W','T','F','S','S'];

/** JS weekday (0 = Sun) → Monday-first index (0 = Mon … 6 = Sun). */
function monIndex(jsDay: number): number { return (jsDay + 6) % 7; }
const PRIORITY_COLORS: Record<string, string> = { High: 'var(--color-orange)', Medium: 'var(--color-warning-alt)', Low: 'var(--color-text-tertiary)' };

// Curated, saturated palette for meetings — readable as chip text and on-brand.
const MEETING_COLORS = ['var(--color-primary)', 'var(--color-blue-mid-4)', 'var(--color-blue-mid-6)', 'var(--color-success)', 'var(--color-warning-alt)', 'var(--color-red-mid-2)', 'var(--color-pink-mid-2)', 'var(--color-purple-mid-3)'];
const DEFAULT_MEETING_COLOR = 'var(--color-blue-mid-4)';
const DEFAULT_MILESTONE_COLOR = 'var(--color-blue-mid-6)';
// Event families the Calendar filter can toggle.
const KIND_META: Array<{ id: 'meeting' | 'task' | 'milestone'; label: string; icon: string }> = [
  { id: 'meeting', label: 'Meetings', icon: 'event' },
  { id: 'task', label: 'Task deadlines', icon: 'task_alt' },
  { id: 'milestone', label: 'Milestones', icon: 'flag' },
];

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
  if (!hex || !/^#?[0-9a-fA-F]{6}$/.test(hex.replace('#', ''))) return 'var(--color-surface-tint)';
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function startOfWeek(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  r.setDate(r.getDate() - monIndex(r.getDay()));
  return r;
}

/** Minutes since midnight → "HH:MM" (clamped to a valid 00:00–23:59). */
function minToStr(min: number): string {
  const clamped = Math.max(0, Math.min(1439, Math.round(min)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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
  contextItems?: ContextMenuEntry[]; // right-click menu — omitted disables the menu
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
  presetStart?: string;          // pre-fill start time (from a week-grid drag)
  presetEnd?: string;            // pre-fill end time (from a week-grid drag)
  seriesCount?: number;          // when editing: how many meetings share initial.recurrenceId
  onSave: (data: Omit<Meeting, 'id' | 'createdAt' | 'updatedAt'>, id?: string, repeat?: MeetingRecurrenceRule, inviteeIds?: string[]) => void;
  onDelete?: (id: string, opts?: { series?: boolean }) => void;
  onClose: () => void;
}

function memberInitials(fullName: string | null | undefined, username: string): string {
  return (fullName || username || 'U').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

/** Small inline avatar for a member id — initials fallback, lazy-loaded photo. */
function MemberAvatar({ userId, size = 20 }: { userId: string; size?: number }) {
  const member = useMembersStore(s => s.members[userId]);
  const avatar = useMembersStore(s => s.avatars[userId]);
  const ensureAvatar = useMembersStore(s => s.ensureAvatar);
  useEffect(() => { if (member?.hasImage) ensureAvatar(userId); }, [userId, member?.hasImage, ensureAvatar]);
  if (!member) return null;
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, overflow: 'hidden', background: 'linear-gradient(135deg, var(--color-accent-purple-light) 0%, var(--color-primary) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {avatar
        ? <img src={avatar} alt={member.username} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : <span style={{ fontFamily: 'var(--font-heading)', fontSize: size * 0.4, fontWeight: 700, color: 'var(--color-white)' }}>{memberInitials(member.fullName, member.username)}</span>}
    </div>
  );
}

type RepeatPreset = 'none' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly' | 'custom';

const REPEAT_PRESETS: Array<{ value: RepeatPreset; label: string }> = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Every month' },
  { value: 'quarterly', label: 'Every quarter' },
  { value: 'yearly', label: 'Every year' },
  { value: 'custom', label: 'Custom…' },
];

/** Map a UI repeat preset to the (freq, interval) pair the backend expects. */
function repeatPresetToRule(preset: RepeatPreset, customDays: number, count: number): MeetingRecurrenceRule | undefined {
  if (preset === 'none') return undefined;
  const clampedCount = Math.max(2, Math.min(104, Math.floor(count) || 2));
  switch (preset) {
    case 'daily': return { freq: 'daily', interval: 1, count: clampedCount };
    case 'weekly': return { freq: 'weekly', interval: 1, count: clampedCount };
    case 'biweekly': return { freq: 'weekly', interval: 2, count: clampedCount };
    case 'monthly': return { freq: 'monthly', interval: 1, count: clampedCount };
    case 'quarterly': return { freq: 'monthly', interval: 3, count: clampedCount };
    case 'yearly': return { freq: 'yearly', interval: 1, count: clampedCount };
    case 'custom': return { freq: 'daily', interval: Math.max(1, Math.min(365, Math.floor(customDays) || 1)), count: clampedCount };
  }
}

type PopoverKind = 'date' | 'start' | 'end' | 'repeat' | 'invite';

function MeetingModal({ initial, presetDate, presetStart, presetEnd, seriesCount, onSave, onDelete, onClose }: MeetingModalProps) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [date, setDate] = useState(initial?.date ?? presetDate ?? toIso(new Date()));
  const [allDay, setAllDay] = useState(initial?.allDay ?? false);
  const [startTime, setStartTime] = useState<string>(initial?.startTime ?? presetStart ?? '');
  const [endTime, setEndTime] = useState<string>(initial?.endTime ?? presetEnd ?? '');
  const [location, setLocation] = useState(initial?.location ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [color, setColor] = useState(initial?.color ?? DEFAULT_MEETING_COLOR);
  const [repeatPreset, setRepeatPreset] = useState<RepeatPreset>('none');
  const [customDays, setCustomDays] = useState(3);
  const [repeatCount, setRepeatCount] = useState(10);
  const [inviteeIds, setInviteeIds] = useState<string[]>(initial?.attendeeIds ?? []);
  const [inviteSearch, setInviteSearch] = useState('');
  const currentUserId = useAuthStore(s => s.userId);
  const allMembers = useMembersStore(s => s.members);
  const inviteCandidates = useMemo(
    () => Object.values(allMembers).filter(m => m.id !== currentUserId),
    [allMembers, currentUserId]
  );
  const [showDelete, setShowDelete] = useState(false);
  const [deleteWholeSeries, setDeleteWholeSeries] = useState(false);

  // Date/Start/End/Repeat popovers are portaled to <body> and positioned from
  // the trigger button's rect — they must escape this modal's scrollable,
  // overflow-hidden body or they get visually clipped (see MeetingModal card).
  const [popover, setPopover] = useState<PopoverKind | null>(null);
  const [popPos, setPopPos] = useState<{ top: number; left?: number; right?: number }>({ top: 0 });
  const dateBtnRef = useRef<HTMLButtonElement>(null);
  const startBtnRef = useRef<HTMLButtonElement>(null);
  const endBtnRef = useRef<HTMLButtonElement>(null);
  const repeatBtnRef = useRef<HTMLButtonElement>(null);
  const inviteBtnRef = useRef<HTMLButtonElement>(null);

  const openPopover = (kind: PopoverKind, btnRef: React.RefObject<HTMLButtonElement | null>, align: 'left' | 'right' = 'left') => {
    setPopover(p => {
      if (p === kind) return null;
      const rect = btnRef.current?.getBoundingClientRect();
      if (rect) {
        setPopPos(align === 'right'
          ? { top: rect.bottom + 6, right: window.innerWidth - rect.right }
          : { top: rect.bottom + 6, left: rect.left });
      }
      return kind;
    });
  };

  const canSave = title.trim().length > 0 && !!date;
  const isRecurringSeries = !!initial?.recurrenceId && (seriesCount ?? 0) > 1;

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (popover) setPopover(null); else onClose(); } };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose, popover]);

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
    }, initial?.id, initial ? undefined : repeatPresetToRule(repeatPreset, customDays, repeatCount), inviteeIds);
  };

  const friendlyDate = date
    ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    : 'Pick a date';

  const repeatLabel = REPEAT_PRESETS.find(p => p.value === repeatPreset)?.label ?? 'Does not repeat';
  const repeatSummary = repeatPreset === 'none' ? repeatLabel
    : repeatPreset === 'custom' ? `Every ${customDays} day${customDays === 1 ? '' : 's'}, ${repeatCount}x`
    : `${repeatLabel}, ${repeatCount}x`;

  const labelStyle = { fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600 as const, color: 'var(--color-text-secondary)', marginBottom: 6, display: 'block' };
  const triggerStyle = (active: boolean) => ({
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 12px', borderRadius: 8,
    border: `1.5px solid ${active ? 'var(--color-primary)' : 'var(--color-border-alt)'}`, background: active ? 'var(--color-surface-tint)' : 'var(--color-white)',
    cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)', textAlign: 'left' as const, boxSizing: 'border-box' as const,
  });

  // Portaled to <body> — CalendarScreen is a routed screen, and its
  // `.page-transition` wrapper (App.tsx) is left with a non-`none` transform
  // after the pageIn animation, making it a containing block for `position:
  // fixed` descendants. Without the portal, this modal's backdrop is
  // clipped to that wrapper and never covers the Sidebar/TopBar.
  return createPortal(
    // Guard on e.target (not just onClick={onClose}) — the Date/Start/End/Repeat
    // popovers below are portaled to document.body, so their clicks are DOM-detached
    // from this backdrop but still bubble through the React tree to this handler.
    // Checking e.target === e.currentTarget makes sure only an actual backdrop
    // click (not a portaled descendant's) closes the modal.
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.18)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)', animation: 'backdropIn 180ms ease both' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--color-white)', borderRadius: 18, width: '100%', maxWidth: 480, maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 40px rgba(var(--color-primary-rgb), 0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}
        onClick={e => e.stopPropagation()}>
        {/* Accent stripe + header */}
        <div style={{ height: 5, background: color, flexShrink: 0 }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px 12px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 34, height: 34, borderRadius: 10, background: tint(color, 0.16), display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Icon name="event" size={19} color={color} />
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)' }}>
              {initial ? 'Edit Meeting' : 'New Meeting'}
            </div>
          </div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: '50%', border: 'none', background: 'var(--color-surface-tint-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={16} color="var(--color-text-tertiary)" />
          </button>
        </div>

        <div style={{ padding: '4px 24px 8px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Title */}
          <div>
            <label style={labelStyle}>Title</label>
            <input autoFocus value={title} onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && canSave) handleSave(); }}
              placeholder="Meeting title"
              style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-primary)', background: 'transparent', border: 'none', borderBottom: '1.5px solid var(--color-border-alt)', padding: '7px 0', outline: 'none', boxSizing: 'border-box' }}
              onFocus={e => (e.target.style.borderBottomColor = 'var(--color-primary)')}
              onBlur={e => (e.target.style.borderBottomColor = 'var(--color-border-alt)')} />
          </div>

          {/* Date */}
          <div>
            <label style={labelStyle}>Date</label>
            <button ref={dateBtnRef} onClick={() => openPopover('date', dateBtnRef)} style={triggerStyle(popover === 'date')}>
              <Icon name="calendar_today" size={15} color={date ? 'var(--color-primary)' : 'var(--color-text-quaternary)'} />
              <span style={{ flex: 1 }}>{friendlyDate}</span>
            </button>
          </div>

          {/* All-day toggle */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none' }}
            onClick={() => setAllDay(v => !v)}>
            <div style={{ width: 38, height: 22, borderRadius: 9999, background: allDay ? 'var(--color-primary)' : 'var(--color-purple-tint-4)', position: 'relative', transition: 'background 180ms', flexShrink: 0 }}>
              <div style={{ position: 'absolute', top: 2, left: allDay ? 18 : 2, width: 18, height: 18, borderRadius: '50%', background: 'var(--color-white)', transition: 'left 180ms', boxShadow: '0 1px 3px rgba(var(--color-black-rgb), 0.2)' }} />
            </div>
            <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>All-day</span>
          </label>

          {/* Times */}
          {!allDay && (
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Starts</label>
                <button ref={startBtnRef} onClick={() => openPopover('start', startBtnRef)} style={triggerStyle(popover === 'start')}>
                  <Icon name="schedule" size={15} color={startTime ? 'var(--color-primary)' : 'var(--color-text-quaternary)'} />
                  <span style={{ flex: 1 }}>{startTime || '--:--'}</span>
                </button>
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Ends</label>
                <button ref={endBtnRef} onClick={() => openPopover('end', endBtnRef, 'right')} style={triggerStyle(popover === 'end')}>
                  <Icon name="schedule" size={15} color={endTime ? 'var(--color-primary)' : 'var(--color-text-quaternary)'} />
                  <span style={{ flex: 1 }}>{endTime || '--:--'}</span>
                </button>
              </div>
            </div>
          )}

          {/* Repeat — only offered when creating; editing only touches this one occurrence */}
          {!initial && (
            <div>
              <label style={labelStyle}>Repeat</label>
              <button ref={repeatBtnRef} onClick={() => openPopover('repeat', repeatBtnRef)} style={triggerStyle(popover === 'repeat')}>
                <Icon name="repeat" size={15} color={repeatPreset !== 'none' ? 'var(--color-primary)' : 'var(--color-text-quaternary)'} />
                <span style={{ flex: 1 }}>{repeatSummary}</span>
              </button>
            </div>
          )}
          {initial && isRecurringSeries && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--color-surface-tint)', borderRadius: 8, padding: '8px 12px' }}>
              <Icon name="repeat" size={15} color="var(--color-primary)" />
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-primary)' }}>
                Part of a repeating series ({seriesCount} events)
              </span>
            </div>
          )}

          {/* Invite — other instance users; an invited meeting appears on their calendar too */}
          <div>
            <label style={labelStyle}>Invite</label>
            <button ref={inviteBtnRef} onClick={() => openPopover('invite', inviteBtnRef)} style={triggerStyle(popover === 'invite')}>
              <Icon name="person_add" size={15} color={inviteeIds.length > 0 ? 'var(--color-primary)' : 'var(--color-text-quaternary)'} />
              <span style={{ flex: 1 }}>{inviteeIds.length > 0 ? `${inviteeIds.length} invited` : 'Invite others'}</span>
            </button>
            {inviteeIds.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {inviteeIds.map(id => (
                  <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--color-surface-tint)', borderRadius: 9999, padding: '3px 8px 3px 3px' }}>
                    <MemberAvatar userId={id} size={18} />
                    <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-primary)', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {allMembers[id]?.fullName || allMembers[id]?.username || '…'}
                    </span>
                    <button onClick={() => setInviteeIds(ids => ids.filter(x => x !== id))}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}>
                      <Icon name="close" size={11} color="var(--color-accent-purple-light)" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Location */}
          <div>
            <label style={labelStyle}>Location</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1.5px solid var(--color-border-alt)', borderRadius: 8, padding: '9px 12px' }}>
              <Icon name="location_on" size={15} color="var(--color-text-quaternary)" />
              <input value={location} onChange={e => setLocation(e.target.value)} placeholder="Add a location"
                style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)', background: 'transparent', border: 'none', outline: 'none' }} />
            </div>
          </div>

          {/* Color */}
          <div>
            <label style={labelStyle}>Color</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {MEETING_COLORS.map(c => (
                <button key={c} onClick={() => setColor(c)}
                  style={{ width: 28, height: 28, borderRadius: '50%', background: c, border: color === c ? '2.5px solid var(--color-text-primary)' : '2.5px solid transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 120ms' }}>
                  {color === c && <Icon name="check" size={14} color="var(--color-white)" />}
                </button>
              ))}
            </div>
          </div>

          {/* Notes — same Markdown editor+preview as items/milestones */}
          <NotesEditor value={description} onChange={setDescription} minHeight={100} />
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 24px 20px', borderTop: '1px solid var(--color-surface-tint)', flexShrink: 0 }}>
          {initial && onDelete && (
            <button onClick={() => setShowDelete(true)}
              style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-error)', background: 'var(--color-error-bg-alt)', border: '1px solid var(--color-error-bg)', borderRadius: 8, padding: '9px 16px', cursor: 'pointer', marginRight: 'auto' }}>
              Delete
            </button>
          )}
          <button onClick={onClose} style={{ marginLeft: initial && onDelete ? 0 : 'auto', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '9px 20px', cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleSave} disabled={!canSave}
            style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: canSave ? 'var(--color-primary)' : 'var(--color-border-strong)', border: 'none', borderRadius: 8, padding: '9px 22px', cursor: canSave ? 'pointer' : 'not-allowed', transition: 'all 180ms' }}>
            {initial ? 'Save' : 'Add Meeting'}
          </button>
        </div>

        {showDelete && initial && onDelete && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(var(--color-black-rgb), 0.25)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'backdropIn 160ms ease both' }}
            onClick={() => setShowDelete(false)}>
            <div style={{ background: 'var(--color-white)', borderRadius: 14, padding: '22px 24px', maxWidth: 340, boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.18)', animation: 'modalIn 240ms cubic-bezier(0.34,1.56,0.64,1) both' }}
              onClick={e => e.stopPropagation()}>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 6 }}>Delete this meeting?</div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', marginBottom: isRecurringSeries ? 12 : 18 }}>This can't be undone.</div>
              {isRecurringSeries && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }} onClick={() => setDeleteWholeSeries(false)}>
                    <div style={{ width: 16, height: 16, borderRadius: '50%', border: `1.5px solid ${!deleteWholeSeries ? 'var(--color-primary)' : 'var(--color-purple-tint-7)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {!deleteWholeSeries && <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-primary)' }} />}
                    </div>
                    <span style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-primary)' }}>Just this event</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }} onClick={() => setDeleteWholeSeries(true)}>
                    <div style={{ width: 16, height: 16, borderRadius: '50%', border: `1.5px solid ${deleteWholeSeries ? 'var(--color-primary)' : 'var(--color-purple-tint-7)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {deleteWholeSeries && <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-primary)' }} />}
                    </div>
                    <span style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-primary)' }}>All {seriesCount} events in the series</span>
                  </label>
                </div>
              )}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button onClick={() => setShowDelete(false)} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '8px 16px', cursor: 'pointer' }}>Cancel</button>
                <button onClick={() => { onDelete(initial.id, { series: deleteWholeSeries }); }} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-error)', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer' }}>Delete</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Date/Time/Repeat popovers — portaled to <body> so position:fixed is
          relative to the viewport, not this modal's scrollable body. */}
      {popover === 'date' && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 1350 }} onClick={() => setPopover(null)} />
          <div style={{ position: 'fixed', top: popPos.top, left: popPos.left, right: popPos.right, zIndex: 1400 }}>
            <CalendarPicker value={date} onChange={v => { setDate(v); setPopover(null); }} />
          </div>
        </>, document.body
      )}
      {popover === 'start' && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 1350 }} onClick={() => setPopover(null)} />
          <div style={{ position: 'fixed', top: popPos.top, left: popPos.left, right: popPos.right, zIndex: 1400 }}>
            <TimePicker value={startTime} onChange={v => { setStartTime(v); setPopover(null); }} onClear={() => { setStartTime(''); setPopover(null); }} />
          </div>
        </>, document.body
      )}
      {popover === 'end' && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 1350 }} onClick={() => setPopover(null)} />
          <div style={{ position: 'fixed', top: popPos.top, left: popPos.left, right: popPos.right, zIndex: 1400 }}>
            <TimePicker value={endTime} onChange={v => { setEndTime(v); setPopover(null); }} onClear={() => { setEndTime(''); setPopover(null); }} />
          </div>
        </>, document.body
      )}
      {popover === 'repeat' && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 1350 }} onClick={() => setPopover(null)} />
          <div style={{ position: 'fixed', top: popPos.top, left: popPos.left, right: popPos.right, zIndex: 1400 }}>
            <RepeatPopover
              preset={repeatPreset} onPresetChange={setRepeatPreset}
              customDays={customDays} onCustomDaysChange={setCustomDays}
              count={repeatCount} onCountChange={setRepeatCount}
              onDone={() => setPopover(null)} />
          </div>
        </>, document.body
      )}
      {popover === 'invite' && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 1350 }} onClick={() => setPopover(null)} />
          <div style={{ position: 'fixed', top: popPos.top, left: popPos.left, right: popPos.right, zIndex: 1400 }}>
            <InvitePopover
              candidates={inviteCandidates}
              search={inviteSearch} onSearchChange={setInviteSearch}
              selectedIds={inviteeIds}
              onToggle={id => setInviteeIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id])}
              onDone={() => setPopover(null)} />
          </div>
        </>, document.body
      )}
    </div>,
    document.body
  );
}

// ════════════════════════════════════════════════════════════════════
// Invite picker — searchable list of other instance users to invite onto
// a meeting. Matches the CalendarPicker/TimePicker/RepeatPopover chrome.
// ════════════════════════════════════════════════════════════════════
interface InvitePopoverProps {
  candidates: Array<{ id: string; username: string; fullName: string | null }>;
  search: string;
  onSearchChange: (v: string) => void;
  selectedIds: string[];
  onToggle: (id: string) => void;
  onDone: () => void;
}

function InvitePopover({ candidates, search, onSearchChange, selectedIds, onToggle, onDone }: InvitePopoverProps) {
  const filtered = search.trim()
    ? candidates.filter(m => (m.fullName || m.username).toLowerCase().includes(search.trim().toLowerCase()))
    : candidates;

  return (
    <div style={{ background: 'var(--color-white)', border: '1px solid var(--color-border-alt)', borderRadius: 12, boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.14)', padding: '10px', width: Math.min(260, window.innerWidth - 32), transformOrigin: 'top center', animation: 'menuIn 180ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--color-surface-tint-3)', borderRadius: 8, padding: '6px 10px', border: '1px solid var(--color-border)', marginBottom: 8 }}>
        <Icon name="search" size={13} color="var(--color-text-tertiary)" />
        <input autoFocus value={search} onChange={e => onSearchChange(e.target.value)} placeholder="Search people…"
          style={{ background: 'transparent', border: 'none', outline: 'none', fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-primary)', flex: 1 }} />
      </div>

      <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {filtered.length === 0 && (
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', padding: '8px 4px', textAlign: 'center' }}>No matches</div>
        )}
        {filtered.map(m => {
          const active = selectedIds.includes(m.id);
          return (
            <button key={m.id} onClick={() => onToggle(m.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 8, border: 'none', background: active ? 'var(--color-surface-tint)' : 'transparent', cursor: 'pointer', textAlign: 'left', transition: 'background 120ms' }}
              onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--color-purple-pale-5)'; }}
              onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
              <MemberAvatar userId={m.id} size={22} />
              <span style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: active ? 600 : 400, color: active ? 'var(--color-primary)' : 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.fullName || m.username}
              </span>
              {active && <Icon name="check" size={15} color="var(--color-primary)" />}
            </button>
          );
        })}
      </div>

      <button onClick={onDone}
        style={{ width: '100%', marginTop: 10, fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-primary)', border: 'none', borderRadius: 7, padding: '8px 0', cursor: 'pointer' }}>
        Done
      </button>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// Repeat picker — presets (daily/weekly/biweekly/monthly/quarterly/yearly)
// plus a custom "every N days" option and a total-occurrence count.
// Matches CalendarPicker/TimePicker chrome so the three feel like one family.
// ════════════════════════════════════════════════════════════════════
interface RepeatPopoverProps {
  preset: RepeatPreset;
  onPresetChange: (p: RepeatPreset) => void;
  customDays: number;
  onCustomDaysChange: (n: number) => void;
  count: number;
  onCountChange: (n: number) => void;
  onDone: () => void;
}

function RepeatPopover({ preset, onPresetChange, customDays, onCustomDaysChange, count, onCountChange, onDone }: RepeatPopoverProps) {
  const stepper = (value: number, onChange: (n: number) => void, min: number, max: number) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button onClick={() => onChange(Math.max(min, value - 1))}
        style={{ width: 26, height: 26, borderRadius: 7, border: '1px solid var(--color-border-alt)', background: 'var(--color-white)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="remove" size={14} color="var(--color-primary)" />
      </button>
      <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)', minWidth: 26, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      <button onClick={() => onChange(Math.min(max, value + 1))}
        style={{ width: 26, height: 26, borderRadius: 7, border: '1px solid var(--color-border-alt)', background: 'var(--color-white)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="add" size={14} color="var(--color-primary)" />
      </button>
    </div>
  );

  return (
    <div style={{ background: 'var(--color-white)', border: '1px solid var(--color-border-alt)', borderRadius: 12, boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.14)', padding: '10px', width: Math.min(240, window.innerWidth - 32), transformOrigin: 'top center', animation: 'menuIn 180ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {REPEAT_PRESETS.map(p => {
          const active = preset === p.value;
          return (
            <button key={p.value} onClick={() => onPresetChange(p.value)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, border: 'none', background: active ? 'var(--color-surface-tint)' : 'transparent', cursor: 'pointer', textAlign: 'left', transition: 'background 120ms' }}
              onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--color-purple-pale-5)'; }}
              onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
              <div style={{ width: 16, height: 16, borderRadius: '50%', border: `1.5px solid ${active ? 'var(--color-primary)' : 'var(--color-purple-tint-7)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {active && <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-primary)' }} />}
              </div>
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: active ? 600 : 400, color: active ? 'var(--color-primary)' : 'var(--color-text-primary)' }}>{p.label}</span>
            </button>
          );
        })}
      </div>

      {preset === 'custom' && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 10px 4px', borderTop: '1px solid var(--color-divider)', marginTop: 6 }}>
          <span style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-secondary)' }}>Every {customDays} day{customDays === 1 ? '' : 's'}</span>
          {stepper(customDays, onCustomDaysChange, 1, 365)}
        </div>
      )}

      {preset !== 'none' && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 10px 4px', borderTop: '1px solid var(--color-divider)', marginTop: preset === 'custom' ? 0 : 6 }}>
          <span style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-secondary)' }}>Ends after</span>
          {stepper(count, onCountChange, 2, 104)}
        </div>
      )}

      <button onClick={onDone}
        style={{ width: '100%', marginTop: 10, fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-primary)', border: 'none', borderRadius: 7, padding: '8px 0', cursor: 'pointer' }}>
        Done
      </button>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// Meeting view modal — a meeting someone else invited you to. Read-only:
// only the organizer can edit/delete/re-invite; an invitee can just leave.
// ════════════════════════════════════════════════════════════════════
function MeetingViewModal({ meeting, onClose, onLeave }: { meeting: Meeting; onClose: () => void; onLeave: () => void }) {
  const [confirmLeave, setConfirmLeave] = useState(false);
  const allMembers = useMembersStore(s => s.members);
  const currentUserId = useAuthStore(s => s.userId);
  const organizer = meeting.organizerId ? allMembers[meeting.organizerId] : undefined;
  const color = meeting.color || DEFAULT_MEETING_COLOR;

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  const friendlyDate = new Date(meeting.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const rowStyle = { display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0' };
  // Excludes the viewer themselves — from their own view, "who else is invited" shouldn't list "you".
  const others = (meeting.attendeeIds ?? []).filter(id => id !== currentUserId && allMembers[id]);

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.18)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)', animation: 'backdropIn 180ms ease both' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--color-white)', borderRadius: 18, width: '100%', maxWidth: 440, maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 40px rgba(var(--color-primary-rgb), 0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', position: 'relative' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ height: 5, background: color, flexShrink: 0 }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px 12px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div style={{ width: 34, height: 34, borderRadius: 10, background: tint(color, 0.16), display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Icon name="event" size={19} color={color} />
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {meeting.title}
            </div>
          </div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: '50%', border: 'none', background: 'var(--color-surface-tint-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="close" size={16} color="var(--color-text-tertiary)" />
          </button>
        </div>

        <div style={{ padding: '4px 24px 20px', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          {organizer && (
            <div style={rowStyle}>
              <MemberAvatar userId={meeting.organizerId!} size={22} />
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-secondary)' }}>
                Organized by <strong>{organizer.fullName || organizer.username}</strong>
              </span>
            </div>
          )}

          <div style={rowStyle}>
            <Icon name="calendar_today" size={15} color="var(--color-text-quaternary)" />
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)' }}>{friendlyDate}</span>
          </div>

          {!meeting.allDay && (meeting.startTime || meeting.endTime) && (
            <div style={rowStyle}>
              <Icon name="schedule" size={15} color="var(--color-text-quaternary)" />
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)' }}>
                {meeting.startTime || '--:--'}{meeting.endTime ? ` – ${meeting.endTime}` : ''}
              </span>
            </div>
          )}
          {meeting.allDay && (
            <div style={rowStyle}>
              <Icon name="schedule" size={15} color="var(--color-text-quaternary)" />
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)' }}>All day</span>
            </div>
          )}

          {meeting.location && (
            <div style={rowStyle}>
              <Icon name="location_on" size={15} color="var(--color-text-quaternary)" />
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)' }}>{meeting.location}</span>
            </div>
          )}

          {others.length > 0 && (
            <div style={rowStyle}>
              <Icon name="group" size={15} color="var(--color-text-quaternary)" />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {others.map(id => (
                  <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'var(--color-surface-tint)', borderRadius: 9999, padding: '2px 8px 2px 2px' }}>
                    <MemberAvatar userId={id} size={16} />
                    <span style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-primary)' }}>{allMembers[id]?.fullName || allMembers[id]?.username}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {meeting.description && meeting.description.trim() && (
            <>
              <div style={{ height: 1, background: 'var(--color-purple-pale-23)', margin: '10px 0' }} />
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, color: 'var(--color-border-strong)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Notes</div>
              <MarkdownView source={meeting.description} />
            </>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 24px 20px', borderTop: '1px solid var(--color-surface-tint)', flexShrink: 0 }}>
          <button onClick={() => setConfirmLeave(true)}
            style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-error)', background: 'var(--color-error-bg-alt)', border: '1px solid var(--color-error-bg)', borderRadius: 8, padding: '9px 16px', cursor: 'pointer', marginRight: 'auto' }}>
            Remove from my calendar
          </button>
          <button onClick={onClose} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '9px 20px', cursor: 'pointer' }}>Close</button>
        </div>

        {confirmLeave && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(var(--color-black-rgb), 0.25)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'backdropIn 160ms ease both' }}
            onClick={() => setConfirmLeave(false)}>
            <div style={{ background: 'var(--color-white)', borderRadius: 14, padding: '22px 24px', maxWidth: 320, boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.18)', animation: 'modalIn 240ms cubic-bezier(0.34,1.56,0.64,1) both' }}
              onClick={e => e.stopPropagation()}>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 6 }}>Remove this meeting?</div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', marginBottom: 18 }}>It'll disappear from your calendar. {organizer ? (organizer.fullName || organizer.username) : 'The organizer'} keeps it on theirs.</div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button onClick={() => setConfirmLeave(false)} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '8px 16px', cursor: 'pointer' }}>Cancel</button>
                <button onClick={onLeave} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-error)', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer' }}>Remove</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

// ════════════════════════════════════════════════════════════════════
// Day "what to add" chooser
// ════════════════════════════════════════════════════════════════════
function DayAddChooser({ date, onTask, onMeeting, onClose }: { date: string; onTask: () => void; onMeeting: () => void; onClose: () => void }) {
  const friendly = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const opt = (icon: string, title: string, sub: string, onClick: () => void) => (
    <button onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 12, border: '1.5px solid var(--color-border-alt)', background: 'var(--color-white)', cursor: 'pointer', textAlign: 'left', transition: 'all 150ms', width: '100%' }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-border-alt)'; e.currentTarget.style.background = 'var(--color-white)'; }}>
      <div style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon name={icon} size={20} color="var(--color-primary)" />
      </div>
      <div>
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)' }}>{title}</div>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 1 }}>{sub}</div>
      </div>
    </button>
  );
  // Portaled to <body> — see the comment on MeetingModal's return for why.
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.18)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)', animation: 'backdropIn 180ms ease both' }}
      onClick={onClose}>
      <div style={{ background: 'var(--color-white)', borderRadius: 16, width: '100%', maxWidth: 380, boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px 8px' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>Add to calendar</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{friendly}</div>
          </div>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: 'var(--color-surface-tint-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={15} color="var(--color-text-tertiary)" />
          </button>
        </div>
        <div style={{ padding: '8px 22px 22px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {opt('task_alt', 'Task', 'A to-do with a deadline', onTask)}
          {opt('event', 'Meeting', 'A standalone calendar event', onMeeting)}
        </div>
      </div>
    </div>,
    document.body
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

  // Portaled to <body> — see the comment on MeetingModal's return for why.
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.18)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={onClose}>
      <div style={{ background: 'var(--color-white)', borderRadius: 14, width: '100%', maxWidth: 420, boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px 14px', borderBottom: '1px solid var(--color-surface-tint)' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>Add Task</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{friendly}</div>
          </div>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={16} color="var(--color-text-tertiary)" />
          </button>
        </div>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div>
            <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 5, display: 'block' }}>Task Name</label>
            <input autoFocus value={title} onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && canSubmit) handleAdd(); }}
              placeholder="What needs to be done?"
              style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-primary)', background: 'transparent', border: 'none', borderBottom: '1.5px solid var(--color-border-alt)', padding: '7px 0', outline: 'none', boxSizing: 'border-box', transition: 'border-color 200ms' }}
              onFocus={e => (e.target.style.borderBottomColor = 'var(--color-primary)')}
              onBlur={e => (e.target.style.borderBottomColor = 'var(--color-border-alt)')} />
          </div>
          <div>
            <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 8, display: 'block' }}>Add to</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
              <button onClick={() => setDest('dash')}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 8, border: `1.5px solid ${dest === 'dash' ? 'var(--color-primary)' : 'var(--color-border-alt)'}`, background: dest === 'dash' ? 'var(--color-surface-tint)' : 'transparent', cursor: 'pointer', textAlign: 'left', transition: 'all 150ms' }}>
                <div style={{ width: 20, height: 20, borderRadius: '50%', background: dest === 'dash' ? 'var(--color-primary)' : 'var(--color-border-alt)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {dest === 'dash' && <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-white)' }} />}
                </div>
                <Icon name="today" size={15} color={dest === 'dash' ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: dest === 'dash' ? 'var(--color-primary)' : 'var(--color-text-secondary)' }}>Dashboard</span>
              </button>
              {lists.map(list => (
                <button key={list.id} onClick={() => setDest(list.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 8, border: `1.5px solid ${dest === list.id ? 'var(--color-primary)' : 'var(--color-border-alt)'}`, background: dest === list.id ? 'var(--color-surface-tint)' : 'transparent', cursor: 'pointer', textAlign: 'left', transition: 'all 150ms' }}>
                  <div style={{ width: 20, height: 20, borderRadius: '50%', background: dest === list.id ? 'var(--color-primary)' : 'var(--color-border-alt)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {dest === list.id && <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-white)' }} />}
                  </div>
                  {list.emoji ? <span style={{ fontSize: 15, lineHeight: 1 }}>{list.emoji}</span> : <Icon name="format_list_bulleted" size={15} color={dest === list.id ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />}
                  <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: dest === list.id ? 'var(--color-primary)' : 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{list.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '14px 24px 20px', borderTop: '1px solid var(--color-surface-tint)' }}>
          <button onClick={onClose} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '9px 20px', cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleAdd} disabled={!canSubmit}
            style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: canSubmit ? 'var(--color-primary)' : 'var(--color-border-strong)', border: 'none', borderRadius: 8, padding: '9px 20px', cursor: canSubmit ? 'pointer' : 'not-allowed', transition: 'all 180ms' }}>
            Add Task
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ════════════════════════════════════════════════════════════════════
// Compact chip (month / year) & card (week)
// ════════════════════════════════════════════════════════════════════
function ChipCompact({ chip, onOpenMenu }: { chip: Chip; onOpenMenu?: (e: React.MouseEvent, items: ContextMenuEntry[]) => void }) {
  return (
    <div onClick={e => { e.stopPropagation(); chip.onClick(); }}
      onContextMenu={e => { if (chip.contextItems) onOpenMenu?.(e, chip.contextItems); }}
      title={chip.label}
      draggable={!!chip.dragData}
      onDragStart={chip.dragData ? e => { e.dataTransfer.setData('text/plain', chip.dragData!); e.dataTransfer.effectAllowed = 'move'; e.stopPropagation(); } : undefined}
      style={{ display: 'flex', alignItems: 'center', gap: 4, background: chip.bg, borderRadius: 4, padding: '2px 5px', cursor: chip.dragData ? 'grab' : 'pointer', transition: 'filter 120ms', minWidth: 0, overflow: 'hidden' }}
      onMouseEnter={e => (e.currentTarget.style.filter = 'brightness(0.96)')}
      onMouseLeave={e => (e.currentTarget.style.filter = 'none')}>
      {chip.priorityColor
        ? <div style={{ width: 5, height: 5, borderRadius: '50%', background: chip.priorityColor, flexShrink: 0 }} />
        : chip.emoji
          ? <span style={{ fontSize: 10, lineHeight: 1, flexShrink: 0 }}>{chip.emoji}</span>
          : <div style={{ width: 5, height: 5, borderRadius: '50%', background: chip.accent, flexShrink: 0 }} />}
      <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: chip.accent, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0, fontWeight: 500 }}>{chip.label}</span>
    </div>
  );
}

function ChipCard({ chip, onOpenMenu }: { chip: Chip; onOpenMenu?: (e: React.MouseEvent, items: ContextMenuEntry[]) => void }) {
  return (
    <div onClick={chip.onClick}
      onContextMenu={e => { if (chip.contextItems) onOpenMenu?.(e, chip.contextItems); }}
      draggable={!!chip.dragData}
      onDragStart={chip.dragData ? e => { e.dataTransfer.setData('text/plain', chip.dragData!); e.dataTransfer.effectAllowed = 'move'; e.stopPropagation(); } : undefined}
      style={{ display: 'flex', gap: 7, background: chip.bg, borderRadius: 8, padding: '7px 9px', cursor: chip.dragData ? 'grab' : 'pointer', borderLeft: `3px solid ${chip.accent}`, transition: 'filter 120ms' }}
      onMouseEnter={e => (e.currentTarget.style.filter = 'brightness(0.97)')}
      onMouseLeave={e => (e.currentTarget.style.filter = 'none')}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          {chip.priorityColor && <div style={{ width: 6, height: 6, borderRadius: '50%', background: chip.priorityColor, flexShrink: 0 }} />}
          {chip.emoji && <span style={{ fontSize: 12, lineHeight: 1, flexShrink: 0 }}>{chip.emoji}</span>}
          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: chip.accent, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{chip.label}</span>
        </div>
        {(chip.allDay || chip.time || chip.subtitle) && (
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {chip.allDay ? 'All day' : chip.time ? chip.time : ''}{chip.subtitle ? `${chip.allDay || chip.time ? ' · ' : ''}${chip.subtitle}` : ''}
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// Day items modal — opened from a month cell's "+N more". Lists every item
// scheduled on that day; clicking one opens its detail (and closes this).
// ════════════════════════════════════════════════════════════════════
function DayItemsModal({ date, chips, onClose, onOpenMenu }: { date: string; chips: Chip[]; onClose: () => void; onOpenMenu?: (e: React.MouseEvent, items: ContextMenuEntry[]) => void }) {
  const friendly = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);
  // Portaled to <body> — see the comment on MeetingModal's return for why.
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.18)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)', animation: 'backdropIn 180ms ease both' }}
      onClick={onClose}>
      <div style={{ background: 'var(--color-white)', borderRadius: 16, width: '100%', maxWidth: 380, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px 12px', flexShrink: 0 }}>
          <div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>{friendly}</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{chips.length} {chips.length === 1 ? 'item' : 'items'}</div>
          </div>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: 'var(--color-surface-tint-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="close" size={15} color="var(--color-text-tertiary)" />
          </button>
        </div>
        <div style={{ padding: '4px 16px 18px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
          {chips.map(c => (
            <ChipCard key={c.key} chip={{ ...c, onClick: () => { onClose(); c.onClick(); } }} onOpenMenu={onOpenMenu} />
          ))}
        </div>
      </div>
    </div>,
    document.body
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
  // Month's dense 7-col grid doesn't fit a mobile-width screen — a stored
  // calendarView of 'month' (set on desktop, shared across devices) renders
  // as Week here instead, without touching the stored preference so desktop
  // still sees Month next time.
  const effectiveView: typeof view = isMobile && view === 'month' ? 'week' : view;
  const hiddenWsArr = useUserPrefsStore(s => s.calendarHiddenWorkspaces);
  const hiddenWs = useMemo(() => new Set(hiddenWsArr), [hiddenWsArr]);
  const setHiddenWs = useCallback((next: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const cur = new Set(useUserPrefsStore.getState().calendarHiddenWorkspaces);
    const result = typeof next === 'function' ? next(cur) : next;
    useUserPrefsStore.getState().setCalendarHiddenWorkspaces([...result]);
  }, []);
  // Event-family filter (task deadlines / milestones / meetings). Persisted like
  // the workspace filter; the dashboard's "See all meetings" deep-links into a
  // meetings-only view via ?show=meetings (handled below).
  const hiddenKindsArr = useUserPrefsStore(s => s.calendarHiddenKinds);
  const hiddenKinds = useMemo(() => new Set(hiddenKindsArr), [hiddenKindsArr]);
  const kindVisible = useCallback((k: string) => !hiddenKinds.has(k), [hiddenKinds]);
  const toggleKind = (k: string) => {
    const cur = new Set(useUserPrefsStore.getState().calendarHiddenKinds);
    if (cur.has(k)) cur.delete(k); else cur.add(k);
    useUserPrefsStore.getState().setCalendarHiddenKinds([...cur]);
  };
  const [anchor, setAnchor] = useState<Date>(today);
  const [showFilter, setShowFilter] = useState(false);

  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [editingMeeting, setEditingMeeting] = useState<Meeting | null>(null);
  const [chipMenu, setChipMenu] = useState<{ x: number; y: number; items: ContextMenuEntry[] } | null>(null);
  const openChipMenu = useCallback((e: React.MouseEvent, items: ContextMenuEntry[]) => {
    e.preventDefault();
    e.stopPropagation();
    setChipMenu({ x: e.clientX, y: e.clientY, items });
  }, []);
  const [creatingMeeting, setCreatingMeeting] = useState<{ date: string; startTime?: string; endTime?: string } | null>(null);
  const [dayChooser, setDayChooser] = useState<string | null>(null);
  const [addingTaskDate, setAddingTaskDate] = useState<string | null>(null);
  const [dayItemsIso, setDayItemsIso] = useState<string | null>(null);
  // Week view's all-day row caps task-deadline chips at 1 per day; the rest
  // are reached through this ("Show more Deadlines") reusing DayItemsModal.
  const [deadlinesOverflow, setDeadlinesOverflow] = useState<{ iso: string; chips: Chip[] } | null>(null);

  // Week view: click-and-drag on the time grid to block out a meeting's time.
  // The live drag state lives in the beginWeekSelect closure; this only mirrors
  // it for rendering the selection overlay.
  const [weekSel, setWeekSel] = useState<{ iso: string; aMin: number; bMin: number } | null>(null);

  const [search, setSearch] = useState('');
  const [dragTaskId, setDragTaskId] = useState<number | null>(null);
  const [showUnscheduled, setShowUnscheduled] = useState(false);

  // "New meeting" shortcut — same as the "New Meeting" button.
  useEffect(() => {
    const onCreateMeeting = () => setCreatingMeeting({ date: effectiveView === 'year' ? todayIso : toIso(anchor) });
    window.addEventListener('shortcut:create-meeting', onCreateMeeting);
    return () => window.removeEventListener('shortcut:create-meeting', onCreateMeeting);
  }, [effectiveView, anchor, todayIso]);

  const filterRef = useRef<HTMLDivElement>(null);
  const unschedRef = useRef<HTMLDivElement>(null);
  // One time-grid vertical-scroll ref per rendered day-group — desktop always
  // renders exactly one (all 7 days); mobile renders up to 3 (3-day pages).
  const weekScrollRefs = useRef<Array<HTMLDivElement | null>>([]);

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

  // Live cross-device meeting sync: the delta engine bumps this counter when a
  // meeting changes anywhere (incl. via CalDAV), and we refetch just the meetings.
  const meetingRev = useSyncStore(s => s.entityRevisions.meeting ?? 0);
  useEffect(() => {
    if (meetingRev === 0) return;
    apiGetMeetings().then(m => setMeetings(m.meetings)).catch(() => {});
  }, [meetingRev]);

  // Close filter on outside click.
  useEffect(() => {
    if (!showFilter) return;
    const onClick = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setShowFilter(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showFilter]);

  // Deep-link from the dashboard's "See all meetings": ?show=meetings switches
  // the event-family filter to meetings-only, then the param is stripped so a
  // later refresh doesn't re-apply it (the filter itself persists). Read straight
  // off window.location to avoid a router hook the React Compiler can't model.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('show') !== 'meetings') return;
    useUserPrefsStore.getState().setCalendarHiddenKinds(['task', 'milestone']);
    params.delete('show');
    const qs = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }, []);

  // Close unscheduled popover on outside click.
  useEffect(() => {
    if (!showUnscheduled) return;
    const onClick = (e: MouseEvent) => {
      if (unschedRef.current && !unschedRef.current.contains(e.target as Node)) setShowUnscheduled(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showUnscheduled]);

  // Auto-scroll every rendered Week time-grid (one on desktop, up to 3 pages
  // on mobile) to the morning when it opens.
  useEffect(() => {
    if (effectiveView !== 'week') return;
    for (const el of weekScrollRefs.current) { if (el) el.scrollTop = 7 * HOUR_H; }
  }, [effectiveView, anchor]);

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
        label: t.title, accent: 'var(--color-primary)', bg: 'var(--color-surface-tint)',
        priorityColor: t.priority ? PRIORITY_COLORS[t.priority] : undefined,
        subtitle: t._listName && t._listName !== 'Dashboard' ? t._listName : null,
        startMin: s ?? undefined, endMin: s != null ? s + 30 : undefined,
        dragData: String(t.id),
        onClick: () => setSelectedTask(t),
        contextItems: [{ key: 'view', label: 'View details', icon: 'tune', onClick: () => setSelectedTask(t) }],
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
          contextItems: [{ key: 'view', label: 'View details', icon: 'tune', onClick: () => navigate(`/timeline/${tl.id}`) }],
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
        contextItems: [{ key: 'edit', label: mt.isOwner === false ? 'View meeting' : 'Edit meeting', icon: mt.isOwner === false ? 'tune' : 'edit', onClick: () => setEditingMeeting(mt) }],
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

  // Event-family filter, applied as a cheap post-process so the (heavier)
  // chip-building memo above stays untouched. A plain derived value — the React
  // Compiler memoizes it — so no manual dependency list to keep in sync.
  // Event-family filter, applied as a cheap post-process so the (heavier)
  // chip-building memo above stays untouched. A plain derived value — the React
  // Compiler memoizes it — so there's no manual dependency list to keep in sync.
  const visibleChipsByDate: Record<string, Chip[]> = (() => {
    if (hiddenKindsArr.length === 0) return chipsByDate;
    const hidden = new Set(hiddenKindsArr);
    const out: Record<string, Chip[]> = {};
    for (const d of Object.keys(chipsByDate)) {
      const arr = chipsByDate[d].filter(c => !hidden.has(c.kind));
      if (arr.length) out[d] = arr;
    }
    return out;
  })();

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
  const saveMeeting = async (data: Omit<Meeting, 'id' | 'createdAt' | 'updatedAt'>, id?: string, repeat?: MeetingRecurrenceRule, inviteeIds?: string[]) => {
    setEditingMeeting(null);
    setCreatingMeeting(null);
    if (id) {
      setMeetings(ms => ms.map(m => m.id === id ? { ...m, ...data, attendeeIds: inviteeIds ?? m.attendeeIds } : m));
      apiUpdateMeeting(id, { ...data, inviteeIds }).catch(() => loadData());
    } else {
      const tempId = `tmp_${Date.now()}`;
      const temp: Meeting = { id: tempId, ...data, isOwner: true, attendeeIds: inviteeIds ?? [] };
      setMeetings(ms => [...ms, temp]);
      try {
        const res = await apiCreateMeeting({ ...data, repeat, inviteeIds });
        // A repeating series materializes multiple rows server-side; swap the
        // optimistic placeholder for all of them at once.
        setMeetings(ms => ms.flatMap(m => m.id === tempId ? res.meetings : [m]));
      } catch { setMeetings(ms => ms.filter(m => m.id !== tempId)); }
    }
  };

  const deleteMeeting = (id: string, opts?: { series?: boolean }) => {
    setEditingMeeting(null);
    if (opts?.series) {
      const recurrenceId = meetings.find(m => m.id === id)?.recurrenceId;
      setMeetings(ms => ms.filter(m => m.id !== id && m.recurrenceId !== recurrenceId));
    } else {
      setMeetings(ms => ms.filter(m => m.id !== id));
    }
    apiDeleteMeeting(id, opts).catch(() => loadData());
  };

  // An invitee removing a meeting from their own calendar — doesn't touch it
  // for the organizer or any other attendee.
  const leaveMeeting = (id: string) => {
    setEditingMeeting(null);
    setMeetings(ms => ms.filter(m => m.id !== id));
    apiLeaveMeeting(id).catch(() => loadData());
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

  // Week time-grid: press-and-drag to block out a time range, then release to
  // open the meeting composer pre-filled with that day + start/end. A plain
  // click (no drag) falls back to the day "what to add" chooser.
  const beginWeekSelect = useCallback((iso: string, e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // Ignore presses that start on an existing chip — those drag/open the chip.
    if ((e.target as HTMLElement).closest('[data-cal-chip]')) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const minAt = (clientY: number) => {
      const y = clientY - rect.top;
      const snapped = Math.round((y / HOUR_H) * 60 / 15) * 15;   // snap to 15 min
      return Math.max(0, Math.min(24 * 60, snapped));
    };
    const start = minAt(e.clientY);
    const sel = { aMin: start, bMin: start, moved: false };
    setWeekSel({ iso, aMin: start, bMin: start });

    const onMove = (ev: MouseEvent) => {
      const b = minAt(ev.clientY);
      if (b !== sel.aMin) sel.moved = true;
      sel.bMin = b;
      setWeekSel({ iso, aMin: sel.aMin, bMin: b });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setWeekSel(null);
      const lo = Math.min(sel.aMin, sel.bMin), hi = Math.max(sel.aMin, sel.bMin);
      if (!sel.moved || hi - lo < 15) setDayChooser(iso);
      else setCreatingMeeting({ date: iso, startTime: minToStr(lo), endTime: minToStr(hi) });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  // ── Period navigation ──────────────────────────────────────────
  const go = (dir: number) => setAnchor(a => {
    const d = new Date(a);
    if (effectiveView === 'month') d.setMonth(d.getMonth() + dir);
    else if (effectiveView === 'week') d.setDate(d.getDate() + dir * 7);
    else d.setFullYear(d.getFullYear() + dir);
    return d;
  });

  const periodLabel = (() => {
    if (effectiveView === 'month') return `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`;
    if (effectiveView === 'year') return String(anchor.getFullYear());
    const ws = startOfWeek(anchor);
    const we = new Date(ws); we.setDate(we.getDate() + 6);
    const sameMonth = ws.getMonth() === we.getMonth();
    return sameMonth
      ? `${MONTHS_SHORT[ws.getMonth()]} ${ws.getDate()} – ${we.getDate()}, ${we.getFullYear()}`
      : `${MONTHS_SHORT[ws.getMonth()]} ${ws.getDate()} – ${MONTHS_SHORT[we.getMonth()]} ${we.getDate()}, ${we.getFullYear()}`;
  })();

  // The unscheduled-tasks panel is task-centric, so hide it when task deadlines
  // are filtered out (e.g. the meetings-only view) — and entirely on mobile,
  // where it's dropped from the toolbar altogether.
  const showPanel = effectiveView !== 'year' && kindVisible('task') && !isMobile;

  // ════════════════════════════════════════════════════════════════
  // Views
  // ════════════════════════════════════════════════════════════════
  const renderMonth = () => {
    const y = anchor.getFullYear(), mo = anchor.getMonth();
    const firstDay = monIndex(new Date(y, mo, 1).getDay());
    const daysInMonth = new Date(y, mo + 1, 0).getDate();
    const daysInPrev = new Date(y, mo, 0).getDate();
    const cells: Array<{ date: Date; current: boolean }> = [];
    for (let i = firstDay - 1; i >= 0; i--) cells.push({ date: new Date(y, mo - 1, daysInPrev - i), current: false });
    for (let d = 1; d <= daysInMonth; d++) cells.push({ date: new Date(y, mo, d), current: true });
    while (cells.length < 42) cells.push({ date: new Date(y, mo + 1, cells.length - daysInMonth - firstDay + 1), current: false });

    return (
      <div style={{ flex: 1, overflow: 'auto', padding: '0 16px 16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 1 }}>
          {WEEK_HEADER.map(d => (
            <div key={d} style={{ textAlign: 'center', fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, color: 'var(--color-text-quaternary)', padding: '10px 0' }}>{d}</div>
          ))}
          {cells.map((cell, i) => {
            const iso = toIso(cell.date);
            const isToday = iso === todayIso;
            const chips = cell.current ? (visibleChipsByDate[iso] ?? []) : [];
            const visible = chips.slice(0, 3);
            const overflow = chips.length - visible.length;
            return (
              <div key={i}
                onDragOver={e => { if (cell.current) e.preventDefault(); }}
                onDrop={e => { if (cell.current) handleDayDrop(iso, e); }}
                onClick={() => { if (cell.current) setDayChooser(iso); }}
                style={{ minHeight: isMobile ? 76 : 100, border: isToday ? '1.5px solid var(--color-purple-tint-1)' : '1px solid var(--color-surface-tint-2)', background: isToday ? 'var(--color-purple-pale-5)' : cell.current ? 'var(--color-white)' : 'var(--color-surface-neutral)', borderRadius: 6, padding: 4, transition: 'background 150ms', cursor: cell.current ? 'pointer' : 'default', position: 'relative', minWidth: 0, overflow: 'hidden' }}
                className="cal-cell">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, padding: '0 2px' }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: isToday ? 700 : 400, color: isToday ? 'var(--color-primary)' : cell.current ? 'var(--color-text-primary)' : 'var(--color-border-strong)' }}>{cell.date.getDate()}</div>
                  {cell.current && (
                    <div className="cal-add-btn" style={{ width: 16, height: 16, borderRadius: '50%', background: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0, transition: 'opacity 150ms', flexShrink: 0 }}>
                      <Icon name="add" size={11} color="var(--color-white)" />
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  {visible.map(c => <ChipCompact key={c.key} chip={c} onOpenMenu={openChipMenu} />)}
                  {overflow > 0 && (
                    <button onClick={e => { e.stopPropagation(); setDayItemsIso(iso); }}
                      style={{ fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', background: 'transparent', border: 'none', textAlign: 'left', padding: '1px 5px', borderRadius: 4, cursor: 'pointer', transition: 'all 120ms' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; e.currentTarget.style.color = 'var(--color-primary)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--color-text-tertiary)'; }}>
                      +{overflow} more
                    </button>
                  )}
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
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();

    const dayData = days.map(d => {
      const iso = toIso(d);
      const chips = visibleChipsByDate[iso] ?? [];
      const timed = chips.filter(c => c.startMin != null);
      const untimed = chips.filter(c => c.startMin == null);
      return { d, iso, isToday: iso === todayIso, timed, untimed, layout: layoutDay(timed) };
    });
    type DayDatum = (typeof dayData)[number];

    // Splits one day's untimed chips into what's shown vs. hidden behind
    // "Show more Deadlines" — only task-deadline chips are capped (at 1);
    // meeting/milestone all-day chips are fewer and more load-bearing, so
    // they're left unlimited.
    const splitUntimed = (untimed: Chip[]) => {
      const shown: Chip[] = [];
      const hiddenTasks: Chip[] = [];
      let taskCount = 0;
      for (const c of untimed) {
        if (c.kind === 'task') {
          taskCount++;
          if (taskCount <= 1) shown.push(c); else hiddenTasks.push(c);
        } else {
          shown.push(c);
        }
      }
      return { shown, hiddenTasks };
    };

    // Renders one self-contained [day headers / all-day row / time grid]
    // block for an arbitrary subset of days. Desktop calls this once with
    // all 7 days (unchanged from before); mobile calls it once per 3-day
    // page (see below) — each page carries its own hour gutter, so paging
    // never needs to keep a frozen gutter in sync across scroll regions.
    const renderDayGroup = (group: DayDatum[], refIdx: number) => {
      const gridCols = `${gutter}px repeat(${group.length}, minmax(0, 1fr))`;
      return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          {/* Day headers */}
          <div style={{ display: 'grid', gridTemplateColumns: gridCols, borderBottom: '1px solid var(--color-surface-tint-2)', flexShrink: 0 }}>
            <div />
            {group.map(({ d, iso, isToday }) => (
              <div key={iso} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 4px', borderLeft: '1px solid var(--color-purple-pale-19)' }}>
                <span style={{ fontFamily: 'var(--font-heading)', fontSize: 10.5, fontWeight: 700, color: 'var(--color-text-quaternary)', textTransform: 'uppercase' }}>{DAYS_SHORT[d.getDay()]}</span>
                <span style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 700, color: isToday ? 'var(--color-white)' : 'var(--color-text-primary)', background: isToday ? 'var(--color-primary)' : 'transparent', borderRadius: '50%', width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{d.getDate()}</span>
              </div>
            ))}
          </div>

          {/* All-day / untimed row */}
          <div style={{ display: 'grid', gridTemplateColumns: gridCols, borderBottom: '1px solid var(--color-border)', flexShrink: 0, maxHeight: 132, overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', padding: '6px 6px 0', fontFamily: 'var(--font-body)', fontSize: 9, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase' }}>all-day</div>
            {group.map(({ iso, untimed }) => {
              const { shown, hiddenTasks } = splitUntimed(untimed);
              return (
                <div key={iso}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => handleDayDrop(iso, e)}
                  style={{ borderLeft: '1px solid var(--color-purple-pale-19)', padding: 4, display: 'flex', flexDirection: 'column', gap: 3, minHeight: 30 }}>
                  {shown.map(c => <ChipCard key={c.key} chip={c} onOpenMenu={openChipMenu} />)}
                  {hiddenTasks.length > 0 && (
                    <button onClick={e => { e.stopPropagation(); setDeadlinesOverflow({ iso, chips: hiddenTasks }); }}
                      style={{ fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', background: 'transparent', border: 'none', textAlign: 'left', padding: '1px 5px', borderRadius: 4, cursor: 'pointer', transition: 'all 120ms' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; e.currentTarget.style.color = 'var(--color-primary)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--color-text-tertiary)'; }}>
                      Show more Deadlines (+{hiddenTasks.length})
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Time grid */}
          <div ref={el => { weekScrollRefs.current[refIdx] = el; }} style={{ flex: 1, overflowY: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: gridCols }}>
              {/* Hour gutter */}
              <div style={{ position: 'relative', height: 24 * HOUR_H }}>
                {HOURS.map(h => h === 0 ? null : (
                  <div key={h} style={{ position: 'absolute', top: h * HOUR_H - 6, right: 6, fontFamily: 'var(--font-body)', fontSize: 9.5, color: 'var(--color-text-quaternary)' }}>
                    {String(h).padStart(2, '0')}:00
                  </div>
                ))}
              </div>
              {/* Day columns */}
              {group.map(({ iso, isToday, timed, layout }) => (
                <div key={iso}
                  onMouseDown={e => beginWeekSelect(iso, e)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => handleDayDrop(iso, e)}
                  style={{ position: 'relative', height: 24 * HOUR_H, borderLeft: '1px solid var(--color-purple-pale-19)', background: isToday ? 'var(--color-purple-pale-3)' : 'var(--color-white)', cursor: 'pointer' }}>
                  {HOURS.map(h => (
                    <div key={h} style={{ position: 'absolute', top: h * HOUR_H, left: 0, right: 0, borderTop: '1px solid var(--color-purple-pale-19)' }} />
                  ))}
                  {weekSel && weekSel.iso === iso && (() => {
                    const lo = Math.min(weekSel.aMin, weekSel.bMin), hi = Math.max(weekSel.aMin, weekSel.bMin);
                    return (
                      <div style={{ position: 'absolute', top: (lo / 60) * HOUR_H, height: Math.max(((hi - lo) / 60) * HOUR_H, 2), left: 2, right: 2, background: 'rgba(var(--color-primary-rgb), 0.16)', border: '1.5px solid var(--color-primary)', borderRadius: 5, zIndex: 4, pointerEvents: 'none', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '2px 0' }}>
                        <span style={{ fontFamily: 'var(--font-body)', fontSize: 9.5, fontWeight: 600, color: 'var(--color-primary)' }}>{minToStr(lo)} – {minToStr(hi)}</span>
                      </div>
                    );
                  })()}
                  {isToday && (
                    <div style={{ position: 'absolute', top: (nowMin / 60) * HOUR_H, left: 0, right: 0, height: 2, background: 'var(--color-red-mid-2)', zIndex: 3 }}>
                      <div style={{ position: 'absolute', left: -3, top: -3, width: 7, height: 7, borderRadius: '50%', background: 'var(--color-red-mid-2)' }} />
                    </div>
                  )}
                  {timed.map(c => {
                    const lay = layout.get(c) ?? { col: 0, cols: 1 };
                    const top = (c.startMin! / 60) * HOUR_H;
                    const height = Math.max(((c.endMin! - c.startMin!) / 60) * HOUR_H, 18);
                    const wPct = 100 / lay.cols;
                    return (
                      <div key={c.key}
                        data-cal-chip
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => { e.stopPropagation(); c.onClick(); }}
                        onContextMenu={e => { if (c.contextItems) openChipMenu(e, c.contextItems); }}
                        draggable={!!c.dragData}
                        onDragStart={c.dragData ? e => { e.dataTransfer.setData('text/plain', c.dragData!); e.dataTransfer.effectAllowed = 'move'; e.stopPropagation(); } : undefined}
                        title={c.label}
                        style={{ position: 'absolute', top: top + 1, height: height - 2, left: `calc(${lay.col * wPct}% + 2px)`, width: `calc(${wPct}% - 4px)`, background: c.bg, borderLeft: `3px solid ${c.accent}`, borderRadius: 5, padding: '2px 5px', overflow: 'hidden', cursor: c.dragData ? 'grab' : 'pointer', zIndex: 2 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          {c.priorityColor && <div style={{ width: 5, height: 5, borderRadius: '50%', background: c.priorityColor, flexShrink: 0 }} />}
                          {c.emoji && <span style={{ fontSize: 10, lineHeight: 1, flexShrink: 0 }}>{c.emoji}</span>}
                          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: c.accent, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
                        </div>
                        {height > 30 && c.time && <div style={{ fontFamily: 'var(--font-body)', fontSize: 9.5, color: 'var(--color-text-tertiary)' }}>{c.time}</div>}
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

    if (!isMobile) return renderDayGroup(dayData, 0);

    // Mobile: page through the week 3 days at a time via native horizontal
    // scroll-snap — each page is its own fully self-contained day-group, so
    // there's no cross-page scroll position to keep in sync.
    const pages: DayDatum[][] = [];
    for (let i = 0; i < dayData.length; i += 3) pages.push(dayData.slice(i, i + 3));
    return (
      <div style={{ flex: 1, display: 'flex', overflowX: 'auto', overflowY: 'hidden', scrollSnapType: 'x mandatory' }}>
        {pages.map((group, gi) => (
          <div key={gi} style={{ flex: '0 0 100%', minWidth: 0, scrollSnapAlign: 'start', display: 'flex' }}>
            {renderDayGroup(group, gi)}
          </div>
        ))}
      </div>
    );
  };

  const renderYear = () => {
    const y = anchor.getFullYear();
    return (
      <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 16 }}>
          {MONTHS.map((monthName, mo) => {
            const firstDay = monIndex(new Date(y, mo, 1).getDay());
            const daysInMonth = new Date(y, mo + 1, 0).getDate();
            const cells: Array<Date | null> = [];
            for (let i = 0; i < firstDay; i++) cells.push(null);
            for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(y, mo, d));
            return (
              <div key={mo} style={{ border: '1px solid var(--color-surface-tint-2)', borderRadius: 12, padding: 10, background: 'var(--color-white)' }}>
                <button onClick={() => { setAnchor(new Date(y, mo, 1)); setView('month'); }}
                  style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 700, color: 'var(--color-primary)', background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 0 8px', textAlign: 'left' }}>
                  {monthName}
                </button>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
                  {DAYS_MINI.map((d, i) => <div key={i} style={{ textAlign: 'center', fontFamily: 'var(--font-body)', fontSize: 9, fontWeight: 600, color: 'var(--color-border-strong)' }}>{d}</div>)}
                  {cells.map((d, i) => {
                    if (!d) return <div key={i} />;
                    const iso = toIso(d);
                    const isToday = iso === todayIso;
                    const chips = visibleChipsByDate[iso] ?? [];
                    const dots = chips.slice(0, 3);
                    return (
                      <button key={i} onClick={() => { setAnchor(d); setView('month'); }}
                        style={{ aspectRatio: '1', border: 'none', background: isToday ? 'var(--color-primary)' : 'transparent', borderRadius: 6, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, padding: 0, transition: 'background 120ms' }}
                        onMouseEnter={e => { if (!isToday) e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
                        onMouseLeave={e => { if (!isToday) e.currentTarget.style.background = 'transparent'; }}>
                        <span style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, fontWeight: isToday ? 700 : 400, color: isToday ? 'var(--color-white)' : 'var(--color-text-secondary)' }}>{d.getDate()}</span>
                        <div style={{ display: 'flex', gap: 1.5, height: 4, alignItems: 'center' }}>
                          {dots.map(c => <div key={c.key} style={{ width: 3.5, height: 3.5, borderRadius: '50%', background: isToday ? 'rgba(var(--color-white-rgb), 0.85)' : c.accent }} />)}
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
      style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: effectiveView === v ? 'var(--color-primary)' : 'var(--color-text-tertiary)', background: effectiveView === v ? 'var(--color-white)' : 'transparent', border: 'none', borderRadius: 7, padding: '6px 14px', cursor: 'pointer', boxShadow: effectiveView === v ? '0 1px 4px rgba(var(--color-primary-rgb), 0.18)' : 'none', transition: 'all 150ms' }}>
      {label}
    </button>
  );

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: isMobile ? '12px 14px' : '14px 24px', borderBottom: '1px solid var(--color-border-alt)', flexShrink: 0, flexWrap: 'wrap' }}>
          {/* Navigation */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={() => go(-1)} style={{ background: 'none', border: '1px solid var(--color-border)', borderRadius: 8, cursor: 'pointer', padding: '6px 9px', display: 'flex', alignItems: 'center' }}>
              <Icon name="chevron_left" size={18} color="var(--color-text-tertiary)" />
            </button>
            <button onClick={() => go(1)} style={{ background: 'none', border: '1px solid var(--color-border)', borderRadius: 8, cursor: 'pointer', padding: '6px 9px', display: 'flex', alignItems: 'center' }}>
              <Icon name="chevron_right" size={18} color="var(--color-text-tertiary)" />
            </button>
            <button onClick={() => setAnchor(new Date())}
              style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', border: 'none', borderRadius: 8, padding: '6px 14px', cursor: 'pointer' }}>
              Today
            </button>
          </div>
          <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: isMobile ? 15 : 18, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}>{periodLabel}</h2>

          {/* Right cluster */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
            {/* View switcher */}
            <div style={{ display: 'flex', gap: 2, background: 'var(--color-surface-tint-2)', borderRadius: 9, padding: 3 }}>
              {viewBtn('week', 'Week')}
              {/* Month's dense 7-col grid doesn't fit a mobile-width screen — dropped there entirely (see effectiveView). */}
              {!isMobile && viewBtn('month', 'Month')}
              {viewBtn('year', 'Year')}
            </div>

            {/* Workspace filter */}
            <div ref={filterRef} style={{ position: 'relative' }}>
              <button onClick={() => setShowFilter(v => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: (hiddenWs.size > 0 || hiddenKinds.size > 0) ? 'var(--color-primary)' : 'var(--color-text-tertiary)', background: (hiddenWs.size > 0 || hiddenKinds.size > 0) ? 'var(--color-surface-tint)' : 'transparent', border: `1px solid ${(hiddenWs.size > 0 || hiddenKinds.size > 0) ? 'var(--color-accent-purple-soft)' : 'var(--color-border)'}`, borderRadius: 8, padding: '7px 12px', cursor: 'pointer', transition: 'all 150ms' }}>
                <Icon name="filter_list" size={16} color={(hiddenWs.size > 0 || hiddenKinds.size > 0) ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                {!isMobile && 'Filter'}
                {hiddenWs.size > 0 && <span style={{ fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 700, color: 'var(--color-white)', background: 'var(--color-primary)', borderRadius: 9999, padding: '1px 6px' }}>{Math.max(workspaces.length - hiddenWs.size, 0)}/{workspaces.length}</span>}
              </button>
              {showFilter && (
                <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 250, maxHeight: 360, overflowY: 'auto', background: 'var(--color-white)', borderRadius: 14, border: '1px solid var(--color-border-alt)', boxShadow: '0 8px 32px rgba(var(--color-primary-rgb), 0.14)', zIndex: 400, animation: 'menuIn 160ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
                  {/* Event families — hide meetings / task deadlines / milestones */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px 8px' }}>
                    <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-quaternary)' }}>Show</span>
                    {hiddenKinds.size > 0 && <button onClick={() => useUserPrefsStore.getState().setCalendarHiddenKinds([])} style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-primary)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}>Reset</button>}
                  </div>
                  <div style={{ padding: '0 8px 6px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {KIND_META.map(k => {
                      const on = kindVisible(k.id);
                      return (
                        <button key={k.id} onClick={() => toggleKind(k.id)}
                          style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 8px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', transition: 'background 120ms' }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-tint)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          <div style={{ width: 18, height: 18, borderRadius: 5, border: `1.5px solid ${on ? 'var(--color-primary)' : 'var(--color-purple-tint-7)'}`, background: on ? 'var(--color-primary)' : 'var(--color-white)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 120ms' }}>
                            {on && <Icon name="check" size={13} color="var(--color-white)" />}
                          </div>
                          <Icon name={k.icon} size={15} color="var(--color-text-tertiary)" />
                          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)' }}>{k.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ height: 1, background: 'var(--color-divider)', margin: '2px 12px 0' }} />
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px 8px' }}>
                    <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-quaternary)' }}>Workspaces</span>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => setHiddenWs(new Set())} style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-primary)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}>All</button>
                      <button onClick={() => setHiddenWs(new Set(workspaces.map(w => w.id)))} style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}>None</button>
                    </div>
                  </div>
                  <div style={{ padding: '0 8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {workspaces.length === 0 && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', padding: '8px 8px 4px' }}>No workspaces</div>}
                    {workspaces.map(w => {
                      const on = !hiddenWs.has(w.id);
                      return (
                        <button key={w.id} onClick={() => toggleWs(w.id)}
                          style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 8px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', transition: 'background 120ms' }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-tint)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          <div style={{ width: 18, height: 18, borderRadius: 5, border: `1.5px solid ${on ? 'var(--color-primary)' : 'var(--color-purple-tint-7)'}`, background: on ? 'var(--color-primary)' : 'var(--color-white)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 120ms' }}>
                            {on && <Icon name="check" size={13} color="var(--color-white)" />}
                          </div>
                          {w.emoji && <span style={{ fontSize: 15, lineHeight: 1 }}>{w.emoji}</span>}
                          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Unscheduled tasks — desktop only; dropped from the mobile toolbar (see showPanel) */}
            {showPanel && (
              <div ref={unschedRef} style={{ position: 'relative' }}>
                <button onClick={() => setShowUnscheduled(v => !v)}
                  title="Unscheduled tasks"
                  style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: showUnscheduled ? 'var(--color-primary)' : 'var(--color-text-tertiary)', background: showUnscheduled ? 'var(--color-surface-tint)' : 'transparent', border: `1px solid ${showUnscheduled ? 'var(--color-accent-purple-soft)' : 'var(--color-border)'}`, borderRadius: 8, padding: '7px 12px', cursor: 'pointer', transition: 'all 150ms' }}>
                  <Icon name="bolt" size={16} color={showUnscheduled ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                  Unscheduled
                  {unscheduled.length > 0 && <span style={{ fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 700, color: 'var(--color-white)', background: 'var(--color-primary)', borderRadius: 9999, padding: '1px 6px' }}>{unscheduled.length}</span>}
                </button>
                {showUnscheduled && (
                  <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 280, maxHeight: '60vh', display: 'flex', flexDirection: 'column', background: 'var(--color-white)', borderRadius: 14, border: '1px solid var(--color-border-alt)', boxShadow: '0 8px 32px rgba(var(--color-primary-rgb), 0.14)', zIndex: 400, animation: 'menuIn 160ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}>
                    <div style={{ padding: '12px 14px 8px', borderBottom: '1px solid var(--color-divider)', flexShrink: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                        <Icon name="bolt" size={15} color="var(--color-primary)" />
                        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-quaternary)' }}>Unscheduled</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--color-surface-tint-3)', borderRadius: 8, padding: '6px 10px', border: '1px solid var(--color-border)' }}>
                        <Icon name="search" size={13} color="var(--color-text-tertiary)" />
                        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
                          style={{ background: 'transparent', border: 'none', outline: 'none', fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-primary)', flex: 1 }} />
                      </div>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-text-quaternary)', marginTop: 7 }}>Drag a task onto a day to schedule it.</div>
                    </div>
                    <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px' }}>
                      {filteredUnscheduled.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '20px 8px', fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>All tasks scheduled!</div>
                      ) : (
                        filteredUnscheduled.map(t => (
                          <div key={`${t._listId}-${t.id}`} draggable
                            onDragStart={e => { e.dataTransfer.setData('text/plain', String(t.id)); e.dataTransfer.effectAllowed = 'move'; setDragTaskId(t.id); }}
                            onDragEnd={() => setDragTaskId(null)}
                            onClick={() => setSelectedTask(t)}
                            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, background: 'var(--color-white)', border: '1px solid var(--color-border)', marginBottom: 4, cursor: 'grab', transition: 'all 150ms', opacity: dragTaskId === t.id ? 0.4 : 1 }}
                            onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--color-accent-purple-light)')}
                            onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--color-border)')}>
                            <Icon name="drag_indicator" size={15} color="var(--color-border-strong)" />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
                              {t._listName && t._listName !== 'Dashboard' && <div style={{ fontFamily: 'var(--font-body)', fontSize: 10, color: 'var(--color-text-tertiary)' }}>{t._listName}</div>}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* New meeting — sits right next to the filter/unscheduled cluster */}
            <button onClick={() => setCreatingMeeting({ date: effectiveView === 'year' ? todayIso : toIso(anchor) })}
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-primary)', border: 'none', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', boxShadow: '0 2px 8px rgba(var(--color-primary-rgb), 0.25)', transition: 'background 150ms' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-purple-mid-11)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--color-primary)')}>
              <Icon name="add" size={16} color="var(--color-white)" />
              {isMobile ? 'Meeting' : 'New Meeting'}
            </button>
          </div>
        </div>

        {/* Body */}
        {effectiveView === 'month' ? renderMonth() : effectiveView === 'week' ? renderWeek() : renderYear()}
      </div>

      {/* Modals */}
      {chipMenu && (
        <ContextMenu x={chipMenu.x} y={chipMenu.y} items={chipMenu.items} onClose={() => setChipMenu(null)} />
      )}
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
      {dayItemsIso && (
        <DayItemsModal date={dayItemsIso} chips={visibleChipsByDate[dayItemsIso] ?? []} onOpenMenu={openChipMenu} onClose={() => setDayItemsIso(null)} />
      )}
      {deadlinesOverflow && (
        <DayItemsModal date={deadlinesOverflow.iso} chips={deadlinesOverflow.chips} onOpenMenu={openChipMenu} onClose={() => setDeadlinesOverflow(null)} />
      )}
      {editingMeeting && editingMeeting.isOwner === false ? (
        <MeetingViewModal
          meeting={editingMeeting}
          onClose={() => setEditingMeeting(null)}
          onLeave={() => leaveMeeting(editingMeeting.id)} />
      ) : (creatingMeeting || editingMeeting) && (
        <MeetingModal
          initial={editingMeeting}
          presetDate={creatingMeeting?.date}
          presetStart={creatingMeeting?.startTime}
          presetEnd={creatingMeeting?.endTime}
          seriesCount={editingMeeting?.recurrenceId ? meetings.filter(m => m.recurrenceId === editingMeeting.recurrenceId).length : undefined}
          onSave={saveMeeting}
          onDelete={editingMeeting ? deleteMeeting : undefined}
          onClose={() => { setCreatingMeeting(null); setEditingMeeting(null); }} />
      )}

      <style>{`.cal-cell:hover .cal-add-btn { opacity: 1 !important; }`}</style>
    </div>
  );
}
