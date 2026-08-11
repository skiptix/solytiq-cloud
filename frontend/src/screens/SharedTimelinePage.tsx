import { usePageTitle } from "../hooks/usePageTitle";
import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import Icon from '../components/Icon';
import MarkdownView from '../components/MarkdownView';
import { localIso } from '../utils/date';
import { milestoneCompletion, railFillIndex } from '../utils/timeline';
import { verifySharePassword, ShareSessionError } from '../utils/shareSession';
import Spinner from '@/components/animate-ui/Spinner';

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

type MilestoneStatus = 'upcoming' | 'in-progress' | 'done';

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function statusOf(s: MilestoneStatus): { label: string; color: string; icon: string } {
  switch (s) {
    case 'done':        return { label: 'Done', color: 'var(--color-success)', icon: 'check_circle' };
    case 'in-progress': return { label: 'In progress', color: 'var(--color-blue-mid-7)', icon: 'pending' };
    default:            return { label: 'Upcoming', color: 'var(--color-accent-purple-light)', icon: 'schedule' };
  }
}

interface TimelineMeta {
  name: string;
  emoji: string | null;
  color: string | null;
  colorBg: string | null;
  subtitle: string | null;
  layout: string;
  hasPassword: boolean;
  expiresAt: string | null;
  isExpired: boolean;
  createdAt: string;
  sharedBy: string | null;
  sharedByImage: string | null;
}

interface SharedMilestone {
  id: string;
  title: string;
  description: string | null;
  descriptionMarkdown?: boolean;
  date: string | null;
  time: string | null;
  status: MilestoneStatus;
  emoji: string | null;
  color: string | null;
}

interface TimelineContent {
  timeline: { name: string; emoji: string | null; color: string | null; colorBg: string | null; subtitle: string | null; layout: string };
  milestones: SharedMilestone[];
}

type PageState = 'loading' | 'password' | 'ready' | 'expired' | 'notfound' | 'error';

