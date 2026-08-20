import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { AnimatePresence, motion, useReducedMotion } from '@/components/animate-ui/motion';
import { EASE_SETTLE, EASE_SPRING, EASE_STANDARD, backdropVariants } from '@/components/animate-ui/motionTokens';
import type { AIChatMessage, AISession } from '../../store/useAIStore';
import type { AIFile } from '../../types';
import Icon from '../Icon';
import Spinner from '@/components/animate-ui/Spinner';
import MotionButton from '../animate-ui/MotionButton';
import MotionIn from '../animate-ui/MotionIn';
import AIRecentChats from './AIRecentChats';
import { useAIFileUpload, formatFileSize, fileIcon, FILE_INPUT_ACCEPT } from './useAIFileUpload';
import { useVisualViewport } from '../../hooks/useVisualViewport';
import { useLockBodyScroll } from '../../hooks/useLockBodyScroll';

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
  isMobile: boolean;
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

/**
 * Sol's chat surface on BOTH platforms: no card, no header bar — replies
 * float as speech bubbles directly over a blurred backdrop, the way a
 * phone's own messaging app looks, with the input pinned as a floating pill
 * near the bottom instead of a footer strip. Desktop differs only in degree,
 * not in kind: a capped content width so lines don't stretch across a wide
 * monitor, an "X" instead of a swipe-down chevron to close, and small
 * history/clear-chat icons next to it (mobile is one ephemeral conversation
 * by design — see the History/clear icons below).
 */
