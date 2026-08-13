import { usePageTitle } from '../hooks/usePageTitle';
import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Icon from '../components/Icon';
import { verifySharePassword, ShareSessionError } from '../utils/shareSession';
import Spinner from '@/components/animate-ui/Spinner';
import MotionIn from '../components/animate-ui/MotionIn';
import MotionButton from '../components/animate-ui/MotionButton';

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

interface FolderMeta {
  name: string;
  emoji: string | null;
  color: string | null;
  hasPassword: boolean;
  expiresAt: string | null;
  isExpired: boolean;
  createdAt: string;
  sharedBy: string | null;
  sharedByImage: string | null;
}

type SharedFolderItemType = 'list' | 'timeline' | 'markdownList';

interface SharedFolderItem {
  type: SharedFolderItemType;
  name: string;
  emoji: string | null;
  color: string | null;
  colorBg: string | null;
  shareToken: string;
  progress: { total: number; completed: number } | null;
}

interface FolderContent {
  folder: { name: string; emoji: string | null; color: string | null };
  items: SharedFolderItem[];
}

type PageState = 'loading' | 'password' | 'ready' | 'expired' | 'notfound' | 'error';

const ITEM_META: Record<SharedFolderItemType, { icon: string; label: string; path: string }> = {
  list: { icon: 'format_list_bulleted', label: 'Board', path: 'list' },
  timeline: { icon: 'timeline', label: 'Timeline', path: 'timeline' },
  markdownList: { icon: 'notes', label: 'Page', path: 'markdown-list' },
};

