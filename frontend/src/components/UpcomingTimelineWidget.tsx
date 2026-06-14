import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { UpcomingMilestone, MilestoneStatus } from '../types';
import useAppStore from '../store/useAppStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import { apiGetUpcomingMilestones } from '../api/client';
import Icon from './Icon';

// Mirror the milestone status palette used in TimelineScreen.
const STATUS_META: Record<MilestoneStatus, { label: string; color: string }> = {
  upcoming: { label: 'Upcoming', color: '#9d8dff' },
  'in-progress': { label: 'In progress', color: '#ea580c' },
  done: { label: 'Done', color: '#10B981' },
};

function todayIso(): string {
  // en-CA renders as YYYY-MM-DD in the local timezone.
  return new Date().toLocaleDateString('en-CA');
}

function friendlyDate(iso?: string | null): string {
  if (!iso) return '';
  const today = todayIso();
  if (iso === today) return 'Today';
  const d = new Date(iso.slice(0, 10) + 'T12:00:00');
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (iso === tomorrow.toLocaleDateString('en-CA')) return 'Tomorrow';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function daysUntil(iso?: string | null): number | null {
  if (!iso) return null;
  const today = new Date(todayIso() + 'T00:00:00');
  const target = new Date(iso.slice(0, 10) + 'T00:00:00');
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

// ── Single event row ───────────────────────────────────────────
function EventRow({ m, onOpen }: { m: UpcomingMilestone; onOpen: () => void }) {
  const [hov, setHov] = useState(false);
  const accent = m.color ?? m.timelineColor ?? STATUS_META[m.status].color;
  const days = daysUntil(m.date);
  const soon = days != null && days <= 2;
  return (
    <div onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)} onClick={onOpen}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, background: hov ? '#F5F3FF' : 'transparent', cursor: 'pointer', transition: 'background 150ms' }}>
      <div style={{ width: 9, height: 9, minWidth: 9, borderRadius: '50%', background: accent, boxShadow: `0 0 0 3px ${accent}22`, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {m.emoji && <span style={{ fontSize: 13, lineHeight: 1, flexShrink: 0 }}>{m.emoji}</span>}
          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
          {m.timelineEmoji
            ? <span style={{ fontSize: 11, lineHeight: 1 }}>{m.timelineEmoji}</span>
            : <Icon name="timeline" size={11} color="#b0acbe" />}
          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10.5, color: '#787584', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.timelineName}</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
        <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 600, color: soon ? '#ea580c' : '#484552' }}>
          {friendlyDate(m.date)}{m.time ? ` · ${m.time}` : ''}
        </span>
        {days != null && days > 2 && (
          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#b0acbe' }}>in {days} days</span>
        )}
      </div>
    </div>
  );
}

// ── Upcoming Timeline Widget ───────────────────────────────────
// Compact card listing the next few upcoming timeline milestones. Used at the
// top of the Dashboard (all timelines) and Folder overviews (scoped to folder).
export default function UpcomingTimelineWidget({ folderId, accent = '#1D4ED8', limit = 3 }: { folderId?: string; accent?: string; limit?: number }) {
  const navigate = useNavigate();
  const currentWorkspaceId = useWorkspaceStore(s => s.currentWorkspaceId);
  // Re-fetch whenever timelines change (edits, SSE refresh) so the widget stays live.
  const timelines = useAppStore(s => s.timelines);
  const [milestones, setMilestones] = useState<UpcomingMilestone[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiGetUpcomingMilestones({ workspaceId: currentWorkspaceId ?? undefined, folderId, limit })
      .then(res => { if (!cancelled) { setMilestones(res.milestones); setLoaded(true); } })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [currentWorkspaceId, folderId, limit, timelines]);

  // Stay out of the way until we know there's something to show.
  if (!loaded || milestones.length === 0) return null;

  const accentBg = `${accent}14`;

  return (
    <section style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 14, padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px 6px' }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: accentBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="timeline" size={15} color={accent} />
        </div>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 700, color: '#1c1b22' }}>Upcoming on the timeline</div>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 700, color: accent, background: accentBg, borderRadius: 9999, padding: '2px 9px' }}>{milestones.length}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {milestones.map(m => (
          <EventRow key={m.id} m={m} onOpen={() => navigate(`/timeline/${m.timelineId}`)} />
        ))}
      </div>
    </section>
  );
}
