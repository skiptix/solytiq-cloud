import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Icon from '../components/Icon';

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

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

interface SharedTask {
  id: string;
  title: string;
  checked: boolean;
  note: string | null;
  deadline: string | null;
  time: string | null;
  priority: string | null;
  badge: string | null;
  linkedListType: 'sublist' | 'link' | null;
  linkedShareToken: string | null;
  linkedProgress: { total: number; completed: number } | null;
}

interface SharedSection {
  id: string;
  label: string;
  emoji: string | null;
  tasks: SharedTask[];
}

interface ListContent {
  list: { name: string; emoji: string | null; color: string | null; colorBg: string | null; subtitle: string | null };
  sections: SharedSection[];
}

type PageState = 'loading' | 'password' | 'ready' | 'expired' | 'notfound' | 'error';

function sharedByInitials(name: string): string {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

export default function SharedListPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<PageState>('loading');
  const [meta, setMeta] = useState<ListMeta | null>(null);
  const [content, setContent] = useState<ListContent | null>(null);
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);

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

  const accent = content?.list.color ?? meta?.color ?? '#5e4dbb';
  const colorBg = content?.list.colorBg ?? meta?.colorBg ?? '#F9FAFB';

  const allTasks = content?.sections.flatMap(s => s.tasks) ?? [];
  const total = allTasks.length;
  const completed = allTasks.filter(t => t.checked || (t.linkedProgress && t.linkedProgress.total > 0 && t.linkedProgress.completed === t.linkedProgress.total)).length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  const cardMaxWidth = state === 'ready' ? 720 : 460;

  return (
    <div style={{ minHeight: '100vh', background: '#f8f7fc', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: state === 'ready' ? 'flex-start' : 'center', padding: '72px 24px 24px' }}>
      {/* Logo */}
      <div style={{ position: 'fixed', top: 20, left: 24, display: 'flex', alignItems: 'center', gap: 9, zIndex: 5 }}>
        <img src="/solytiq-cloud.png" alt="Solytiq" style={{ width: 36, height: 36, borderRadius: 9, objectFit: 'cover', flexShrink: 0 }} />
        <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 800, color: '#1c1b22', letterSpacing: '-0.02em' }}>solytiq</span>
      </div>

      {/* Shared-by bubble */}
      {meta?.sharedBy && (
        <div style={{ position: 'fixed', top: 20, right: 24, display: 'flex', alignItems: 'center', gap: 8, background: '#fff', border: '1.5px solid #E5E7EB', borderRadius: 99, padding: '6px 12px 6px 6px', boxShadow: '0 2px 8px rgba(94,77,187,0.07)', zIndex: 5 }}>
          <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'linear-gradient(135deg, #9d8dff 0%, #5e4dbb 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
            {meta.sharedByImage
              ? <img src={meta.sharedByImage} alt={meta.sharedBy} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 9, fontWeight: 700, color: '#fff', letterSpacing: '0.02em' }}>{sharedByInitials(meta.sharedBy)}</span>
            }
          </div>
          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584' }}>Shared by <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontWeight: 600, color: '#1c1b22' }}>{meta.sharedBy}</span></span>
        </div>
      )}

      <div style={{ background: '#fff', borderRadius: 20, boxShadow: '0 8px 40px rgba(94,77,187,0.10)', padding: state === 'ready' ? 0 : '40px 40px 36px', width: '100%', maxWidth: cardMaxWidth, display: 'flex', flexDirection: 'column', alignItems: state === 'ready' ? 'stretch' : 'center', overflow: 'hidden', transition: 'max-width 300ms ease' }}>

        {/* Loading */}
        {state === 'loading' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '20px 0' }}>
            <div style={{ width: 36, height: 36, border: '3px solid #e8e4f0', borderTopColor: '#5e4dbb', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#b0acbe' }}>Loading…</div>
          </div>
        )}

        {/* Error states */}
        {(state === 'notfound' || state === 'expired' || state === 'error') && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '12px 0 8px', textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: state === 'expired' ? '#fef3c7' : '#fff5f5', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={state === 'expired' ? 'schedule' : 'error_outline'} size={28} color={state === 'expired' ? '#d97706' : '#ba1a1a'} />
            </div>
            <div>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 18, fontWeight: 700, color: '#1c1b22', marginBottom: 6 }}>
                {state === 'notfound' ? 'List not found' : state === 'expired' ? 'Link expired' : 'Something went wrong'}
              </div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#787584', lineHeight: 1.5 }}>
                {state === 'notfound' ? "This share link doesn't exist or has been removed." :
                 state === 'expired'  ? 'This share link has expired and is no longer available.' :
                                        'Unable to load this list. Please try again.'}
              </div>
            </div>
          </div>
        )}

        {/* Password */}
        {state === 'password' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, width: '100%' }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="lock" size={28} color="#5e4dbb" />
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 20, fontWeight: 700, color: '#1c1b22', marginBottom: 4 }}>{meta?.name ?? 'Protected list'}</div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13.5, color: '#787584' }}>This list is password protected.</div>
            </div>
            <div style={{ width: '100%' }}>
              <input
                type="password"
                value={password}
                onChange={e => { setPassword(e.target.value); setPwError(false); }}
                onKeyDown={e => { if (e.key === 'Enter') fetchContent(password); }}
                placeholder="Enter password to view"
                style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#1c1b22', background: '#F9FAFB', border: `1.5px solid ${pwError ? '#ba1a1a' : '#E5E7EB'}`, borderRadius: 10, padding: '11px 14px', outline: 'none', boxSizing: 'border-box' }}
                autoFocus
              />
              {pwError && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a', marginTop: 5 }}>Incorrect password, please try again.</div>}
            </div>
            <button
              onClick={() => fetchContent(password)}
              disabled={loadingContent || !password}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 700, color: '#fff', background: loadingContent || !password ? '#9d8dff' : '#5e4dbb', border: 'none', borderRadius: 12, padding: '13px', cursor: loadingContent || !password ? 'not-allowed' : 'pointer', transition: 'background 150ms' }}>
              {loadingContent ? <div style={{ width: 16, height: 16, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /> : <Icon name="visibility" size={18} color="#fff" />}
              View list
            </button>
          </div>
        )}

        {/* Ready — list content */}
        {state === 'ready' && content && (
          <>
            {/* Hero */}
            <div style={{ background: colorBg, padding: '28px 32px 24px', borderBottom: '1px solid #f0ecf8' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                    {content.list.emoji && <span style={{ fontSize: 26 }}>{content.list.emoji}</span>}
                    <h1 style={{ margin: 0, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 24, fontWeight: 800, color: '#1c1b22', letterSpacing: '-0.02em' }}>{content.list.name}</h1>
                  </div>
                  {content.list.subtitle && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13.5, color: '#787584', marginBottom: 6 }}>{content.list.subtitle}</div>}
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12.5, color: '#787584' }}>{completed} of {total} done</div>
                </div>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 40, fontWeight: 700, color: accent, lineHeight: 1, flexShrink: 0 }}>{pct}%</div>
              </div>
              <div style={{ marginTop: 14, height: 6, background: 'rgba(0,0,0,0.08)', borderRadius: 9999, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: pct === 100 ? '#10B981' : accent, borderRadius: 9999, transition: 'width 600ms ease-in-out' }} />
              </div>
            </div>

            {/* Sections */}
            <div style={{ padding: '24px 32px 32px', display: 'flex', flexDirection: 'column', gap: 22 }}>
              {content.sections.length === 0 && (
                <div style={{ textAlign: 'center', padding: '24px', fontFamily: 'Inter, sans-serif', fontSize: 13.5, color: '#b0acbe' }}>This list is empty.</div>
              )}
              {content.sections.map(section => (
                <div key={section.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 2px' }}>
                    {section.emoji && <span style={{ fontSize: 14 }}>{section.emoji}</span>}
                    <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5e5e5e' }}>{section.label}</span>
                    <div style={{ flex: 1, height: 1, background: '#E5E7EB' }} />
                  </div>
                  <div style={{ background: '#F9FAFB', borderRadius: 12, border: '1px solid #E5E7EB', overflow: 'hidden' }}>
                    {section.tasks.length === 0 ? (
                      <div style={{ padding: '14px 16px', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', textAlign: 'center' }}>No items.</div>
                    ) : (
                      <div style={{ padding: 4 }}>
                        {section.tasks.map(task => {
                          const isLinked = !!task.linkedListType;
                          const lp = task.linkedProgress;
                          const linkedComplete = !!(lp && lp.total > 0 && lp.completed === lp.total);
                          const navigable = !!task.linkedShareToken;
                          const done = task.checked || linkedComplete;
                          return (
                            <div
                              key={task.id}
                              onClick={() => { if (navigable) navigate(`/share/list/${task.linkedShareToken}`); }}
                              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, cursor: navigable ? 'pointer' : 'default', transition: 'background 150ms' }}
                              onMouseEnter={e => { if (navigable) e.currentTarget.style.background = '#F5F3FF'; }}
                              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                            >
                              {isLinked ? (
                                <div style={{ width: 20, height: 20, minWidth: 20, borderRadius: '50%', border: `2px solid ${accent}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, position: 'relative' }}>
                                  {linkedComplete
                                    ? <Icon name="check" size={12} color={accent} />
                                    : <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 8, fontWeight: 700, color: accent }}>{lp ? `${lp.completed}/${lp.total}` : ''}</span>}
                                </div>
                              ) : (
                                <div style={{ width: 20, height: 20, minWidth: 20, borderRadius: 5, border: '1.5px solid', borderColor: task.checked ? accent : '#c9c4d5', background: task.checked ? accent : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                  {task.checked && <Icon name="check" size={13} color="#fff" />}
                                </div>
                              )}
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: isLinked ? accent : '#1c1b22', lineHeight: 1.4, opacity: done ? 0.45 : 1, textDecoration: done ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
                                  {task.badge && <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10, fontWeight: 700, color: '#5e4dbb', background: '#F5F3FF', padding: '2px 7px', borderRadius: 9999, flexShrink: 0 }}>{task.badge}</span>}
                                </div>
                                {task.note && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.note}</div>}
                              </div>
                              {task.deadline && <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#b0acbe', flexShrink: 0 }}>{fmtDate(task.deadline)}</span>}
                              {navigable && <Icon name="chevron_right" size={18} color="#b0acbe" />}
                              {isLinked && !navigable && <Icon name="lock" size={14} color="#d1d5db" />}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {meta?.expiresAt && state === 'ready' && (
        <div style={{ marginTop: 16, fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#d97706', background: '#fef3c7', borderRadius: 99, padding: '4px 12px' }}>Link expires {fmtDate(meta.expiresAt)}</div>
      )}

      <div style={{ marginTop: 24, fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe' }}>
        Shared via <span style={{ color: '#5e4dbb', fontWeight: 600 }}>Solytiq</span>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
