import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import Icon from '../components/Icon';

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
  if (mime.includes('pdf'))   return '#dc2626';
  if (mime.includes('image')) return '#2563eb';
  if (mime.includes('video')) return '#7c3aed';
  if (mime.includes('zip'))   return '#d97706';
  return '#5e4dbb';
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
}

type PageState = 'loading' | 'password' | 'ready' | 'expired' | 'private' | 'notfound' | 'error';

export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<PageState>('loading');
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState(false);
  const [downloading, setDownloading] = useState(false);

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
    if (state === 'ready' && info && !info.hasPassword) {
      const kind = getPreviewKind(info.mimeType);
      if (kind !== 'none') {
        setPreviewKind(kind);
        triggerPreviewLoad(kind, undefined);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, info]);

  useEffect(() => {
    return () => {
      if (fontBlobRef.current) URL.revokeObjectURL(fontBlobRef.current);
    };
  }, []);

  const downloadUrl = (pw?: string) => {
    const url = `${BASE_URL}/share/${token}/download`;
    return pw ? `${url}?password=${encodeURIComponent(pw)}` : url;
  };

  const triggerPreviewLoad = async (kind: PreviewKind, pw: string | undefined) => {
    setPreviewLoading(true);
    setPreviewError(false);
    setPreviewVisible(false);
    setPreviewMediaUrl(null);
    setPreviewText(null);
    setPreviewFontFamily(null);

    const url = downloadUrl(pw);

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

  const handlePreview = async () => {
    if (!info) return;
    if (info.hasPassword && !password) { setPwError(true); return; }
    const kind = getPreviewKind(info.mimeType);
    if (kind === 'none') return;
    setPreviewKind(kind);
    await triggerPreviewLoad(kind, info.hasPassword ? password : undefined);
  };

  const handleDownload = async () => {
    if (!info) return;
    if (info.hasPassword && !password) { setPwError(true); return; }
    setDownloading(true);
    try {
      const url = downloadUrl(info.hasPassword ? password : undefined);
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
      a.download = info.name;
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

  return (
    <div style={{ minHeight: '100vh', background: '#f8f7fc', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      {/* Logo */}
      <div style={{ position: 'absolute', top: 20, left: 24, display: 'flex', alignItems: 'center', gap: 9 }}>
        <img src="/solytiq-cloud.png" alt="Solytiq" style={{ width: 36, height: 36, borderRadius: 9, objectFit: 'cover', flexShrink: 0 }} />
        <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 800, color: '#1c1b22', letterSpacing: '-0.02em' }}>solytiq</span>
      </div>

      {/* Shared-by bubble */}
      {info?.sharedBy && (
        <div style={{ position: 'absolute', top: 20, right: 24, display: 'flex', alignItems: 'center', gap: 8, background: '#fff', border: '1.5px solid #E5E7EB', borderRadius: 99, padding: '6px 12px 6px 6px', boxShadow: '0 2px 8px rgba(94,77,187,0.07)' }}>
          <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'linear-gradient(135deg, #9d8dff 0%, #5e4dbb 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
            {info.sharedByImage
              ? <img src={info.sharedByImage} alt={info.sharedBy} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 9, fontWeight: 700, color: '#fff', letterSpacing: '0.02em' }}>{sharedByInitials(info.sharedBy)}</span>
            }
          </div>
          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584' }}>Shared by <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontWeight: 600, color: '#1c1b22' }}>{info.sharedBy}</span></span>
        </div>
      )}

      <div style={{ background: '#fff', borderRadius: 20, boxShadow: '0 8px 40px rgba(94,77,187,0.10)', padding: '40px 40px 36px', width: '100%', maxWidth: cardMaxWidth, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0, transition: 'max-width 300ms ease' }}>

        {/* Loading */}
        {state === 'loading' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '20px 0' }}>
            <div style={{ width: 36, height: 36, border: '3px solid #e8e4f0', borderTopColor: '#5e4dbb', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#b0acbe' }}>Loading…</div>
          </div>
        )}

        {/* Error states */}
        {(state === 'notfound' || state === 'private' || state === 'expired' || state === 'error') && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '12px 0 8px', textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: state === 'expired' ? '#fef3c7' : '#fff5f5', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={state === 'expired' ? 'schedule' : state === 'private' ? 'lock' : 'error_outline'} size={28} color={state === 'expired' ? '#d97706' : '#ba1a1a'} />
            </div>
            <div>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 18, fontWeight: 700, color: '#1c1b22', marginBottom: 6 }}>
                {state === 'notfound' ? 'File not found'  :
                 state === 'private'  ? 'Private file'    :
                 state === 'expired'  ? 'Link expired'    : 'Something went wrong'}
              </div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#787584', lineHeight: 1.5 }}>
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
            <div style={{ width: 72, height: 72, borderRadius: 18, background: '#F9FAFB', border: '1.5px solid #E5E7EB', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', marginBottom: 20, position: 'relative', overflow: 'hidden' }}>
              <Icon name="description" size={36} color="#d1d5db" />
              <div style={{ position: 'absolute', bottom: 5, left: '50%', transform: 'translateX(-50%)', background: badgeColor, color: '#fff', fontFamily: 'Inter, sans-serif', fontSize: 8, fontWeight: 800, letterSpacing: '0.04em', padding: '2px 5px', borderRadius: 4 }}>{label}</div>
            </div>

            {/* Title */}
            {info.title && (
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 24, fontWeight: 800, color: '#1c1b22', textAlign: 'center', letterSpacing: '-0.02em', marginBottom: 6, wordBreak: 'break-word', width: '100%', lineHeight: 1.25 }}>{info.title}</div>
            )}

            {/* File name */}
            <div style={{ fontFamily: info.title ? 'Inter, sans-serif' : 'Hanken Grotesk, sans-serif', fontSize: info.title ? 13 : 20, fontWeight: info.title ? 400 : 700, color: info.title ? '#787584' : '#1c1b22', textAlign: 'center', letterSpacing: info.title ? 0 : '-0.01em', marginBottom: 8, wordBreak: 'break-word', width: '100%' }}>{info.name}</div>

            {/* Meta */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: info.note ? 18 : 28, flexWrap: 'wrap', justifyContent: 'center' }}>
              <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>{fmtSize(info.size)}</span>
              <span style={{ color: '#e8e4f0' }}>·</span>
              <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>Shared {fmtDate(info.createdAt)}</span>
              {info.expiresAt && (
                <>
                  <span style={{ color: '#e8e4f0' }}>·</span>
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#d97706', background: '#fef3c7', borderRadius: 99, padding: '2px 8px' }}>Expires {fmtDate(info.expiresAt)}</span>
                </>
              )}
            </div>

            {/* Note */}
            {info.note && (
              <div style={{ width: '100%', marginBottom: 24, background: '#F5F3FF', border: '1.5px solid #e8e4f0', borderRadius: 14, padding: '14px 18px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{ marginTop: 1, flexShrink: 0 }}><Icon name="sticky_note_2" size={17} color="#5e4dbb" /></div>
                <p style={{ margin: 0, fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#484552', lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{info.note}</p>
              </div>
            )}

            {/* Preview area */}
            {previewLoading && (
              <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '28px 0', marginBottom: 20, borderRadius: 14, border: '1.5px solid #E5E7EB', background: '#F9FAFB' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 28, height: 28, border: '3px solid #e8e4f0', borderTopColor: '#5e4dbb', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>Loading preview…</span>
                </div>
              </div>
            )}

            {previewVisible && !previewLoading && (
              <div style={{ width: '100%', marginBottom: 24, borderRadius: 14, overflow: 'hidden', border: '1.5px solid #E5E7EB', background: '#F9FAFB' }}>

                {/* Image */}
                {previewKind === 'image' && previewMediaUrl && (
                  <img
                    src={previewMediaUrl}
                    alt={info.name}
                    style={{ display: 'block', width: '100%', maxHeight: 500, objectFit: 'contain', background: '#F9FAFB' }}
                    onError={() => { setPreviewVisible(false); setPreviewError(true); }}
                  />
                )}

                {/* Video */}
                {previewKind === 'video' && previewMediaUrl && (
                  <video
                    src={previewMediaUrl}
                    controls
                    style={{ display: 'block', width: '100%', maxHeight: 440, background: '#000', outline: 'none' }}
                    onError={() => { setPreviewVisible(false); setPreviewError(true); }}
                  />
                )}

                {/* Audio */}
                {previewKind === 'audio' && previewMediaUrl && (
                  <div style={{ padding: '20px', background: '#F9FAFB' }}>
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
                  <pre style={{ margin: 0, padding: '16px 20px', fontFamily: "'Fira Mono', 'Cascadia Code', 'Consolas', monospace", fontSize: 12.5, lineHeight: 1.65, color: '#1c1b22', background: '#F9FAFB', maxHeight: 460, overflowY: 'auto', overflowX: 'auto', whiteSpace: 'pre', wordBreak: 'normal' }}>
                    {previewText}
                  </pre>
                )}

                {/* Font */}
                {previewKind === 'font' && previewFontFamily && (
                  <div style={{ padding: '28px 24px', background: '#F9FAFB' }}>
                    <div style={{ fontFamily: `'${previewFontFamily}', sans-serif`, fontSize: 30, color: '#1c1b22', marginBottom: 14, lineHeight: 1.25 }}>
                      The quick brown fox jumps over the lazy dog
                    </div>
                    <div style={{ fontFamily: `'${previewFontFamily}', sans-serif`, fontSize: 15, color: '#787584', letterSpacing: '0.02em', marginBottom: 8 }}>
                      ABCDEFGHIJKLMNOPQRSTUVWXYZ
                    </div>
                    <div style={{ fontFamily: `'${previewFontFamily}', sans-serif`, fontSize: 15, color: '#787584', letterSpacing: '0.02em' }}>
                      abcdefghijklmnopqrstuvwxyz 0123456789
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Preview error placeholder */}
            {previewError && !previewLoading && (
              <div style={{ width: '100%', marginBottom: 24, borderRadius: 14, border: '1.5px solid #E5E7EB', background: '#F9FAFB', padding: '20px', display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center' }}>
                <Icon name="visibility_off" size={18} color="#b0acbe" />
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>Preview not available</span>
              </div>
            )}

            {/* Password field */}
            {info.hasPassword && (
              <div style={{ width: '100%', marginBottom: 16 }}>
                <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#787584', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>
                  Password required
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={e => { setPassword(e.target.value); setPwError(false); }}
                  onKeyDown={e => { if (e.key === 'Enter') handleDownload(); }}
                  placeholder="Enter password to access"
                  style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#1c1b22', background: '#F9FAFB', border: `1.5px solid ${pwError ? '#ba1a1a' : '#E5E7EB'}`, borderRadius: 10, padding: '11px 14px', outline: 'none', boxSizing: 'border-box' }}
                  autoFocus
                />
                {pwError && (
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a', marginTop: 5 }}>Incorrect password, please try again.</div>
                )}
              </div>
            )}

            {/* Preview button — password-protected files only, before preview is shown */}
            {info.hasPassword && hasPreviewSupport && !previewVisible && !previewLoading && !previewError && (
              <button
                onClick={handlePreview}
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', border: '1.5px solid #ebe6ff', borderRadius: 12, padding: '13px', cursor: 'pointer', marginBottom: 10, transition: 'background 150ms' }}
                onMouseEnter={e => { e.currentTarget.style.background = '#ede8ff'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#F5F3FF'; }}
              >
                <Icon name="visibility" size={18} color="#5e4dbb" />
                Preview
              </button>
            )}

            {/* Download button */}
            <button
              onClick={handleDownload}
              disabled={downloading}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 700, color: '#fff', background: downloading ? '#9d8dff' : '#5e4dbb', border: 'none', borderRadius: 12, padding: '14px', cursor: downloading ? 'not-allowed' : 'pointer', transition: 'background 150ms' }}
              onMouseEnter={e => { if (!downloading) e.currentTarget.style.background = '#4f3fa8'; }}
              onMouseLeave={e => { if (!downloading) e.currentTarget.style.background = '#5e4dbb'; }}
            >
              {downloading
                ? <><div style={{ width: 16, height: 16, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />Downloading…</>
                : <><Icon name="download" size={18} color="#fff" />Download</>
              }
            </button>
          </>
        )}
      </div>

      <div style={{ marginTop: 24, fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe' }}>
        Shared via <span style={{ color: '#5e4dbb', fontWeight: 600 }}>Solytiq</span>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
