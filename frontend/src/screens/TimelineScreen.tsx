import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Milestone, MilestoneStatus, TimelineLayout } from '../types';
import useAppStore from '../store/useAppStore';
import useAuthStore from '../store/useAuthStore';
import useUserPrefsStore from '../store/useUserPrefsStore';
import { todayInTz } from '../utils/date';
import { apiCreateMilestone, apiUpdateMilestone, apiDeleteMilestone } from '../api/client';
import { genId } from '../utils/id';
import Icon from '../components/Icon';
import EmojiSelector from '../components/EmojiSelector';
import CalendarPicker from '../components/CalendarPicker';

const STATUSES: Array<{ key: MilestoneStatus; label: string; color: string; icon: string }> = [
  { key: 'upcoming', label: 'Upcoming', color: '#9d8dff', icon: 'schedule' },
  { key: 'in-progress', label: 'In progress', color: '#ea580c', icon: 'pending' },
  { key: 'done', label: 'Done', color: '#10B981', icon: 'check_circle' },
];

const MILESTONE_COLORS = ['#5e4dbb', '#1D4ED8', '#10B981', '#ea580c', '#f59e0b', '#ba1a1a', '#db2777', '#0d9488'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function statusOf(key: MilestoneStatus) {
  return STATUSES.find(s => s.key === key) ?? STATUSES[0];
}

function fmtDate(date?: string | null) {
  if (!date) return null;
  const parts = date.split('-');
  if (parts.length !== 3) return date;
  const [y, m, d] = parts.map(Number);
  if (!m || !d) return date;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

// Chronological order; undated milestones fall to the bottom by position.
function sortMilestones(ms: Milestone[]): Milestone[] {
  return [...ms].sort((a, b) => {
    if (a.date && b.date) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    } else if (a.date) return -1;
    else if (b.date) return 1;
    return (a.position ?? 0) - (b.position ?? 0);
  });
}

// ── Milestone editor (add / edit) ─────────────────────────────────────────────
interface MilestoneEditorProps {
  accent: string;
  initial?: Milestone;
  onSave: (data: Partial<Milestone>) => void;
  onClose: () => void;
}
function MilestoneEditor({ accent, initial, onSave, onClose }: MilestoneEditorProps) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [date, setDate] = useState(initial?.date ?? '');
  const [time, setTime] = useState(initial?.time ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [status, setStatus] = useState<MilestoneStatus>(initial?.status ?? 'upcoming');
  const [emoji, setEmoji] = useState(initial?.emoji ?? '📍');
  const [color, setColor] = useState<string | null>(initial?.color ?? null);
  const [dateError, setDateError] = useState(false);
  const [showCal, setShowCal] = useState(false);
  const calRef = useRef<HTMLDivElement>(null);

  // Close calendar on outside click
  useEffect(() => {
    if (!showCal) return;
    const handler = (e: MouseEvent) => {
      if (calRef.current && !calRef.current.contains(e.target as Node)) setShowCal(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showCal]);

  const save = () => {
    if (!title.trim()) return;
    if (!date) { setDateError(true); return; }
    onSave({
      title: title.trim(),
      date: date,
      time: time || null,
      description: description.trim() || null,
      status,
      emoji: emoji || null,
      color: color ?? null,
    });
  };

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'backdropIn 200ms ease both' }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 460, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid #f1ecf6', flexShrink: 0 }}>
          <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>{initial ? 'Edit Milestone' : 'New Milestone'}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 2 }}>
            <Icon name="close" size={18} color="#787584" />
          </button>
        </div>

        <div style={{ padding: '18px 24px 22px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <EmojiSelector value={emoji} onChange={setEmoji} direction="down" size={40} allowRemove={false} />
            <input autoFocus value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} placeholder="Milestone title"
              style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 14.5, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '9px 12px', outline: 'none', background: '#fff' }}
              onFocus={e => (e.target.style.borderColor = accent)} onBlur={e => (e.target.style.borderColor = '#e8e4f0')} />
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1, position: 'relative' }} ref={calRef}>
              <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: dateError ? '#ba1a1a' : '#787584', display: 'block', marginBottom: 4 }}>Date *</label>
              {/* Trigger button — same look as task deadline picker */}
              <button
                type="button"
                onClick={() => { setShowCal(v => !v); setDateError(false); }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 7, padding: '8px 10px', borderRadius: 8, border: `1.5px solid ${dateError ? '#ba1a1a' : showCal ? accent : '#e8e4f0'}`, background: dateError ? '#fff8f7' : '#fff', cursor: 'pointer', fontFamily: 'Inter, sans-serif', fontSize: 13.5, color: date ? '#1c1b22' : '#b0acbe', transition: 'border-color 150ms', textAlign: 'left' }}
              >
                <Icon name="calendar_today" size={14} color={date ? accent : '#c9c4d5'} />
                {date ? fmtDate(date) : 'Pick a date…'}
              </button>
              {dateError && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#ba1a1a', marginTop: 3 }}>A date is required.</div>}
              {/* Calendar dropdown */}
              {showCal && (
                <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 50 }}>
                  <CalendarPicker
                    value={date || undefined}
                    onChange={d => { setDate(d); setShowCal(false); setDateError(false); }}
                    onClear={() => { setDate(''); setShowCal(false); }}
                  />
                </div>
              )}
            </div>
            <div style={{ width: 130 }}>
              <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#787584', display: 'block', marginBottom: 4 }}>Time</label>
              <input type="time" value={time ?? ''} onChange={e => setTime(e.target.value)}
                style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 13.5, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '8px 10px', outline: 'none', background: '#fff', color: '#1c1b22' }} />
            </div>
          </div>

          <div>
            <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#787584', display: 'block', marginBottom: 5 }}>Status</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {STATUSES.map(s => {
                const sel = status === s.key;
                return (
                  <button key={s.key} onClick={() => setStatus(s.key)}
                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '8px 6px', borderRadius: 8, border: `1.5px solid ${sel ? s.color : '#e8e4f0'}`, background: sel ? `${s.color}14` : '#fff', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 600, color: sel ? s.color : '#787584', transition: 'all 140ms' }}>
                    <Icon name={s.icon} size={13} color={sel ? s.color : '#9d8dff'} />{s.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#787584', display: 'block', marginBottom: 5 }}>Accent</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center' }}>
              <button onClick={() => setColor(null)} title="Match status"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 24, padding: '0 10px', borderRadius: 9999, background: color === null ? '#f0edff' : '#fff', border: `1.5px solid ${color === null ? accent : '#e8e4f0'}`, cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: color === null ? accent : '#787584' }}>
                Auto
              </button>
              {MILESTONE_COLORS.map(c => (
                <button key={c} onClick={() => setColor(c)} title={c}
                  style={{ width: 24, height: 24, borderRadius: '50%', background: c, border: color === c ? '2.5px solid #1c1b22' : '2px solid transparent', cursor: 'pointer', padding: 0 }} />
              ))}
            </div>
          </div>

          <div>
            <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#787584', display: 'block', marginBottom: 5 }}>Notes</label>
            <textarea value={description ?? ''} onChange={e => setDescription(e.target.value)} placeholder="Optional notes…" rows={3}
              style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 13.5, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '9px 11px', outline: 'none', background: '#fff', resize: 'vertical', color: '#1c1b22' }}
              onFocus={e => (e.target.style.borderColor = accent)} onBlur={e => (e.target.style.borderColor = '#e8e4f0')} />
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '12px 24px 18px', borderTop: '1px solid #f1ecf6', flexShrink: 0 }}>
          <button onClick={onClose} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: '1px solid #E5E7EB', borderRadius: 8, padding: '9px 18px', cursor: 'pointer' }}>Cancel</button>
          <button onClick={save} disabled={!title.trim()}
            style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: title.trim() ? accent : '#c9c4d5', border: 'none', borderRadius: 8, padding: '9px 22px', cursor: title.trim() ? 'pointer' : 'default' }}>
            {initial ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Timeline screen ────────────────────────────────────────────────────────────
export default function TimelineScreen() {
  const { timelineId } = useParams<{ timelineId: string }>();
  const navigate = useNavigate();
  const { userId: currentUserId } = useAuthStore();
  const { timelines, listsLoading, setTimelines, loadFromApi } = useAppStore();
  const timezone = useUserPrefsStore(s => s.timezone);
  const today = todayInTz(timezone);
  const timeline = timelines.find(t => t.id === timelineId);

  const [editing, setEditing] = useState<Milestone | null>(null);
  const [adding, setAdding] = useState(false);

  if (!timeline) {
    if (listsLoading) {
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 32, height: 32, border: '3px solid #e8e4f0', borderTopColor: '#5e4dbb', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
        </div>
      );
    }
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 18, fontWeight: 700, color: '#1c1b22', marginBottom: 8 }}>Timeline not found</div>
          <button onClick={() => navigate('/dashboard')} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer' }}>Go to Dashboard</button>
        </div>
      </div>
    );
  }

  const accent = timeline.color ?? '#5e4dbb';
  const bg = timeline.colorBg ?? '#F9FAFB';
  const layout: TimelineLayout = timeline.layout ?? 'vertical';
  const isOwner = timeline.userId === currentUserId;
  const milestones = sortMilestones(timeline.milestones);
  const total = milestones.length;

  // Date-based progress: a milestone counts as reached when its date <= today,
  // OR when it was manually marked done.
  const reachedCount = milestones.filter(m => m.status === 'done' || (m.date != null && m.date <= today)).length;
  const done = milestones.filter(m => m.status === 'done').length;
  const pct = total > 0 ? Math.round((reachedCount / total) * 100) : 0;

  // Index of the last milestone that is reached (for rail fill height).
  const lastReachedIdx = milestones.reduce((acc, m, i) =>
    (m.status === 'done' || (m.date != null && m.date <= today)) ? i : acc, -1);

  // Layout density knobs.
  const gap = layout === 'compact' ? 8 : layout === 'detailed' ? 26 : 16;
  const nodeSize = layout === 'detailed' ? 20 : layout === 'compact' ? 13 : 16;
  const cardPad = layout === 'compact' ? '8px 12px' : layout === 'detailed' ? '16px 18px' : '12px 14px';
  const titleSize = layout === 'detailed' ? 16 : layout === 'compact' ? 13.5 : 14.5;

  const updateStoreMilestones = (fn: (ms: Milestone[]) => Milestone[]) =>
    setTimelines(prev => prev.map(t => (t.id === timeline.id ? { ...t, milestones: fn(t.milestones) } : t)));

  const handleAdd = (data: Partial<Milestone>) => {
    const id = genId('milestone');
    const optimistic: Milestone = {
      id,
      timelineId: timeline.id,
      title: data.title ?? '',
      date: data.date ?? null,
      time: data.time ?? null,
      description: data.description ?? null,
      status: (data.status as MilestoneStatus) ?? 'upcoming',
      emoji: data.emoji ?? null,
      color: data.color ?? null,
      position: timeline.milestones.length,
    };
    updateStoreMilestones(ms => [...ms, optimistic]);
    setAdding(false);
    apiCreateMilestone(timeline.id, { id, title: optimistic.title, date: optimistic.date, time: optimistic.time, description: optimistic.description, status: optimistic.status, emoji: optimistic.emoji, color: optimistic.color })
      .catch(() => loadFromApi());
  };

  const handleSave = (milestoneId: string, data: Partial<Milestone>) => {
    updateStoreMilestones(ms => ms.map(m => (m.id === milestoneId ? { ...m, ...data } : m)));
    setEditing(null);
    apiUpdateMilestone(milestoneId, data).catch(() => loadFromApi());
  };

  const handleDelete = (milestoneId: string) => {
    updateStoreMilestones(ms => ms.filter(m => m.id !== milestoneId));
    apiDeleteMilestone(milestoneId).catch(() => loadFromApi());
  };

  const cycleStatus = (m: Milestone) => {
    if (!isOwner) return;
    const order: MilestoneStatus[] = ['upcoming', 'in-progress', 'done'];
    const next = order[(order.indexOf(m.status) + 1) % order.length];
    handleSave(m.id, { status: next });
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: '#fff' }}>
      {/* Hero */}
      <div style={{ background: bg, borderBottom: '1px solid #f0ecf8', padding: '32px 40px 26px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, maxWidth: 860, margin: '0 auto' }}>
          <div style={{ width: 56, height: 56, borderRadius: 16, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, boxShadow: '0 2px 10px rgba(0,0,0,0.06)', flexShrink: 0 }}>
            {timeline.emoji ?? <Icon name="timeline" size={28} color={accent} />}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h1 style={{ margin: 0, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 26, fontWeight: 800, color: '#1c1b22' }}>{timeline.name}</h1>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: accent, background: '#fff', padding: '3px 9px', borderRadius: 9999, border: `1px solid ${accent}33` }}>
                <Icon name="timeline" size={13} color={accent} /> Timeline
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#787584' }}>
                <Icon name={timeline.isPublic ? 'public' : 'lock'} size={13} color="#787584" />{timeline.isPublic ? 'Public' : 'Private'}
              </span>
            </div>
            {timeline.subtitle && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#787584', marginTop: 4 }}>{timeline.subtitle}</div>}
            {/* Progress */}
            <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1, maxWidth: 320, height: 8, borderRadius: 9999, background: 'rgba(0,0,0,0.07)', overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', borderRadius: 9999, background: accent, transition: 'width 400ms ease' }} />
              </div>
              <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, color: '#484552' }}>{done}/{total} done · {pct}%</span>
            </div>
          </div>
          {isOwner && (
            <button onClick={() => setAdding(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 10, border: 'none', background: accent, color: '#fff', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', flexShrink: 0, boxShadow: `0 4px 14px ${accent}40` }}>
              <Icon name="add" size={17} color="#fff" /> Milestone
            </button>
          )}
        </div>
      </div>

      {/* Timeline body */}
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '28px 40px 80px' }}>
        {total === 0 ? (
          <div style={{ textAlign: 'center', padding: '56px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 64, height: 64, borderRadius: 18, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="timeline" size={32} color={accent} />
            </div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 18, fontWeight: 700, color: '#1c1b22' }}>No milestones yet</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13.5, color: '#787584', maxWidth: 300, lineHeight: 1.6 }}>
              {isOwner ? 'Add your first milestone to start building this timeline.' : 'This timeline has no milestones yet.'}
            </div>
            {isOwner && (
              <button onClick={() => setAdding(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 20px', borderRadius: 10, border: 'none', background: accent, color: '#fff', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                <Icon name="add" size={17} color="#fff" /> Add Milestone
              </button>
            )}
          </div>
        ) : (
          <div style={{ position: 'relative', paddingLeft: 8 }}>
            {/* Vertical rail — grey background track */}
            <div style={{ position: 'absolute', left: 8 + nodeSize / 2 - 1, top: nodeSize / 2, bottom: nodeSize / 2, width: 2, background: '#e8e4f0', borderRadius: 2 }} />
            {/* Accent progress fill — grows from top to last reached node */}
            {lastReachedIdx >= 0 && (
              <div style={{
                position: 'absolute',
                left: 8 + nodeSize / 2 - 1,
                top: nodeSize / 2,
                // Fill to the center of the last reached node
                height: `calc(${((lastReachedIdx) / Math.max(total - 1, 1)) * 100}% + 0px)`,
                width: 2,
                background: accent,
                borderRadius: 2,
                transition: 'height 600ms cubic-bezier(0.4,0,0.2,1)',
                zIndex: 0,
              }} />
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap }}>
              {milestones.map((m) => {
                // A milestone is visually "reached" if its date is past/today OR manually done
                const dateReached = m.date != null && m.date <= today;
                const effectivelyDone = m.status === 'done' || dateReached;
                const effectiveStatus: MilestoneStatus = effectivelyDone ? 'done' : m.status;
                const st = statusOf(effectiveStatus);
                const dot = m.color ?? st.color;
                const dateLabel = fmtDate(m.date);
                const isPast = m.date ? m.date < today : false;
                const isToday = m.date === today;
                return (
                  <div key={m.id} style={{ position: 'relative', display: 'flex', gap: 18, alignItems: 'flex-start' }}>
                    {/* Node */}
                    <button
                      onClick={() => cycleStatus(m)}
                      title={isOwner ? `Status: ${st.label} — click to change` : st.label}
                      style={{ position: 'relative', zIndex: 1, width: nodeSize, height: nodeSize, borderRadius: '50%', flexShrink: 0, marginTop: 4, background: effectivelyDone ? dot : '#fff', border: `2.5px solid ${dot}`, cursor: isOwner ? 'pointer' : 'default', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 0 4px #fff', transition: 'all 300ms' }}>
                      {effectivelyDone && <Icon name="check" size={nodeSize - 7} color="#fff" />}
                      {!effectivelyDone && effectiveStatus === 'in-progress' && <div style={{ width: nodeSize / 3, height: nodeSize / 3, borderRadius: '50%', background: dot }} />}
                    </button>

                    {/* Card */}
                    <div style={{ flex: 1, minWidth: 0, background: effectivelyDone ? `${dot}08` : '#fff', border: `1px solid ${effectivelyDone ? dot + '30' : '#ece8f4'}`, borderLeft: `3px solid ${dot}`, borderRadius: 12, padding: cardPad, transition: 'box-shadow 150ms, background 300ms', boxShadow: '0 1px 3px rgba(0,0,0,0.03)' }}
                      onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.07)')}
                      onMouseLeave={e => (e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.03)')}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                        {m.emoji && <span style={{ fontSize: layout === 'detailed' ? 20 : 16, lineHeight: 1.2, flexShrink: 0 }}>{m.emoji}</span>}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: titleSize, fontWeight: 700, color: effectivelyDone ? '#787584' : '#1c1b22', textDecoration: effectivelyDone && m.status === 'done' ? 'line-through' : 'none', transition: 'color 300ms' }}>{m.title}</span>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10, fontWeight: 700, color: st.color, background: `${st.color}1a`, padding: '2px 8px', borderRadius: 9999, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                              <Icon name={st.icon} size={11} color={st.color} />{st.label}
                            </span>
                            {isToday && <span style={{ display: 'inline-flex', alignItems: 'center', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10, fontWeight: 700, color: '#ea580c', background: '#fff7ed', padding: '2px 8px', borderRadius: 9999, letterSpacing: '0.04em' }}>TODAY</span>}
                          </div>
                          {(dateLabel || m.time) && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontFamily: 'Inter, sans-serif', fontSize: 12, color: isPast && !isToday ? '#10B981' : '#787584' }}>
                              <Icon name="event" size={13} color={isPast && !isToday ? '#10B981' : '#9d8dff'} />
                              {dateLabel}{m.time ? `${dateLabel ? ' · ' : ''}${m.time}` : ''}
                            </div>
                          )}
                          {m.description && layout !== 'compact' && (
                            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#5a5664', marginTop: 6, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{m.description}</div>
                          )}
                        </div>
                        {isOwner && (
                          <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                            <button onClick={() => setEditing(m)} title="Edit milestone"
                              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer' }}
                              onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
                              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                              <Icon name="edit" size={15} color="#787584" />
                            </button>
                            <button onClick={() => handleDelete(m.id)} title="Delete milestone"
                              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer' }}
                              onMouseEnter={e => (e.currentTarget.style.background = '#fff0ef')}
                              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                              <Icon name="delete" size={15} color="#ba1a1a" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Add milestone footer (owner) */}
            {isOwner && (
              <button onClick={() => setAdding(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: gap, marginLeft: nodeSize + 18 + 8, padding: '10px 14px', borderRadius: 10, border: '1.5px dashed #d8d2e8', background: '#fcfbff', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: accent }}
                onMouseEnter={e => (e.currentTarget.style.background = bg)}
                onMouseLeave={e => (e.currentTarget.style.background = '#fcfbff')}>
                <Icon name="add" size={16} color={accent} /> Add milestone
              </button>
            )}
          </div>
        )}
      </div>

      {adding && <MilestoneEditor accent={accent} onSave={handleAdd} onClose={() => setAdding(false)} />}
      {editing && <MilestoneEditor accent={accent} initial={editing} onSave={data => handleSave(editing.id, data)} onClose={() => setEditing(null)} />}
    </div>
  );
}
