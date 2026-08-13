import { usePageTitle } from "../hooks/usePageTitle";
import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import Icon from '../components/Icon';
import MarkdownTable from '../components/MarkdownTable';
import { renderInline } from '../components/MarkdownView';
import { useMobile } from '../hooks/useBreakpoint';
import type { MarkdownTableBlock } from '../types';
import { verifySharePassword, ShareSessionError } from '../utils/shareSession';
import Spinner from '@/components/animate-ui/Spinner';
import MotionIn from '../components/animate-ui/MotionIn';
import MotionButton from '../components/animate-ui/MotionButton';

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

interface MarkdownListMeta {
  name: string;
  emoji: string | null;
  color: string | null;
  colorBg: string | null;
  subtitle: string | null;
  fullWidth: boolean;
  hasPassword: boolean;
  expiresAt: string | null;
  isExpired: boolean;
  createdAt: string;
  sharedBy: string | null;
  sharedByImage: string | null;
}

interface SharedBlock {
  id: string;
  type: string;
  text?: string;
  level?: 1 | 2 | 3;
  checked?: boolean;
  imageId?: string;
  caption?: string;
  url?: string;
  title?: string;
  description?: string;
  layout?: 'stack' | 'columns';
  columns?: MarkdownTableBlock['columns'];
  rows?: MarkdownTableBlock['rows'];
}

interface MarkdownListContentResponse {
  markdownList: { name: string; emoji: string | null; color: string | null; colorBg: string | null; subtitle: string | null; fullWidth?: boolean };
  content: { version: 1; blocks: SharedBlock[] };
}

