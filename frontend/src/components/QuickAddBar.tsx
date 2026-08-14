import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from '@/components/animate-ui/motion';
import { EASE_SETTLE, EASE_SPRING, LAYOUT_TRANSITION, listItemVariants } from '@/components/animate-ui/motionTokens';
import MotionButton from './animate-ui/MotionButton';
import MotionIn from './animate-ui/MotionIn';
import Spinner from '@/components/animate-ui/Spinner';
import Icon from './Icon';
import TaskItem from './TaskItem';
import type { List, QuickAddSuggestion, Task } from '../types';
import { apiQuickAddItem, apiQuickAddPredict } from '../api/client';
import useAsyncData from '../hooks/useAsyncData';

/**
 * How long typing has to pause before the live hint is fetched. Long enough
 * that a normal typing burst is one request, short enough that the hint feels
 * like it's keeping up.
 */
const HINT_DEBOUNCE_MS = 260;

/** Below this many characters a prediction is noise — every board matches "a". */
const MIN_HINT_LENGTH = 3;

interface QuickAddBarProps {
  list: List;
  isMobile: boolean;
  /** Files an item into a real section (the accepted suggestion, or a manual pick). */
  onFileTask: (taskId: number, sectionId: string) => void;
  onToggleTask: (taskId: number) => void;
  onDeleteTask: (taskId: number) => void;
  onUpdateTask: (taskId: number, updates: Partial<Task>) => void;
  onRowClick: (task: Task) => void;
  /** A task was created in the tray — the screen adds it to its own state. */
  onStaged: (task: Task) => void;
  availableLists: List[];
  /** Drag support: the tray is a drop target for items dragged out of a section. */
  onDropIntoTray: () => void;
  draggingFromSection: boolean;
  onTaskDragStart: (taskId: number) => void;
  onTaskDragEnd: () => void;
}

/** The suggestion chip — one tap files the item and animates it away. */
function SuggestionChip({ suggestion, onAccept, primary }: { suggestion: QuickAddSuggestion; onAccept: () => void; primary: boolean }) {
  return (
    <MotionButton
      onClick={onAccept}
      title={suggestion.reason}
      initial={{ opacity: 0, y: -6, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      // No per-chip `exit`: the chips live inside a container that animates out
      // as one, so an individual exit would fight it.
      transition={{ duration: 0.2, ease: EASE_SPRING }}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600,
        color: primary ? 'var(--color-white)' : 'var(--color-primary)',
        background: primary ? 'var(--color-primary)' : 'var(--color-surface-tint)',
        border: `1px solid ${primary ? 'var(--color-primary)' : 'var(--color-purple-tint-6)'}`,
        borderRadius: 9999, padding: '6px 12px', cursor: 'pointer', whiteSpace: 'nowrap',
      }}>
      <Icon name="auto_awesome" size={13} color={primary ? 'var(--color-white)' : 'var(--color-primary)'} />
      Move to {suggestion.emoji ? `${suggestion.emoji} ` : ''}{suggestion.label}
    </MotionButton>
  );
}