export default function AIChatOverlay({
  messages, isThinking, contextView, onSend, onClose, onClearHistory,
  onShowRecentChats, showRecentChats, recentSessions, onSelectSession, onDeleteSession, onCloseRecentChats,
  uploadedFiles, onAddFile, onRemoveFile, sessionId, isMobile,
}: Props) {
  const [input, setInput] = useState('');
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { uploadingFiles, uploadError, uploadFiles, handleRemoveFile } = useAIFileUpload({ sessionId, onAddFile, onRemoveFile });
  // The overlay opens WITHOUT focusing the input — tapping the badge should
  // only ever reveal the input, never pop the keyboard open on its own.
  // Typing starts on its own deliberate tap, same as tapping a suggestion
  // chip below (which does focus — picking one is exactly that deliberate
  // "I want to type/send now" gesture).
  const { height: viewportHeight, top: viewportTop } = useVisualViewport();
  // Nothing behind this overlay should be scrollable while it's open — on
  // iOS this also stops the browser's own "scroll the page to reveal the
  // focused input" behavior from fighting with useVisualViewport's own
  // resize handling, which is what made focusing the input feel like a
  // janky double-scroll instead of the keyboard just sliding the input up.
  useLockBodyScroll();

  // True once the visible viewport has shrunk meaningfully below the page's
  // own height — i.e. the on-screen keyboard is up. Only really fires on
  // mobile; desktop has no software keyboard to shrink anything.
  const keyboardOpen = viewportHeight < window.innerHeight - 40;

  // Re-pins to the latest message on a new message AND whenever the visible
  // viewport height changes — the keyboard opening shrinks it, and without
  // this the most recent bubble (and the input sitting right above the
  // keyboard) could end up scrolled out of view above the fold.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, viewportHeight]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isThinking) return;
    setInput('');
    onSend(text);
  }, [input, isThinking, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFilePickerChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    await uploadFiles(Array.from(e.target.files ?? []));
    e.target.value = '';
  }, [uploadFiles]);

  const hasFiles = uploadedFiles.length > 0 || uploadingFiles.length > 0;

  // Desktop has the room for a third starter prompt (the file-drop hint);
  // mobile's screen is too narrow above the keyboard for three chips.
  const suggestions = [
    contextView === 'list' ? 'Add a task to the first section' : 'Add a task called "Weekly review"',
    contextView === 'calendar' ? 'Schedule the top priority task for tomorrow' : 'Mark all overdue tasks as done',
    ...(isMobile ? [] : ["Drop a PDF here and I'll create todos from it"]),
  ];

  const contentMaxWidth = isMobile ? undefined : 640;

  return (
    <>
      <motion.div
        onClick={onClose}
        variants={backdropVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(var(--color-black-rgb), 0.45)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          zIndex: 9000,
        }}
      />

      {/* The content layer covers the VISIBLE viewport (not the full layout
          viewport `inset:0` would use) so its children can be laid out with
          plain flexbox, but it never captures a tap itself — only the actual
          floating pieces (close button, messages, input) opt back in via
          pointerEvents:'auto'. That's what makes tapping any bare patch of
          blurred background dismiss the sheet without a maze of
          onClick/stopPropagation on every bubble and chip.
          `top`/`height` come from useVisualViewport rather than `inset: 0`:
          iOS Safari's on-screen keyboard shrinks the visual viewport without
          shrinking the layout viewport `inset: 0` sizes against, so a plain
          full-inset box would keep its original height with its bottom
          portion — the input bar included — rendered underneath the
          keyboard. Sizing to the actual visible area keeps the whole column
          above it instead, and animating the change (rather than snapping)
          is what makes the input read as sliding up with the keyboard
          instead of jumping. */}
      <motion.div
        animate={{ top: viewportTop, height: viewportHeight }}
        transition={{ duration: 0.25, ease: EASE_STANDARD }}
        style={{ position: 'fixed', left: 0, right: 0, zIndex: 9001, display: 'flex', flexDirection: 'column', pointerEvents: 'none' }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, paddingTop: 'calc(env(safe-area-inset-top, 0px) + 14px)', pointerEvents: 'auto' }}>
          {!isMobile && (
            <MotionButton
              onClick={onShowRecentChats}
              title="Recent chats"
              whileHover={{ background: 'rgba(var(--color-white-rgb), 1)', scale: 1.06 }}
              transition={{ duration: 0.18 }}
              style={{
                width: 36, height: 36, borderRadius: '50%', border: '1px solid rgba(var(--color-black-rgb), 0.06)',
                background: 'rgba(var(--color-white-rgb), 0.9)', boxShadow: '0 4px 16px rgba(var(--color-black-rgb), 0.16)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
              }}
            >
              <Icon name="history" size={17} color="var(--color-text-secondary)" />
            </MotionButton>
          )}
          {/* Raw motion.button (not MotionButton) — this one needs an `exit`
              target for AnimatePresence, which MotionButton's prop surface
              deliberately doesn't expose (see its own header comment). */}
          <motion.button
            onClick={onClose}
            aria-label="Close chat"
            initial={{ opacity: 0, y: -10, scale: 0.8 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            whileTap={{ scale: 0.92 }}
            transition={{ duration: 0.22, ease: EASE_SPRING }}
            style={{
              width: 36, height: 36, borderRadius: '50%', border: '1px solid rgba(var(--color-black-rgb), 0.06)',
              background: 'rgba(var(--color-white-rgb), 0.9)',
              boxShadow: '0 4px 16px rgba(var(--color-black-rgb), 0.16)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            }}
          >
            <Icon name={isMobile ? 'keyboard_arrow_down' : 'close'} size={isMobile ? 20 : 17} color="var(--color-text-secondary)" />
          </motion.button>
          {!isMobile && (
            <MotionButton
              onClick={() => setShowClearConfirm(true)}
              title="Clear chat"
              whileHover={{ background: 'rgba(var(--color-white-rgb), 1)', scale: 1.06 }}
              transition={{ duration: 0.18 }}
              style={{
                width: 36, height: 36, borderRadius: '50%', border: '1px solid rgba(var(--color-black-rgb), 0.06)',
                background: 'rgba(var(--color-white-rgb), 0.9)', boxShadow: '0 4px 16px rgba(var(--color-black-rgb), 0.16)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
              }}
            >
              <Icon name="delete_sweep" size={16} color="var(--color-text-secondary)" />
            </MotionButton>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, width: '100%', maxWidth: contentMaxWidth, margin: '0 auto' }}>
          {/* Messages — floating bubbles, newest at the bottom, empty space
              above so a short conversation still sits near the input rather
              than pinned to the top of the screen. */}
          <div
            ref={scrollRef}
            style={{
              flex: 1, minHeight: 0, overflowY: 'auto', pointerEvents: 'auto',
              padding: '8px 16px 4px',
              display: 'flex', flexDirection: 'column',
              justifyContent: messages.length === 0 ? 'flex-end' : 'flex-start',
            }}
          >
            <AnimatePresence initial={false}>
              {messages.map((msg) => (
                <motion.div
                  key={msg.id}
                  layout="position"
                  initial={{ opacity: 0, y: 18, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.32, ease: EASE_SPRING }}
                >
                  {msg.role === 'user' ? <UserMessage msg={msg} /> : <AssistantMessage msg={msg} />}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          {/* Starter chips — only before the first message, gone for good the
              moment the conversation actually starts. */}
          {messages.length === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 16px 10px', pointerEvents: 'auto' }}>
              {suggestions.map((hint, i) => (
                <motion.button
                  key={hint}
                  onClick={() => { setInput(hint); inputRef.current?.focus(); }}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  whileTap={{ scale: 0.97 }}
                  transition={{ duration: 0.3, delay: (i * 70) / 1000, ease: EASE_STANDARD }}
                  style={{
                    alignSelf: 'flex-start', maxWidth: '82%', border: '1px solid rgba(var(--color-primary-rgb), 0.16)',
                    fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-primary)',
                    background: 'rgba(var(--color-white-rgb), 0.88)', backdropFilter: 'blur(6px)',
                    borderRadius: 14,
                    padding: '8px 13px', textAlign: 'left', cursor: 'pointer',
                    boxShadow: '0 4px 14px rgba(var(--color-black-rgb), 0.08)',
                  }}
                >
                  {hint}
                </motion.button>
              ))}
            </div>
          )}

          {/* File chips */}
          {hasFiles && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 16px 8px', pointerEvents: 'auto' }}>
              {uploadedFiles.map((f) => (
                <MotionIn
                  key={f.id}
                  initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: EASE_STANDARD }}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    background: 'rgba(var(--color-white-rgb), 0.9)', backdropFilter: 'blur(6px)',
                    border: '1px solid rgba(var(--color-primary-rgb), 0.2)', borderRadius: 10,
                    padding: '4px 6px 4px 8px', fontFamily: 'var(--font-body)', fontSize: 11.5,
                    color: 'var(--color-primary)', fontWeight: 500, maxWidth: 160,
                    boxShadow: '0 2px 8px rgba(var(--color-black-rgb), 0.06)',
                  }}
                >
                  <Icon name={fileIcon(f.mimeType, f.filename)} size={12} color="var(--color-purple-mid-1)" />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 90 }}>{f.filename}</span>
                  <span style={{ color: 'var(--color-accent-purple-light)', fontSize: 10, flexShrink: 0 }}>{formatFileSize(f.size)}</span>
                  <MotionButton
                    onClick={() => handleRemoveFile(f.id)}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', cursor: 'pointer', padding: 2, borderRadius: 4, flexShrink: 0 }}
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
                  initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: EASE_STANDARD }}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    background: 'rgba(var(--color-white-rgb), 0.9)', backdropFilter: 'blur(6px)',
                    border: '1px solid rgba(var(--color-primary-rgb), 0.15)', borderRadius: 10,
                    padding: '4px 8px', fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-accent-purple-light)', maxWidth: 160,
                  }}
                >
                  <Spinner size={11} thickness={2} durationMs={600} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name} · {u.progress}%</span>
                </MotionIn>
              ))}
            </div>
          )}

          {uploadError && (
            <MotionIn
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: EASE_STANDARD }}
              style={{
                margin: '0 16px 8px', padding: '6px 10px', borderRadius: 10, pointerEvents: 'auto',
                background: 'rgba(var(--color-white-rgb), 0.92)', border: '1px solid var(--color-error-bg)',
                fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-error)',
                display: 'flex', alignItems: 'center', gap: 5,
              }}
            >
              <Icon name="error" size={12} color="var(--color-error)" />
              {uploadError}
            </MotionIn>
          )}

          {/* Input — a floating pill, not a footer strip. No extra safe-area
              clearance once the keyboard is open: the keyboard already
              covers the home-indicator area that padding exists for, so
              keeping it would just leave a gap between the input and the
              keyboard instead of sitting flush above it. */}
          <div style={{ padding: `0 12px ${keyboardOpen ? '14px' : 'calc(env(safe-area-inset-bottom, 0px) + 14px)'}`, pointerEvents: 'auto' }}>
            <MotionIn
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 16 }}
              transition={{ duration: 0.3, ease: EASE_SETTLE }}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: 'var(--color-white)', borderRadius: 24,
                padding: '6px 6px 6px 6px',
                boxShadow: '0 12px 36px rgba(var(--color-black-rgb), 0.22)',
                border: '1px solid rgba(var(--color-primary-rgb), 0.1)',
              }}
            >
              <button
                onClick={() => fileInputRef.current?.click()}
                title="Attach file"
                disabled={isThinking}
                style={{
                  width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                  background: 'none', border: 'none', cursor: isThinking ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  opacity: isThinking ? 0.4 : 1,
                }}
              >
                <Icon name="attach_file" size={17} color="var(--color-accent-purple-light)" />
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
                  flex: 1, fontFamily: 'var(--font-body)', fontSize: 14.5, color: 'var(--color-text-primary)',
                  background: 'transparent', border: 'none', outline: 'none', resize: 'none',
                  lineHeight: 1.4, maxHeight: 90, overflowY: 'auto', padding: '7px 2px',
                  opacity: isThinking ? 0.5 : 1,
                }}
                onInput={(e) => {
                  const t = e.currentTarget;
                  t.style.height = 'auto';
                  t.style.height = `${Math.min(t.scrollHeight, 90)}px`;
                }}
              />
              <MotionButton
                onClick={handleSend}
                disabled={!input.trim() || isThinking}
                animate={{
                  background: !input.trim() || isThinking ? 'var(--color-border)' : 'linear-gradient(135deg, var(--color-purple-mid-8) 0%, var(--color-purple-mid-13) 100%)',
                  scale: !input.trim() || isThinking ? 0.95 : 1,
                }}
                transition={{ duration: 0.16 }}
                style={{
                  width: 34, height: 34, borderRadius: '50%', flexShrink: 0, border: 'none',
                  cursor: !input.trim() || isThinking ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                {isThinking
                  ? <Spinner size={15} thickness={2} durationMs={600} />
                  : <Icon name="arrow_upward" size={16} color={!input.trim() ? 'var(--color-text-quaternary)' : 'var(--color-white)'} />}
              </MotionButton>
            </MotionIn>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={FILE_INPUT_ACCEPT}
          style={{ display: 'none' }}
          onChange={handleFilePickerChange}
        />
      </motion.div>

      {/* Recent chats — desktop only (see the header comment above). Floats
          as its own card over the same blur rather than living inside a
          window, since there's no window anymore. */}
      {!isMobile && showRecentChats && (
        <div
          style={{
            position: 'fixed', top: '50%', left: '50%', translate: '-50% -50%',
            width: Math.min(380, window.innerWidth - 32), height: Math.min(560, window.innerHeight - 100),
            zIndex: 9002, pointerEvents: 'auto', borderRadius: 20,
            boxShadow: '0 20px 60px rgba(var(--color-black-rgb), 0.32)',
          }}
        >
          <AIRecentChats sessions={recentSessions} onSelect={onSelectSession} onDelete={onDeleteSession} onClose={onCloseRecentChats} />
        </div>
      )}

      {/* Clear history confirmation — desktop only, same reasoning. */}
      {!isMobile && showClearConfirm && (
        <MotionIn
          initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.2, ease: EASE_STANDARD }}
          style={{
            position: 'fixed', top: '50%', left: '50%', translate: '-50% -50%',
            width: Math.min(340, window.innerWidth - 48),
            zIndex: 9002, pointerEvents: 'auto',
            background: 'var(--color-white)', borderRadius: 20, boxShadow: '0 20px 60px rgba(var(--color-black-rgb), 0.32)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: 24,
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
              whileHover={{ background: 'var(--color-border)', scale: 1.02 }}
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
              whileHover={{ background: 'var(--color-red-deep-2)', scale: 1.02 }}
              transition={{ duration: 0.18 }}
            >
              Clear
            </MotionButton>
          </div>
        </MotionIn>
      )}
    </>
  );
}
