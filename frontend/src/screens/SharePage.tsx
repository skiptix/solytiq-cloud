import { usePageTitle } from "../hooks/usePageTitle";
import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import Icon from '../components/Icon';
import { verifySharePassword, ShareSessionError } from '../utils/shareSession';
import Spinner from '@/components/animate-ui/Spinner';
import MotionIn from '../components/animate-ui/MotionIn';
import MotionButton from '../components/animate-ui/MotionButton';

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

function fmtSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000)     return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function mimeLabel(mime: string): string {
  if (mime.includes('pdf'))   return 'PDF';
  if (mime.includes('image')) return mime.split('/')[1].toUpperCase();
  if (mime.includes('video')) return 'VIDEO';
  if (mime.includes('zip') || mime.includes('compressed')) return 'ZIP';
  if (mime.includes('word') || mime.includes('document')) return 'DOC';
  const ext = mime.split('/')[1]?.toUpperCase();
  return ext?.slice(0, 5) ?? 'FILE';
}

function mimeBadgeColor(mime: string): string {
  if (mime.includes('pdf'))   return 'var(--color-red-mid-4)';
  if (mime.includes('image')) return 'var(--color-blue-mid-5)';
  if (mime.includes('video')) return 'var(--color-purple-mid-9)';
  if (mime.includes('zip'))   return 'var(--color-warning)';
  return 'var(--color-primary)';
}

type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'font' | 'none';

function getPreviewKind(mime: string): PreviewKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.includes('/pdf')) return 'pdf';
  if (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime.includes('xml') ||
    mime.includes('yaml') ||
    mime.includes('javascript') ||
    mime.includes('x-sh') ||
    mime.includes('x-python') ||
    mime.includes('x-php') ||
    mime.includes('x-ruby') ||
    mime.includes('x-java') ||
    mime.includes('x-c') ||
    mime.includes('x-go') ||
    mime.includes('x-rust') ||
    mime.includes('geo+json') ||
    mime.includes('calendar') ||
    mime.includes('vcard') ||
    mime === 'message/rfc822'
  ) return 'text';
  if (
    mime.startsWith('font/') ||
    mime.includes('font-woff') ||
    mime.includes('font-ttf') ||
    mime.includes('font-opentype') ||
    mime.includes('font-sfnt')
  ) return 'font';
  return 'none';
}

interface SharedBundleFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

interface FileInfo {
  name: string;
  title: string | null;
  note: string | null;
  mimeType: string;
  size: number;
  hasPassword: boolean;
  expiresAt: string | null;
  isExpired: boolean;
  createdAt: string;
  sharedBy: string | null;
  sharedByImage: string | null;
  files?: SharedBundleFile[];
}

type PageState = 'loading' | 'password' | 'ready' | 'expired' | 'private' | 'notfound' | 'error';

