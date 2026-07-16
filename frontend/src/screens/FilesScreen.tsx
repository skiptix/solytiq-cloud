import { usePageTitle } from "../hooks/usePageTitle";
import { useMobile } from '../hooks/useBreakpoint';
import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { SharedFile } from '../types';
import { apiGetFiles, apiUpdateFile, apiDeleteFile, apiUploadFile, apiUploadFilesBundle, apiGetStorageUsage, apiPreviewFile } from '../api/client';
import useAuthStore from '../store/useAuthStore';
import useSyncStore from '../store/useSyncStore';
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
  if (mime.includes('pdf'))   return 'var(--color-red-mid-4)';
  if (mime.includes('image')) return 'var(--color-blue-mid-5)';
  if (mime.includes('video')) return 'var(--color-purple-mid-9)';
  if (mime.includes('zip'))   return 'var(--color-warning)';
  return 'var(--color-primary)';
}

function FileBadge({ mime, size = 40 }: { mime: string; size?: number }) {
  const label = mimeLabel(mime);
  const color = mimeBadgeColor(mime);
  return (
    <div style={{ width: size, height: size, borderRadius: 8, background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden', position: 'relative' }}>
      <div style={{ position: 'absolute', bottom: 3, left: '50%', transform: 'translateX(-50%)', background: color, color: 'var(--color-white)', fontFamily: 'var(--font-body)', fontSize: 7, fontWeight: 800, letterSpacing: '0.04em', padding: '1px 4px', borderRadius: 3 }}>{label}</div>
      <Icon name="description" size={size * 0.5} color="var(--color-blue-tint-3)" />
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
  initialFiles?: File[];
}

function UploadWizard({ onClose, onUploaded, defaultIsPublic = true, initialFiles = [] }: UploadWizardProps) {
  const [queue, setQueue] = useState<UploadEntry[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [isPublic, setIsPublic] = useState(defaultIsPublic);
  const [title, setTitle] = useState('');
  const [password, setPassword] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showExpiryCal, setShowExpiryCal] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((files: FileList | File[]) => {
    const selected = Array.from(files);
    if (!selected.length) return;
    const entries: UploadEntry[] = selected.map(f => ({
      id: Math.random().toString(36).slice(2),
      file: f,
      progress: 0,
      status: 'pending',
    }));
    setQueue(q => [...q, ...entries]);
    setQueue(q => q.map(e => entries.some(entry => entry.id === e.id) ? { ...e, status: 'uploading' } : e));

    const uploadOpts = { isPublic, title: title || undefined, password: password || undefined, expiresAt: expiresAt ? new Date(expiresAt + 'T23:59:59').toISOString() : undefined };
    const uploadPromise = selected.length > 1
      ? apiUploadFilesBundle(selected, uploadOpts, (pct) => setQueue(q => q.map(e => entries.some(entry => entry.id === e.id) ? { ...e, progress: pct } : e)))
      : apiUploadFile(selected[0], uploadOpts, (pct) => setQueue(q => q.map(e => e.id === entries[0].id ? { ...e, progress: pct } : e)));

    uploadPromise.then(result => {
      setQueue(q => q.map(e => entries.some(entry => entry.id === e.id) ? { ...e, status: 'done', progress: 100, result } : e));
      onUploaded(result);
    }).catch(err => {
      setQueue(q => q.map(e => entries.some(entry => entry.id === e.id) ? { ...e, status: 'error', error: String(err) } : e));
    });
  }, [isPublic, title, password, expiresAt, onUploaded]);

  useEffect(() => {
    if (initialFiles.length) addFiles(initialFiles);
  // run once for files passed in from page-level drag/drop
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  return createPortal(
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: 'var(--color-white)', borderRadius: 20, width: '100%', maxWidth: 520, maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '22px 22px 18px', borderBottom: '1px solid var(--color-surface-tint-2)' }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, border: '1.5px solid var(--color-border-alt)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="cloud_upload" size={20} color="var(--color-primary)" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>Upload files</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', marginTop: 2 }}>Select and upload the files of your choice</div>
          </div>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-gray)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
            <Icon name="close" size={18} color="var(--color-text-tertiary)" />
          </button>
        </div>

        <div style={{ overflowY: 'auto', padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Drop zone */}
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
            style={{ border: `2px dashed ${dragOver ? 'var(--color-primary)' : 'var(--color-blue-tint-3)'}`, borderRadius: 14, padding: '32px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, cursor: 'pointer', background: dragOver ? 'var(--color-surface-tint)' : 'var(--color-white)', transition: 'all 150ms' }}
          >
            <Icon name="cloud_upload" size={36} color={dragOver ? 'var(--color-primary)' : 'var(--color-blue-mid-2)'} />
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', textAlign: 'center' }}>Choose files or drag & drop them here.</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-blue-mid-2)', textAlign: 'center' }}>JPEG, PNG, PDF, MP4 and more — no per-file limit.</div>
            <button
              onClick={e => { e.stopPropagation(); inputRef.current?.click(); }}
              style={{ marginTop: 4, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', background: 'transparent', border: '1.5px solid var(--color-border-alt)', borderRadius: 99, padding: '7px 20px', cursor: 'pointer' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-gray)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >Browse Files</button>
          </div>
          <input ref={inputRef} type="file" multiple style={{ display: 'none' }}
            onChange={e => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ''; }} />

          {/* Upload settings toggle */}
          <button
            onClick={() => setShowSettings(s => !s)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', padding: 0, alignSelf: 'flex-start' }}
          >
            <Icon name={showSettings ? 'expand_less' : 'expand_more'} size={14} color="var(--color-primary)" />
            Upload settings
          </button>

          {showSettings && (
            <div style={{ background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Title */}
              <div>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 6 }}>Share title <span style={{ fontWeight: 400, color: 'var(--color-text-quaternary)' }}>(optional)</span></div>
                <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Give this share a title…"
                  style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)', background: 'var(--color-white)', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '8px 12px', outline: 'none', boxSizing: 'border-box' }} />
              </div>
              {/* Public / Private */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>Visibility</div>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 1 }}>{isPublic ? 'Anyone with the link can download' : 'Only you can see this file'}</div>
                </div>
                <div style={{ display: 'flex', background: 'var(--color-border-alt)', borderRadius: 8, padding: 2, gap: 2 }}>
                  {(['Public', 'Private'] as const).map(v => (
                    <button key={v} onClick={() => setIsPublic(v === 'Public')}
                      style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: (v === 'Public') === isPublic ? 'var(--color-primary)' : 'var(--color-text-tertiary)', background: (v === 'Public') === isPublic ? 'var(--color-white)' : 'transparent', border: 'none', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', transition: 'all 150ms', boxShadow: (v === 'Public') === isPublic ? '0 1px 3px rgba(var(--color-black-rgb), 0.08)' : 'none' }}>
                      {v}
                    </button>
                  ))}
                </div>
              </div>
              {/* Password */}
              <div>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 6 }}>Password <span style={{ fontWeight: 400, color: 'var(--color-text-quaternary)' }}>(optional)</span></div>
                <input value={password} onChange={e => setPassword(e.target.value)} placeholder="Leave blank for no password" type="password"
                  style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)', background: 'var(--color-white)', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '8px 12px', outline: 'none', boxSizing: 'border-box' }} />
              </div>
              {/* Expiry */}
              <div style={{ position: 'relative' }}>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 6 }}>Expires <span style={{ fontWeight: 400, color: 'var(--color-text-quaternary)' }}>(optional)</span></div>
                <button
                  onClick={() => setShowExpiryCal(s => !s)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: 'var(--color-white)', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 13, color: expiresAt ? 'var(--color-text-primary)' : 'var(--color-text-quaternary)', textAlign: 'left' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-primary)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-border-alt)'; }}
                >
                  <Icon name="calendar_today" size={14} color={expiresAt ? 'var(--color-primary)' : 'var(--color-text-quaternary)'} />
                  <span style={{ flex: 1 }}>{expiresAt ? new Date(expiresAt + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Pick a date…'}</span>
                  {expiresAt && (
                    <span onClick={e => { e.stopPropagation(); setExpiresAt(''); setShowExpiryCal(false); }} style={{ color: 'var(--color-text-quaternary)', lineHeight: 1, cursor: 'pointer', padding: '0 2px' }}>×</span>
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
            <div key={entry.id} style={{ background: 'var(--color-white)', border: '1px solid var(--color-border-alt)', borderRadius: 12, padding: '14px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <FileBadge mime={entry.file.type || 'application/octet-stream'} size={42} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.file.name}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                      {fmtSize(Math.round(entry.file.size * entry.progress / 100))} of {fmtSize(entry.file.size)}
                    </span>
                    <span style={{ color: 'var(--color-blue-tint-3)' }}>·</span>
                    {entry.status === 'uploading' && <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-warning)', display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ display: 'inline-block', width: 10, height: 10, border: '2px solid var(--color-warning)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />Uploading...</span>}
                    {entry.status === 'done'      && <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-success)', display: 'flex', alignItems: 'center', gap: 4 }}><Icon name="check_circle" size={13} color="var(--color-success)" />Completed</span>}
                    {entry.status === 'error'     && <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>Failed</span>}
                    {entry.status === 'pending'   && <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>Waiting…</span>}
                  </div>
                </div>
                {entry.status === 'uploading' ? (
                  <Icon name="close" size={16} color="var(--color-blue-tint-3)" />
                ) : (
                  <button onClick={() => setQueue(q => q.filter(e => e.id !== entry.id))}
                    style={{ width: 28, height: 28, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-gray)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                    <Icon name="delete" size={15} color="var(--color-text-tertiary)" />
                  </button>
                )}
              </div>
              {(entry.status === 'uploading' || entry.status === 'pending') && (
                <div style={{ marginTop: 10, background: 'var(--color-border-alt)', borderRadius: 99, height: 4, overflow: 'hidden' }}>
                  <div style={{ width: `${entry.progress}%`, height: '100%', background: 'var(--color-primary)', borderRadius: 99, transition: 'width 200ms' }} />
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ padding: '14px 22px 20px', borderTop: queue.length ? '1px solid var(--color-surface-tint-2)' : 'none' }}>
          <button onClick={onClose}
            style={{ width: '100%', fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-primary)', border: 'none', borderRadius: 10, padding: '11px', cursor: 'pointer' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-purple-mid-10)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-primary)'; }}>
            Done
          </button>
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>,
    document.body
  );
}

// ── File Detail Modal (preview + edit) ───────────────────────────

interface FileDetailModalProps {
  file: SharedFile;
  onClose: () => void;
  onSaved: (f: SharedFile) => void;
}

function FileDetailModal({ file, onClose, onSaved }: FileDetailModalProps) {
  const isMobile = useMobile();
  const [closing, setClosing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [name, setName] = useState(file.name);
  const [title, setTitle] = useState(file.title ?? '');
  const [note, setNote] = useState(file.note ?? '');
  const [isPublic, setIsPublic] = useState(file.isPublic);
  const [password, setPassword] = useState('');
  const [clearPw, setClearPw] = useState(false);
  const [expiresAt, setExpiresAt] = useState(file.expiresAt ? file.expiresAt.slice(0, 10) : '');
  const [showExpiryCal, setShowExpiryCal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const isImage = file.mimeType.startsWith('image/');
  const isVideo = file.mimeType.startsWith('video/');
  const isPdf   = file.mimeType === 'application/pdf';
  const canPreview = isImage || isVideo || isPdf;

  useEffect(() => {
    if (!canPreview) { setPreviewLoading(false); return; }
    let objectUrl: string;
    apiPreviewFile(file.id)
      .then(url => { objectUrl = url; setPreviewUrl(url); })
      .catch(() => {})
      .finally(() => setPreviewLoading(false));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [file.id]);

  const handleClose = () => { setClosing(true); setTimeout(() => onClose(), 190); };

  const save = async () => {
    setSaving(true);
    try {
      const updates: Parameters<typeof apiUpdateFile>[1] = { name, title: title || null, note: note || null, isPublic };
      if (clearPw) updates.password = null;
      else if (password) updates.password = password;
      updates.expiresAt = expiresAt ? new Date(expiresAt + 'T23:59:59').toISOString() : null;
      const res = await apiUpdateFile(file.id, updates);
      onSaved(res.file);
      handleClose();
    } catch { /* silent */ } finally { setSaving(false); }
  };

  const copyLink = () => {
    navigator.clipboard.writeText(file.shareUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  const panelAnim = closing
    ? 'settingsModalOut 190ms ease-in both'
    : 'settingsModalIn 360ms cubic-bezier(0.22,1,0.36,1) both';
  const backdropAnim = closing
    ? 'backdropOut 190ms ease both'
    : 'backdropIn 220ms ease both';

  return createPortal(
    <div onClick={e => { if (e.target === e.currentTarget) handleClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.28)', backdropFilter: 'blur(5px)', zIndex: 1000, display: 'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center', padding: isMobile ? 0 : 24, animation: backdropAnim }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: 'var(--color-white)', borderRadius: isMobile ? '16px 16px 0 0' : 20, width: '100%', maxWidth: 560, maxHeight: isMobile ? '90vh' : '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(var(--color-black-rgb), 0.18)', animation: panelAnim, overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px 14px', borderBottom: '1px solid var(--color-surface-tint-2)', flexShrink: 0 }}>
          <FileBadge mime={file.mimeType} size={36} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.title || file.name}</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', marginTop: 1 }}>{fmtSize(file.size)} · {fmtDate(file.createdAt)}</div>
          </div>
          <button onClick={handleClose} style={{ width: 30, height: 30, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-tint-2)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <Icon name="close" size={18} color="var(--color-text-tertiary)" />
          </button>
        </div>

        {/* Preview area */}
        <div style={{ background: 'var(--color-purple-pale-11)', borderBottom: '1px solid var(--color-surface-tint-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 220, maxHeight: 300, overflow: 'hidden', flexShrink: 0, position: 'relative' }}>
          {previewLoading && canPreview ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 28, height: 28, border: '3px solid var(--color-border)', borderTopColor: 'var(--color-primary)', borderRadius: '50%', animation: 'spin 600ms linear infinite' }} />
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>Loading preview…</span>
            </div>
          ) : previewUrl && isImage ? (
            <img src={previewUrl} alt={file.name} style={{ maxWidth: '100%', maxHeight: 300, objectFit: 'contain', display: 'block', animation: 'sectionFadeUp 280ms ease both' }} />
          ) : previewUrl && isVideo ? (
            <video src={previewUrl} controls style={{ maxWidth: '100%', maxHeight: 300, display: 'block', borderRadius: 0 }} />
          ) : previewUrl && isPdf ? (
            <iframe src={previewUrl} title={file.name} style={{ width: '100%', height: 280, border: 'none', display: 'block' }} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: 32, animation: 'sectionFadeUp 280ms ease both' }}>
              <FileBadge mime={file.mimeType} size={72} />
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-tertiary)', textAlign: 'center' }}>{file.name}</div>
            </div>
          )}
        </div>

        {/* Edit form */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Share link (prominent, at top) */}
          {isPublic && (
            <div style={{ background: 'var(--color-surface-tint)', borderRadius: 12, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <Icon name="link" size={16} color="var(--color-primary)" />
              <span style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.shareUrl}</span>
              <button onClick={copyLink}
                style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: copied ? 'var(--color-success)' : 'var(--color-primary)', background: copied ? 'var(--color-green-pale-1)' : 'var(--color-white)', border: `1px solid ${copied ? 'var(--color-green-tint-2)' : 'var(--color-accent-purple-soft-alt)'}`, borderRadius: 7, padding: '5px 12px', cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, transition: 'all 150ms' }}>
                <Icon name={copied ? 'check' : 'content_copy'} size={12} color={copied ? 'var(--color-success)' : 'var(--color-primary)'} />
                {copied ? 'Copied!' : 'Copy link'}
              </button>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
            {/* Share title */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <label style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Share title</label>
              <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Optional title…"
                style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)', background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '8px 11px', outline: 'none', boxSizing: 'border-box' }} />
            </div>
            {/* File name */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <label style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>File name</label>
              <input value={name} onChange={e => setName(e.target.value)}
                style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)', background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '8px 11px', outline: 'none', boxSizing: 'border-box' }} />
            </div>
          </div>

          {/* Note */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Note <span style={{ fontWeight: 400, color: 'var(--color-text-quaternary)', textTransform: 'none', letterSpacing: 0 }}>(visible on public share page)</span></label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Add a note to display on the share page…"
              rows={3}
              style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)', background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '8px 11px', outline: 'none', resize: 'vertical', boxSizing: 'border-box', lineHeight: 1.6, minHeight: 72 }}
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent-purple-soft-alt)'; }}
              onBlur={e => { e.currentTarget.style.borderColor = 'var(--color-border-alt)'; }}
            />
          </div>

          {/* Visibility */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Visibility</label>
            <div style={{ display: 'flex', background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: 3, gap: 2 }}>
              {(['Public', 'Private'] as const).map(v => (
                <button key={v} onClick={() => setIsPublic(v === 'Public')}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: (v === 'Public') === isPublic ? 'var(--color-primary)' : 'var(--color-text-tertiary)', background: (v === 'Public') === isPublic ? 'var(--color-white)' : 'transparent', border: 'none', borderRadius: 6, padding: '7px', cursor: 'pointer', transition: 'all 150ms', boxShadow: (v === 'Public') === isPublic ? '0 1px 3px rgba(var(--color-black-rgb), 0.1)' : 'none' }}>
                  <Icon name={v === 'Public' ? 'public' : 'lock'} size={13} color={(v === 'Public') === isPublic ? 'var(--color-primary)' : 'var(--color-text-quaternary)'} /> {v}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
            {/* Password */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <label style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Password {file.hasPassword && <span style={{ color: 'var(--color-success)', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>· set</span>}
              </label>
              {file.hasPassword && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 2 }}>
                  <input type="checkbox" checked={clearPw} onChange={e => setClearPw(e.target.checked)} />
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>Remove</span>
                </label>
              )}
              {!clearPw && (
                <input value={password} onChange={e => setPassword(e.target.value)} placeholder={file.hasPassword ? 'Change password…' : 'No password'} type="password"
                  style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)', background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '8px 11px', outline: 'none', boxSizing: 'border-box' }} />
              )}
            </div>
            {/* Expiry */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, position: 'relative' }}>
              <label style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Expires</label>
              <button onClick={() => setShowExpiryCal(s => !s)}
                style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '8px 11px', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 13, color: expiresAt ? 'var(--color-text-primary)' : 'var(--color-text-quaternary)', textAlign: 'left' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-primary)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-border-alt)'; }}>
                <Icon name="calendar_today" size={13} color={expiresAt ? 'var(--color-primary)' : 'var(--color-text-quaternary)'} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{expiresAt ? new Date(expiresAt + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'No expiry'}</span>
                {expiresAt && <span onClick={e => { e.stopPropagation(); setExpiresAt(''); setShowExpiryCal(false); }} style={{ color: 'var(--color-text-quaternary)', cursor: 'pointer' }}>×</span>}
              </button>
              {showExpiryCal && (
                <div style={{ position: 'absolute', bottom: 'calc(100% + 4px)', right: 0, zIndex: 500 }}>
                  <CalendarPicker value={expiresAt} onChange={d => { setExpiresAt(d); setShowExpiryCal(false); }} onClear={() => { setExpiresAt(''); setShowExpiryCal(false); }} />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', gap: 10, padding: '12px 20px 18px', borderTop: '1px solid var(--color-surface-tint-2)', flexShrink: 0 }}>
          <button onClick={handleClose}
            style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-tertiary)', background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 10, padding: '10px', cursor: 'pointer' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface-gray)'; }}>
            Cancel
          </button>
          <button onClick={save} disabled={saving}
            style={{ flex: 2, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: saving ? 'var(--color-accent-purple-light)' : 'var(--color-primary)', border: 'none', borderRadius: 10, padding: '10px', cursor: saving ? 'not-allowed' : 'pointer' }}
            onMouseEnter={e => { if (!saving) e.currentTarget.style.background = 'var(--color-purple-mid-10)'; }}
            onMouseLeave={e => { if (!saving) e.currentTarget.style.background = 'var(--color-primary)'; }}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>,
    document.body
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
    <div onClick={() => onEdit()} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ background: 'var(--color-surface-gray)', border: `1px solid ${hov ? 'var(--color-accent-purple-soft-alt)' : 'var(--color-border-alt)'}`, borderRadius: 14, padding: '16px', display: 'flex', flexDirection: 'column', gap: 12, transition: 'border-color 150ms', cursor: 'pointer', flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <FileBadge mime={file.mimeType} size={44} />
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: file.isPublic ? 'var(--color-primary)' : 'var(--color-text-tertiary)', background: file.isPublic ? 'var(--color-surface-tint)' : 'var(--color-surface-gray)', border: `1px solid ${file.isPublic ? 'var(--color-accent-purple-soft-alt)' : 'var(--color-border-alt)'}`, borderRadius: 99, padding: '2px 8px', flexShrink: 0 }}>
          {file.isPublic ? 'Public' : 'Private'}
        </span>
      </div>
      <div>
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.bundleCount && file.bundleCount > 1 ? (file.bundleName || `${file.bundleCount} files`) : file.name}</div>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', marginTop: 2 }}>{file.bundleCount && file.bundleCount > 1 ? `${file.bundleCount} files · ` : ''}{fmtSize(file.size)} · {fmtDate(file.createdAt)}</div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {file.isPublic && (
          <button onClick={copyLink}
            style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: copied ? 'var(--color-success)' : 'var(--color-primary)', background: copied ? 'var(--color-green-pale-1)' : 'var(--color-surface-tint)', border: 'none', borderRadius: 7, padding: '6px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
            onMouseEnter={e => { if (!copied) e.currentTarget.style.background = 'var(--color-surface-tint-4)'; }}
            onMouseLeave={e => { if (!copied) e.currentTarget.style.background = copied ? 'var(--color-green-pale-1)' : 'var(--color-surface-tint)'; }}>
            <Icon name={copied ? 'check' : 'link'} size={13} color={copied ? 'var(--color-success)' : 'var(--color-primary)'} />
            {copied ? 'Copied' : 'Copy link'}
          </button>
        )}
        <button onClick={e => { e.stopPropagation(); onEdit(); }}
          style={{ width: 30, height: 30, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
          <Icon name="edit" size={15} color="var(--color-text-tertiary)" />
        </button>
        <button onClick={e => { e.stopPropagation(); onDelete(); }}
          style={{ width: 30, height: 30, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-error-bg-alt)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
          <Icon name="delete" size={15} color="var(--color-error)" />
        </button>
      </div>
    </div>
  );
}

// ── Main Screen ───────────────────────────────────────────────────

export default function FilesScreen() {
  usePageTitle("Files");
  const isMobile = useMobile();
  const { userId } = useAuthStore();
  const [files, setFiles] = useState<SharedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pendingUploadFiles, setPendingUploadFiles] = useState<File[]>([]);
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

  // Live cross-device file sync: the delta engine bumps this counter when a
  // shared file changes anywhere, and we refetch the file list + storage usage.
  // Fetch without toggling the full-screen loader (this is a background refresh).
  const fileRev = useSyncStore(s => s.entityRevisions.file ?? 0);
  useEffect(() => {
    if (fileRev === 0) return;
    apiGetFiles().then(r => setFiles(r.files)).catch(() => {});
    apiGetStorageUsage().then(setStorageInfo).catch(() => {});
  }, [fileRev]);

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
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-text-quaternary)' }}>{text}</div>
      {action}
    </div>
  );

  return (
    <div
      style={{ flex: 1, height: '100%', overflowY: 'auto' }}
      onDragOver={e => { e.preventDefault(); setPageDragOver(true); }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPageDragOver(false); }}
      onDrop={e => { e.preventDefault(); setPageDragOver(false); if (e.dataTransfer.files.length) { setPendingUploadFiles(Array.from(e.dataTransfer.files)); setUploadOpen(true); } }}
    >
      <div style={{ maxWidth: 860, margin: '0 auto', padding: isMobile ? '16px 12px 48px' : '32px 32px 48px', display: 'flex', flexDirection: 'column', gap: 28, width: '100%', animation: 'sectionFadeUp 360ms cubic-bezier(0.22,1,0.36,1) both' }}>

        {/* Page header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h1 style={{ fontFamily: 'var(--font-heading)', fontSize: 28, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.02em', margin: 0 }}>Files</h1>
          <button
            onClick={() => { setPendingUploadFiles([]); setUploadOpen(true); }}
            style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-primary)', border: 'none', borderRadius: 10, padding: '9px 16px', cursor: 'pointer' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-purple-mid-10)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-primary)'; }}
          >
            <Icon name="cloud_upload" size={16} color="var(--color-white)" />
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
          const barColor = pct >= 90 ? 'var(--color-error)' : pct >= 75 ? 'var(--color-warning)' : 'var(--color-primary)';
          return (
            <div style={{ background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 14, padding: '14px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: unlimited ? 0 : 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Icon name="storage" size={16} color="var(--color-text-tertiary)" />
                  <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>Storage</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-secondary)', fontWeight: 500 }}>
                    {fmtBytes(storageInfo.used)}
                  </span>
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>/</span>
                  {unlimited
                    ? <span style={{ fontFamily: 'var(--font-body)', fontSize: 15, color: 'var(--color-primary)', fontWeight: 700, lineHeight: 1 }}>∞</span>
                    : <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>{fmtBytes(storageInfo.quota!)}</span>
                  }
                  {!unlimited && (
                    <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 600, color: barColor, background: pct >= 90 ? 'var(--color-error-bg)' : pct >= 75 ? 'var(--color-yellow-tint-1)' : 'var(--color-surface-tint)', borderRadius: 99, padding: '2px 8px', marginLeft: 4 }}>{pct}%</span>
                  )}
                </div>
              </div>
              {!unlimited && (
                <div style={{ background: 'var(--color-border-alt)', borderRadius: 99, height: 6, overflow: 'hidden' }}>
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
            onDrop={e => { e.preventDefault(); setPageDragOver(false); if (e.dataTransfer.files.length) { setPendingUploadFiles(Array.from(e.dataTransfer.files)); setUploadOpen(true); } }}
            onClick={() => { setPendingUploadFiles([]); setUploadOpen(true); }}
            style={{ border: `2px dashed ${pageDragOver ? 'var(--color-primary)' : 'var(--color-blue-tint-3)'}`, borderRadius: 16, padding: '40px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, cursor: 'pointer', background: pageDragOver ? 'var(--color-surface-tint)' : 'var(--color-white)', transition: 'all 150ms' }}
          >
            <Icon name="cloud_upload" size={40} color={pageDragOver ? 'var(--color-primary)' : 'var(--color-blue-tint-3)'} />
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)' }}>Drop files here or click to upload</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>JPEG, PNG, PDF, MP4 and more · no per-file limit, just your storage quota</div>
          </div>
        </div>

        {/* All files list */}
        <div>
          {sectionLabel('All files', <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>{files.length} {files.length === 1 ? 'file' : 'files'}</span>)}
          <div style={{ background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 14, overflow: 'hidden' }}>
            {loading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '28px', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>
                Loading…
              </div>
            ) : files.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '40px 24px' }}>
                <Icon name="folder_open" size={36} color="var(--color-border-alt)" />
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-quaternary)' }}>No files yet</div>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-blue-tint-3)' }}>Upload your first file to get started</div>
              </div>
            ) : (
              files.map((f, i) => (
                <div key={f.id}
                  onClick={() => setEditTarget(f)}
                  onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--color-purple-pale-11)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = ''; }}
                  style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 18px', borderBottom: i < files.length - 1 ? '1px solid var(--color-surface-tint-2)' : 'none', cursor: 'pointer', transition: 'background 120ms' }}>
                  <FileBadge mime={f.mimeType} size={38} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.bundleCount && f.bundleCount > 1 ? (f.bundleName || `${f.bundleCount} files`) : f.name}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
                      {f.bundleCount && f.bundleCount > 1 && <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-primary)', fontWeight: 600 }}>{f.bundleCount} files</span>}
                      {f.bundleCount && f.bundleCount > 1 && <span style={{ color: 'var(--color-border)' }}>·</span>}
                      <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>{fmtSize(f.size)}</span>
                      <span style={{ color: 'var(--color-border)' }}>·</span>
                      <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>{fmtDate(f.createdAt)}</span>
                      {f.expiresAt && <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-warning)', background: 'var(--color-yellow-tint-1)', borderRadius: 99, padding: '1px 7px' }}>Expires {fmtDate(f.expiresAt)}</span>}
                      {f.hasPassword && <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-tertiary)', background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 99, padding: '1px 7px', display: 'flex', alignItems: 'center', gap: 3 }}><Icon name="lock" size={10} color="var(--color-text-tertiary)" />Password</span>}
                      {f.userId === userId && (
                        <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 600, color: f.isPublic ? 'var(--color-primary)' : 'var(--color-text-tertiary)', background: f.isPublic ? 'var(--color-surface-tint)' : 'var(--color-surface-gray)', border: `1px solid ${f.isPublic ? 'var(--color-accent-purple-soft-alt)' : 'var(--color-border-alt)'}`, borderRadius: 99, padding: '1px 7px' }}>
                          {f.isPublic ? 'Public' : 'Private'}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    {f.isPublic && (
                      <button onClick={e => { e.stopPropagation(); copyLink(f); }}
                        style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: copiedId === f.id ? 'var(--color-success)' : 'var(--color-primary)', background: copiedId === f.id ? 'var(--color-green-pale-1)' : 'var(--color-surface-tint)', border: 'none', borderRadius: 7, padding: '6px 10px', cursor: 'pointer' }}
                        onMouseEnter={e => { if (copiedId !== f.id) e.currentTarget.style.background = 'var(--color-surface-tint-4)'; }}
                        onMouseLeave={e => { if (copiedId !== f.id) e.currentTarget.style.background = 'var(--color-surface-tint)'; }}>
                        <Icon name={copiedId === f.id ? 'check' : 'link'} size={13} color={copiedId === f.id ? 'var(--color-success)' : 'var(--color-primary)'} />
                        {copiedId === f.id ? 'Copied!' : 'Share'}
                      </button>
                    )}
                    <button onClick={e => { e.stopPropagation(); setEditTarget(f); }}
                      style={{ width: 30, height: 30, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                      <Icon name="edit" size={15} color="var(--color-text-tertiary)" />
                    </button>
                    <button onClick={e => { e.stopPropagation(); setDeleteTarget(f); }}
                      style={{ width: 30, height: 30, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-error-bg-alt)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                      <Icon name="delete" size={15} color="var(--color-error)" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Upload wizard */}
      {uploadOpen && <UploadWizard onClose={() => { setUploadOpen(false); setPendingUploadFiles([]); }} onUploaded={handleUploaded} initialFiles={pendingUploadFiles} />}

      {/* File detail modal */}
      {editTarget && <FileDetailModal file={editTarget} onClose={() => setEditTarget(null)} onSaved={handleSaved} />}

      {/* Delete confirmation */}
      {deleteTarget && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) setDeleteTarget(null); }}>
          <div style={{ background: 'var(--color-white)', borderRadius: 20, width: '100%', maxWidth: 400, padding: '28px 28px 24px', boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)' }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}>Delete file?</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-tertiary)', marginBottom: 20 }}>
              <strong style={{ color: 'var(--color-text-primary)' }}>{deleteTarget.name}</strong> will be permanently deleted and the share link will stop working.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setDeleteTarget(null)}
                style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-tertiary)', background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 10, padding: '10px', cursor: 'pointer' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface-gray)'; }}>
                Cancel
              </button>
              <button onClick={handleDelete} disabled={deleting}
                style={{ flex: 2, fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-white)', background: deleting ? 'var(--color-red-mid-1)' : 'var(--color-error)', border: 'none', borderRadius: 10, padding: '10px', cursor: deleting ? 'not-allowed' : 'pointer' }}
                onMouseEnter={e => { if (!deleting) e.currentTarget.style.background = 'var(--color-red-deep-2)'; }}
                onMouseLeave={e => { if (!deleting) e.currentTarget.style.background = 'var(--color-error)'; }}>
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
