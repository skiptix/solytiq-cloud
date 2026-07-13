import { useEffect, useRef, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import type { AIChatMessage, AISession } from '../../store/useAIStore';
import type { AIFile } from '../../types';
import Icon from '../Icon';
import AIRecentChats from './AIRecentChats';
import { apiUploadAIFile, apiDeleteAIFile } from '../../api/client';

interface Props {
  messages: AIChatMessage[];
  isThinking: boolean;
  contextView: string;
  onSend: (text: string) => void;
  onClose: () => void;
  onClearHistory: () => void;
  onShowRecentChats: () => void;
  showRecentChats: boolean;
  recentSessions: AISession[];
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onCloseRecentChats: () => void;
  uploadedFiles: AIFile[];
  onAddFile: (file: AIFile) => void;
  onRemoveFile: (id: string) => void;
  sessionId: string | null;
}

const VIEW_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  list: 'List',
  calendar: 'Calendar',
  files: 'Files',
  settings: 'Settings',
  general: 'App',
};

const ACCEPTED_MIME_PREFIXES = ['application/pdf', 'text/', 'image/'];
const ACCEPTED_MIME_EXACT = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);
// Extensions whose MIME type may be wrong in the browser (e.g. .ts → video/mp2t)
const ACCEPTED_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs',
  'md', 'markdown',
  'html', 'htm',
  'csv',
  'xlsx', 'xls',
  'json', 'yaml', 'yml', 'toml', 'xml', 'sql', 'py', 'rb', 'go', 'rs',
  'txt', 'log',
]);

function getExt(name: string) {
  return (name.split('.').pop() ?? '').toLowerCase();
}