export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<PageState>('loading');
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState(false);
  const [downloading, setDownloading] = useState(false);
  // S4: the short-lived session ticket obtained by verifying the password
  // (utils/shareSession.ts) — replaces `?password=` on every download/preview
  // request after the first successful verify. Reset whenever `password`
  // changes so a re-typed password re-verifies rather than reusing a stale
  // (possibly now-invalid, e.g. after this share's password was rotated)
  // ticket for a DIFFERENT password value.
  const [sessionTicket, setSessionTicket] = useState<string | undefined>(undefined);

  const [previewKind, setPreviewKind] = useState<PreviewKind>('none');
  const [previewMediaUrl, setPreviewMediaUrl] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewFontFamily, setPreviewFontFamily] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false);
  const fontBlobRef = useRef<string | null>(null);
  const fontCounterRef = useRef(0);

  useEffect(() => {
    if (!token) { setState('notfound'); return; }
    fetch(`${BASE_URL}/share/${token}`)
      .then(async res => {
        if (res.status === 404) { setState('notfound'); return; }
        if (res.status === 403) { setState('private');  return; }
        if (!res.ok) { setState('error'); return; }
        const data: FileInfo = await res.json();
        setInfo(data);
        setState(data.isExpired ? 'expired' : 'ready');
      })
      .catch(() => setState('error'));
  }, [token]);

  useEffect(() => {
    return () => {
      if (fontBlobRef.current) URL.revokeObjectURL(fontBlobRef.current);
    };
  }, []);

  const downloadUrl = (session?: string, fileId?: string) => {
    const url = `${BASE_URL}/share/${token}/download${fileId ? `/${fileId}` : ''}`;
    return session ? `${url}?session=${encodeURIComponent(session)}` : url;
  };

  /** Resolve a usable session ticket for this share: the cached one if we
   *  already verified successfully, otherwise verify `password` now (POST,
   *  never a URL — see utils/shareSession.ts). Returns undefined (and sets
   *  pwError) on a wrong password; undefined is also the correct "no
   *  password needed" value for a share that isn't protected at all. */
  const ensureSession = async (): Promise<string | undefined> => {
    if (!info?.hasPassword) return undefined;
    if (sessionTicket) return sessionTicket;
    if (!token || !password) { setPwError(true); return undefined; }
    try {
      const session = await verifySharePassword('file', token, password);
      setSessionTicket(session);
      return session;
    } catch (err) {
      if (err instanceof ShareSessionError && err.status === 401) setPwError(true);
      return undefined;
    }
  };

  const triggerPreviewLoad = async (kind: PreviewKind, session: string | undefined) => {
    setPreviewLoading(true);
    setPreviewError(false);
    setPreviewVisible(false);
    setPreviewMediaUrl(null);
    setPreviewText(null);
    setPreviewFontFamily(null);

    const url = downloadUrl(session);

    try {
      if (kind === 'text') {
        const res = await fetch(url);
        if (res.status === 401) { setPwError(true); setPreviewLoading(false); return; }
        if (!res.ok) { setPreviewError(true); setPreviewLoading(false); return; }
        const text = await res.text();
        setPreviewText(text.slice(0, 200_000));
        setPreviewVisible(true);
      } else if (kind === 'font') {
        const res = await fetch(url);
        if (res.status === 401) { setPwError(true); setPreviewLoading(false); return; }
        if (!res.ok) { setPreviewError(true); setPreviewLoading(false); return; }
        const blob = await res.blob();
        if (fontBlobRef.current) URL.revokeObjectURL(fontBlobRef.current);
        const blobUrl = URL.createObjectURL(blob);
        fontBlobRef.current = blobUrl;
        fontCounterRef.current += 1;
        const familyName = `preview-font-${fontCounterRef.current}`;
        const fontFace = new FontFace(familyName, `url(${blobUrl})`);
        await fontFace.load();
        document.fonts.add(fontFace);
        setPreviewFontFamily(familyName);
        setPreviewVisible(true);
      } else {
        // image, video, audio, pdf — use URL as src directly
        setPreviewMediaUrl(url);
        setPreviewVisible(true);
      }
    } catch {
      setPreviewError(true);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Declared AFTER triggerPreviewLoad on purpose: an effect that closes over a
  // `const` arrow function defined further down works at runtime (the effect
  // runs post-mount) but reads as a use-before-declare, which is exactly what
  // react-hooks/immutability flags.
  useEffect(() => {
    if (state === 'ready' && info && !info.hasPassword) {
      const kind = getPreviewKind(info.mimeType);
      if (kind !== 'none') {
        setPreviewKind(kind);
        triggerPreviewLoad(kind, undefined);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, info]);

  const handlePreview = async () => {
    if (!info) return;
    const session = await ensureSession();
    if (info.hasPassword && !session) return; // ensureSession already set pwError
    const kind = getPreviewKind(info.mimeType);
    if (kind === 'none') return;
    setPreviewKind(kind);
    await triggerPreviewLoad(kind, session);
  };

  const handleDownload = async (file?: SharedBundleFile) => {
    if (!info) return;
    const session = await ensureSession();
    if (info.hasPassword && !session) return; // ensureSession already set pwError
    setDownloading(true);
    try {
      const url = downloadUrl(session, file?.id);
      const res = await fetch(url);
      if (res.status === 401) {
        setPwError(true);
        setDownloading(false);
        return;
      }
      if (!res.ok) { setDownloading(false); return; }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = file?.name ?? info.name;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      // silently fail
    } finally {
      setDownloading(false);
    }
  };

  const label = mimeLabel(info?.mimeType ?? '');
  const badgeColor = mimeBadgeColor(info?.mimeType ?? '');
  const hasPreviewSupport = info ? getPreviewKind(info.mimeType) !== 'none' : false;

  const showingPreview = previewLoading || previewVisible || previewError;
  const isWideKind = previewKind === 'image' || previewKind === 'video' || previewKind === 'pdf';
  const cardMaxWidth = showingPreview && isWideKind ? 720
    : showingPreview && previewKind === 'text' ? 680
    : 440;

  function sharedByInitials(name: string): string {
    return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  }

  let pageTitle = 'Loading file...';
  if (state === 'notfound') {
    pageTitle = 'File not found';
  } else if (info) {
    pageTitle = info.name;
  }
  usePageTitle(pageTitle);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-purple-pale-9)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      {/* Logo */}
      <div style={{ position: 'absolute', top: 20, left: 24, display: 'flex', alignItems: 'center', gap: 9 }}>
        <img src="/solytiq-cloud.png" alt="Solytiq" style={{ width: 36, height: 36, borderRadius: 9, objectFit: 'cover', flexShrink: 0 }} />
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 800, color: 'var(--color-text-primary)', letterSpacing: '-0.02em' }}>solytiq</span>
      </div>

      {/* Shared-by bubble */}
      {info?.sharedBy && (
        <div style={{ position: 'absolute', top: 20, right: 24, display: 'flex', alignItems: 'center', gap: 8, background: 'var(--color-white)', border: '1.5px solid var(--color-border-alt)', borderRadius: 99, padding: '6px 12px 6px 6px', boxShadow: '0 2px 8px rgba(var(--color-primary-rgb), 0.07)' }}>
          <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'linear-gradient(135deg, var(--color-accent-purple-light) 0%, var(--color-primary) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
            {info.sharedByImage
              ? <img src={info.sharedByImage} alt={info.sharedBy} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <span style={{ fontFamily: 'var(--font-heading)', fontSize: 9, fontWeight: 700, color: 'var(--color-white)', letterSpacing: '0.02em' }}>{sharedByInitials(info.sharedBy)}</span>
            }
          </div>
          <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)' }}>Shared by <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, color: 'var(--color-text-primary)' }}>{info.sharedBy}</span></span>
        </div>
      )}

      <MotionIn transition={{ duration: 0.3 }} style={{ background: 'var(--color-white)', borderRadius: 20, boxShadow: '0 8px 40px rgba(var(--color-primary-rgb), 0.10)', padding: '40px 40px 36px', width: '100%', maxWidth: cardMaxWidth, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0, }}>

        {/* Loading */}
        {state === 'loading' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '20px 0' }}>
            <Spinner size={36} thickness={3} durationMs={700} />
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-quaternary)' }}>Loading…</div>
          </div>
        )}

        {/* Error states */}
        {(state === 'notfound' || state === 'private' || state === 'expired' || state === 'error') && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '12px 0 8px', textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: state === 'expired' ? 'var(--color-yellow-tint-1)' : 'var(--color-error-bg-alt)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={state === 'expired' ? 'schedule' : state === 'private' ? 'lock' : 'error_outline'} size={28} color={state === 'expired' ? 'var(--color-warning)' : 'var(--color-error)'} />
            </div>
            <div>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 6 }}>
                {state === 'notfound' ? 'File not found'  :
                 state === 'private'  ? 'Private file'    :
                 state === 'expired'  ? 'Link expired'    : 'Something went wrong'}
              </div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
                {state === 'notfound' ? "This share link doesn't exist or has been removed." :
                 state === 'private'  ? "This file is private and can't be accessed via a share link." :
                 state === 'expired'  ? 'This share link has expired and is no longer available.' :
                                       'Unable to load this file. Please try again.'}
              </div>
            </div>
          </div>
        )}

        {/* Ready state */}
        {state === 'ready' && info && (
          <>
            {/* File icon */}
            <div style={{ width: 72, height: 72, borderRadius: 18, background: 'var(--color-surface-gray)', border: '1.5px solid var(--color-border-alt)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', marginBottom: 20, position: 'relative', overflow: 'hidden' }}>
              <Icon name="description" size={36} color="var(--color-blue-tint-3)" />
              <div style={{ position: 'absolute', bottom: 5, left: '50%', transform: 'translateX(-50%)', background: badgeColor, color: 'var(--color-white)', fontFamily: 'var(--font-body)', fontSize: 8, fontWeight: 800, letterSpacing: '0.04em', padding: '2px 5px', borderRadius: 4 }}>{label}</div>
            </div>

            {/* Title */}
            {info.title && (
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 24, fontWeight: 800, color: 'var(--color-text-primary)', textAlign: 'center', letterSpacing: '-0.02em', marginBottom: 6, wordBreak: 'break-word', width: '100%', lineHeight: 1.25 }}>{info.title}</div>
            )}

            {/* File name */}
            <div style={{ fontFamily: info.title ? 'Inter, sans-serif' : 'Hanken Grotesk, sans-serif', fontSize: info.title ? 13 : 20, fontWeight: info.title ? 400 : 700, color: info.title ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)', textAlign: 'center', letterSpacing: info.title ? 0 : '-0.01em', marginBottom: 8, wordBreak: 'break-word', width: '100%' }}>{info.name}</div>

            {/* Meta */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: info.note ? 18 : 28, flexWrap: 'wrap', justifyContent: 'center' }}>
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>{fmtSize(info.size)}</span>
              <span style={{ color: 'var(--color-border)' }}>·</span>
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>Shared {fmtDate(info.createdAt)}</span>
              {info.expiresAt && (
                <>
                  <span style={{ color: 'var(--color-border)' }}>·</span>
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-warning)', background: 'var(--color-yellow-tint-1)', borderRadius: 99, padding: '2px 8px' }}>Expires {fmtDate(info.expiresAt)}</span>
                </>
              )}
            </div>

            {/* Note */}
            {info.note && (
              <div style={{ width: '100%', marginBottom: 24, background: 'var(--color-surface-tint)', border: '1.5px solid var(--color-border)', borderRadius: 14, padding: '14px 18px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{ marginTop: 1, flexShrink: 0 }}><Icon name="sticky_note_2" size={17} color="var(--color-primary)" /></div>
                <p style={{ margin: 0, fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-secondary)', lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{info.note}</p>
              </div>
            )}

            {info.files && info.files.length > 1 && (
              <div style={{ width: '100%', marginBottom: 24, border: '1.5px solid var(--color-border-alt)', borderRadius: 14, overflow: 'hidden', background: 'var(--color-surface-gray)' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border-alt)', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Icon name="folder_zip" size={17} color="var(--color-primary)" />
                  Shared bundle
                </div>
                {info.files.map((bundleFile, index) => (
                  <div key={bundleFile.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', borderBottom: index < info.files!.length - 1 ? '1px solid var(--color-purple-pale-36)' : 'none' }}>
                    <div style={{ width: 34, height: 34, borderRadius: 8, background: 'var(--color-white)', border: '1px solid var(--color-border-alt)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Icon name="description" size={18} color={mimeBadgeColor(bundleFile.mimeType)} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{bundleFile.name}</div>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', marginTop: 1 }}>{fmtSize(bundleFile.size)}</div>
                    </div>
                    <button onClick={() => handleDownload(bundleFile)} disabled={downloading}
                      style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 700, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', border: 'none', borderRadius: 8, padding: '7px 10px', cursor: downloading ? 'not-allowed' : 'pointer' }}>
                      Download
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Preview area */}
            {previewLoading && (
              <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '28px 0', marginBottom: 20, borderRadius: 14, border: '1.5px solid var(--color-border-alt)', background: 'var(--color-surface-gray)' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                  <Spinner size={28} thickness={3} durationMs={700} />
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>Loading preview…</span>
                </div>
              </div>
            )}

            {previewVisible && !previewLoading && (
              <div style={{ width: '100%', marginBottom: 24, borderRadius: 14, overflow: 'hidden', border: '1.5px solid var(--color-border-alt)', background: 'var(--color-surface-gray)' }}>

                {/* Image */}
                {previewKind === 'image' && previewMediaUrl && (
                  <img
                    src={previewMediaUrl}
                    alt={info.name}
                    style={{ display: 'block', width: '100%', maxHeight: 500, objectFit: 'contain', background: 'var(--color-surface-gray)' }}
                    onError={() => { setPreviewVisible(false); setPreviewError(true); }}
                  />
                )}

                {/* Video */}
                {previewKind === 'video' && previewMediaUrl && (
                  <video
                    src={previewMediaUrl}
                    controls
                    style={{ display: 'block', width: '100%', maxHeight: 440, background: 'var(--color-black)', outline: 'none' }}
                    onError={() => { setPreviewVisible(false); setPreviewError(true); }}
                  />
                )}

                {/* Audio */}
                {previewKind === 'audio' && previewMediaUrl && (
                  <div style={{ padding: '20px', background: 'var(--color-surface-gray)' }}>
                    <audio
                      src={previewMediaUrl}
                      controls
                      style={{ width: '100%', display: 'block' }}
                      onError={() => { setPreviewVisible(false); setPreviewError(true); }}
                    />
                  </div>
                )}

                {/* PDF */}
                {previewKind === 'pdf' && previewMediaUrl && (
                  <iframe
                    src={previewMediaUrl}
                    title={info.name}
                    style={{ display: 'block', width: '100%', height: 600, border: 'none' }}
                  />
                )}

                {/* Text / Code */}
                {previewKind === 'text' && previewText !== null && (
                  <pre style={{ margin: 0, padding: '16px 20px', fontFamily: "var(--font-mono-code)", fontSize: 12.5, lineHeight: 1.65, color: 'var(--color-text-primary)', background: 'var(--color-surface-gray)', maxHeight: 460, overflowY: 'auto', overflowX: 'auto', whiteSpace: 'pre', wordBreak: 'normal' }}>
                    {previewText}
                  </pre>
                )}

                {/* Font */}
                {previewKind === 'font' && previewFontFamily && (
                  <div style={{ padding: '28px 24px', background: 'var(--color-surface-gray)' }}>
                    <div style={{ fontFamily: `'${previewFontFamily}', sans-serif`, fontSize: 30, color: 'var(--color-text-primary)', marginBottom: 14, lineHeight: 1.25 }}>
                      The quick brown fox jumps over the lazy dog
                    </div>
                    <div style={{ fontFamily: `'${previewFontFamily}', sans-serif`, fontSize: 15, color: 'var(--color-text-tertiary)', letterSpacing: '0.02em', marginBottom: 8 }}>
                      ABCDEFGHIJKLMNOPQRSTUVWXYZ
                    </div>
                    <div style={{ fontFamily: `'${previewFontFamily}', sans-serif`, fontSize: 15, color: 'var(--color-text-tertiary)', letterSpacing: '0.02em' }}>
                      abcdefghijklmnopqrstuvwxyz 0123456789
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Preview error placeholder */}
            {previewError && !previewLoading && (
              <div style={{ width: '100%', marginBottom: 24, borderRadius: 14, border: '1.5px solid var(--color-border-alt)', background: 'var(--color-surface-gray)', padding: '20px', display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center' }}>
                <Icon name="visibility_off" size={18} color="var(--color-text-quaternary)" />
                <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>Preview not available</span>
              </div>
            )}

            {/* Password field */}
            {info.hasPassword && (
              <div style={{ width: '100%', marginBottom: 16 }}>
                <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>
                  Password required
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={e => { setPassword(e.target.value); setPwError(false); setSessionTicket(undefined); }}
                  onKeyDown={e => { if (e.key === 'Enter') handleDownload(); }}
                  placeholder="Enter password to access"
                  style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-primary)', background: 'var(--color-surface-gray)', border: `1.5px solid ${pwError ? 'var(--color-error)' : 'var(--color-border-alt)'}`, borderRadius: 10, padding: '11px 14px', outline: 'none', boxSizing: 'border-box' }}
                  autoFocus
                />
                {pwError && (
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)', marginTop: 5 }}>Incorrect password, please try again.</div>
                )}
              </div>
            )}

            {/* Preview button — password-protected files only, before preview is shown */}
            {info.hasPassword && hasPreviewSupport && !previewVisible && !previewLoading && !previewError && (
              <MotionButton
                onClick={handlePreview}
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 600, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', border: '1.5px solid var(--color-purple-pale-27)', borderRadius: 12, padding: '13px', cursor: 'pointer', marginBottom: 10 }}
                whileHover={{ background: 'var(--color-purple-pale-22)' }}
                transition={{ duration: 0.15 }}
              >
                <Icon name="visibility" size={18} color="var(--color-primary)" />
                Preview
              </MotionButton>
            )}

            {/* Download button */}
            <MotionButton
              onClick={() => handleDownload()}
              disabled={downloading}
              transition={{ duration: 0.15 }} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 700, color: 'var(--color-white)', background: downloading ? 'var(--color-accent-purple-light)' : 'var(--color-primary)', border: 'none', borderRadius: 12, padding: '14px', cursor: downloading ? 'not-allowed' : 'pointer', }}
              onMouseEnter={e => { if (!downloading) e.currentTarget.style.background = 'var(--color-purple-mid-10)'; }}
              onMouseLeave={e => { if (!downloading) e.currentTarget.style.background = 'var(--color-primary)'; }}
            >
              {downloading
                ? <><Spinner size={16} thickness={2} trackColor="rgba(var(--color-white-rgb), 0.4)" indicatorColor="var(--color-white)" durationMs={700} />Downloading…</>
                : <><Icon name="download" size={18} color="var(--color-white)" />{info.files && info.files.length > 1 ? 'Download first file' : 'Download'}</>
              }
            </MotionButton>
          </>
        )}
      </MotionIn>

      <div style={{ marginTop: 24, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>
        Shared via <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>Solytiq</span>
      </div>

    </div>
  );
}