function sharedByInitials(name: string): string {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

export default function SharedTimelinePage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<PageState>('loading');
  const [meta, setMeta] = useState<TimelineMeta | null>(null);
  const [content, setContent] = useState<TimelineContent | null>(null);
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  const [previewMilestone, setPreviewMilestone] = useState<SharedMilestone | null>(null);

  // Re-render every minute so intra-day ("hourly") progress keeps advancing.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => forceTick(t => t + 1), 60_000);
    return () => clearInterval(interval);
  }, []);

  const now = new Date();
  const today = localIso(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const fetchContent = useCallback(async (sessionTicket: string | undefined) => {
    setLoadingContent(true);
    setPwError(false);
    try {
      const url = `${BASE_URL}/share/timeline/${token}/content${sessionTicket ? `?session=${encodeURIComponent(sessionTicket)}` : ''}`;
      const res = await fetch(url);
      if (res.status === 401) { setPwError(true); setState('password'); return; }
      if (res.status === 410) { setState('expired'); return; }
      if (res.status === 404) { setState('notfound'); return; }
      if (!res.ok) { setState('error'); return; }
      const data: TimelineContent = await res.json();
      setContent(data);
      setState('ready');
    } catch {
      setState('error');
    } finally {
      setLoadingContent(false);
    }
  }, [token]);

  const submitPassword = useCallback(async (pw: string) => {
    if (!token || !pw) return;
    setLoadingContent(true);
    setPwError(false);
    try {
      const session = await verifySharePassword('timeline', token, pw);
      await fetchContent(session);
    } catch (err) {
      if (err instanceof ShareSessionError && err.status === 401) { setPwError(true); setState('password'); }
      else setState('error');
    } finally {
      setLoadingContent(false);
    }
  }, [token, fetchContent]);

  useEffect(() => {
    if (!token) { setState('notfound'); return; }
    setState('loading');
    setContent(null);
    setPassword('');
    setPwError(false);
    fetch(`${BASE_URL}/share/timeline/${token}`)
      .then(async res => {
        if (res.status === 404) { setState('notfound'); return; }
        if (!res.ok) { setState('error'); return; }
        const data: TimelineMeta = await res.json();
        setMeta(data);
        if (data.isExpired) { setState('expired'); return; }
        if (data.hasPassword) { setState('password'); return; }
        fetchContent(undefined);
      })
      .catch(() => setState('error'));
  }, [token, fetchContent]);

  const accent = content?.timeline.color ?? meta?.color ?? 'var(--color-primary)';
  const colorBg = content?.timeline.colorBg ?? meta?.colorBg ?? 'var(--color-surface-gray)';

  const milestones = content?.milestones ?? [];
  const total = milestones.length;
  const completions = milestones.map(m => milestoneCompletion(m, today, nowMinutes));
  const done = completions.filter(c => c >= 1).length;
  const totalCompletion = completions.reduce((a, c) => a + c, 0);
  const pct = total > 0 ? Math.round((totalCompletion / total) * 100) : 0;
  const fillIndex = railFillIndex(completions);
  const fillPct = total > 1 ? Math.max(0, Math.min(1, fillIndex / (total - 1))) * 100 : 0;
  const railActive = fillIndex > -1 && fillIndex < total - 1 && fillIndex % 1 !== 0;

  let pageTitle = 'Loading timeline...';
  if (state === 'notfound') {
    pageTitle = 'Timeline not found';
  } else if (meta) {
    const prefix = meta.emoji ? `${meta.emoji} ` : '';
    pageTitle = `${prefix}${meta.name}`;
  }
  usePageTitle(pageTitle);

  const cardMaxWidth = state === 'ready' ? 720 : 460;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-purple-pale-9)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: state === 'ready' ? 'flex-start' : 'center', padding: '72px 24px 24px' }}>
      {/* Logo */}
      <div style={{ position: 'fixed', top: 20, left: 24, display: 'flex', alignItems: 'center', gap: 9, zIndex: 5 }}>
        <img src="/solytiq-cloud.png" alt="Solytiq" style={{ width: 36, height: 36, borderRadius: 9, objectFit: 'cover', flexShrink: 0 }} />
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 800, color: 'var(--color-text-primary)', letterSpacing: '-0.02em' }}>solytiq</span>
      </div>

      {/* Shared-by bubble */}
      {meta?.sharedBy && (
        <div style={{ position: 'fixed', top: 20, right: 24, display: 'flex', alignItems: 'center', gap: 8, background: 'var(--color-white)', border: '1.5px solid var(--color-border-alt)', borderRadius: 99, padding: '6px 12px 6px 6px', boxShadow: '0 2px 8px rgba(var(--color-primary-rgb), 0.07)', zIndex: 5 }}>
          <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'linear-gradient(135deg, var(--color-accent-purple-light) 0%, var(--color-primary) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
            {meta.sharedByImage
              ? <img src={meta.sharedByImage} alt={meta.sharedBy} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <span style={{ fontFamily: 'var(--font-heading)', fontSize: 9, fontWeight: 700, color: 'var(--color-white)', letterSpacing: '0.02em' }}>{sharedByInitials(meta.sharedBy)}</span>
            }
          </div>
          <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)' }}>Shared by <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, color: 'var(--color-text-primary)' }}>{meta.sharedBy}</span></span>
        </div>
      )}

      <div style={{ background: 'var(--color-white)', borderRadius: 20, boxShadow: '0 8px 40px rgba(var(--color-primary-rgb), 0.10)', padding: state === 'ready' ? 0 : '40px 40px 36px', width: '100%', maxWidth: cardMaxWidth, display: 'flex', flexDirection: 'column', alignItems: state === 'ready' ? 'stretch' : 'center', overflow: 'hidden', transition: 'max-width 300ms ease' }}>

        {/* Loading */}
        {state === 'loading' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '20px 0' }}>
            <Spinner size={36} thickness={3} durationMs={700} />
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-quaternary)' }}>Loading…</div>
          </div>
        )}

        {/* Error states */}
        {(state === 'notfound' || state === 'expired' || state === 'error') && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '12px 0 8px', textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: state === 'expired' ? 'var(--color-yellow-tint-1)' : 'var(--color-error-bg-alt)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={state === 'expired' ? 'schedule' : 'error_outline'} size={28} color={state === 'expired' ? 'var(--color-warning)' : 'var(--color-error)'} />
            </div>
            <div>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 6 }}>
                {state === 'notfound' ? 'Timeline not found' : state === 'expired' ? 'Link expired' : 'Something went wrong'}
              </div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
                {state === 'notfound' ? "This share link doesn't exist or has been removed." :
                 state === 'expired'  ? 'This share link has expired and is no longer available.' :
                                        'Unable to load this timeline. Please try again.'}
              </div>
            </div>
          </div>
        )}

        {/* Password */}
        {state === 'password' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, width: '100%' }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="lock" size={28} color="var(--color-primary)" />
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 4 }}>{meta?.name ?? 'Protected timeline'}</div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-tertiary)' }}>This timeline is password protected.</div>
            </div>
            <div style={{ width: '100%' }}>
              <input
                type="password"
                value={password}
                onChange={e => { setPassword(e.target.value); setPwError(false); }}
                onKeyDown={e => { if (e.key === 'Enter') void submitPassword(password); }}
                placeholder="Enter password to view"
                style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-primary)', background: 'var(--color-surface-gray)', border: `1.5px solid ${pwError ? 'var(--color-error)' : 'var(--color-border-alt)'}`, borderRadius: 10, padding: '11px 14px', outline: 'none', boxSizing: 'border-box' }}
                autoFocus
              />
              {pwError && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)', marginTop: 5 }}>Incorrect password, please try again.</div>}
            </div>
            <button
              onClick={() => void submitPassword(password)}
              disabled={loadingContent || !password}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 700, color: 'var(--color-white)', background: loadingContent || !password ? 'var(--color-accent-purple-light)' : 'var(--color-primary)', border: 'none', borderRadius: 12, padding: '13px', cursor: loadingContent || !password ? 'not-allowed' : 'pointer', transition: 'background 150ms' }}>
              {loadingContent ? <Spinner size={16} thickness={2} trackColor="rgba(var(--color-white-rgb), 0.4)" indicatorColor="var(--color-white)" durationMs={700} /> : <Icon name="visibility" size={18} color="var(--color-white)" />}
              View timeline
            </button>
          </div>
        )}

        {/* Ready — timeline content */}
        {state === 'ready' && content && (
          <>
            {/* Hero */}
            <div style={{ background: colorBg, padding: '28px 32px 24px', borderBottom: '1px solid var(--color-divider)' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
                <div style={{ width: 52, height: 52, borderRadius: 15, background: 'var(--color-white)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, boxShadow: '0 2px 10px rgba(var(--color-black-rgb), 0.06)', flexShrink: 0 }}>
                  {content.timeline.emoji ?? <Icon name="timeline" size={26} color={accent} />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <h1 style={{ margin: 0, fontFamily: 'var(--font-heading)', fontSize: 24, fontWeight: 800, color: 'var(--color-text-primary)' }}>{content.timeline.name}</h1>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: accent, background: 'var(--color-white)', padding: '3px 9px', borderRadius: 9999, border: `1px solid ${accent}33` }}>
                      <Icon name="timeline" size={13} color={accent} /> Timeline
                    </span>
                  </div>
                  {content.timeline.subtitle && <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-tertiary)', marginTop: 4 }}>{content.timeline.subtitle}</div>}
                  <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ flex: 1, maxWidth: 320, height: 8, borderRadius: 9999, background: 'rgba(var(--color-black-rgb), 0.07)', overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', borderRadius: 9999, background: accent, transition: 'width 400ms ease' }} />
                    </div>
                    <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-secondary)' }}>{done}/{total} done · {pct}%</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Milestones */}
            <div style={{ padding: '28px 36px 36px' }}>
              {total === 0 ? (
                <div style={{ textAlign: 'center', padding: '24px', fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-quaternary)' }}>This timeline has no milestones yet.</div>
              ) : (
                <div style={{ position: 'relative', paddingLeft: 8 }}>
                  <div style={{ position: 'absolute', left: 8 + 8 - 1, top: 8, bottom: 8, width: 2, background: 'var(--color-border)', borderRadius: 2 }} />
                  {fillIndex > -1 && (
                    <div className={railActive ? 'timeline-rail-flow' : undefined} style={{ position: 'absolute', left: 8 + 8 - 1, top: 8, height: `${fillPct}%`, width: 2, borderRadius: 2, backgroundColor: accent, backgroundImage: railActive ? 'linear-gradient(180deg, transparent 0%, rgba(var(--color-white-rgb), 0.6) 50%, transparent 100%)' : undefined, backgroundSize: '100% 50%', backgroundRepeat: 'repeat-y', transition: 'height 600ms cubic-bezier(0.4,0,0.2,1)', animation: railActive ? 'railFlow 1.8s linear infinite' : undefined }} />
                  )}
                  {railActive && (
                    <div className="timeline-rail-tip" style={{ position: 'absolute', left: 8 + 8, top: `calc(8px + ${fillPct}%)`, width: 7, height: 7, marginTop: -3.5, borderRadius: '50%', background: accent, transition: 'top 600ms cubic-bezier(0.4,0,0.2,1)', animation: 'railTipPulse 1.8s ease-in-out infinite' }} />
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {milestones.map((m, i) => {
                      const completion = completions[i];
                      const effectivelyDone = completion >= 1;
                      const inProgress = completion > 0 && completion < 1;
                      const effectiveStatus: MilestoneStatus = effectivelyDone ? 'done' : inProgress ? 'in-progress' : m.status;
                      const st = statusOf(effectiveStatus);
                      const dot = m.color ?? st.color;
                      const isToday = m.date === today;
                      return (
                        <div key={m.id} style={{ position: 'relative', display: 'flex', gap: 18, alignItems: 'flex-start' }}>
                          <div style={{ position: 'relative', zIndex: 1, width: 16, height: 16, borderRadius: '50%', flexShrink: 0, marginTop: 4, background: effectivelyDone ? dot : 'var(--color-white)', border: `2.5px solid ${dot}`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 0 4px var(--color-white)' }}>
                            {effectivelyDone && <Icon name="check" size={9} color="var(--color-white)" />}
                            {!effectivelyDone && effectiveStatus === 'in-progress' && <div style={{ width: 5, height: 5, borderRadius: '50%', background: dot }} />}
                          </div>
                          <div
                            onClick={() => setPreviewMilestone(m)}
                            style={{ flex: 1, minWidth: 0, background: effectivelyDone ? `${dot}08` : 'var(--color-white)', border: `1px solid ${effectivelyDone ? dot + '30' : 'var(--color-purple-pale-34)'}`, borderLeft: `3px solid ${dot}`, borderRadius: 12, padding: '12px 14px', boxShadow: '0 1px 3px rgba(var(--color-black-rgb), 0.03)', cursor: 'pointer', transition: 'box-shadow 150ms' }}
                            onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 4px 16px rgba(var(--color-black-rgb), 0.07)')}
                            onMouseLeave={e => (e.currentTarget.style.boxShadow = '0 1px 3px rgba(var(--color-black-rgb), 0.03)')}>
                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                              {m.emoji && <span style={{ fontSize: 16, lineHeight: 1.2, flexShrink: 0 }}>{m.emoji}</span>}
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                  <span style={{ fontFamily: 'var(--font-heading)', fontSize: 14.5, fontWeight: 700, color: effectivelyDone ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)', textDecoration: effectivelyDone && m.status === 'done' ? 'line-through' : 'none' }}>{m.title}</span>
                                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-heading)', fontSize: 10, fontWeight: 700, color: st.color, background: `${st.color}1a`, padding: '2px 8px', borderRadius: 9999, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                    <Icon name={st.icon} size={11} color={st.color} />{st.label}
                                  </span>
                                  {isToday && <span style={{ fontFamily: 'var(--font-heading)', fontSize: 10, fontWeight: 700, color: 'var(--color-orange)', background: 'var(--color-orange-pale-3)', padding: '2px 8px', borderRadius: 9999, letterSpacing: '0.04em' }}>TODAY</span>}
                                </div>
                                {(m.date || m.time) && (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                                    <Icon name="event" size={13} color="var(--color-accent-purple-light)" />
                                    {fmtDate(m.date)}{m.time ? `${m.date ? ' · ' : ''}${m.time}` : ''}
                                  </div>
                                )}
                                {m.description && (
                                  <div style={{ marginTop: 6, display: '-webkit-box', WebkitLineClamp: 6, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                                    <MarkdownView source={m.description} fontSize={13} />
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {meta?.expiresAt && state === 'ready' && (
        <div style={{ marginTop: 16, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-warning)', background: 'var(--color-yellow-tint-1)', borderRadius: 99, padding: '4px 12px' }}>Link expires {fmtDate(meta.expiresAt)}</div>
      )}

      <div style={{ marginTop: 24, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>
        Shared via <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>Solytiq</span>
      </div>

      {previewMilestone && <MilestonePreview milestone={previewMilestone} onClose={() => setPreviewMilestone(null)} />}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// Read-only milestone preview — mirrors the milestone editor chrome (accent
// stripe, properties panel, notes) but without any edit controls.
function PreviewRow({ icon, label, children, last = false }: { icon: string; label: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px', borderBottom: last ? 'none' : '1px solid rgba(var(--color-border-alt-rgb), 0.5)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: 120, flexShrink: 0 }}>
        <Icon name={icon} size={14} color="var(--color-purple-tint-11)" />
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)' }}>{label}</span>
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)' }}>{children}</div>
    </div>
  );
}

function MilestonePreview({ milestone: m, onClose }: { milestone: SharedMilestone; onClose: () => void }) {
  const st = statusOf(m.status);
  const stripe = m.color ?? st.color;
  const hasProps = !!(m.date || m.time || m.status);

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.28)', backdropFilter: 'blur(6px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 20px', animation: 'backdropIn 200ms ease both' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--color-white)', borderRadius: 18, width: '100%', maxWidth: 560, maxHeight: '88vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 32px 80px rgba(var(--color-black-rgb), 0.22)', animation: 'modalIn 260ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
        <div style={{ height: 3, background: stripe, flexShrink: 0 }} />
        <div style={{ overflowY: 'auto', padding: '24px 28px 28px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: hasProps || m.description ? 22 : 0 }}>
            {m.emoji && <span style={{ fontSize: 26, lineHeight: 1.1, flexShrink: 0 }}>{m.emoji}</span>}
            <div style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', lineHeight: 1.3, paddingTop: 2, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{m.title}</div>
            <button onClick={onClose} title="Close" style={{ width: 34, height: 34, borderRadius: 9, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-tint)')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <Icon name="close" size={18} color="var(--color-text-tertiary)" />
            </button>
          </div>

          {hasProps && (
            <div style={{ background: 'var(--color-surface-tint-3)', borderRadius: 12, border: '1px solid var(--color-purple-pale-23)', marginBottom: m.description ? 24 : 0 }}>
              {m.date && <PreviewRow icon="calendar_today" label="Date">{fmtDate(m.date)}</PreviewRow>}
              {m.time && <PreviewRow icon="schedule" label="Time">{m.time}</PreviewRow>}
              <PreviewRow icon="flag" label="Status" last>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, color: st.color, background: `${st.color}1a`, padding: '3px 9px', borderRadius: 9999, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  <Icon name={st.icon} size={12} color={st.color} />{st.label}
                </span>
              </PreviewRow>
            </div>
          )}

          {m.description && (
            <div>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, color: 'var(--color-border-strong)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Notes</div>
              <MarkdownView source={m.description} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
