import { useState, useEffect } from 'react';
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

interface FileInfo {
  name: string;
  mimeType: string;
  size: number;
  hasPassword: boolean;
  expiresAt: string | null;
  isExpired: boolean;
  createdAt: string;
}

type PageState = 'loading' | 'password' | 'ready' | 'expired' | 'private' | 'notfound' | 'error';

export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<PageState>('loading');
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState(false);
  const [downloading, setDownloading] = useState(false);

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

  const downloadUrl = (pw?: string) => {
    const url = `${BASE_URL}/share/${token}/download`;
    return pw ? `${url}?password=${encodeURIComponent(pw)}` : url;
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

  return (
    <div style={{ minHeight: '100vh', background: '#f8f7fc', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      {/* Brand */}
      <div style={{ position: 'absolute', top: 24, left: 32, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 18, fontWeight: 800, color: '#5e4dbb', letterSpacing: '-0.02em' }}>
        solytiq
      </div>

      <div style={{ background: '#fff', borderRadius: 20, boxShadow: '0 8px 40px rgba(94,77,187,0.10)', padding: '40px 40px 36px', width: '100%', maxWidth: 440, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0 }}>

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

            {/* File name */}
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 20, fontWeight: 700, color: '#1c1b22', textAlign: 'center', letterSpacing: '-0.01em', marginBottom: 8, wordBreak: 'break-word' }}>{info.name}</div>

            {/* Meta */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 28, flexWrap: 'wrap', justifyContent: 'center' }}>
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
                  placeholder="Enter password to download"
                  style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#1c1b22', background: '#F9FAFB', border: `1.5px solid ${pwError ? '#ba1a1a' : '#E5E7EB'}`, borderRadius: 10, padding: '11px 14px', outline: 'none', boxSizing: 'border-box' }}
                  autoFocus
                />
                {pwError && (
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a', marginTop: 5 }}>Incorrect password, please try again.</div>
                )}
              </div>
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