export default function QuickAddBar({
  list, isMobile, onFileTask, onToggleTask, onDeleteTask, onUpdateTask, onRowClick, onStaged,
  availableLists, onDropIntoTray, draggingFromSection, onTaskDragStart, onTaskDragEnd,
}: QuickAddBarProps) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** The item just added, and where the predictor thinks it belongs. */
  const [pending, setPending] = useState<{ task: Task; suggestions: QuickAddSuggestion[] } | null>(null);
  /** The id currently flying into a section — drives the exit animation. */
  const [filing, setFiling] = useState<number | null>(null);
  const [trayHover, setTrayHover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const staged = list.stagedTasks ?? [];
  const trimmed = value.trim();
  const hasText = trimmed.length > 0;

  // Focus shortcut ("q") — deliberately separate from "i" (create-item), which
  // still focuses a section's own add field. Quick Add is the board's front
  // door; a section's field is for when you already know where it goes.
  useEffect(() => {
    const onFocusShortcut = () => inputRef.current?.focus();
    window.addEventListener('shortcut:quick-add', onFocusShortcut);
    return () => window.removeEventListener('shortcut:quick-add', onFocusShortcut);
  }, []);

  // Live hint while typing. `useAsyncData` owns the debounce, the cancellation
  // and the "discard a response whose key has moved on" rule — which matters
  // here more than anywhere: a slow early keystroke's response landing after a
  // fast later one would otherwise show a hint for text already replaced. The
  // key going null (too short, or the post-add chips took over) resets `hint`
  // to null by derivation, so nothing has to remember to clear it.
  const { data: hint, loading: hintLoading } = useAsyncData(
    !pending && trimmed.length >= MIN_HINT_LENGTH ? { listId: list.id, title: trimmed } : null,
    () => apiQuickAddPredict(list.id, trimmed, true).then((r) => r.suggestions[0] ?? null),
    null as QuickAddSuggestion | null,
    { debounceMs: HINT_DEBOUNCE_MS },
  );

  const submit = useCallback(async (): Promise<{ task: Task; suggestions: QuickAddSuggestion[] } | null> => {
    if (!trimmed || submitting) return null;
    setSubmitting(true);
    try {
      const res = await apiQuickAddItem(list.id, { title: trimmed });
      const task: Task = { ...res.task, id: Number(res.task.id) };
      onStaged(task);
      setValue('');
      setPending(res.suggestions.length > 0 ? { task, suggestions: res.suggestions } : null);
      return { task, suggestions: res.suggestions };
    } catch (e) {
      console.error('quick add failed', e);
      return null;
    } finally {
      setSubmitting(false);
    }
  }, [trimmed, submitting, list.id, onStaged]);

  /** Accept a suggestion: play the item out of the tray, then file it for real. */
  const accept = useCallback((taskId: number, sectionId: string) => {
    setFiling(taskId);
    setPending(null);
    // Let the exit animation run before the row leaves the tray's data — the
    // move itself is optimistic in the store, so the wait is purely visual.
    window.setTimeout(() => {
      onFileTask(taskId, sectionId);
      setFiling(null);
    }, 220);
  }, [onFileTask]);

  const dismiss = useCallback(() => setPending(null), []);

  return (
    <div
      data-quickadd-bar
      onDragOver={(e) => { if (draggingFromSection) { e.preventDefault(); setTrayHover(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTrayHover(false); }}
      onDrop={(e) => { if (draggingFromSection) { e.preventDefault(); setTrayHover(false); onDropIntoTray(); } }}
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      {/* Input */}
      <div style={{ position: 'relative' }}>
        <motion.div
          animate={{ borderColor: focused ? 'var(--color-primary)' : 'var(--color-border-strong)' }}
          transition={{ duration: 0.2 }}
          style={{ position: 'absolute', left: 14, top: '50%', y: '-50%', width: 18, height: 18, borderRadius: 4, borderWidth: 1.5, borderStyle: 'solid', pointerEvents: 'none' }} />
        <motion.input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && hasText) { e.preventDefault(); void submit(); }
            // Tab accepts the live hint outright — add the item AND file it
            // where the hint said, in one gesture, the way an editor's
            // autocomplete completes what you were clearly about to type.
            // Enter stays the deliberate path: add it, then choose.
            if (e.key === 'Tab' && hint && hasText && !e.shiftKey) {
              e.preventDefault();
              const hinted = hint.sectionId;
              void submit().then((res) => { if (res) accept(res.task.id, hinted); });
            }
            if (e.key === 'Escape') { setValue(''); setPending(null); (e.target as HTMLInputElement).blur(); }
          }}
          placeholder={isMobile ? 'Add new item…' : 'Add new item — it lands below, then move it where it belongs'}
          animate={{ paddingRight: hasText ? 48 : 16, outlineColor: focused ? 'rgba(var(--color-primary-rgb), 0.18)' : 'rgba(var(--color-primary-rgb), 0)' }}
          transition={{ outlineColor: { duration: 0.2 }, paddingRight: { duration: 0.18 } }}
          style={{
            width: '100%', background: 'var(--color-white)', border: 'none', borderRadius: 10,
            paddingTop: 13, paddingBottom: 13, paddingLeft: 42,
            fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-secondary)',
            outlineWidth: 2, outlineStyle: 'solid', outlineOffset: -1,
          }} />
        {hasText && (
          <MotionButton
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void submit()}
            disabled={submitting}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1, background: submitting ? 'var(--color-surface-tint)' : 'var(--color-primary)' }}
            transition={{ duration: 0.2, ease: EASE_SPRING }}
            style={{ position: 'absolute', right: 10, top: '50%', y: '-50%', width: 28, height: 28, borderRadius: '50%', border: 'none', cursor: submitting ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {submitting
              ? <Spinner size={14} thickness={2} durationMs={600} />
              : <Icon name="arrow_upward" size={16} color="var(--color-white)" />}
          </MotionButton>
        )}
      </div>

      {/* Live hint while typing — passive, states the prediction without acting on it. */}
      <AnimatePresence>
        {!pending && hasText && (hint || hintLoading) && (
          <MotionIn
            key="hint"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.16, ease: EASE_SETTLE }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 4px', fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
            {hintLoading && !hint ? (
              <>
                <Spinner size={11} thickness={1.6} durationMs={700} />
                Looking for where this usually goes…
              </>
            ) : hint ? (
              <>
                <Icon name="auto_awesome" size={13} color="var(--color-accent-purple-light)" />
                Looks like <strong style={{ color: 'var(--color-primary)', fontWeight: 600 }}>{hint.emoji ? `${hint.emoji} ` : ''}{hint.label}</strong>
                <span style={{ color: 'var(--color-text-quaternary)' }}>· {hint.reason}</span>
              </>
            ) : null}
          </MotionIn>
        )}
      </AnimatePresence>

      {/* Actionable suggestions for the item just added. */}
      <AnimatePresence>
        {pending && (
          <MotionIn
            key="suggestions"
            initial={{ opacity: 0, y: -6, height: 0 }}
            animate={{ opacity: 1, y: 0, height: 'auto' }}
            exit={{ opacity: 0, y: -6, height: 0 }}
            transition={{ duration: 0.2, ease: EASE_SETTLE }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '0 2px', overflow: 'hidden' }}>
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              “{pending.task.title}” →
            </span>
            {pending.suggestions.map((s, i) => (
              <SuggestionChip key={s.sectionId} suggestion={s} primary={i === 0} onAccept={() => accept(pending.task.id, s.sectionId)} />
            ))}
            <MotionButton
              onClick={dismiss}
              title="Leave it below for now"
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer' }}>
              <Icon name="close" size={14} color="var(--color-text-quaternary)" />
            </MotionButton>
          </MotionIn>
        )}
      </AnimatePresence>

      {/* The staging tray. Rendered whenever it holds anything, or while an item
          is being dragged toward it, so a drop target exists to aim at. */}
      <AnimatePresence initial={false}>
        {(staged.length > 0 || (draggingFromSection && trayHover)) && (
          <MotionIn
            key="tray"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2, ease: EASE_SETTLE }}
            style={{
              display: 'flex', flexDirection: 'column', gap: 2,
              background: 'var(--color-surface-gray)', borderRadius: 12,
              border: trayHover ? '1.5px solid var(--color-accent-purple-light)' : '1px dashed var(--color-border-alt)',
              boxShadow: trayHover ? '0 0 0 3px rgba(var(--color-accent-purple-light-rgb), 0.15)' : 'none',
              overflow: 'hidden',
            }}>
            {staged.length === 0 ? (
              <div style={{ padding: 16, textAlign: 'center', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-accent-purple-light)' }}>
                Drop here to unfile
              </div>
            ) : (
              <div style={{ padding: 4 }}>
                <AnimatePresence initial={false}>
                  {staged.map((task) => (
                    <motion.div
                      key={task.id}
                      layout="position"
                      variants={listItemVariants}
                      initial="initial"
                      animate="animate"
                      // An accepted suggestion sends the row toward the sections
                      // below rather than just fading — the motion is what makes
                      // "it went somewhere" legible.
                      exit={filing === task.id ? { opacity: 0, y: 24, scale: 0.96, transition: { duration: 0.22, ease: EASE_SETTLE } } : 'exit'}
                      transition={LAYOUT_TRANSITION}>
                      <TaskItem
                        task={{ ...task, _source: 'list' as const, _listId: list.id, _listName: list.name }}
                        onToggle={onToggleTask}
                        onDelete={onDeleteTask}
                        onUpdate={onUpdateTask}
                        onRowClick={onRowClick}
                        onDragStart={onTaskDragStart}
                        onDragEnd={onTaskDragEnd}
                        hideListBadge
                        availableLists={availableLists}
                        currentListId={list.id} />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            )}
          </MotionIn>
        )}
      </AnimatePresence>
    </div>
  );
}
