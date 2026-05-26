import { useState, useEffect, useCallback, useRef } from 'react';
import type { SharedFile } from '../types';
import { apiGetFiles, apiUpdateFile, apiDeleteFile, apiUploadFile, apiGetStorageUsage } from '../api/client';
import useAuthStore from '../store/useAuthStore';
import Icon from '../components/Icon';
import CalendarPicker from '../components/CalendarPicker';

// ── Helpers ───────────────────────────────────────────────────────

function fmtSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000)     return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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

function FileBadge({ mime, size = 40 }: { mime: string; size?: number }) {
  const label = mimeLabel(mime);
  const color = mimeBadgeColor(mime);
  return (
    <div style={{ width: size, height: size, borderRadius: 8, background: '#F9FAFB', border: '1px solid #E5E7EB', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden', position: 'relative' }}>
      <div style={{ position: 'absolute', bottom: 3, left: '50%', transform: 'translateX(-50%)', background: color, color: '#fff', fontFamily: 'Inter, sans-serif', fontSize: 7, fontWeight: 800, letterSpacing: '0.04em', padding: '1px 4px', borderRadius: 3 }}>{label}</div>
      <Icon name="description" size={size * 0.5} color="#d1d5db" />
    </div>
  );
}

// ── Upload queue entry ────────────────────────────────────────────

interface UploadEntry {
  id: string;
  file: File;
  progress: number;
  status: 'pending' | 'uploading' | 'done' | 'error';
  error?: string;
  result?: SharedFile;
}

// ── Upload Wizard Modal ───────────────────────────────────────────

interface UploadWizardProps {
  onClose: () => void;
  onUploaded: (file: SharedFile) => void;
  defaultIsPublic?: boolean;
}

function UploadWizard({ onClose, onUploaded, defaultIsPublic = true }: UploadWizardProps) {
  const [queue, setQueue] = useState<UploadEntry[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [isPublic, setIsPublic] = useState(defaultIsPublic);
  const [password, setPassword] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showExpiryCal, setShowExpiryCal] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((files: FileList | File[]) => {
    const entries: UploadEntry[] = Array.from(files).map(f => ({
      id: Math.random().toString(36).slice(2),
      file: f,
      progress: 0,
      status: 'pending',
    }));
    setQueue(q => [...q, ...entries]);

    entries.forEach(entry => {
      setQueue(q => q.map(e => e.id === entry.id ? { ...e, status: 'uploading' } : e));
      apiUploadFile(entry.file, { isPublic, password: password || undefined, expiresAt: expiresAt ? new Date(expiresAt + 'T23:59:59').toISOString() : undefined },
        (pct) => setQueue(q => q.map(e => e.id === entry.id ? { ...e, progress: pct } : e))
      ).then(result => {
        setQueue(q => q.map(e => e.id === entry.id ? { ...e, status: 'done', progress: 100, result } : e));
        onUploaded(result);
      }).catch(err => {
        setQueue(q => q.map(e => e.id === entry.id ? { ...e, status: 'error', error: String(err) } : e));
      });
    });
  }, [isPublic, password, expiresAt, onUploaded]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 520, maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(0,0,0,0.18)', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '22px 22px 18px', borderBottom: '1px solid #f1ecf6' }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, border: '1.5px solid #E5E7EB', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="cloud_upload" size={20} color="#5e4dbb" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>Upload files</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', marginTop: 2 }}>Select and upload the files of your choice</div>
          </div>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#F9FAFB'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
            <Icon name="close" size={18} color="#787584" />
          </button>
        </div>

        <div style={{ overflowY: 'auto', padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Drop zone */}
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
            style={{ border: `2px dashed ${dragOver ? '#5e4dbb' : '#d1d5db'}`, borderRadius: 14, padding: '32px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, cursor: 'pointer', background: dragOver ? '#F5F3FF' : '#fff', transition: 'all 150ms' }}
          >
            <Icon name="cloud_upload" size={36} color={dragOver ? '#5e4dbb' : '#9ca3af'} />
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 700, color: '#1c1b22', textAlign: 'center' }}>Choose a file or drag & drop it here.</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#9ca3af', textAlign: 'center' }}>JPEG, PNG, PDF, MP4 and more, up to 200 MB.</div>
            <button
              onClick={e => { e.stopPropagation(); inputRef.current?.click(); }}
              style={{ marginTop: 4, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22', background: 'transparent', border: '1.5px solid #E5E7EB', borderRadius: 99, padding: '7px 20px', cursor: 'pointer' }}
              onMouseEnter={e => { e.currentTarget.style.background = '#F9FAFB'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >Browse File</button>
          </div>
          <input ref={inputRef} type="file" multiple style={{ display: 'none' }}
            onChange={e => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ''; }} />

          {/* Upload settings toggle */}
          <button
            onClick={() => setShowSettings(s => !s)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#5e4dbb', padding: 0, alignSelf: 'flex-start' }}
          >
            <Icon name={showSettings ? 'expand_less' : 'expand_more'} size={14} color="#5e4dbb" />
            Upload settings
          </button>

          {showSettings && (
            <div style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Public / Private */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22' }}>Visibility</div>
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 1 }}>{isPublic ? 'Anyone with the link can download' : 'Only you can see this file'}</div>
                </div>
                <div style={{ display: 'flex', background: '#E5E7EB', borderRadius: 8, padding: 2, gap: 2 }}>
                  {(['Public', 'Private'] as const).map(v => (
                    <button key={v} onClick={() => setIsPublic(v === 'Public')}
                      style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: (v === 'Public') === isPublic ? '#5e4dbb' : '#787584', background: (v === 'Public') === isPublic ? '#fff' : 'transparent', border: 'none', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', transition: 'all 150ms', boxShadow: (v === 'Public') === isPublic ? '0 1px 3px rgba(0,0,0,0.08)' : 'none' }}>
                      {v}
                    </button>
                  ))}
                </div>
              </div>
              {/* Password */}
              <div>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22', marginBottom: 6 }}>Password <span style={{ fontWeight: 400, color: '#b0acbe' }}>(optional)</span></div>
                <input value={password} onChange={e => setPassword(e.target.value)} placeholder="Leave blank for no password" type="password"
                  style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#1c1b22', background: '#fff', border: '1px solid #E5E7EB', borderRadius: 8, padding: '8px 12px', outline: 'none', boxSizing: 'border-box' }} />
              </div>
              {/* Expiry */}
              <div style={{ position: 'relative' }}>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22', marginBottom: 6 }}>Expires <span style={{ fontWeight: 400, color: '#b0acbe' }}>(optional)</span></div>
                <button
                  onClick={() => setShowExpiryCal(s => !s)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', fontFamily: 'Inter, sans-serif', fontSize: 13, color: expiresAt ? '#1c1b22' : '#b0acbe', textAlign: 'left' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = '#5e4dbb'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = '#E5E7EB'; }}
                >
                  <Icon name="calendar_today" size={14} color={expiresAt ? '#5e4dbb' : '#b0acbe'} />
                  <span style={{ flex: 1 }}>{expiresAt ? new Date(expiresAt + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Pick a date…'}</span>
                  {expiresAt && (
                    <span onClick={e => { e.stopPropagation(); setExpiresAt(''); setShowExpiryCal(false); }} style={{ color: '#b0acbe', lineHeight: 1, cursor: 'pointer', padding: '0 2px' }}>×</span>
                  )}
                </button>
                {showExpiryCal && (
                  <div style={{ position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, zIndex: 500 }}>
                    <CalendarPicker
                      value={expiresAt}
                      onChange={d => { setExpiresAt(d); setShowExpiryCal(false); }}
                      onClear={() => { setExpiresAt(''); setShowExpiryCal(false); }}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Upload queue */}
          {queue.map(entry => (
            <div key={entry.id} style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: '14px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <FileBadge mime={entry.file.type || 'application/octet-stream'} size={42} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.file.name}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584' }}>
                      {fmtSize(Math.round(entry.file.size * entry.progress / 100))} of {fmtSize(entry.file.size)}
                    </span>
                    <span style={{ color: '#d1d5db' }}>·</span>
                    {entry.status === 'uploading' && <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#d97706', display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ display: 'inline-block', width: 10, height: 10, border: '2px solid #d97706', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />Uploading...</span>}
                    {entry.status === 'done'      && <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#10B981', display: 'flex', alignItems: 'center', gap: 4 }}><Icon name="check_circle" size={13} color="#10B981" />Completed</span>}
                    {entry.status === 'error'     && <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a' }}>Failed</span>}
                    {entry.status === 'pending'   && <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe' }}>Waiting…</span>}
                  </div>
                </div>
                {entry.status === 'uploading' ? (
                  <Icon name="close" size={16} color="#d1d5db" />
                ) : (
                  <button onClick={() => setQueue(q => q.filter(e => e.id !== entry.id))}
                    style={{ width: 28, height: 28, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    onMouseEnter={e => { e.currentTarget.style.background = '#F9FAFB'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                    <Icon name="delete" size={15} color="#787584" />
                  </button>
                )}
              </div>
              {(entry.status === 'uploading' || entry.status === 'pending') && (
                <div style={{ marginTop: 10, background: '#E5E7EB', borderRadius: 99, height: 4, overflow: 'hidden' }}>
                  <div style={{ width: `${entry.progress}%`, height: '100%', background: '#5e4dbb', borderRadius: 99, transition: 'width 200ms' }} />
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ padding: '14px 22px 20px', borderTop: queue.length ? '1px solid #f1ecf6' : 'none' }}>
          <button onClick={onClose}
            style={{ width: '100%', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#fff', background: '#5e4dbb', border: 'none', borderRadius: 10, padding: '11px', cursor: 'pointer' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#4f3fa8'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#5e4dbb'; }}>
            Done
          </button>
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── Edit File Modal ───────────────────────────────────────────────

interface EditModalProps {
  file: SharedFile;
  onClose: () => void;
  onSaved: (f: SharedFile) => void;
}

function EditModal({ file, onClose, onSaved }: EditModalProps) {
  const [name, setName] = useState(file.name);
  const [isPublic, setIsPublic] = useState(file.isPublic);
  const [password, setPassword] = useState('');
  const [clearPw, setClearPw] = useState(false);
  const [expiresAt, setExpiresAt] = useState(file.expiresAt ? file.expiresAt.slice(0, 10) : '');
  const [showExpiryCal, setShowExpiryCal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const updates: Parameters<typeof apiUpdateFile>[1] = { name, isPublic };
      if (clearPw) updates.password = null;
      else if (password) updates.password = password;
      updates.expiresAt = expiresAt ? new Date(expiresAt + 'T23:59:59').toISOString() : null;
      const res = await apiUpdateFile(file.id, updates);
      onSaved(res.file);
      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const copyLink = () => {
    navigator.clipboard.writeText(file.shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 480, boxShadow: '0 12px 40px rgba(0,0,0,0.18)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 22px 16px', borderBottom: '1px solid #f1ecf6' }}>
          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>Edit file</div>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#F9FAFB'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
            <Icon name="close" size={18} color="#787584" />
          </button>
        </div>

        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Name */}
          <div>
            <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#787584', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>File name</label>
            <input value={name} onChange={e => setName(e.target.value)}
              style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#1c1b22', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, padding: '9px 12px', outline: 'none', boxSizing: 'border-box' }} />
          </div>

          {/* Visibility */}
          <div>
            <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#787584', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>Visibility</label>
            <div style={{ display: 'flex', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, padding: 3, gap: 2 }}>
              {(['Public', 'Private'] as const).map(v => (
                <button key={v} onClick={() => setIsPublic(v === 'Public')}
                  style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: (v === 'Public') === isPublic ? '#5e4dbb' : '#787584', background: (v === 'Public') === isPublic ? '#fff' : 'transparent', border: 'none', borderRadius: 6, padding: '7px', cursor: 'pointer', transition: 'all 150ms', boxShadow: (v === 'Public') === isPublic ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>
                  <Icon name={v === 'Public' ? 'public' : 'lock'} size={13} color={(v === 'Public') === isPublic ? '#5e4dbb' : '#b0acbe'} /> {v}
                </button>
              ))}
            </div>
          </div>

          {/* Share link */}
          {isPublic && (
            <div>
              <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#787584', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>Share link</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, padding: '9px 12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.shareUrl}</div>
                <button onClick={copyLink}
                  style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: copied ? '#10B981' : '#5e4dbb', background: copied ? '#f0fdf4' : '#F5F3FF', border: 'none', borderRadius: 8, padding: '9px 14px', cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5 }}
                  onMouseEnter={e => { if (!copied) e.currentTarget.style.background = '#ede9ff'; }}
                  onMouseLeave={e => { if (!copied) e.currentTarget.style.background = '#F5F3FF'; }}>
                  <Icon name={copied ? 'check' : 'content_copy'} size={14} color={copied ? '#10B981' : '#5e4dbb'} />
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          {/* Password */}
          <div>
            <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#787584', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>
              Password {file.hasPassword && <span style={{ fontWeight: 400, color: '#10B981', textTransform: 'none', letterSpacing: 0 }}>· currently set</span>}
            </label>
            {file.hasPassword && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={clearPw} onChange={e => setClearPw(e.target.checked)} />
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584' }}>Remove password</span>
              </label>
            )}
            {!clearPw && (
              <input value={password} onChange={e => setPassword(e.target.value)} placeholder={file.hasPassword ? 'Enter new password to change' : 'Leave blank for no password'} type="password"
                style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#1c1b22', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, padding: '9px 12px', outline: 'none', boxSizing: 'border-box' }} />
            )}
          </div>

          {/* Expiry */}
          <div style={{ position: 'relative' }}>
            <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#787584', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>Expires</label>
            <button
              onClick={() => setShowExpiryCal(s => !s)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, padding: '9px 12px', cursor: 'pointer', fontFamily: 'Inter, sans-serif', fontSize: 13, color: expiresAt ? '#1c1b22' : '#b0acbe', textAlign: 'left' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = '#5e4dbb'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = '#E5E7EB'; }}
            >
              <Icon name="calendar_today" size={14} color={expiresAt ? '#5e4dbb' : '#b0acbe'} />
              <span style={{ flex: 1 }}>{expiresAt ? new Date(expiresAt + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Pick a date…'}</span>
              {expiresAt && (
                <span onClick={e => { e.stopPropagation(); setExpiresAt(''); setShowExpiryCal(false); }} style={{ color: '#b0acbe', lineHeight: 1, cursor: 'pointer', padding: '0 2px' }}>×</span>
              )}
            </button>
            {showExpiryCal && (
              <div style={{ position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, zIndex: 500 }}>
                <CalendarPicker
                  value={expiresAt}
                  onChange={d => { setExpiresAt(d); setShowExpiryCal(false); }}
                  onClear={() => { setExpiresAt(''); setShowExpiryCal(false); }}
                />
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, padding: '14px 22px 20px' }}>
          <button onClick={onClose} style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#787584', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 10, padding: '10px', cursor: 'pointer' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#f1ecf6'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#F9FAFB'; }}>
            Cancel
          </button>
          <button onClick={save} disabled={saving}
            style={{ flex: 2, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#fff', background: saving ? '#9d8dff' : '#5e4dbb', border: 'none', borderRadius: 10, padding: '10px', cursor: saving ? 'not-allowed' : 'pointer' }}
            onMouseEnter={e => { if (!saving) e.currentTarget.style.background = '#4f3fa8'; }}
            onMouseLeave={e => { if (!saving) e.currentTarget.style.background = '#5e4dbb'; }}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Recent file card ──────────────────────────────────────────────

function RecentCard({ file, onEdit, onDelete }: { file: SharedFile; onEdit: () => void; onDelete: () => void }) {
  const [hov, setHov] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyLink = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(file.shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ background: '#F9FAFB', border: `1px solid ${hov ? '#c4b5fd' : '#E5E7EB'}`, borderRadius: 14, padding: '16px', display: 'flex', flexDirection: 'column', gap: 12, transition: 'border-color 150ms', cursor: 'default', flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <FileBadge mime={file.mimeType} size={44} />
        <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: file.isPublic ? '#5e4dbb' : '#787584', background: file.isPublic ? '#F5F3FF' : '#F9FAFB', border: `1px solid ${file.isPublic ? '#c4b5fd' : '#E5E7EB'}`, borderRadius: 99, padding: '2px 8px', flexShrink: 0 }}>
          {file.isPublic ? 'Public' : 'Private'}
        </span>
      </div>
      <div>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe', marginTop: 2 }}>{fmtSize(file.size)} · {fmtDate(file.createdAt)}</div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {file.isPublic && (
          <button onClick={copyLink}
            style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: copied ? '#10B981' : '#5e4dbb', background: copied ? '#f0fdf4' : '#F5F3FF', border: 'none', borderRadius: 7, padding: '6px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
            onMouseEnter={e => { if (!copied) e.currentTarget.style.background = '#ede9ff'; }}
            onMouseLeave={e => { if (!copied) e.currentTarget.style.background = copied ? '#f0fdf4' : '#F5F3FF'; }}>
            <Icon name={copied ? 'check' : 'link'} size={13} color={copied ? '#10B981' : '#5e4dbb'} />
            {copied ? 'Copied' : 'Copy link'}
          </button>
        )}
        <button onClick={e => { e.stopPropagation(); onEdit(); }}
          style={{ width: 30, height: 30, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onMouseEnter={e => { e.currentTarget.style.background = '#F5F3FF'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
          <Icon name="edit" size={15} color="#787584" />
        </button>
        <button onClick={e => { e.stopPropagation(); onDelete(); }}
          style={{ width: 30, height: 30, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onMouseEnter={e => { e.currentTarget.style.background = '#fff5f5'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
          <Icon name="delete" size={15} color="#ba1a1a" />
        </button>
      </div>
    </div>
  );
}

// ── Main Screen ───────────────────────────────────────────────────

export default function FilesScreen() {
  const { userId } = useAuthStore();
  const [files, setFiles] = useState<SharedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SharedFile | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SharedFile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pageDragOver, setPageDragOver] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [storageInfo, setStorageInfo] = useState<{ used: number; quota: number | null; isAdmin: boolean } | null>(null);

  const loadStorage = useCallback(async () => {
    try {
      const info = await apiGetStorageUsage();
      setStorageInfo(info);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiGetFiles();
      setFiles(res.files);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); loadStorage(); }, [load, loadStorage]);

  const handleUploaded = (f: SharedFile) => {
    setFiles(prev => [f, ...prev]);
    loadStorage();
  };

  const handleSaved = (f: SharedFile) => {
    setFiles(prev => prev.map(x => x.id === f.id ? f : x));
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiDeleteFile(deleteTarget.id);
      setFiles(prev => prev.filter(f => f.id !== deleteTarget.id));
      setDeleteTarget(null);
      loadStorage();
    } catch (e) {
      console.error(e);
    } finally {
      setDeleting(false);
    }
  };

  const copyLink = (f: SharedFile) => {
    navigator.clipboard.writeText(f.shareUrl).then(() => {
      setCopiedId(f.id);
      setTimeout(() => setCopiedId(null), 1800);
    });
  };

  const recent = files.slice(0, 3);

  const sectionLabel = (text: string, action?: React.ReactNode) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, paddingLeft: 2 }}>
      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#b0acbe' }}>{text}</div>
      {action}
    </div>
  );

  return (
    <div
      style={{ flex: 1, height: '100%', overflowY: 'auto' }}
      onDragOver={e => { e.preventDefault(); setPageDragOver(true); }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPageDragOver(false); }}
      onDrop={e => { e.preventDefault(); setPageDragOver(false); if (e.dataTransfer.files.length) setUploadOpen(true); }}
    >
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '32px 32px 48px', display: 'flex', flexDirection: 'column', gap: 28, width: '100%' }}>

        {/* Page header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h1 style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 28, fontWeight: 700, color: '#1c1b22', letterSpacing: '-0.02em', margin: 0 }}>Files</h1>
          <button
            onClick={() => setUploadOpen(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#5e4dbb', border: 'none', borderRadius: 10, padding: '9px 16px', cursor: 'pointer' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#4f3fa8'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#5e4dbb'; }}
          >
            <Icon name="cloud_upload" size={16} color="#fff" />
            Upload
          </button>
        </div>

        {/* Storage usage */}
        {storageInfo && (() => {
          const fmtBytes = (b: number) => {
            if (b >= 1e12) return `${(b / 1e12).toFixed(2)} TB`;
            if (b >= 1e9)  return `${(b / 1e9).toFixed(2)} GB`;
            if (b >= 1e6)  return `${(b / 1e6).toFixed(1)} MB`;
            return `${Math.round(b / 1e3)} KB`;
          };
          const unlimited = storageInfo.isAdmin || storageInfo.quota === null;
          const pct = unlimited ? 0 : Math.min(100, Math.round((storageInfo.used / storageInfo.quota!) * 100));
          const barColor = pct >= 90 ? '#ba1a1a' : pct >= 75 ? '#d97706' : '#5e4dbb';
          return (
            <div style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 14, padding: '14px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: unlimited ? 0 : 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Icon name="storage" size={16} color="#787584" />
                  <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22' }}>Storage</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#484552', fontWeight: 500 }}>
                    {fmtBytes(storageInfo.used)}
                  </span>
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>/</span>
                  {unlimited
                    ? <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 15, color: '#5e4dbb', fontWeight: 700, lineHeight: 1 }}>∞</span>
                    : <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>{fmtBytes(storageInfo.quota!)}</span>
                  }
                  {!unlimited && (
                    <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 600, color: barColor, background: pct >= 90 ? '#ffdad6' : pct >= 75 ? '#fef3c7' : '#F5F3FF', borderRadius: 99, padding: '2px 8px', marginLeft: 4 }}>{pct}%</span>
                  )}
                </div>
              </div>
              {!unlimited && (
                <div style={{ background: '#E5E7EB', borderRadius: 99, height: 6, overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: 99, transition: 'width 500ms ease' }} />
                </div>
              )}
            </div>
          );
        })()}

        {/* Recent files */}
        {!loading && recent.length > 0 && (
          <div>
            {sectionLabel('Recent')}
            <div style={{ display: 'flex', gap: 14 }}>
              {recent.map(f => (
                <RecentCard key={f.id} file={f}
                  onEdit={() => setEditTarget(f)}
                  onDelete={() => setDeleteTarget(f)} />
              ))}
            </div>
          </div>
        )}

        {/* Drop zone / upload area */}
        <div>
          {sectionLabel('Upload')}
          <div
            onDragOver={e => { e.preventDefault(); setPageDragOver(true); }}
            onDragLeave={() => setPageDragOver(false)}
            onDrop={e => { e.preventDefault(); setPageDragOver(false); if (e.dataTransfer.files.length) setUploadOpen(true); }}
            onClick={() => setUploadOpen(true)}
            style={{ border: `2px dashed ${pageDragOver ? '#5e4dbb' : '#d1d5db'}`, borderRadius: 16, padding: '40px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, cursor: 'pointer', background: pageDragOver ? '#F5F3FF' : '#fff', transition: 'all 150ms' }}
          >
            <Icon name="cloud_upload" size={40} color={pageDragOver ? '#5e4dbb' : '#d1d5db'} />
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 700, color: '#1c1b22' }}>Drop files here or click to upload</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>JPEG, PNG, PDF, MP4 and more · up to 50 MB per file</div>
          </div>
        </div>

        {/* All files list */}
        <div>
          {sectionLabel('All files', <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe' }}>{files.length} {files.length === 1 ? 'file' : 'files'}</span>)}
          <div style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 14, overflow: 'hidden' }}>
            {loading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '28px', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>
                Loading…
              </div>
            ) : files.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '40px 24px' }}>
                <Icon name="folder_open" size={36} color="#E5E7EB" />
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#b0acbe' }}>No files yet</div>
                <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#d1d5db' }}>Upload your first file to get started</div>
              </div>
            ) : (
              files.map((f, i) => (
                <div key={f.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 18px', borderBottom: i < files.length - 1 ? '1px solid #f1ecf6' : 'none' }}>
                  <FileBadge mime={f.mimeType} size={38} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe' }}>{fmtSize(f.size)}</span>
                      <span style={{ color: '#e8e4f0' }}>·</span>
                      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe' }}>{fmtDate(f.createdAt)}</span>
                      {f.expiresAt && <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#d97706', background: '#fef3c7', borderRadius: 99, padding: '1px 7px' }}>Expires {fmtDate(f.expiresAt)}</span>}
                      {f.hasPassword && <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 99, padding: '1px 7px', display: 'flex', alignItems: 'center', gap: 3 }}><Icon name="lock" size={10} color="#787584" />Password</span>}
                      {f.userId === userId && (
                        <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 600, color: f.isPublic ? '#5e4dbb' : '#787584', background: f.isPublic ? '#F5F3FF' : '#F9FAFB', border: `1px solid ${f.isPublic ? '#c4b5fd' : '#E5E7EB'}`, borderRadius: 99, padding: '1px 7px' }}>
                          {f.isPublic ? 'Public' : 'Private'}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    {f.isPublic && (
                      <button onClick={() => copyLink(f)}
                        style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: copiedId === f.id ? '#10B981' : '#5e4dbb', background: copiedId === f.id ? '#f0fdf4' : '#F5F3FF', border: 'none', borderRadius: 7, padding: '6px 10px', cursor: 'pointer' }}
                        onMouseEnter={e => { if (copiedId !== f.id) e.currentTarget.style.background = '#ede9ff'; }}
                        onMouseLeave={e => { if (copiedId !== f.id) e.currentTarget.style.background = '#F5F3FF'; }}>
                        <Icon name={copiedId === f.id ? 'check' : 'link'} size={13} color={copiedId === f.id ? '#10B981' : '#5e4dbb'} />
                        {copiedId === f.id ? 'Copied!' : 'Share'}
                      </button>
                    )}
                    <button onClick={() => setEditTarget(f)}
                      style={{ width: 30, height: 30, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#F5F3FF'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                      <Icon name="edit" size={15} color="#787584" />
                    </button>
                    <button onClick={() => setDeleteTarget(f)}
                      style={{ width: 30, height: 30, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#fff5f5'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                      <Icon name="delete" size={15} color="#ba1a1a" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Upload wizard */}
      {uploadOpen && <UploadWizard onClose={() => setUploadOpen(false)} onUploaded={handleUploaded} />}

      {/* Edit modal */}
      {editTarget && <EditModal file={editTarget} onClose={() => setEditTarget(null)} onSaved={handleSaved} />}

      {/* Delete confirmation */}
      {deleteTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) setDeleteTarget(null); }}>
          <div style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 400, padding: '28px 28px 24px', boxShadow: '0 12px 40px rgba(0,0,0,0.18)' }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22', marginBottom: 8 }}>Delete file?</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#787584', marginBottom: 20 }}>
              <strong style={{ color: '#1c1b22' }}>{deleteTarget.name}</strong> will be permanently deleted and the share link will stop working.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setDeleteTarget(null)}
                style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#787584', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 10, padding: '10px', cursor: 'pointer' }}
                onMouseEnter={e => { e.currentTarget.style.background = '#f1ecf6'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#F9FAFB'; }}>
                Cancel
              </button>
              <button onClick={handleDelete} disabled={deleting}
                style={{ flex: 2, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#fff', background: deleting ? '#e87575' : '#ba1a1a', border: 'none', borderRadius: 10, padding: '10px', cursor: deleting ? 'not-allowed' : 'pointer' }}
                onMouseEnter={e => { if (!deleting) e.currentTarget.style.background = '#991212'; }}
                onMouseLeave={e => { if (!deleting) e.currentTarget.style.background = '#ba1a1a'; }}>
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
