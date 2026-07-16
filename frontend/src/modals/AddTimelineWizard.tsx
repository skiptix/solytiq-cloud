import { useState, useRef, useEffect } from 'react';
import type { Timeline, TimelineLayout, MilestoneStatus } from '../types';
import useAppStore from '../store/useAppStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import { apiCreateTimeline, apiCreateMilestone } from '../api/client';
import { genId } from '../utils/id';
import Icon from '../components/Icon';
import EmojiSelector from '../components/EmojiSelector';
import CalendarPicker from '../components/CalendarPicker';
import TimePicker from '../components/TimePicker';

const COLORS = [
  { color: 'var(--color-primary)', bg: 'var(--color-surface-tint)' },
  { color: 'var(--color-blue-mid-7)', bg: 'var(--color-blue-pale-2)' },
  { color: 'var(--color-success)', bg: 'rgba(var(--color-success-rgb), 0.10)' },
  { color: 'var(--color-orange)', bg: 'var(--color-orange-pale-3)' },
  { color: 'var(--color-warning-alt)', bg: 'var(--color-yellow-pale-1)' },
  { color: 'var(--color-error)', bg: 'var(--color-error-bg)' },
];

const LAYOUTS: Array<{ key: TimelineLayout; label: string; desc: string; icon: string }> = [
  { key: 'vertical', label: 'Vertical', desc: 'Classic dated rail with nodes', icon: 'timeline' },
  { key: 'compact', label: 'Compact', desc: 'Dense rows, minimal spacing', icon: 'view_agenda' },
  { key: 'detailed', label: 'Detailed', desc: 'Roomy cards with notes', icon: 'view_day' },
];

