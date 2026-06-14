import { useState, useRef, useEffect } from 'react';
import type { Timeline, TimelineLayout, MilestoneStatus } from '../types';
import useAppStore from '../store/useAppStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import { apiCreateTimeline, apiCreateMilestone } from '../api/client';
import { genId } from '../utils/id';
import Icon from '../components/Icon';
import EmojiSelector from '../components/EmojiSelector';
import CalendarPicker from '../components/CalendarPicker';

const COLORS = [
  { color: '#5e4dbb', bg: '#F5F3FF' },
  { color: '#1D4ED8', bg: '#eff6ff' },
  { color: '#10B981', bg: 'rgba(16,185,129,0.10)' },
  { color: '#ea580c', bg: '#fff7ed' },
  { color: '#f59e0b', bg: '#fffbeb' },
  { color: '#ba1a1a', bg: '#ffdad6' },
];

const LAYOUTS: Array<{ key: TimelineLayout; label: string; desc: string; icon: string }> = [
  { key: 'vertical', label: 'Vertical', desc: 'Classic dated rail with nodes', icon: 'timeline' },
  { key: 'compact', label: 'Compact', desc: 'Dense rows, minimal spacing', icon: 'view_agenda' },
  { key: 'detailed', label: 'Detailed', desc: 'Roomy cards with notes', icon: 'view_day' },
];