type PageState = 'loading' | 'password' | 'ready' | 'expired' | 'notfound' | 'error';

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function sharedByInitials(name: string): string {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

export default function SharedMarkdownListPage() {
  const { token } = useParams<{ token: string }>();
  const isMobile = useMobile();
  const [state, setState] = useState<PageState>('loading');
  const [meta, setMeta] = useState<MarkdownListMeta | null>(null);
  const [content, setContent] = useState<MarkdownListContentResponse | null>(null);
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  // S4: the short-lived session ticket obtained by verifying the password
  // (utils/shareSession.ts) — passed to SharedBlockView so its <img> tags
  // never carry the plaintext password.
  const [sessionTicket, setSessionTicket] = useState<string | undefined>(undefined);

  const fetchContent = useCallback(async (sessionParam: string | undefined) => {
    setLoadingContent(true);
    setPwError(false);
    try {
      const url = `${BASE_URL}/share/markdown-list/${token}/content${sessionParam ? `?session=${encodeURIComponent(sessionParam)}` : ''}`;
      const res = await fetch(url);
      if (res.status === 401) { setPwError(true); setState('password'); return; }
      if (res.status === 410) { setState('expired'); return; }
      if (res.status === 404) { setState('notfound'); return; }
      if (!res.ok) { setState('error'); return; }
      const data: MarkdownListContentResponse = await res.json();
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
      const session = await verifySharePassword('markdownList', token, pw);
      setSessionTicket(session);
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
    setSessionTicket(undefined);
    setPwError(false);
    fetch(`${BASE_URL}/share/markdown-list/${token}`)
      .then(async res => {
        if (res.status === 404) { setState('notfound'); return; }
        if (!res.ok) { setState('error'); return; }
        const data: MarkdownListMeta = await res.json();
        setMeta(data);
        if (data.isExpired) { setState('expired'); return; }
        if (data.hasPassword) { setState('password'); return; }
        fetchContent(undefined);
      })
      .catch(() => setState('error'));
  }, [token, fetchContent]);

  const accent = content?.markdownList.color ?? meta?.color ?? 'var(--color-primary)';
  const colorBg = content?.markdownList.colorBg ?? meta?.colorBg ?? 'var(--color-surface-gray)';

  let pageTitle = 'Loading markdown page...';
  if (state === 'notfound') {
    pageTitle = 'Markdown page not found';
  } else if (meta) {
    const prefix = meta.emoji ? `${meta.emoji} ` : '';
    pageTitle = `${prefix}${meta.name}`;
  }
  usePageTitle(pageTitle);

  const fullWidth = content?.markdownList.fullWidth ?? meta?.fullWidth ?? false;
  const cardMaxWidth = state === 'ready' ? (fullWidth ? 1400 : 720) : 460;

  // Numbering for contiguous numbered-list-item runs, same rule as the editor.
  const numberByBlockId: Record<string, number> = {};
  if (content) {
    let run = 0;
    for (const b of content.content.blocks) {
      if (b.type === 'numbered-list-item') { run += 1; numberByBlockId[b.id] = run; }
      else run = 0;
    }
  }

  // Blocks are grouped into outlined sections, same rule as the editor: a
  // `/divider` block closes the current section and opens a new one. A
  // `layout: 'columns'` divider additionally consumes the section right
  // after it, rendering both side by side in a 2-column grid instead of the
  // usual stacked section-then-divider sequence.
  const sections: SharedBlock[][] = [[]];
  const sectionDividers: SharedBlock[] = [];
  if (content) {
    for (const b of content.content.blocks) {
      if (b.type === 'divider') { sectionDividers.push(b); sections.push([]); }
      else sections[sections.length - 1].push(b);
    }
  }

  const rows: React.ReactNode[] = [];
  {
    let i = 0;
    while (i < sections.length) {
      const sectionBlocks = sections[i];
      const divider = sectionDividers[i];
      const nextSection = sections[i + 1];
      if (divider?.layout === 'columns' && sectionBlocks.length > 0 && nextSection && nextSection.length > 0) {
        rows.push(
          <div key={`row-${divider.id}`} style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16 }}>
            {[sectionBlocks, nextSection].map((sideBlocks, colIdx) => (
              <div key={colIdx} style={{ minWidth: 0, border: '1px solid var(--color-border-alt)', borderRadius: 12, background: 'var(--color-surface-gray)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {sideBlocks.map(block => (
                  <SharedBlockView key={block.id} block={block} accent={accent} number={numberByBlockId[block.id]} token={token} session={sessionTicket} />
                ))}
              </div>
            ))}
          </div>
        );
        i += 2;
        continue;
      }
      if (sectionBlocks.length > 0) {
        rows.push(
          <div key={`section-${i}`} style={{ border: '1px solid var(--color-border-alt)', borderRadius: 12, background: 'var(--color-surface-gray)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {sectionBlocks.map(block => (
              <SharedBlockView key={block.id} block={block} accent={accent} number={numberByBlockId[block.id]} token={token} session={sessionTicket} />
            ))}
          </div>
        );
      }
      if (divider) rows.push(<SharedBlockView key={divider.id} block={divider} accent={accent} token={token} session={sessionTicket} />);
      i += 1;
    }
  }

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
                {state === 'notfound' ? 'Markdown page not found' : state === 'expired' ? 'Link expired' : 'Something went wrong'}
              </div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
                {state === 'notfound' ? "This share link doesn't exist or has been removed." :
                 state === 'expired'  ? 'This share link has expired and is no longer available.' :
                                        'Unable to load this markdown page. Please try again.'}
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
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 4 }}>{meta?.name ?? 'Protected markdown page'}</div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-tertiary)' }}>This markdown page is password protected.</div>
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
              View markdown page
            </MotionButton>
          </div>
        )}

        {/* Ready — markdown content */}
        {state === 'ready' && content && (
          <>
            {/* Hero */}
            <div style={{ background: colorBg, padding: '28px 32px 24px', borderBottom: '1px solid var(--color-divider)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {content.markdownList.emoji && <span style={{ fontSize: 26 }}>{content.markdownList.emoji}</span>}
                <h1 style={{ margin: 0, fontFamily: 'var(--font-heading)', fontSize: 24, fontWeight: 800, color: 'var(--color-text-primary)', letterSpacing: '-0.02em' }}>{content.markdownList.name}</h1>
              </div>
              {content.markdownList.subtitle && <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-tertiary)', marginTop: 6 }}>{content.markdownList.subtitle}</div>}
            </div>

            {/* Blocks */}
            <div style={{ padding: '24px 32px 32px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              {content.content.blocks.length === 0 && (
                <div style={{ textAlign: 'center', padding: '24px', fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-quaternary)' }}>This markdown page is empty.</div>
              )}
              {rows}
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

// Read-only rendering of a single block — sections of blocks share one
// outline (see MarkdownListScreen.tsx), split wherever a `/divider` block
// appears, and this component just renders the block's own content with no
// interactivity beyond the outbound link.
function SharedBlockView({ block, accent, number, token, session }: { block: SharedBlock; accent: string; number?: number; token?: string; session: string | undefined }) {
  const cardStyle: React.CSSProperties = {
    borderRadius: block.type === 'image' ? 8 : 0,
    padding: block.type === 'divider' ? '4px 14px' : block.type === 'image' ? 8 : '6px 4px',
    overflow: block.type === 'image' ? 'hidden' : 'visible',
  };

  if (block.type === 'divider') {
    return <div style={cardStyle}><hr style={{ border: 'none', borderTop: '1.5px solid var(--color-border)', margin: '10px 0' }} /></div>;
  }
  if (block.type === 'image') {
    return (
      <div style={cardStyle}>
        <img src={`${BASE_URL}/share/markdown-list/${token}/images/${block.imageId}${session ? `?session=${encodeURIComponent(session)}` : ''}`} alt={block.caption ?? ''} style={{ maxWidth: '100%', borderRadius: 8, display: 'block' }} />
        {block.caption && <div style={{ marginTop: 6, padding: '0 4px 4px', fontFamily: 'var(--font-body)', fontSize: 12.5, fontStyle: 'italic', color: 'var(--color-text-tertiary)' }}>{block.caption}</div>}
      </div>
    );
  }
  if (block.type === 'table') {
    return <div style={cardStyle}><MarkdownTable block={block as unknown as MarkdownTableBlock} /></div>;
  }
  if (block.type === 'link') {
    return (
      <div style={cardStyle}>
        <a href={block.url} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', flexDirection: 'column', gap: 3, textDecoration: 'none' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-primary)' }}>
            <Icon name="link" size={14} color="var(--color-primary)" /> {block.title || block.url}
          </span>
          {block.description && <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>{block.description}</span>}
          <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{block.url}</span>
        </a>
      </div>
    );
  }

  const text = block.text ?? '';
  let textStyle: React.CSSProperties = { fontFamily: 'var(--font-body)', fontSize: 15, color: 'var(--color-text-primary)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' };
  if (block.type === 'heading') {
    const sizes = { 1: 26, 2: 21, 3: 17 } as const;
    textStyle = { ...textStyle, fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: sizes[block.level ?? 3] };
  } else if (block.type === 'quote') {
    textStyle = { ...textStyle, fontStyle: 'italic', color: 'var(--color-text-secondary)' };
  } else if (block.type === 'todo' && block.checked) {
    textStyle = { ...textStyle, opacity: 0.4, textDecoration: 'line-through' };
  }

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        {block.type === 'bulleted-list-item' && <span style={{ paddingTop: 2, color: 'var(--color-text-tertiary)', fontSize: 16, lineHeight: 1, flexShrink: 0 }}>•</span>}
        {block.type === 'numbered-list-item' && <span style={{ color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, flexShrink: 0, minWidth: 16 }}>{number}.</span>}
        {block.type === 'todo' && (
          <div style={{ width: 20, height: 20, minWidth: 20, borderRadius: 5, border: '1.5px solid', borderColor: block.checked ? accent : 'var(--color-border-strong)', background: block.checked ? accent : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {block.checked && <Icon name="check" size={13} color="var(--color-white)" />}
          </div>
        )}
        {block.type === 'quote' && <span style={{ width: 3, alignSelf: 'stretch', background: 'var(--color-border-strong)', borderRadius: 2, flexShrink: 0 }} />}
        <div style={{ flex: 1, minWidth: 0, ...textStyle }}>{text ? renderInline(text, block.id) : ' '}</div>
      </div>
    </div>
  );
}