const MILESTONE_STATUSES: Array<{ key: MilestoneStatus; label: string; color: string; icon: string }> = [
  { key: 'upcoming', label: 'Upcoming', color: 'var(--color-accent-purple-light)', icon: 'schedule' },
  { key: 'in-progress', label: 'In progress', color: 'var(--color-orange)', icon: 'pending' },
  { key: 'done', label: 'Done', color: 'var(--color-success)', icon: 'check_circle' },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDate(date?: string | null) {
  if (!date) return null;
  const parts = date.split('-');
  if (parts.length !== 3) return date;
  const [y, m, d] = parts.map(Number);
  if (!m || !d) return date;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

interface MilestoneDraft {
  id: string;
  title: string;
  date: string;
  time: string;
  description: string;
  status: MilestoneStatus;
  emoji: string;
}

interface AddTimelineWizardProps {
  onClose: () => void;
  onCreated: (timeline: Timeline) => void;
}

export default function AddTimelineWizard({ onClose, onCreated }: AddTimelineWizardProps) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [emoji, setEmoji] = useState('🗓️');
  const [isPublic, setIsPublic] = useState(false);
  const [colorIdx, setColorIdx] = useState(0);
  const [layout, setLayout] = useState<TimelineLayout>('vertical');
  const [milestones, setMilestones] = useState<MilestoneDraft[]>([]);

  // New-milestone draft fields
  const [mTitle, setMTitle] = useState('');
  const [mDate, setMDate] = useState('');
  const [mTime, setMTime] = useState('');
  const [mDesc, setMDesc] = useState('');
  const [mStatus, setMStatus] = useState<MilestoneStatus>('upcoming');
  const [mEmoji, setMEmoji] = useState('📍');
  const [showCal, setShowCal] = useState(false);
  const calRef = useRef<HTMLDivElement>(null);
  const [showTime, setShowTime] = useState(false);
  const timeRef = useRef<HTMLDivElement>(null);

  // Close calendar on outside click
  useEffect(() => {
    if (!showCal) return;
    const handler = (e: MouseEvent) => {
      if (calRef.current && !calRef.current.contains(e.target as Node)) setShowCal(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showCal]);

  // Close time picker on outside click
  useEffect(() => {
    if (!showTime) return;
    const handler = (e: MouseEvent) => {
      if (timeRef.current && !timeRef.current.contains(e.target as Node)) setShowTime(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showTime]);

  const [loading, setLoading] = useState(false);
  const [createError, setCreateError] = useState('');

  const { setTimelines, loadFromApi } = useAppStore();
  const currentWorkspaceId = useWorkspaceStore(s => s.currentWorkspaceId);
  const selectedColor = COLORS[colorIdx];

  const addMilestone = () => {
    if (!mTitle.trim()) return;
    setMilestones(ms => [...ms, {
      id: genId('milestone'),
      title: mTitle.trim(),
      date: mDate,
      time: mTime,
      description: mDesc.trim(),
      status: mStatus,
      emoji: mEmoji,
    }]);
    setMTitle(''); setMDate(''); setMTime(''); setMDesc(''); setMStatus('upcoming'); setMEmoji('📍');
  };

  // Sort drafts chronologically for preview/summary; undated go last.
  const sortedMilestones = [...milestones].sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date.localeCompare(b.date);
  });

  const handleCreate = async () => {
    if (!name.trim()) return;
    setLoading(true);
    setCreateError('');
    try {
      const timelineId = genId('timeline');
      const res = await apiCreateTimeline({
        id: timelineId,
        name: name.trim(),
        emoji,
        isPublic,
        layout,
        color: selectedColor.color,
        colorBg: selectedColor.bg,
        subtitle: subtitle.trim() || undefined,
        workspaceId: currentWorkspaceId ?? undefined,
      });
      const created = res.timeline;
      setTimelines(prev => [...prev, { ...created, milestones: [] }]);
      // Create milestones sequentially in chronological order.
      for (const m of sortedMilestones) {
        try {
          await apiCreateMilestone(created.id, {
            id: m.id,
            title: m.title,
            date: m.date || null,
            time: m.time || null,
            description: m.description || null,
            status: m.status,
            emoji: m.emoji || null,
          });
        } catch (e) { console.error('milestone create failed', e); }
      }
      await loadFromApi(currentWorkspaceId ?? undefined);
      const saved = useAppStore.getState().timelines.find(t => t.id === created.id) ?? { ...created, milestones: [] };
      onCreated(saved as Timeline);
    } catch (e) {
      console.error('createTimeline failed', e);
      setCreateError('Failed to create timeline. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  const inputStyle: React.CSSProperties = { width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, border: 'none', borderBottom: '1.5px solid var(--color-border-alt)', padding: '8px 0', outline: 'none', color: 'var(--color-text-primary)', background: 'transparent' };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 24px', overflowY: 'auto' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ margin: 'auto', background: 'var(--color-white)', borderRadius: 16, width: '100%', maxWidth: 520, display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid var(--color-surface-tint-2)', flexShrink: 0 }}>
          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>
            {step === 0 ? 'New Timeline' : step === 1 ? 'Add Milestones' : 'Review & Create'}
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 2 }}>
            <Icon name="close" size={18} color="var(--color-text-tertiary)" />
          </button>
        </div>

        {/* Progress */}
        <div style={{ display: 'flex', gap: 4, padding: '12px 24px 0', flexShrink: 0 }}>
          {[0, 1, 2].map(i => <div key={i} style={{ flex: 1, height: 3, borderRadius: 9999, background: i <= step ? selectedColor.color : 'var(--color-border)', transition: 'background 300ms' }} />)}
        </div>

        <div style={{ padding: '20px 24px 24px' }}>
          {step === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {/* Emoji */}
              <div>
                <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 8 }}>Icon</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <EmojiSelector value={emoji} onChange={setEmoji} direction="down" size={40} allowRemove={false} />
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>Click to choose an emoji</span>
                </div>
              </div>
              {/* Name */}
              <div>
                <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 }}>Timeline Name *</label>
                <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Product Launch"
                  style={inputStyle}
                  onFocus={e => (e.target.style.borderBottomColor = selectedColor.color)}
                  onBlur={e => (e.target.style.borderBottomColor = 'var(--color-border-alt)')} />
              </div>
              {/* Subtitle */}
              <div>
                <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 }}>Subtitle</label>
                <input value={subtitle} onChange={e => setSubtitle(e.target.value)} placeholder="Optional description"
                  style={inputStyle}
                  onFocus={e => (e.target.style.borderBottomColor = selectedColor.color)}
                  onBlur={e => (e.target.style.borderBottomColor = 'var(--color-border-alt)')} />
              </div>
              {/* Layout */}
              <div>
                <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 8 }}>Layout</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {LAYOUTS.map(l => {
                    const sel = layout === l.key;
                    return (
                      <button key={l.key} onClick={() => setLayout(l.key)}
                        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${sel ? selectedColor.color : 'var(--color-border-alt)'}`, background: sel ? selectedColor.bg : 'var(--color-white)', cursor: 'pointer', textAlign: 'left', transition: 'all 150ms' }}>
                        <Icon name={l.icon} size={20} color={sel ? selectedColor.color : 'var(--color-accent-purple-light)'} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)' }}>{l.label}</div>
                          <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>{l.desc}</div>
                        </div>
                        {sel && <Icon name="check_circle" size={18} color={selectedColor.color} />}
                      </button>
                    );
                  })}
                </div>
              </div>
              {/* Privacy */}
              <div>
                <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 8 }}>Privacy</label>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={() => setIsPublic(false)}
                    style={{ flex: 1, padding: '10px', borderRadius: 10, border: `1.5px solid ${!isPublic ? selectedColor.color : 'var(--color-border-alt)'}`, background: !isPublic ? selectedColor.bg : 'var(--color-white)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'all 150ms' }}>
                    <Icon name="lock" size={16} color={!isPublic ? selectedColor.color : 'var(--color-text-tertiary)'} />
                    <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: !isPublic ? selectedColor.color : 'var(--color-text-tertiary)' }}>Private</span>
                  </button>
                  <button onClick={() => setIsPublic(true)}
                    style={{ flex: 1, padding: '10px', borderRadius: 10, border: `1.5px solid ${isPublic ? selectedColor.color : 'var(--color-border-alt)'}`, background: isPublic ? selectedColor.bg : 'var(--color-white)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'all 150ms' }}>
                    <Icon name="public" size={16} color={isPublic ? selectedColor.color : 'var(--color-text-tertiary)'} />
                    <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: isPublic ? selectedColor.color : 'var(--color-text-tertiary)' }}>Public</span>
                  </button>
                </div>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 6 }}>
                  {isPublic ? 'Everyone in this workspace can see this timeline.' : 'Only you can see and edit this timeline.'}
                </div>
              </div>
              {/* Color */}
              <div>
                <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 8 }}>Accent Color</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {COLORS.map((c, i) => (
                    <button key={i} onClick={() => setColorIdx(i)}
                      style={{ width: 32, height: 32, borderRadius: '50%', background: c.color, border: `3px solid ${colorIdx === i ? 'var(--color-text-primary)' : 'transparent'}`, cursor: 'pointer', transition: 'all 150ms' }} />
                  ))}
                </div>
              </div>
              {/* Preview */}
              <div style={{ background: selectedColor.bg, border: `1px solid ${selectedColor.color}40`, borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 20 }}>{emoji}</span>
                <div>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)' }}>{name || 'Timeline Name'}</div>
                  {subtitle && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>{subtitle}</div>}
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)' }}>Milestones are the dated points on your timeline. Add some now or skip and add them later.</div>

              {/* Existing milestones */}
              {sortedMilestones.map(m => {
                const st = MILESTONE_STATUSES.find(s => s.key === m.status)!;
                return (
                  <div key={m.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', background: 'var(--color-purple-pale-11)', borderRadius: 10, border: '1px solid var(--color-border)' }}>
                    <span style={{ fontSize: 16, marginTop: 1 }}>{m.emoji}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)' }}>{m.title}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, flexWrap: 'wrap' }}>
                        {m.date && <span style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>{m.date}{m.time ? ` · ${m.time}` : ''}</span>}
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-heading)', fontSize: 10.5, fontWeight: 700, color: st.color, background: `${st.color}1a`, padding: '1px 7px', borderRadius: 9999, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                          <Icon name={st.icon} size={11} color={st.color} />{st.label}
                        </span>
                      </div>
                      {m.description && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 3 }}>{m.description}</div>}
                    </div>
                    <button onClick={() => setMilestones(ms => ms.filter(x => x.id !== m.id))} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: 2 }}>
                      <Icon name="close" size={14} color="var(--color-text-tertiary)" />
                    </button>
                  </div>
                );
              })}

              {/* New milestone form */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '14px', borderRadius: 12, border: '1.5px dashed var(--color-purple-tint-3)', background: 'var(--color-purple-pale-2)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <EmojiSelector value={mEmoji} onChange={setMEmoji} direction="down" size={38} allowRemove={false} />
                  <input value={mTitle} onChange={e => setMTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && addMilestone()} placeholder="Milestone title…"
                    style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 14, border: '1.5px solid var(--color-border)', borderRadius: 8, padding: '8px 12px', outline: 'none', background: 'var(--color-white)' }}
                    onFocus={e => (e.target.style.borderColor = selectedColor.color)} onBlur={e => (e.target.style.borderColor = 'var(--color-border)')} />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1, position: 'relative' }} ref={calRef}>
                    <label style={{ fontFamily: 'var(--font-heading)', fontSize: 10.5, fontWeight: 600, color: 'var(--color-text-tertiary)', display: 'block', marginBottom: 3 }}>Date</label>
                    <button
                      type="button"
                      onClick={() => setShowCal(v => !v)}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', borderRadius: 8, border: `1.5px solid ${showCal ? selectedColor.color : 'var(--color-border)'}`, background: 'var(--color-white)', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 13, color: mDate ? 'var(--color-text-primary)' : 'var(--color-text-quaternary)', transition: 'border-color 150ms', textAlign: 'left' }}
                    >
                      <Icon name="calendar_today" size={14} color={mDate ? selectedColor.color : 'var(--color-border-strong)'} />
                      {mDate ? fmtDate(mDate) : 'dd.mm.yyyy'}
                    </button>
                    {showCal && (
                      <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 50 }}>
                        <CalendarPicker
                          value={mDate || undefined}
                          onChange={d => { setMDate(d); setShowCal(false); }}
                          onClear={() => { setMDate(''); setShowCal(false); }}
                        />
                      </div>
                    )}
                  </div>
                  <div style={{ width: 120, position: 'relative' }} ref={timeRef}>
                    <label style={{ fontFamily: 'var(--font-heading)', fontSize: 10.5, fontWeight: 600, color: 'var(--color-text-tertiary)', display: 'block', marginBottom: 3 }}>Time</label>
                    <button
                      type="button"
                      onClick={() => setShowTime(v => !v)}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', borderRadius: 8, border: `1.5px solid ${showTime ? selectedColor.color : 'var(--color-border)'}`, background: 'var(--color-white)', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 13, color: mTime ? 'var(--color-text-primary)' : 'var(--color-text-quaternary)', transition: 'border-color 150ms', textAlign: 'left' }}
                    >
                      <Icon name="schedule" size={14} color={mTime ? selectedColor.color : 'var(--color-border-strong)'} />
                      {mTime || '--:--'}
                    </button>
                    {showTime && (
                      <div style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 50 }}>
                        <TimePicker
                          value={mTime || undefined}
                          onChange={t => setMTime(t)}
                          onClear={() => { setMTime(''); setShowTime(false); }}
                        />
                      </div>
                    )}
                  </div>
                </div>
                <div>
                  <label style={{ fontFamily: 'var(--font-heading)', fontSize: 10.5, fontWeight: 600, color: 'var(--color-text-tertiary)', display: 'block', marginBottom: 4 }}>Status</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {MILESTONE_STATUSES.map(s => {
                      const sel = mStatus === s.key;
                      return (
                        <button key={s.key} onClick={() => setMStatus(s.key)}
                          style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '7px 6px', borderRadius: 8, border: `1.5px solid ${sel ? s.color : 'var(--color-border)'}`, background: sel ? `${s.color}14` : 'var(--color-white)', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 600, color: sel ? s.color : 'var(--color-text-tertiary)', transition: 'all 140ms' }}>
                          <Icon name={s.icon} size={13} color={sel ? s.color : 'var(--color-accent-purple-light)'} />{s.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <input value={mDesc} onChange={e => setMDesc(e.target.value)} placeholder="Notes (optional)"
                  style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 13, border: '1.5px solid var(--color-border)', borderRadius: 8, padding: '7px 10px', outline: 'none', background: 'var(--color-white)' }}
                  onFocus={e => (e.target.style.borderColor = selectedColor.color)} onBlur={e => (e.target.style.borderColor = 'var(--color-border)')} />
                <button onClick={addMilestone} disabled={!mTitle.trim()}
                  style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: mTitle.trim() ? selectedColor.color : 'var(--color-border-strong)', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: mTitle.trim() ? 'pointer' : 'default' }}>
                  <Icon name="add" size={15} color="var(--color-white)" /> Add milestone
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ background: selectedColor.bg, border: `1px solid ${selectedColor.color}40`, borderRadius: 12, padding: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <span style={{ fontSize: 24 }}>{emoji}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)' }}>{name}</div>
                    {subtitle && <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)' }}>{subtitle}</div>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(var(--color-white-rgb), 0.5)', padding: '4px 8px', borderRadius: 8 }}>
                    <Icon name={isPublic ? 'public' : 'lock'} size={14} color="var(--color-text-tertiary)" />
                    <span style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase' }}>{isPublic ? 'Public' : 'Private'}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: milestones.length ? 12 : 0 }}>
                  <Icon name={LAYOUTS.find(l => l.key === layout)!.icon} size={14} color={selectedColor.color} />
                  <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)' }}>{LAYOUTS.find(l => l.key === layout)!.label} layout · {milestones.length} milestone{milestones.length === 1 ? '' : 's'}</span>
                </div>
                {sortedMilestones.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 4, borderLeft: `2px solid ${selectedColor.color}40` }}>
                    {sortedMilestones.map(m => (
                      <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 10 }}>
                        <span style={{ fontSize: 13 }}>{m.emoji}</span>
                        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)' }}>{m.title}</span>
                        {m.date && <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-tertiary)' }}>· {m.date}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {createError && (
          <div style={{ margin: '0 24px 8px', padding: '8px 12px', background: 'var(--color-error-bg)', borderRadius: 8, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>
            {createError}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, padding: '12px 24px 24px', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--color-surface-tint-2)', flexShrink: 0 }}>
          {step > 0 ? (
            <button onClick={() => setStep(s => s - 1)} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: 'none', cursor: 'pointer', padding: '10px 0', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Icon name="chevron_left" size={14} color="var(--color-text-secondary)" /> Back
            </button>
          ) : <div />}
          {step < 2 ? (
            <button onClick={() => setStep(s => s + 1)} disabled={step === 0 && !name.trim()}
              style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: (step === 0 && !name.trim()) ? 'var(--color-border-strong)' : selectedColor.color, border: 'none', borderRadius: 8, padding: '10px 24px', cursor: (step === 0 && !name.trim()) ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
              {step === 1 ? 'Review' : 'Next'} <Icon name="arrow_forward" size={14} color="var(--color-white)" />
            </button>
          ) : (
            <button onClick={handleCreate} disabled={loading}
              style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: loading ? 'var(--color-accent-purple-light)' : selectedColor.color, border: 'none', borderRadius: 8, padding: '10px 24px', cursor: loading ? 'wait' : 'pointer' }}>
              {loading ? 'Creating…' : 'Create Timeline'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