function sharedByInitials(name: string): string {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function SharedFolderPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<PageState>('loading');
  const [meta, setMeta] = useState<FolderMeta | null>(null);
  const [content, setContent] = useState<FolderContent | null>(null);
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);

  const fetchContent = useCallback(async (sessionTicket: string | undefined) => {
    setLoadingContent(true);
    setPwError(false);
    try {
      const url = `${BASE_URL}/share/folder/${token}/content${sessionTicket ? `?session=${encodeURIComponent(sessionTicket)}` : ''}`;
      const res = await fetch(url);
      if (res.status === 401) { setPwError(true); setState('password'); return; }
      if (res.status === 410) { setState('expired'); return; }
      if (res.status === 404) { setState('notfound'); return; }
      if (!res.ok) { setState('error'); return; }
      const data: FolderContent = await res.json();
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
      const session = await verifySharePassword('folder', token, pw);
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
    fetch(`${BASE_URL}/share/folder/${token}`)
      .then(async res => {
        if (res.status === 404) { setState('notfound'); return; }
        if (!res.ok) { setState('error'); return; }
        const data: FolderMeta = await res.json();
        setMeta(data);
        if (data.isExpired) { setState('expired'); return; }
        if (data.hasPassword) { setState('password'); return; }
        fetchContent(undefined);
      })
      .catch(() => setState('error'));
  }, [token, fetchContent]);

  const accent = content?.folder.color ?? meta?.color ?? 'var(--color-primary)';

  const openItem = (item: SharedFolderItem) => {
    // The visitor already entered any folder password; the cascaded item shares
    // inherit it, so their own pages will prompt for the same password when set.
    navigate(`/share/${ITEM_META[item.type].path}/${item.shareToken}`);
  };

  let pageTitle = 'Loading folder…';
  if (state === 'notfound') pageTitle = 'Folder not found';
  else if (meta) pageTitle = `${meta.emoji ? `${meta.emoji} ` : ''}${meta.name}`;
  usePageTitle(pageTitle);

  const cardMaxWidth = state === 'ready' ? 760 : 460;

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

      <MotionIn transition={{ duration: 0.3 }} style={{ background: 'var(--color-white)', borderRadius: 20, boxShadow: '0 8px 40px rgba(var(--color-primary-rgb), 0.10)', padding: state === 'ready' ? 0 : '40px 40px 36px', width: '100%', maxWidth: cardMaxWidth, display: 'flex', flexDirection: 'column', alignItems: state === 'ready' ? 'stretch' : 'center', overflow: 'hidden', }}>

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
                {state === 'notfound' ? 'Folder not found' : state === 'expired' ? 'Link expired' : 'Something went wrong'}
              </div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
                {state === 'notfound' ? "This share link doesn't exist or has been removed." :
                 state === 'expired'  ? 'This share link has expired and is no longer available.' :
                                        'Unable to load this folder. Please try again.'}
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
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 4 }}>{meta?.name ?? 'Protected folder'}</div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-tertiary)' }}>This folder is password protected.</div>
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
            <MotionButton
              onClick={() => void submitPassword(password)}
              disabled={loadingContent || !password}
              transition={{ duration: 0.15 }} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 700, color: 'var(--color-white)', background: loadingContent || !password ? 'var(--color-accent-purple-light)' : 'var(--color-primary)', border: 'none', borderRadius: 12, padding: '13px', cursor: loadingContent || !password ? 'not-allowed' : 'pointer', }}>
              {loadingContent ? <Spinner size={16} thickness={2} trackColor="rgba(var(--color-white-rgb), 0.4)" indicatorColor="var(--color-white)" durationMs={700} /> : <Icon name="visibility" size={18} color="var(--color-white)" />}
              Open folder
            </MotionButton>
          </div>
        )}

        {/* Ready — navigator */}
        {state === 'ready' && content && (
          <>
            {/* Hero */}
            <div style={{ background: 'var(--color-surface-gray)', padding: '28px 32px 24px', borderBottom: '1px solid var(--color-divider)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--color-white)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 2px 8px rgba(var(--color-primary-rgb), 0.08)' }}>
                  {content.folder.emoji
                    ? <span style={{ fontSize: 24 }}>{content.folder.emoji}</span>
                    : <Icon name="folder" size={24} color={accent} />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h1 style={{ margin: 0, fontFamily: 'var(--font-heading)', fontSize: 24, fontWeight: 800, color: 'var(--color-text-primary)', letterSpacing: '-0.02em' }}>{content.folder.name}</h1>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                    {content.items.length} shared {content.items.length === 1 ? 'item' : 'items'}
                  </div>
                </div>
              </div>
            </div>

            {/* Item grid */}
            <div style={{ padding: '24px 32px 32px' }}>
              {content.items.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '24px', fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-quaternary)' }}>
                  Nothing has been shared in this folder yet.
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
                  {content.items.map(item => {
                    const im = ITEM_META[item.type];
                    const itemAccent = item.color ?? accent;
                    const pct = item.progress && item.progress.total > 0
                      ? Math.round((item.progress.completed / item.progress.total) * 100)
                      : null;
                    return (
                      <MotionButton
                        key={`${item.type}-${item.shareToken}`}
                        onClick={() => openItem(item)}
                        transition={{ duration: 0.14 }} style={{ display: 'flex', flexDirection: 'column', gap: 10, textAlign: 'left', background: item.colorBg ?? 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 14, padding: '16px 16px 14px', cursor: 'pointer', }}
                        onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(var(--color-primary-rgb), 0.12)'; e.currentTarget.style.borderColor = itemAccent; }}
                        onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.borderColor = 'var(--color-border-alt)'; }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--color-white)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            {item.emoji ? <span style={{ fontSize: 18 }}>{item.emoji}</span> : <Icon name={im.icon} size={18} color={itemAccent} />}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</div>
                            <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{im.label}</div>
                          </div>
                          <Icon name="arrow_forward" size={16} color="var(--color-text-quaternary)" />
                        </div>
                        {pct !== null && item.progress && (
                          <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
                              <span>{item.progress.completed} of {item.progress.total} done</span>
                              <span style={{ fontWeight: 600, color: itemAccent }}>{pct}%</span>
                            </div>
                            <div style={{ height: 5, background: 'rgba(var(--color-black-rgb), 0.07)', borderRadius: 9999, overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: `${pct}%`, background: pct === 100 ? 'var(--color-success)' : itemAccent, borderRadius: 9999 }} />
                            </div>
                          </div>
                        )}
                      </MotionButton>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </MotionIn>

      {meta?.expiresAt && state === 'ready' && (
        <div style={{ marginTop: 16, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-warning)', background: 'var(--color-yellow-tint-1)', borderRadius: 99, padding: '4px 12px' }}>Link expires {fmtDate(meta.expiresAt)}</div>
      )}

      <div style={{ marginTop: 24, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>
        Shared via <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>Solytiq</span>
      </div>

    </div>
  );
}