const MILESTONE_STATUSES: Array<{ key: MilestoneStatus; label: string; color: string; icon: string }> = [
  { key: 'upcoming', label: 'Upcoming', color: '#9d8dff', icon: 'schedule' },
  { key: 'in-progress', label: 'In progress', color: '#ea580c', icon: 'pending' },
  { key: 'done', label: 'Done', color: '#10B981', icon: 'check_circle' },
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

  // Close calendar on outside click
  useEffect(() => {
    if (!showCal) return;
    const handler = (e: MouseEvent) => {
      if (calRef.current && !calRef.current.contains(e.target as Node)) setShowCal(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showCal]);

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

  const inputStyle: React.CSSProperties = { width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, border: 'none', borderBottom: '1.5px solid #E5E7EB', padding: '8px 0', outline: 'none', color: '#1c1b22', background: 'transparent' };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 24px', overflowY: 'auto' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ margin: 'auto', background: '#fff', borderRadius: 16, width: '100%', maxWidth: 520, display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid #f1ecf6', flexShrink: 0 }}>
          <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>
            {step === 0 ? 'New Timeline' : step === 1 ? 'Add Milestones' : 'Review & Create'}
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 2 }}>
            <Icon name="close" size={18} color="#787584" />
          </button>
        </div>

        {/* Progress */}
        <div style={{ display: 'flex', gap: 4, padding: '12px 24px 0', flexShrink: 0 }}>
          {[0, 1, 2].map(i => <div key={i} style={{ flex: 1, height: 3, borderRadius: 9999, background: i <= step ? selectedColor.color : '#e8e4f0', transition: 'background 300ms' }} />)}
        </div>

        <div style={{ padding: '20px 24px 24px' }}>
          {step === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {/* Emoji */}
              <div>
                <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', display: 'block', marginBottom: 8 }}>Icon</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <EmojiSelector value={emoji} onChange={setEmoji} direction="down" size={40} allowRemove={false} />
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe' }}>Click to choose an emoji</span>
                </div>
              </div>
              {/* Name */}
              <div>
                <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', display: 'block', marginBottom: 6 }}>Timeline Name *</label>
                <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Product Launch"
                  style={inputStyle}
                  onFocus={e => (e.target.style.borderBottomColor = selectedColor.color)}
                  onBlur={e => (e.target.style.borderBottomColor = '#E5E7EB')} />
              </div>
              {/* Subtitle */}
              <div>
                <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', display: 'block', marginBottom: 6 }}>Subtitle</label>
                <input value={subtitle} onChange={e => setSubtitle(e.target.value)} placeholder="Optional description"
                  style={inputStyle}
                  onFocus={e => (e.target.style.borderBottomColor = selectedColor.color)}
                  onBlur={e => (e.target.style.borderBottomColor = '#E5E7EB')} />
              </div>
              {/* Layout */}
              <div>
                <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', display: 'block', marginBottom: 8 }}>Layout</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {LAYOUTS.map(l => {
                    const sel = layout === l.key;
                    return (
                      <button key={l.key} onClick={() => setLayout(l.key)}
                        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${sel ? selectedColor.color : '#E5E7EB'}`, background: sel ? selectedColor.bg : '#fff', cursor: 'pointer', textAlign: 'left', transition: 'all 150ms' }}>
                        <Icon name={l.icon} size={20} color={sel ? selectedColor.color : '#9d8dff'} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 600, color: '#1c1b22' }}>{l.label}</div>
                          <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#787584' }}>{l.desc}</div>
                        </div>
                        {sel && <Icon name="check_circle" size={18} color={selectedColor.color} />}
                      </button>
                    );
                  })}
                </div>
              </div>
              {/* Privacy */}
              <div>
                <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', display: 'block', marginBottom: 8 }}>Privacy</label>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={() => setIsPublic(false)}
                    style={{ flex: 1, padding: '10px', borderRadius: 10, border: `1.5px solid ${!isPublic ? selectedColor.color : '#E5E7EB'}`, background: !isPublic ? selectedColor.bg : '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'all 150ms' }}>
                    <Icon name="lock" size={16} color={!isPublic ? selectedColor.color : '#787584'} />
                    <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: !isPublic ? selectedColor.color : '#787584' }}>Private</span>
                  </button>
                  <button onClick={() => setIsPublic(true)}
                    style={{ flex: 1, padding: '10px', borderRadius: 10, border: `1.5px solid ${isPublic ? selectedColor.color : '#E5E7EB'}`, background: isPublic ? selectedColor.bg : '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'all 150ms' }}>
                    <Icon name="public" size={16} color={isPublic ? selectedColor.color : '#787584'} />
                    <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: isPublic ? selectedColor.color : '#787584' }}>Public</span>
                  </button>
                </div>
                <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584', marginTop: 6 }}>
                  {isPublic ? 'Everyone in this workspace can see this timeline.' : 'Only you can see and edit this timeline.'}
                </div>
              </div>
              {/* Color */}
              <div>
                <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', display: 'block', marginBottom: 8 }}>Accent Color</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {COLORS.map((c, i) => (
                    <button key={i} onClick={() => setColorIdx(i)}
                      style={{ width: 32, height: 32, borderRadius: '50%', background: c.color, border: `3px solid ${colorIdx === i ? '#1c1b22' : 'transparent'}`, cursor: 'pointer', transition: 'all 150ms' }} />
                  ))}
                </div>
              </div>
              {/* Preview */}
              <div style={{ background: selectedColor.bg, border: `1px solid ${selectedColor.color}40`, borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 20 }}>{emoji}</span>
                <div>
                  <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 700, color: '#1c1b22' }}>{name || 'Timeline Name'}</div>
                  {subtitle && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584' }}>{subtitle}</div>}
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584' }}>Milestones are the dated points on your timeline. Add some now or skip and add them later.</div>

              {/* Existing milestones */}
              {sortedMilestones.map(m => {
                const st = MILESTONE_STATUSES.find(s => s.key === m.status)!;
                return (
                  <div key={m.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', background: '#f7f4fc', borderRadius: 10, border: '1px solid #e8e4f0' }}>
                    <span style={{ fontSize: 16, marginTop: 1 }}>{m.emoji}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 600, color: '#1c1b22' }}>{m.title}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, flexWrap: 'wrap' }}>
                        {m.date && <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#787584' }}>{m.date}{m.time ? ` · ${m.time}` : ''}</span>}
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10.5, fontWeight: 700, color: st.color, background: `${st.color}1a`, padding: '1px 7px', borderRadius: 9999, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                          <Icon name={st.icon} size={11} color={st.color} />{st.label}
                        </span>
                      </div>
                      {m.description && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 3 }}>{m.description}</div>}
                    </div>
                    <button onClick={() => setMilestones(ms => ms.filter(x => x.id !== m.id))} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: 2 }}>
                      <Icon name="close" size={14} color="#787584" />
                    </button>
                  </div>
                );
              })}

              {/* New milestone form */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '14px', borderRadius: 12, border: '1.5px dashed #d8d2e8', background: '#fcfbff' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <EmojiSelector value={mEmoji} onChange={setMEmoji} direction="down" size={38} allowRemove={false} />
                  <input value={mTitle} onChange={e => setMTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && addMilestone()} placeholder="Milestone title…"
                    style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 14, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '8px 12px', outline: 'none', background: '#fff' }}
                    onFocus={e => (e.target.style.borderColor = selectedColor.color)} onBlur={e => (e.target.style.borderColor = '#e8e4f0')} />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1, position: 'relative' }} ref={calRef}>
                    <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10.5, fontWeight: 600, color: '#787584', display: 'block', marginBottom: 3 }}>Date</label>
                    <button
                      type="button"
                      onClick={() => setShowCal(v => !v)}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', borderRadius: 8, border: `1.5px solid ${showCal ? selectedColor.color : '#e8e4f0'}`, background: '#fff', cursor: 'pointer', fontFamily: 'Inter, sans-serif', fontSize: 13, color: mDate ? '#1c1b22' : '#b0acbe', transition: 'border-color 150ms', textAlign: 'left' }}
                    >
                      <Icon name="calendar_today" size={14} color={mDate ? selectedColor.color : '#c9c4d5'} />
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
                  <div style={{ width: 120 }}>
                    <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10.5, fontWeight: 600, color: '#787584', display: 'block', marginBottom: 3 }}>Time</label>
                    <input type="time" value={mTime} onChange={e => setMTime(e.target.value)}
                      style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 13, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '7px 10px', outline: 'none', background: '#fff', color: '#1c1b22' }} />
                  </div>
                </div>
                <div>
                  <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10.5, fontWeight: 600, color: '#787584', display: 'block', marginBottom: 4 }}>Status</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {MILESTONE_STATUSES.map(s => {
                      const sel = mStatus === s.key;
                      return (
                        <button key={s.key} onClick={() => setMStatus(s.key)}
                          style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '7px 6px', borderRadius: 8, border: `1.5px solid ${sel ? s.color : '#e8e4f0'}`, background: sel ? `${s.color}14` : '#fff', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 600, color: sel ? s.color : '#787584', transition: 'all 140ms' }}>
                          <Icon name={s.icon} size={13} color={sel ? s.color : '#9d8dff'} />{s.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <input value={mDesc} onChange={e => setMDesc(e.target.value)} placeholder="Notes (optional)"
                  style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 13, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '7px 10px', outline: 'none', background: '#fff' }}
                  onFocus={e => (e.target.style.borderColor = selectedColor.color)} onBlur={e => (e.target.style.borderColor = '#e8e4f0')} />
                <button onClick={addMilestone} disabled={!mTitle.trim()}
                  style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: mTitle.trim() ? selectedColor.color : '#c9c4d5', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: mTitle.trim() ? 'pointer' : 'default' }}>
                  <Icon name="add" size={15} color="#fff" /> Add milestone
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
                    <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22' }}>{name}</div>
                    {subtitle && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584' }}>{subtitle}</div>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.5)', padding: '4px 8px', borderRadius: 8 }}>
                    <Icon name={isPublic ? 'public' : 'lock'} size={14} color="#787584" />
                    <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#787584', textTransform: 'uppercase' }}>{isPublic ? 'Public' : 'Private'}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: milestones.length ? 12 : 0 }}>
                  <Icon name={LAYOUTS.find(l => l.key === layout)!.icon} size={14} color={selectedColor.color} />
                  <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#787584' }}>{LAYOUTS.find(l => l.key === layout)!.label} layout · {milestones.length} milestone{milestones.length === 1 ? '' : 's'}</span>
                </div>
                {sortedMilestones.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 4, borderLeft: `2px solid ${selectedColor.color}40` }}>
                    {sortedMilestones.map(m => (
                      <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 10 }}>
                        <span style={{ fontSize: 13 }}>{m.emoji}</span>
                        <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, color: '#1c1b22' }}>{m.title}</span>
                        {m.date && <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584' }}>· {m.date}</span>}
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
          <div style={{ margin: '0 24px 8px', padding: '8px 12px', background: '#ffdad6', borderRadius: 8, fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a' }}>
            {createError}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, padding: '12px 24px 24px', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #f1ecf6', flexShrink: 0 }}>
          {step > 0 ? (
            <button onClick={() => setStep(s => s - 1)} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: 'none', cursor: 'pointer', padding: '10px 0', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Icon name="chevron_left" size={14} color="#484552" /> Back
            </button>
          ) : <div />}
          {step < 2 ? (
            <button onClick={() => setStep(s => s + 1)} disabled={step === 0 && !name.trim()}
              style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: (step === 0 && !name.trim()) ? '#c9c4d5' : selectedColor.color, border: 'none', borderRadius: 8, padding: '10px 24px', cursor: (step === 0 && !name.trim()) ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
              {step === 1 ? 'Review' : 'Next'} <Icon name="arrow_forward" size={14} color="#fff" />
            </button>
          ) : (
            <button onClick={handleCreate} disabled={loading}
              style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: loading ? '#9d8dff' : selectedColor.color, border: 'none', borderRadius: 8, padding: '10px 24px', cursor: loading ? 'wait' : 'pointer' }}>
              {loading ? 'Creating…' : 'Create Timeline'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
