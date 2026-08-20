import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from '@/components/animate-ui/motion';
import { EASE_SETTLE, EASE_SPRING, EASE_STANDARD, backdropVariants } from '@/components/animate-ui/motionTokens';
import type { AIChatMessage } from '../../store/useAIStore';
import type { AIFile } from '../../types';
import Icon from '../Icon';
import Spinner from '@/components/animate-ui/Spinner';
import MotionButton from '../animate-ui/MotionButton';
import MotionIn from '../animate-ui/MotionIn';
import { UserMessage, AssistantMessage } from './AIChatWindow';
import { useAIFileUpload, formatFileSize, fileIcon, FILE_INPUT_ACCEPT } from './useAIFileUpload';
import { useVisualViewport } from '../../hooks/useVisualViewport';

interface Props {
  messages: AIChatMessage[];
  isThinking: boolean;
  contextView: string;
  onSend: (text: string) => void;
  onClose: () => void;
  uploadedFiles: AIFile[];
  onAddFile: (file: AIFile) => void;
  onRemoveFile: (id: string) => void;
  sessionId: string | null;
}

/**
 * Mobile's answer to AIChatWindow: no card, no header bar — Sol's replies
 * float as speech bubbles directly over a blurred backdrop, the way a phone's
 * own messaging app looks, with the input pinned as a floating pill near the
 * bottom instead of a footer strip. Deliberately a SEPARATE component rather
 * than another isMobile branch inside AIChatWindow — the two no longer share
 * a layout shape (window vs. no window at all), only the message bubbles
 * themselves (UserMessage/AssistantMessage, imported from there) and the file
 * upload plumbing (useAIFileUpload) are actually common code.
 *
 * No session history/switcher here by design — mobile is one ephemeral
 * conversation at a time; the full history lives in the desktop window.
 */
export default function AIMobileChat({ messages, isThinking, contextView, onSend, onClose, uploadedFiles, onAddFile, onRemoveFile, sessionId }: Props) {
  const [input, setInput] = useState('');
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

  // Same starter prompts as the desktop empty state, trimmed to the two that
  // matter most floating as chips — a third would crowd the small strip of
  // room above the keyboard.
  const suggestions = [
    contextView === 'list' ? 'Add a task to the first section' : 'Add a task called "Weekly review"',
    contextView === 'calendar' ? 'Schedule the top priority task for tomorrow' : 'Mark all overdue tasks as done',
  ];

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
          (and the input specifically) above it instead. */}
      <div style={{ position: 'fixed', left: 0, right: 0, top: viewportTop, height: viewportHeight, zIndex: 9001, display: 'flex', flexDirection: 'column', pointerEvents: 'none' }}>
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 'calc(env(safe-area-inset-top, 0px) + 14px)', pointerEvents: 'auto' }}>
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
            <Icon name="keyboard_arrow_down" size={20} color="var(--color-text-secondary)" />
          </motion.button>
        </div>

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

        {/* Input — a floating pill, not a footer strip */}
        <div style={{ padding: '0 12px calc(env(safe-area-inset-bottom, 0px) + 14px)', pointerEvents: 'auto' }}>
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

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={FILE_INPUT_ACCEPT}
          style={{ display: 'none' }}
          onChange={handleFilePickerChange}
        />
      </div>
    </>
  );
}
