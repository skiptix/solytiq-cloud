import { useEffect, useRef, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { useReducedMotion, motion, useDragControls, type PanInfo } from '@/components/animate-ui/motion';
import type { AIChatMessage, AISession } from '../../store/useAIStore';
import type { AIFile } from '../../types';
import Icon from '../Icon';
import AIRecentChats from './AIRecentChats';
import { apiUploadAIFile, apiDeleteAIFile } from '../../api/client';
import { EASE_STANDARD, SWIPE_DISMISS_DISTANCE, SWIPE_DISMISS_VELOCITY, backdropVariants, desktopWindowVariants, sheetVariants } from '@/components/animate-ui/motionTokens';
import MotionButton from '../animate-ui/MotionButton';
import MotionIn from '../animate-ui/MotionIn';

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
  isMobile?: boolean;
}

const VIEW_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  list: 'Board',
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
  // Continuous decorative motion — paused explicitly under reduced motion.
  const reduceMotion = useReducedMotion();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '10px 14px' }}>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          animate={reduceMotion ? undefined : { y: [0, -6, 0], opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.2, delay: i * 0.2, ease: 'easeInOut', repeat: Infinity }} style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: 'var(--color-accent-purple-light)',
            display: 'inline-block',
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
          background: 'linear-gradient(135deg, var(--color-purple-mid-8) 0%, var(--color-purple-mid-13) 100%)',
          color: 'var(--color-white)',
          borderRadius: '18px 18px 4px 18px',
          padding: '10px 14px',
          fontFamily: 'var(--font-body)',
          fontSize: 13.5,
          lineHeight: 1.5,
          wordBreak: 'break-word',
          boxShadow: '0 2px 8px rgba(var(--color-purple-mid-8-rgb), 0.25)',
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
        <MotionIn
          animate={{ rotate: 360 }} transition={{ duration: 0.7, ease: 'linear', repeat: Infinity }} style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--color-accent-purple-light) 0%, var(--color-purple-mid-13) 100%)',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 2px 6px rgba(var(--color-accent-purple-light-rgb), 0.4)',
          }}
        >
          <span style={{ fontSize: 14 }}>✦</span>
        </MotionIn>
        <div
          style={{
            background: 'var(--color-surface-tint)',
            borderRadius: '4px 18px 18px 18px',
            border: '1px solid var(--color-border)',
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
          background: 'linear-gradient(135deg, var(--color-accent-purple-light) 0%, var(--color-purple-mid-13) 100%)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 2,
          boxShadow: '0 2px 6px rgba(var(--color-accent-purple-light-rgb), 0.4)',
        }}
      >
        <span style={{ fontSize: 14 }}>✦</span>
      </div>
      <div style={{ maxWidth: 'calc(100% - 36px)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {msg.actionSummary && (
          <MotionIn
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, ease: EASE_STANDARD }} style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              background: 'rgba(var(--color-success-rgb), 0.1)',
              border: '1px solid rgba(var(--color-success-rgb), 0.25)',
              borderRadius: 8,
              padding: '4px 10px',
              fontFamily: 'var(--font-body)',
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--color-teal-deep-3)',
            }}
          >
            <Icon name="check_circle" size={13} color="var(--color-teal-deep-3)" />
            {msg.actionSummary}
          </MotionIn>
        )}
        {msg.content && (
          <MotionIn
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2, ease: EASE_STANDARD }} style={{
              background: msg.error ? 'var(--color-error-bg-alt)' : 'var(--color-surface-tint)',
              border: `1px solid ${msg.error ? 'var(--color-error-bg)' : 'var(--color-border)'}`,
              borderRadius: '4px 18px 18px 18px',
              padding: '10px 14px',
              fontFamily: 'var(--font-body)',
              fontSize: 13.5,
              lineHeight: 1.6,
              color: msg.error ? 'var(--color-error)' : 'var(--color-text-primary)',
              wordBreak: 'break-word',
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
                    <pre style={{ background: 'rgba(var(--color-black-rgb), 0.06)', borderRadius: 6, padding: '8px 10px', overflow: 'auto', margin: '6px 0', fontSize: 12 }}>
                      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{children}</code>
                    </pre>
                  ) : (
                    <code style={{ background: 'rgba(var(--color-black-rgb), 0.07)', borderRadius: 4, padding: '1px 5px', fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{children}</code>
                  );
                },
                h1: ({ children }) => <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 15, margin: '6px 0 4px' }}>{children}</div>,
                h2: ({ children }) => <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 14, margin: '6px 0 4px' }}>{children}</div>,
                h3: ({ children }) => <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 13.5, margin: '4px 0 4px' }}>{children}</div>,
                a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)', textDecoration: 'underline' }}>{children}</a>,
                blockquote: ({ children }) => <blockquote style={{ borderLeft: '3px solid var(--color-border-strong)', paddingLeft: 10, margin: '6px 0', color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>{children}</blockquote>,
                hr: () => <hr style={{ border: 'none', borderTop: '1px solid var(--color-border)', margin: '8px 0' }} />,
              }}
            >
              {msg.content}
            </ReactMarkdown>
          </MotionIn>
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
  isMobile,
}: Props) {
  // Continuous decorative motion — paused explicitly under reduced motion.
  const reduceMotion = useReducedMotion();
  const [input, setInput] = useState('');
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);
  const sheetDragControls = useDragControls();

  const handleSheetDragEnd = useCallback((_e: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (info.offset.y > SWIPE_DISMISS_DISTANCE || info.velocity.y > SWIPE_DISMISS_VELOCITY) {
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Sending disables the textarea while Sol is thinking, which the browser
  // blurs automatically — re-focus once it's re-enabled so the user can keep
  // typing the next message without an extra click. Skipped on mobile, where
  // it would pop the on-screen keyboard back over the just-arrived reply.
  const wasThinking = useRef(isThinking);
  useEffect(() => {
    if (wasThinking.current && !isThinking && !isMobile) inputRef.current?.focus();
    wasThinking.current = isThinking;
  }, [isThinking, isMobile]);

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

  const sheetStyle: React.CSSProperties = isMobile
    ? {
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        height: 'min(88vh, 680px)',
        maxHeight: '88vh',
        background: 'var(--color-white)',
        borderRadius: '22px 22px 0 0',
        boxShadow: '0 -12px 40px rgba(var(--color-purple-deep-4-rgb), 0.24)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        border: `1.5px solid ${isDragOver ? 'rgba(var(--color-purple-mid-8-rgb), 0.5)' : 'rgba(var(--color-primary-rgb), 0.12)'}`,
        borderBottom: 'none',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        zIndex: 9001,
      }
    : {
        position: 'absolute',
        bottom: 64,
        right: 0,
        width: Math.min(360, window.innerWidth - 24),
        height: Math.min(520, window.innerHeight - 140),
        background: 'var(--color-white)',
        borderRadius: 20,
        boxShadow: '0 20px 60px rgba(var(--color-purple-deep-4-rgb), 0.2), 0 4px 16px rgba(var(--color-primary-rgb), 0.1)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transformOrigin: 'bottom right',
        border: `1.5px solid ${isDragOver ? 'rgba(var(--color-purple-mid-8-rgb), 0.5)' : 'rgba(var(--color-primary-rgb), 0.12)'}`,
      };

  return (
    <>
      {isMobile && (
        <motion.div
          onClick={onClose}
          variants={backdropVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(var(--color-black-rgb), 0.4)',
            backdropFilter: 'blur(2px)',
            zIndex: 9000,
          }}
        />
      )}
      <motion.div
        style={sheetStyle}
        variants={isMobile ? sheetVariants : desktopWindowVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        drag={isMobile ? 'y' : false}
        dragListener={false}
        dragControls={sheetDragControls}
        dragConstraints={isMobile ? { top: 0, bottom: 0 } : undefined}
        dragElastic={isMobile ? { top: 0, bottom: 0.5 } : undefined}
        onDragEnd={isMobile ? handleSheetDragEnd : undefined}
        onClick={(e) => e.stopPropagation()}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Drag handle — mobile bottom sheet only; swipe down past a distance/velocity threshold dismisses */}
        {isMobile && (
          <div
            onPointerDown={(e) => sheetDragControls.start(e)}
            style={{ display: 'flex', justifyContent: 'center', paddingTop: 8, paddingBottom: 4, flexShrink: 0, touchAction: 'none', cursor: 'grab' }}
          >
            <div style={{ width: 36, height: 4, borderRadius: 9999, background: 'var(--color-border-strong)' }} />
          </div>
        )}
      {/* Header */}
      <div
        style={{
          background: 'linear-gradient(135deg, var(--color-purple-mid-8) 0%, var(--color-purple-mid-13) 100%)',
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
            background: 'rgba(var(--color-white-rgb), 0.18)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            boxShadow: '0 0 0 1px rgba(var(--color-white-rgb), 0.15)',
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
              fontFamily: 'var(--font-heading)',
              fontSize: 15,
              fontWeight: 700,
              color: 'var(--color-white)',
              lineHeight: 1.2,
              letterSpacing: '-0.01em',
            }}
          >
            Sol
          </div>
          <div
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: 11,
              color: 'rgba(var(--color-white-rgb), 0.6)',
              marginTop: 1,
            }}
          >
            {viewLabel} context
          </div>
        </div>
        <MotionButton
          onClick={onShowRecentChats}
          title="Recent chats"
          style={{
            width: 30, height: 30, borderRadius: 8,
            background: 'rgba(var(--color-white-rgb), 0.12)', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          whileHover={{ background: 'rgba(var(--color-white-rgb), 0.24)', transform: 'scale(1.08)' }}
          transition={{ duration: 0.18 }}
        >
          <Icon name="history" size={15} color="rgba(var(--color-white-rgb), 0.85)" />
        </MotionButton>
        <MotionButton
          onClick={() => setShowClearConfirm(true)}
          title="Clear chat"
          style={{
            width: 30, height: 30, borderRadius: 8,
            background: 'rgba(var(--color-white-rgb), 0.12)', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          whileHover={{ background: 'rgba(var(--color-white-rgb), 0.24)', transform: 'scale(1.08)' }}
          transition={{ duration: 0.18 }}
        >
          <Icon name="delete_sweep" size={15} color="rgba(var(--color-white-rgb), 0.85)" />
        </MotionButton>
        <MotionButton
          onClick={onClose}
          title="Close"
          style={{
            width: 30, height: 30, borderRadius: 8,
            background: 'rgba(var(--color-white-rgb), 0.12)', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          whileHover={{ background: 'rgba(var(--color-white-rgb), 0.24)', transform: 'scale(1.08)' }}
          transition={{ duration: 0.18 }}
        >
          <Icon name="close" size={15} color="rgba(var(--color-white-rgb), 0.85)" />
        </MotionButton>
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
          <MotionIn
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, ease: EASE_STANDARD }} style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              padding: '20px 10px',
            }}
          >
            <div
              style={{
                width: 56, height: 56, borderRadius: '50%',
                background: 'linear-gradient(135deg, var(--color-surface-tint-4) 0%, var(--color-surface-tint) 100%)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 4px 16px rgba(var(--color-purple-mid-8-rgb), 0.15)',
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
                fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 600,
                color: 'var(--color-text-primary)', textAlign: 'center', letterSpacing: '-0.01em',
              }}
            >
              Hi, I'm Sol — how can I help?
            </div>
            <div
              style={{
                fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-tertiary)',
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
                <MotionButton
                  key={hint}
                  onClick={() => { setInput(hint); inputRef.current?.focus(); }}
                  initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: (i * 60) / 1000, ease: EASE_STANDARD }} style={{
                    fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-primary)',
                    background: 'var(--color-surface-tint)', border: '1px solid rgba(var(--color-primary-rgb), 0.12)',
                    borderRadius: 10, padding: '8px 12px', cursor: 'pointer', textAlign: 'left',
                  }}
                  whileHover={{
                    background: 'var(--color-surface-tint-4)',
                    y: -1,
                    boxShadow: '0 2px 8px rgba(var(--color-primary-rgb), 0.12)',
                    // Own timing, so the staggered entrance delay above never
                    // leaks into the hover response.
                    transition: { duration: 0.18, delay: 0 },
                  }}
                >
                  {hint}
                </MotionButton>
              ))}
            </div>
          </MotionIn>
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
        <MotionIn
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2, ease: EASE_STANDARD }} style={{
            padding: '6px 12px 0',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
          }}
        >
          {uploadedFiles.map((f) => (
            <MotionIn
              key={f.id}
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: EASE_STANDARD }} style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                background: 'linear-gradient(135deg, var(--color-purple-pale-15) 0%, var(--color-purple-pale-29) 100%)',
                border: '1px solid rgba(var(--color-primary-rgb), 0.2)',
                borderRadius: 10,
                padding: '4px 6px 4px 8px',
                fontFamily: 'var(--font-body)',
                fontSize: 11.5,
                color: 'var(--color-primary)',
                fontWeight: 500,
                maxWidth: 160,
              }}
            >
              <Icon name={fileIcon(f.mimeType, f.filename)} size={12} color="var(--color-purple-mid-1)" />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 100 }}>
                {f.filename}
              </span>
              <span style={{ color: 'var(--color-accent-purple-light)', fontSize: 10, flexShrink: 0 }}>{formatFileSize(f.size)}</span>
              <MotionButton
                onClick={() => handleRemoveFile(f.id)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: 2, borderRadius: 4,
                  flexShrink: 0,
                }}
                whileHover={{ background: 'rgba(var(--color-primary-rgb), 0.12)' }}
                transition={{ duration: 0.15 }}
              >
                <Icon name="close" size={11} color="var(--color-accent-purple-light)" />
              </MotionButton>
            </MotionIn>
          ))}
          {uploadingFiles.map((u) => (
            <MotionIn
              key={u.id}
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: EASE_STANDARD }} style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                background: 'var(--color-surface-tint)',
                border: '1px solid rgba(var(--color-primary-rgb), 0.15)',
                borderRadius: 10,
                padding: '4px 8px',
                fontFamily: 'var(--font-body)',
                fontSize: 11.5,
                color: 'var(--color-accent-purple-light)',
                maxWidth: 160,
              }}
            >
              <div
                style={{
                  width: 10, height: 10, border: '1.5px solid var(--color-border-strong)',
                  borderTopColor: 'var(--color-purple-mid-1)', borderRadius: '50%',
                  flexShrink: 0,
                }}
              />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 100 }}>
                {u.name}
              </span>
              <span style={{ fontSize: 10, flexShrink: 0 }}>{u.progress}%</span>
            </MotionIn>
          ))}
        </MotionIn>
      )}

      {/* Upload error */}
      {uploadError && (
        <MotionIn
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2, ease: EASE_STANDARD }} style={{
            margin: '4px 12px 0',
            background: 'var(--color-error-bg-alt)',
            border: '1px solid var(--color-error-bg)',
            borderRadius: 8,
            padding: '6px 10px',
            fontFamily: 'var(--font-body)',
            fontSize: 11.5,
            color: 'var(--color-error)',
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <Icon name="error" size={12} color="var(--color-error)" />
          {uploadError}
        </MotionIn>
      )}

      {/* Input */}
      <div
        style={{
          padding: '10px 12px 14px',
          borderTop: '1px solid rgba(var(--color-primary-rgb), 0.08)',
          flexShrink: 0,
        }}
      >
        <MotionIn
          transition={{ duration: 0.2 }} style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'var(--color-surface-gray)',
            border: '1.5px solid var(--color-border)',
            borderRadius: 14,
            padding: '8px 8px 8px 12px',
          }}
          onFocusCapture={(e) => { e.currentTarget.style.borderColor = 'rgba(var(--color-primary-rgb), 0.35)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(var(--color-primary-rgb), 0.06)'; }}
          onBlurCapture={(e) => { e.currentTarget.style.borderColor = 'var(--color-border)'; e.currentTarget.style.boxShadow = 'none'; }}
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
              flexShrink: 0,
              opacity: isThinking ? 0.4 : 1,
            }}
            onMouseEnter={(e) => { if (!isThinking) e.currentTarget.style.background = 'rgba(var(--color-primary-rgb), 0.08)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
          >
            <Icon name="attach_file" size={16} color="var(--color-accent-purple-light)" />
          </button>
          <motion.textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Sol…"
            rows={1}
            disabled={isThinking}
            transition={{ duration: 0.2 }} style={{
              flex: 1,
              fontFamily: 'var(--font-body)',
              fontSize: 13.5,
              color: 'var(--color-text-primary)',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              resize: 'none',
              lineHeight: 1.5,
              maxHeight: 96,
              overflowY: 'auto',
              opacity: isThinking ? 0.5 : 1,
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
                ? 'var(--color-border)'
                : 'linear-gradient(135deg, var(--color-purple-mid-8) 0%, var(--color-purple-mid-13) 100%)',
              border: 'none',
              cursor: !input.trim() || isThinking ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
              transform: !input.trim() || isThinking ? 'scale(0.95)' : 'scale(1)',
              boxShadow: !input.trim() || isThinking ? 'none' : '0 2px 8px rgba(var(--color-purple-mid-8-rgb), 0.35)',
            }}
          >
            <Icon
              name="arrow_upward"
              size={16}
              color={!input.trim() || isThinking ? 'var(--color-text-quaternary)' : 'var(--color-white)'}
            />
          </button>
        </MotionIn>
        <div
          style={{
            fontFamily: 'var(--font-body)',
            fontSize: 10.5,
            color: 'var(--color-purple-tint-9)',
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
        <MotionIn
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15, ease: EASE_STANDARD }} style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(var(--color-purple-mid-8-rgb), 0.06)',
            backdropFilter: 'blur(2px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            zIndex: 30,
            borderRadius: 18,
            border: '2px dashed rgba(var(--color-purple-mid-8-rgb), 0.4)',
            pointerEvents: 'none',
          }}
        >
          <MotionIn
            animate={reduceMotion ? undefined : { y: [0, -4, 0], scale: [1, 1.04, 1] }} transition={{ duration: 1.2, ease: 'easeInOut', repeat: Infinity }} style={{
              width: 64, height: 64, borderRadius: '50%',
              background: 'linear-gradient(135deg, var(--color-surface-tint-4) 0%, var(--color-purple-pale-40) 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 8px 24px rgba(var(--color-purple-mid-8-rgb), 0.2)',
            }}
          >
            <Icon name="upload_file" size={28} color="var(--color-purple-mid-8)" />
          </MotionIn>
          <div
            style={{
              fontFamily: 'var(--font-heading)',
              fontSize: 15, fontWeight: 700,
              color: 'var(--color-purple-mid-13)',
              textAlign: 'center',
              letterSpacing: '-0.01em',
            }}
          >
            Drop to attach
          </div>
          <div
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: 12, color: 'var(--color-text-tertiary)',
              textAlign: 'center',
            }}
          >
            PDF, XLSX, CSV, HTML, Markdown, TypeScript, images · max 25 MB
          </div>
        </MotionIn>
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
        <MotionIn
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18, ease: EASE_STANDARD }} style={{
            position: 'absolute', inset: 0,
            background: 'rgba(var(--color-white-rgb), 0.92)',
            backdropFilter: 'blur(6px)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: 14, padding: 24, borderRadius: 20, zIndex: 20,
          }}
        >
          <div
            style={{
              width: 48, height: 48, borderRadius: '50%',
              background: 'var(--color-error-bg-alt)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 4px 16px rgba(var(--color-error-rgb), 0.12)',
            }}
          >
            <Icon name="delete_sweep" size={22} color="var(--color-error)" />
          </div>
          <div style={{ textAlign: 'center' }}>
            <div
              style={{
                fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 700,
                color: 'var(--color-text-primary)', marginBottom: 6, letterSpacing: '-0.01em',
              }}
            >
              Clear this chat?
            </div>
            <div
              style={{
                fontFamily: 'var(--font-body)', fontSize: 12.5,
                color: 'var(--color-text-tertiary)', lineHeight: 1.5,
              }}
            >
              Messages will be permanently deleted.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, width: '100%' }}>
            <MotionButton
              onClick={() => setShowClearConfirm(false)}
              style={{
                flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13,
                fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)',
                border: 'none', borderRadius: 10, padding: '10px 0', cursor: 'pointer',
              }}
              whileHover={{ background: 'var(--color-border)', transform: 'scale(1.02)' }}
              transition={{ duration: 0.18 }}
            >
              Cancel
            </MotionButton>
            <MotionButton
              onClick={() => { setShowClearConfirm(false); onClearHistory(); }}
              style={{
                flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13,
                fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-error)',
                border: 'none', borderRadius: 10, padding: '10px 0', cursor: 'pointer',
              }}
              whileHover={{ background: 'var(--color-red-deep-2)', transform: 'scale(1.02)' }}
              transition={{ duration: 0.18 }}
            >
              Clear
            </MotionButton>
          </div>
        </MotionIn>
      )}
      </motion.div>
    </>
  );
}
