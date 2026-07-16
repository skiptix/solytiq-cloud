import { usePageTitle } from "../hooks/usePageTitle";
import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Icon from '../components/Icon';
import MarkdownView from '../components/MarkdownView';
import { useMobile } from '../hooks/useBreakpoint';
import {
  fmtDate, SharedTaskRow, SharedKanbanView, SharedTaskTimelineView,
  type SharedTask, type SharedSection,
} from '../components/SharedListViews';

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

interface ListMeta {
  name: string;
  emoji: string | null;
  color: string | null;
  colorBg: string | null;
  subtitle: string | null;
  hasPassword: boolean;
  expiresAt: string | null;
  isExpired: boolean;
  createdAt: string;
  sharedBy: string | null;
  sharedByImage: string | null;
}

interface ListContent {
  list: { name: string; emoji: string | null; color: string | null; colorBg: string | null; subtitle: string | null; viewMode: 'list' | 'kanban' | 'timeline' };
  sections: SharedSection[];
}

type PageState = 'loading' | 'password' | 'ready' | 'expired' | 'notfound' | 'error';

function sharedByInitials(name: string): string {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

export default function SharedListPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const isMobile = useMobile();
  const [state, setState] = useState<PageState>('loading');
  const [meta, setMeta] = useState<ListMeta | null>(null);
  const [content, setContent] = useState<ListContent | null>(null);
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  const [previewTask, setPreviewTask] = useState<SharedTask | null>(null);

  const fetchContent = useCallback(async (pw: string | undefined) => {
    setLoadingContent(true);
    setPwError(false);
    try {
      const url = `${BASE_URL}/share/list/${token}/content${pw ? `?password=${encodeURIComponent(pw)}` : ''}`;
      const res = await fetch(url);
      if (res.status === 401) { setPwError(true); setState('password'); return; }
      if (res.status === 410) { setState('expired'); return; }
      if (res.status === 404) { setState('notfound'); return; }
      if (!res.ok) { setState('error'); return; }
      const data: ListContent = await res.json();
      setContent(data);
      setState('ready');
    } catch {
      setState('error');
    } finally {
      setLoadingContent(false);
    }
  }, [token]);

  useEffect(() => {
    if (!token) { setState('notfound'); return; }
    setState('loading');
    setContent(null);
    setPassword('');
    setPwError(false);
    fetch(`${BASE_URL}/share/list/${token}`)
      .then(async res => {
        if (res.status === 404) { setState('notfound'); return; }
        if (!res.ok) { setState('error'); return; }
        const data: ListMeta = await res.json();
        setMeta(data);
        if (data.isExpired) { setState('expired'); return; }
        if (data.hasPassword) { setState('password'); return; }
        fetchContent(undefined);
      })
      .catch(() => setState('error'));
  }, [token, fetchContent]);

  const accent = content?.list.color ?? meta?.color ?? 'var(--color-primary)';
  const colorBg = content?.list.colorBg ?? meta?.colorBg ?? 'var(--color-surface-gray)';

  const handleTaskClick = (task: SharedTask) => {
    if (task.linkedShareToken) navigate(`/share/list/${task.linkedShareToken}`);
    else setPreviewTask(task);
  };

  const allTasks = content?.sections.flatMap(s => s.tasks) ?? [];
  const total = allTasks.length;
  const completed = allTasks.filter(t => t.checked || (t.linkedProgress && t.linkedProgress.total > 0 && t.linkedProgress.completed === t.linkedProgress.total)).length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  let pageTitle = 'Loading to-do...';
  if (state === 'notfound') {
    pageTitle = 'To-Do not found';
  } else if (meta) {
    const prefix = meta.emoji ? `${meta.emoji} ` : '';
    pageTitle = `${prefix}${meta.name}`;
  }
  usePageTitle(pageTitle);

  const readyMaxWidth = content?.list.viewMode === 'timeline' ? 1100 : content?.list.viewMode === 'kanban' ? 960 : 720;
  const cardMaxWidth = state === 'ready' ? readyMaxWidth : 460;

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
            <div style={{ width: 36, height: 36, border: '3px solid var(--color-border)', borderTopColor: 'var(--color-primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
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
                {state === 'notfound' ? 'To-Do not found' : state === 'expired' ? 'Link expired' : 'Something went wrong'}
              </div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
                {state === 'notfound' ? "This share link doesn't exist or has been removed." :
                 state === 'expired'  ? 'This share link has expired and is no longer available.' :
                                        'Unable to load this to-do. Please try again.'}
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
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 4 }}>{meta?.name ?? 'Protected to-do'}</div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-tertiary)' }}>This to-do is password protected.</div>
            </div>
            <div style={{ width: '100%' }}>
              <input
                type="password"
                value={password}
                onChange={e => { setPassword(e.target.value); setPwError(false); }}
                onKeyDown={e => { if (e.key === 'Enter') fetchContent(password); }}
                placeholder="Enter password to view"
                style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-primary)', background: 'var(--color-surface-gray)', border: `1.5px solid ${pwError ? 'var(--color-error)' : 'var(--color-border-alt)'}`, borderRadius: 10, padding: '11px 14px', outline: 'none', boxSizing: 'border-box' }}
                autoFocus
              />
              {pwError && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)', marginTop: 5 }}>Incorrect password, please try again.</div>}
            </div>
            <button
              onClick={() => fetchContent(password)}
              disabled={loadingContent || !password}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 700, color: 'var(--color-white)', background: loadingContent || !password ? 'var(--color-accent-purple-light)' : 'var(--color-primary)', border: 'none', borderRadius: 12, padding: '13px', cursor: loadingContent || !password ? 'not-allowed' : 'pointer', transition: 'background 150ms' }}>
              {loadingContent ? <div style={{ width: 16, height: 16, border: '2px solid rgba(var(--color-white-rgb), 0.4)', borderTopColor: 'var(--color-white)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /> : <Icon name="visibility" size={18} color="var(--color-white)" />}
              View to-do
            </button>
          </div>
        )}

        {/* Ready — list content */}
        {state === 'ready' && content && (
          <>
            {/* Hero */}
            <div style={{ background: colorBg, padding: '28px 32px 24px', borderBottom: '1px solid var(--color-divider)' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                    {content.list.emoji && <span style={{ fontSize: 26 }}>{content.list.emoji}</span>}
                    <h1 style={{ margin: 0, fontFamily: 'var(--font-heading)', fontSize: 24, fontWeight: 800, color: 'var(--color-text-primary)', letterSpacing: '-0.02em' }}>{content.list.name}</h1>
                  </div>
                  {content.list.subtitle && <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-tertiary)', marginBottom: 6 }}>{content.list.subtitle}</div>}
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>{completed} of {total} done</div>
                </div>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 40, fontWeight: 700, color: accent, lineHeight: 1, flexShrink: 0 }}>{pct}%</div>
              </div>
              <div style={{ marginTop: 14, height: 6, background: 'rgba(var(--color-black-rgb), 0.08)', borderRadius: 9999, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: pct === 100 ? 'var(--color-success)' : accent, borderRadius: 9999, transition: 'width 600ms ease-in-out' }} />
              </div>
            </div>

            {/* Content — layout follows the owner's "Shared view" setting */}
            <div style={{ padding: '24px 32px 32px' }}>
              {content.sections.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '24px', fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-quaternary)' }}>This to-do is empty.</div>
              ) : content.list.viewMode === 'kanban' ? (
                <SharedKanbanView sections={content.sections} accent={accent} onTaskClick={handleTaskClick} />
              ) : content.list.viewMode === 'timeline' ? (
                <SharedTaskTimelineView sections={content.sections} accent={accent} isMobile={isMobile} onTaskClick={handleTaskClick} />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
                  {content.sections.map(section => (
                    <div key={section.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 2px' }}>
                        {section.emoji && <span style={{ fontSize: 14 }}>{section.emoji}</span>}
                        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-gray-deep-1)' }}>{section.label}</span>
                        <div style={{ flex: 1, height: 1, background: 'var(--color-border-alt)' }} />
                      </div>
                      <div style={{ background: 'var(--color-surface-gray)', borderRadius: 12, border: '1px solid var(--color-border-alt)', overflow: 'hidden' }}>
                        {section.tasks.length === 0 ? (
                          <div style={{ padding: '14px 16px', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)', textAlign: 'center' }}>No items.</div>
                        ) : (
                          <div style={{ padding: 4 }}>
                            {section.tasks.map(task => <SharedTaskRow key={task.id} task={task} accent={accent} onClick={handleTaskClick} />)}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
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

      {previewTask && <ItemPreview task={previewTask} accent={accent} onClose={() => setPreviewTask(null)} />}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// Read-only item preview — mirrors the task dialog chrome (accent stripe,
// properties panel, notes) but without any edit controls.
const PRIORITY_COLORS: Record<string, string> = { High: 'var(--color-orange)', Medium: 'var(--color-warning-alt)', Low: 'var(--color-text-tertiary)' };

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

function ItemPreview({ task, accent, onClose }: { task: SharedTask; accent: string; onClose: () => void }) {
  const hasProps = !!(task.deadline || task.time || task.priority || task.badge);
  const rows: Array<{ icon: string; label: string; node: React.ReactNode }> = [];
  if (task.deadline) rows.push({ icon: 'calendar_today', label: 'Date', node: fmtDate(task.deadline) });
  if (task.time) rows.push({ icon: 'schedule', label: 'Time', node: task.time });
  if (task.priority) rows.push({ icon: 'flag', label: 'Priority', node: <span style={{ fontWeight: 600, color: PRIORITY_COLORS[task.priority] ?? 'var(--color-text-tertiary)' }}>{task.priority}</span> });
  if (task.badge) rows.push({ icon: 'sell', label: 'Tag', node: <span style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', padding: '2px 8px', borderRadius: 9999 }}>{task.badge}</span> });

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.28)', backdropFilter: 'blur(6px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 20px', animation: 'backdropIn 200ms ease both' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--color-white)', borderRadius: 18, width: '100%', maxWidth: 560, maxHeight: '88vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 32px 80px rgba(var(--color-black-rgb), 0.22)', animation: 'modalIn 260ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
        <div style={{ height: 3, background: accent, flexShrink: 0 }} />
        <div style={{ overflowY: 'auto', padding: '24px 28px 28px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: hasProps || task.note ? 22 : 0 }}>
            <div style={{ marginTop: 3, width: 22, height: 22, borderRadius: 6, border: `2px solid ${task.checked ? accent : 'var(--color-border-strong)'}`, background: task.checked ? accent : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {task.checked && <Icon name="check" size={13} color="var(--color-white)" />}
            </div>
            <div style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', lineHeight: 1.3, paddingTop: 1, overflowWrap: 'anywhere', wordBreak: 'break-word', textDecoration: task.checked ? 'line-through' : 'none' }}>{task.title}</div>
            <button onClick={onClose} title="Close" style={{ width: 34, height: 34, borderRadius: 9, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-tint)')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <Icon name="close" size={18} color="var(--color-text-tertiary)" />
            </button>
          </div>

          {hasProps && (
            <div style={{ background: 'var(--color-surface-tint-3)', borderRadius: 12, border: '1px solid var(--color-purple-pale-23)', marginBottom: task.note ? 24 : 0 }}>
              {rows.map((r, i) => <PreviewRow key={r.label} icon={r.icon} label={r.label} last={i === rows.length - 1}>{r.node}</PreviewRow>)}
            </div>
          )}

          {task.note && (
            <div>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, color: 'var(--color-border-strong)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Notes</div>
              <MarkdownView source={task.note} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