function isAccepted(file: File) {
  if (ACCEPTED_MIME_PREFIXES.some((p) => file.type === p || file.type.startsWith(p))) return true;
  if (ACCEPTED_MIME_EXACT.has(file.type)) return true;
  return ACCEPTED_EXTENSIONS.has(getExt(file.name));
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(mime: string, name: string): string {
  if (mime === 'application/pdf') return 'picture_as_pdf';
  if (mime.startsWith('image/')) return 'image';
  const ext = getExt(name);
  if (ext === 'xlsx' || ext === 'xls') return 'table_chart';
  if (ext === 'csv') return 'table_rows';
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') return 'code';
  if (ext === 'md' || ext === 'markdown') return 'article';
  if (ext === 'html' || ext === 'htm') return 'html';
  return 'description';
}

function ThinkingDots() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '10px 14px' }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: '#9d8dff',
            display: 'inline-block',
            animation: `aiDotBounce 1.2s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

function UserMessage({ msg }: { msg: AIChatMessage }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
      <div
        style={{
          maxWidth: '78%',
          background: 'linear-gradient(135deg, #6b5bcc 0%, #4a39aa 100%)',
          color: '#fff',
          borderRadius: '18px 18px 4px 18px',
          padding: '10px 14px',
          fontFamily: 'Inter, sans-serif',
          fontSize: 13.5,
          lineHeight: 1.5,
          wordBreak: 'break-word',
          boxShadow: '0 2px 8px rgba(107,91,204,0.25)',
        }}
      >
        {msg.content}
      </div>
    </div>
  );
}

function AssistantMessage({ msg }: { msg: AIChatMessage }) {
  if (msg.isThinking) {
    return (
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginBottom: 10 }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #9d8dff 0%, #4a39aa 100%)',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 2px 6px rgba(157,141,255,0.4)',
          }}
        >
          <span style={{ fontSize: 14 }}>✦</span>
        </div>
        <div
          style={{
            background: '#F5F3FF',
            borderRadius: '4px 18px 18px 18px',
            border: '1px solid #e8e4f0',
          }}
        >
          <ThinkingDots />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #9d8dff 0%, #4a39aa 100%)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 2,
          boxShadow: '0 2px 6px rgba(157,141,255,0.4)',
        }}
      >
        <span style={{ fontSize: 14 }}>✦</span>
      </div>
      <div style={{ maxWidth: 'calc(100% - 36px)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {msg.actionSummary && (
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              background: 'rgba(16,185,129,0.1)',
              border: '1px solid rgba(16,185,129,0.25)',
              borderRadius: 8,
              padding: '4px 10px',
              fontFamily: 'Inter, sans-serif',
              fontSize: 11.5,
              fontWeight: 600,
              color: '#059669',
              animation: 'aiFadeIn 300ms ease both',
            }}
          >
            <Icon name="check_circle" size={13} color="#059669" />
            {msg.actionSummary}
          </div>
        )}
        {msg.content && (
          <div
            style={{
              background: msg.error ? '#fff5f5' : '#F5F3FF',
              border: `1px solid ${msg.error ? '#ffdad6' : '#e8e4f0'}`,
              borderRadius: '4px 18px 18px 18px',
              padding: '10px 14px',
              fontFamily: 'Inter, sans-serif',
              fontSize: 13.5,
              lineHeight: 1.6,
              color: msg.error ? '#ba1a1a' : '#1c1b22',
              wordBreak: 'break-word',
              animation: 'aiFadeIn 200ms ease both',
            }}
          >
            <ReactMarkdown
              components={{
                p: ({ children }) => <p style={{ margin: '0 0 6px', lineHeight: 1.6 }}>{children}</p>,
                ul: ({ children }) => <ul style={{ margin: '4px 0 6px', paddingLeft: 18 }}>{children}</ul>,
                ol: ({ children }) => <ol style={{ margin: '4px 0 6px', paddingLeft: 18 }}>{children}</ol>,
                li: ({ children }) => <li style={{ marginBottom: 3, lineHeight: 1.5 }}>{children}</li>,
                strong: ({ children }) => <strong style={{ fontWeight: 700, color: 'inherit' }}>{children}</strong>,
                em: ({ children }) => <em style={{ fontStyle: 'italic' }}>{children}</em>,
                code: ({ children, className }) => {
                  const isBlock = className?.includes('language-');
                  return isBlock ? (
                    <pre style={{ background: 'rgba(0,0,0,0.06)', borderRadius: 6, padding: '8px 10px', overflow: 'auto', margin: '6px 0', fontSize: 12 }}>
                      <code style={{ fontFamily: 'monospace', fontSize: 12 }}>{children}</code>
                    </pre>
                  ) : (
                    <code style={{ background: 'rgba(0,0,0,0.07)', borderRadius: 4, padding: '1px 5px', fontFamily: 'monospace', fontSize: 12.5 }}>{children}</code>
                  );
                },
                h1: ({ children }) => <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontWeight: 700, fontSize: 15, margin: '6px 0 4px' }}>{children}</div>,
                h2: ({ children }) => <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontWeight: 700, fontSize: 14, margin: '6px 0 4px' }}>{children}</div>,
                h3: ({ children }) => <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontWeight: 600, fontSize: 13.5, margin: '4px 0 4px' }}>{children}</div>,
                a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#5e4dbb', textDecoration: 'underline' }}>{children}</a>,
                blockquote: ({ children }) => <blockquote style={{ borderLeft: '3px solid #c9c4d5', paddingLeft: 10, margin: '6px 0', color: '#787584', fontStyle: 'italic' }}>{children}</blockquote>,
                hr: () => <hr style={{ border: 'none', borderTop: '1px solid #e8e4f0', margin: '8px 0' }} />,
              }}
            >
              {msg.content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

interface UploadingFile {
  name: string;
  progress: number;
  id: string;
}

export default function AIChatWindow({
  messages,
  isThinking,
  contextView,
  onSend,
  onClose,
  onClearHistory,
  onShowRecentChats,
  showRecentChats,
  recentSessions,
  onSelectSession,
  onDeleteSession,
  onCloseRecentChats,
  uploadedFiles,
  onAddFile,
  onRemoveFile,
  sessionId,
}: Props) {
  const [input, setInput] = useState('');
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = () => {
    const text = input.trim();
    if (!text || isThinking) return;
    setInput('');
    onSend(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const uploadFile = useCallback(async (file: File) => {
    if (!isAccepted(file)) {
      setUploadError(`Unsupported type. Use PDF, XLSX, CSV, HTML, Markdown, TypeScript, or images.`);
      setTimeout(() => setUploadError(null), 4000);
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setUploadError('File too large — max 25 MB.');
      setTimeout(() => setUploadError(null), 4000);
      return;
    }

    const tempId = crypto.randomUUID();
    setUploadingFiles((prev) => [...prev, { name: file.name, progress: 0, id: tempId }]);
    setUploadError(null);

    try {
      const result = await apiUploadAIFile(file, sessionId, (pct) => {
        setUploadingFiles((prev) => prev.map((u) => u.id === tempId ? { ...u, progress: pct } : u));
      });
      onAddFile(result);
    } catch {
      setUploadError(`Failed to upload "${file.name}". Please try again.`);
      setTimeout(() => setUploadError(null), 4000);
    } finally {
      setUploadingFiles((prev) => prev.filter((u) => u.id !== tempId));
    }
  }, [sessionId, onAddFile]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) setIsDragOver(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    for (const file of files.slice(0, 3)) {
      await uploadFile(file);
    }
  }, [uploadFile]);

  const handleFilePickerChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    for (const file of files.slice(0, 3)) {
      await uploadFile(file);
    }
    e.target.value = '';
  }, [uploadFile]);

  const handleRemoveFile = useCallback(async (id: string) => {
    onRemoveFile(id);
    await apiDeleteAIFile(id).catch(() => {});
  }, [onRemoveFile]);

  const viewLabel = VIEW_LABELS[contextView] ?? contextView;
  const hasFiles = uploadedFiles.length > 0 || uploadingFiles.length > 0;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 64,
        right: 0,
        width: Math.min(360, window.innerWidth - 24),
        height: Math.min(520, window.innerHeight - 140),
        background: '#fff',
        borderRadius: 20,
        boxShadow: '0 20px 60px rgba(30,20,80,0.2), 0 4px 16px rgba(94,77,187,0.1)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        animation: 'aiWindowIn 300ms cubic-bezier(0.34,1.56,0.64,1) both',
        border: `1.5px solid ${isDragOver ? 'rgba(107,91,204,0.5)' : 'rgba(94,77,187,0.12)'}`,
        transition: 'border-color 200ms ease',
      }}
      onClick={(e) => e.stopPropagation()}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div
        style={{
          background: 'linear-gradient(135deg, #6b5bcc 0%, #4a39aa 100%)',
          padding: '14px 16px 12px',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.18)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            boxShadow: '0 0 0 1px rgba(255,255,255,0.15)',
            overflow: 'hidden',
          }}
        >
          <img
            src="/cloud_avatar.png"
            alt="Sol"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: 'Hanken Grotesk, sans-serif',
              fontSize: 15,
              fontWeight: 700,
              color: '#fff',
              lineHeight: 1.2,
              letterSpacing: '-0.01em',
            }}
          >
            Sol
          </div>
          <div
            style={{
              fontFamily: 'Inter, sans-serif',
              fontSize: 11,
              color: 'rgba(255,255,255,0.6)',
              marginTop: 1,
            }}
          >
            {viewLabel} context
          </div>
        </div>
        <button
          onClick={onShowRecentChats}
          title="Recent chats"
          style={{
            width: 30, height: 30, borderRadius: 8,
            background: 'rgba(255,255,255,0.12)', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background 180ms ease, transform 150ms ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.24)'; e.currentTarget.style.transform = 'scale(1.08)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; e.currentTarget.style.transform = 'scale(1)'; }}
        >
          <Icon name="history" size={15} color="rgba(255,255,255,0.85)" />
        </button>
        <button
          onClick={() => setShowClearConfirm(true)}
          title="Clear chat"
          style={{
            width: 30, height: 30, borderRadius: 8,
            background: 'rgba(255,255,255,0.12)', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background 180ms ease, transform 150ms ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.24)'; e.currentTarget.style.transform = 'scale(1.08)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; e.currentTarget.style.transform = 'scale(1)'; }}
        >
          <Icon name="delete_sweep" size={15} color="rgba(255,255,255,0.85)" />
        </button>
        <button
          onClick={onClose}
          title="Close"
          style={{
            width: 30, height: 30, borderRadius: 8,
            background: 'rgba(255,255,255,0.12)', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background 180ms ease, transform 150ms ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.24)'; e.currentTarget.style.transform = 'scale(1.08)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; e.currentTarget.style.transform = 'scale(1)'; }}
        >
          <Icon name="close" size={15} color="rgba(255,255,255,0.85)" />
        </button>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '14px 14px 4px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {messages.length === 0 && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              padding: '20px 10px',
              animation: 'aiFadeIn 300ms ease both',
            }}
          >
            <div
              style={{
                width: 56, height: 56, borderRadius: '50%',
                background: 'linear-gradient(135deg, #ede9ff 0%, #f5f3ff 100%)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 4px 16px rgba(107,91,204,0.15)',
                overflow: 'hidden',
              }}
            >
              <img
                src="/cloud_avatar.png"
                alt="Sol"
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            </div>
            <div
              style={{
                fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 600,
                color: '#1c1b22', textAlign: 'center', letterSpacing: '-0.01em',
              }}
            >
              Hi, I'm Sol — how can I help?
            </div>
            <div
              style={{
                fontFamily: 'Inter, sans-serif', fontSize: 12.5, color: '#787584',
                textAlign: 'center', lineHeight: 1.5, maxWidth: 260,
              }}
            >
              I can manage tasks, lists & folders — or read an uploaded file and create todos from it.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4, width: '100%', maxWidth: 280 }}>
              {[
                contextView === 'list' ? 'Add a task to the first section' : 'Add a task called "Weekly review"',
                contextView === 'calendar' ? 'Schedule the top priority task for tomorrow' : 'Mark all overdue tasks as done',
                "Drop a PDF here and I'll create todos from it",
              ].map((hint, i) => (
                <button
                  key={hint}
                  onClick={() => { setInput(hint); inputRef.current?.focus(); }}
                  style={{
                    fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#5e4dbb',
                    background: '#F5F3FF', border: '1px solid rgba(94,77,187,0.12)',
                    borderRadius: 10, padding: '8px 12px', cursor: 'pointer', textAlign: 'left',
                    transition: 'background 180ms ease, transform 150ms ease, box-shadow 180ms ease',
                    animation: `aiItemIn 300ms ease ${i * 60}ms both`,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#ede9ff'; e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(94,77,187,0.12)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = '#F5F3FF'; e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none'; }}
                >
                  {hint}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg) =>
          msg.role === 'user' ? (
            <UserMessage key={msg.id} msg={msg} />
          ) : (
            <AssistantMessage key={msg.id} msg={msg} />
          )
        )}
      </div>

      {/* File chips */}
      {hasFiles && (
        <div
          style={{
            padding: '6px 12px 0',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            animation: 'aiFadeIn 200ms ease both',
          }}
        >
          {uploadedFiles.map((f) => (
            <div
              key={f.id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                background: 'linear-gradient(135deg, #f0eeff 0%, #e8e4ff 100%)',
                border: '1px solid rgba(94,77,187,0.2)',
                borderRadius: 10,
                padding: '4px 6px 4px 8px',
                fontFamily: 'Inter, sans-serif',
                fontSize: 11.5,
                color: '#5e4dbb',
                fontWeight: 500,
                animation: 'aiItemIn 200ms ease both',
                maxWidth: 160,
              }}
            >
              <Icon name={fileIcon(f.mimeType, f.filename)} size={12} color="#7c5dfa" />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 100 }}>
                {f.filename}
              </span>
              <span style={{ color: '#9d8dff', fontSize: 10, flexShrink: 0 }}>{formatFileSize(f.size)}</span>
              <button
                onClick={() => handleRemoveFile(f.id)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: 2, borderRadius: 4, transition: 'background 150ms',
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(94,77,187,0.12)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
              >
                <Icon name="close" size={11} color="#9d8dff" />
              </button>
            </div>
          ))}
          {uploadingFiles.map((u) => (
            <div
              key={u.id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                background: '#f5f3ff',
                border: '1px solid rgba(94,77,187,0.15)',
                borderRadius: 10,
                padding: '4px 8px',
                fontFamily: 'Inter, sans-serif',
                fontSize: 11.5,
                color: '#9d8dff',
                animation: 'aiItemIn 200ms ease both',
                maxWidth: 160,
              }}
            >
              <div
                style={{
                  width: 10, height: 10, border: '1.5px solid #c9c4d5',
                  borderTopColor: '#7c5dfa', borderRadius: '50%',
                  animation: 'aiSpin 700ms linear infinite', flexShrink: 0,
                }}
              />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 100 }}>
                {u.name}
              </span>
              <span style={{ fontSize: 10, flexShrink: 0 }}>{u.progress}%</span>
            </div>
          ))}
        </div>
      )}

      {/* Upload error */}
      {uploadError && (
        <div
          style={{
            margin: '4px 12px 0',
            background: '#fff5f5',
            border: '1px solid #ffdad6',
            borderRadius: 8,
            padding: '6px 10px',
            fontFamily: 'Inter, sans-serif',
            fontSize: 11.5,
            color: '#ba1a1a',
            animation: 'aiFadeIn 200ms ease both',
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <Icon name="error" size={12} color="#ba1a1a" />
          {uploadError}
        </div>
      )}

      {/* Input */}
      <div
        style={{
          padding: '10px 12px 14px',
          borderTop: '1px solid rgba(94,77,187,0.08)',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: '#F9FAFB',
            border: '1.5px solid #e8e4f0',
            borderRadius: 14,
            padding: '8px 8px 8px 12px',
            transition: 'border-color 200ms ease, box-shadow 200ms ease',
          }}
          onFocusCapture={(e) => { e.currentTarget.style.borderColor = 'rgba(94,77,187,0.35)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(94,77,187,0.06)'; }}
          onBlurCapture={(e) => { e.currentTarget.style.borderColor = '#e8e4f0'; e.currentTarget.style.boxShadow = 'none'; }}
        >
          {/* File attach button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            title="Attach file"
            disabled={isThinking}
            style={{
              width: 26, height: 26, borderRadius: 8,
              background: 'none', border: 'none', cursor: isThinking ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, transition: 'background 180ms ease',
              opacity: isThinking ? 0.4 : 1,
            }}
            onMouseEnter={(e) => { if (!isThinking) e.currentTarget.style.background = 'rgba(94,77,187,0.08)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
          >
            <Icon name="attach_file" size={16} color="#9d8dff" />
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Sol…"
            rows={1}
            disabled={isThinking}
            style={{
              flex: 1,
              fontFamily: 'Inter, sans-serif',
              fontSize: 13.5,
              color: '#1c1b22',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              resize: 'none',
              lineHeight: 1.5,
              maxHeight: 96,
              overflowY: 'auto',
              opacity: isThinking ? 0.5 : 1,
              transition: 'opacity 200ms ease',
            }}
            onInput={(e) => {
              const t = e.currentTarget;
              t.style.height = 'auto';
              t.style.height = `${Math.min(t.scrollHeight, 96)}px`;
            }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isThinking}
            style={{
              width: 32, height: 32, borderRadius: 10,
              background: !input.trim() || isThinking
                ? '#e8e4f0'
                : 'linear-gradient(135deg, #6b5bcc 0%, #4a39aa 100%)',
              border: 'none',
              cursor: !input.trim() || isThinking ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, transition: 'all 200ms ease',
              transform: !input.trim() || isThinking ? 'scale(0.95)' : 'scale(1)',
              boxShadow: !input.trim() || isThinking ? 'none' : '0 2px 8px rgba(107,91,204,0.35)',
            }}
          >
            <Icon
              name="arrow_upward"
              size={16}
              color={!input.trim() || isThinking ? '#b0acbe' : '#fff'}
            />
          </button>
        </div>
        <div
          style={{
            fontFamily: 'Inter, sans-serif',
            fontSize: 10.5,
            color: '#c4bfd4',
            marginTop: 5,
            textAlign: 'center',
          }}
        >
          Enter to send · Shift+Enter for newline · Drop PDF, XLSX, CSV, TS, MD, images
        </div>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.xlsx,.xls,.csv,.html,.htm,.md,.markdown,.ts,.tsx,.js,.jsx,.txt,.json,.yaml,.yml,.xml,.sql,.log,image/*"
        style={{ display: 'none' }}
        onChange={handleFilePickerChange}
      />

      {/* Drag-over overlay */}
      {isDragOver && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(107,91,204,0.06)',
            backdropFilter: 'blur(2px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            zIndex: 30,
            borderRadius: 18,
            animation: 'aiFadeIn 150ms ease both',
            border: '2px dashed rgba(107,91,204,0.4)',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              width: 64, height: 64, borderRadius: '50%',
              background: 'linear-gradient(135deg, #ede9ff 0%, #ddd6ff 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 8px 24px rgba(107,91,204,0.2)',
              animation: 'aiFloatPulse 1.2s ease-in-out infinite',
            }}
          >
            <Icon name="upload_file" size={28} color="#6b5bcc" />
          </div>
          <div
            style={{
              fontFamily: 'Hanken Grotesk, sans-serif',
              fontSize: 15, fontWeight: 700,
              color: '#4a39aa',
              textAlign: 'center',
              letterSpacing: '-0.01em',
            }}
          >
            Drop to attach
          </div>
          <div
            style={{
              fontFamily: 'Inter, sans-serif',
              fontSize: 12, color: '#787584',
              textAlign: 'center',
            }}
          >
            PDF, XLSX, CSV, HTML, Markdown, TypeScript, images · max 25 MB
          </div>
        </div>
      )}

      {/* Recent chats overlay */}
      {showRecentChats && (
        <AIRecentChats
          sessions={recentSessions}
          onSelect={onSelectSession}
          onDelete={onDeleteSession}
          onClose={onCloseRecentChats}
        />
      )}

      {/* Clear history confirmation */}
      {showClearConfirm && (
        <div
          style={{
            position: 'absolute', inset: 0,
            background: 'rgba(255,255,255,0.92)',
            backdropFilter: 'blur(6px)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: 14, padding: 24, borderRadius: 20, zIndex: 20,
            animation: 'aiFadeIn 180ms ease both',
          }}
        >
          <div
            style={{
              width: 48, height: 48, borderRadius: '50%',
              background: '#fff5f5',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 4px 16px rgba(186,26,26,0.12)',
            }}
          >
            <Icon name="delete_sweep" size={22} color="#ba1a1a" />
          </div>
          <div style={{ textAlign: 'center' }}>
            <div
              style={{
                fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 700,
                color: '#1c1b22', marginBottom: 6, letterSpacing: '-0.01em',
              }}
            >
              Clear this chat?
            </div>
            <div
              style={{
                fontFamily: 'Inter, sans-serif', fontSize: 12.5,
                color: '#787584', lineHeight: 1.5,
              }}
            >
              Messages will be permanently deleted.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, width: '100%' }}>
            <button
              onClick={() => setShowClearConfirm(false)}
              style={{
                flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13,
                fontWeight: 500, color: '#484552', background: '#f1ecf6',
                border: 'none', borderRadius: 10, padding: '10px 0', cursor: 'pointer',
                transition: 'background 180ms ease, transform 150ms ease',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#e8e4f0'; e.currentTarget.style.transform = 'scale(1.02)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = '#f1ecf6'; e.currentTarget.style.transform = 'scale(1)'; }}
            >
              Cancel
            </button>
            <button
              onClick={() => { setShowClearConfirm(false); onClearHistory(); }}
              style={{
                flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13,
                fontWeight: 600, color: '#fff', background: '#ba1a1a',
                border: 'none', borderRadius: 10, padding: '10px 0', cursor: 'pointer',
                transition: 'background 180ms ease, transform 150ms ease',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#991212'; e.currentTarget.style.transform = 'scale(1.02)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = '#ba1a1a'; e.currentTarget.style.transform = 'scale(1)'; }}
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
