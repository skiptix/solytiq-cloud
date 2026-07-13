import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import MarkdownView from './MarkdownView';
import { previewKind, extOf } from '../utils/attachmentPreview';

// ── Attachment preview ────────────────────────────────────────────────────
// A click-to-preview viewer for the most common attachment formats, shared by
// the Task dialog and the Milestone editor. The bytes are fetched as an
// authenticated Blob (re-tagged with the real mime type client-side) and
// rendered inline — images, PDFs, video, audio, and text/markdown/json/csv.
// Anything else has no preview and is download-only.
// (Format detection lives in ../utils/attachmentPreview so this file only
//  exports a component — see isPreviewable/previewKind there.)

const MAX_TEXT_BYTES = 512 * 1024;   // cap inline text so a huge log can't lock the UI

interface AttachmentPreviewModalProps {
  name: string;
  mimeType: string;
  fetchBlob: () => Promise<Blob>;
  onDownload: () => void;
  onClose: () => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; url?: string; text?: string; truncated?: boolean };

export default function AttachmentPreviewModal({ name, mimeType, fetchBlob, onDownload, onClose }: AttachmentPreviewModalProps) {
  const kind = previewKind(mimeType, name);
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  // Keep the latest fetchBlob without making it a fetch dependency — the parent
  // dialog re-creates the closure on every render, but the file to load is fully
  // identified by name+mimeType, so we fetch once per attachment, not per render.
  const fetchRef = useRef(fetchBlob);
  useEffect(() => { fetchRef.current = fetchBlob; });

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    (async () => {
      try {
        const blob = await fetchRef.current();
        if (cancelled) return;
        if (kind === 'text') {
          const truncated = blob.size > MAX_TEXT_BYTES;
          const text = await (truncated ? blob.slice(0, MAX_TEXT_BYTES) : blob).text();
          if (!cancelled) setState({ status: 'ready', text, truncated });
        } else {
          objectUrl = URL.createObjectURL(blob);
          if (!cancelled) setState({ status: 'ready', url: objectUrl });
        }
      } catch {
        if (!cancelled) setState({ status: 'error' });
      }
    })();
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [name, mimeType, kind]);

  const isMd = kind === 'text' && ['md', 'markdown'].includes(extOf(name));

  const body = (() => {
    if (state.status === 'loading') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, minHeight: 200, color: '#b0acbe' }}>
          <div style={{ width: 26, height: 26, border: '3px solid #e8e4f0', borderTopColor: '#5e4dbb', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13 }}>Loading preview…</span>
        </div>
      );
    }
    if (state.status === 'error' || !kind) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 200, textAlign: 'center', padding: 24 }}>
          <Icon name="visibility_off" size={30} color="#c9c4d5" />
          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#484552' }}>
            {kind ? "Couldn't load this preview" : 'No preview available for this file type'}
          </div>
          <button onClick={onDownload}
            style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#5e4dbb', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>
            <Icon name="download" size={15} color="#fff" /> Download
          </button>
        </div>
      );
    }
    switch (kind) {
      case 'image':
        return <img src={state.url} alt={name} style={{ maxWidth: '100%', maxHeight: '72vh', objectFit: 'contain', borderRadius: 8, display: 'block', margin: '0 auto' }} />;
      case 'pdf':
        return <iframe src={state.url} title={name} style={{ width: '100%', height: '72vh', border: 'none', borderRadius: 8, background: '#fff' }} />;
      case 'video':
        return <video src={state.url} controls style={{ maxWidth: '100%', maxHeight: '72vh', borderRadius: 8, display: 'block', margin: '0 auto' }} />;
      case 'audio':
        return (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 140 }}>
            <audio src={state.url} controls style={{ width: '100%', maxWidth: 420 }} />
          </div>
        );
      case 'text':
        return (
          <div>
            {state.truncated && (
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#d97706', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '6px 10px', marginBottom: 10 }}>
                Showing the first 512 KB — download the file to see the rest.
              </div>
            )}
            {isMd
              ? <MarkdownView source={state.text ?? ''} />
              : <pre style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5, lineHeight: 1.6, color: '#3b3654', background: '#faf9ff', border: '1px solid #e8e4f0', borderRadius: 10, padding: '12px 14px', margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '72vh', overflowY: 'auto' }}>{state.text}</pre>}
          </div>
        );
    }
  })();

  // Portaled to <body> — the dialogs that open this live inside routed screens
  // whose `.page-transition` wrapper traps position:fixed descendants.
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)', animation: 'backdropIn 180ms ease both' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 860, maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 8px 40px rgba(0,0,0,0.28)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px 14px 20px', borderBottom: '1px solid #F0EEF8', flexShrink: 0 }}>
          <Icon name="visibility" size={17} color="#5e4dbb" />
          <div style={{ flex: 1, minWidth: 0, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14.5, fontWeight: 700, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
          <button onClick={onDownload} title="Download"
            style={{ width: 32, height: 32, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
            onMouseEnter={e => { e.currentTarget.style.background = '#F5F3FF'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
            <Icon name="download" size={16} color="#5e4dbb" />
          </button>
          <button onClick={onClose} title="Close"
            style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', background: '#f1ecf6', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="close" size={16} color="#787584" />
          </button>
        </div>
        {/* Body */}
        <div style={{ padding: 16, overflowY: 'auto', background: kind === 'image' || kind === 'pdf' || kind === 'video' ? '#f4f2fa' : '#fff' }}>
          {body}
        </div>
      </div>
    </div>,
    document.body
  );
}
