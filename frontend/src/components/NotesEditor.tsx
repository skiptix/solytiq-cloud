import { useState, useRef, useEffect, useCallback } from 'react';
import Icon from './Icon';
import CopyButton from './CopyButton';
import MarkdownView from './MarkdownView';
import MentionPopover from './MentionPopover';
import LinkPicker from './LinkPicker';
import PopIn from './animate-ui/PopIn';
import { toggleWrap, formatMarkerForKeyDown, type FormatMarker as Marker } from '../utils/textFormatting';
import { detectMention, applyMention, filterMentionMembers, type MentionMember, type MentionContext } from '../utils/mention';
import { detectLinkTrigger, applyLinkToken, type LinkTriggerContext } from '../utils/linkTrigger';
import { useEntitySearch } from '../hooks/useEntitySearch';
import useAIStore from '../store/useAIStore';
import { apiGetAISettings, apiAIChat } from '../api/client';
import type { EntityIndexEntry } from '../types';
import MotionButton from './animate-ui/MotionButton';

// ── Shared Notes editor ─────────────────────────────────────────────────────
// Used by the item dialog (TaskDialog) and the milestone editor so both get
// identical behavior:
//   • ⌘/Ctrl+B → **bold**, ⌘/Ctrl+I → *italic*, ⌘/Ctrl+Shift+X (or S) →
//     ~~strikethrough~~ on the current selection (toggle: applies or removes),
//     plus a small B / I / S toolbar for discoverability.
//   • Notes are always treated as Markdown. A Write / Preview switch lets the
//     user flip between the raw source and the rendered (MarkdownView) form;
//     it opens on Preview by default.
//   • Optionally (when `aiContext` is passed) a tiny "Ask AI" button that
//     drafts/edits the note in one shot, given full context of the item it
//     belongs to — see AiAssistButton below.

/** Full context of the item this note belongs to, so the AI drafts something
 *  actually relevant instead of just riffing on the note text alone. */
export interface NoteAIContext {
  kind: 'task' | 'milestone';
  title: string;
  /** Extra item properties to show the model, e.g. { Deadline: '2026-07-20', Priority: 'High' }. */
  fields?: Record<string, string | undefined>;
}

const EMPTY_NOTE_ACTIONS = [
  { label: 'Draft a note', instruction: 'Write a helpful first draft for this note, based on the context above.' },
  { label: 'Suggest next steps', instruction: 'Suggest 3-5 concrete next steps and write them as a Markdown bullet list.' },
  { label: 'Brainstorm ideas', instruction: 'Brainstorm 5 relevant ideas and write them as a Markdown bullet list.' },
];
const FILLED_NOTE_ACTIONS = [
  { label: 'Summarize', instruction: 'Summarize the note below into 2-3 concise sentences.' },
  { label: 'Improve writing', instruction: 'Improve the writing — fix grammar, clarity, and tone — while keeping the same meaning and level of detail.' },
  { label: 'Expand', instruction: 'Expand the note below with more detail and concrete specifics.' },
  { label: 'Make concise', instruction: 'Make the note below more concise without losing important information.' },
];

function buildNoteAssistSystemPrompt(ctx: NoteAIContext, currentValue: string): string {
  const fieldLines = Object.entries(ctx.fields ?? {})
    .filter((entry): entry is [string, string] => !!entry[1])
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');
  return [
    `You are a writing assistant embedded directly in the Notes field of a ${ctx.kind} called "${ctx.title || 'Untitled'}" inside Solytiq Cloud, a task/project management app.`,
    fieldLines ? `Other properties of this ${ctx.kind}, for context:\n${fieldLines}` : '',
    `Current note text (Markdown, may be empty):\n"""\n${currentValue.trim() || '(empty)'}\n"""`,
    `Follow the user's instruction below and reply with ONLY the new note text, written in Markdown. No commentary, no code fences, no preamble, no surrounding quotes — your entire reply replaces the note as-is.`,
  ].filter(Boolean).join('\n\n');
}

interface AiAssistButtonProps {
  aiContext: NoteAIContext;
  value: string;
  onApply: (text: string) => void;
}

function AiAssistButton({ aiContext, value, onApply }: AiAssistButtonProps) {
  const { settings, settingsLoaded, setSettings, setSettingsLoaded } = useAIStore();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (settingsLoaded) return;
    apiGetAISettings().then((d) => { setSettings(d); setSettingsLoaded(true); }).catch(() => setSettingsLoaded(true));
  }, [settingsLoaded, setSettings, setSettingsLoaded]);

  const runAction = async (instruction: string) => {
    setLoading(true);
    setError('');
    try {
      const system = buildNoteAssistSystemPrompt(aiContext, value);
      const res = await apiAIChat([
        { role: 'system', content: system },
        { role: 'user', content: instruction },
      ]);
      const text = res.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error('Empty response');
      onApply(text);
      setOpen(false);
      setPrompt('');
    } catch {
      setError('Something went wrong — please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (!settings.enabled) return null;
  const actions = value.trim() ? FILLED_NOTE_ACTIONS : EMPTY_NOTE_ACTIONS;

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <MotionButton
        type="button"
        title="Ask AI"
        onClick={() => setOpen((o) => !o)}
        transition={{ duration: 0.12 }} style={{ display: 'flex', alignItems: 'center', gap: 4, height: 26, padding: '0 9px', borderRadius: 7, border: `1px solid ${open ? 'var(--color-primary)' : 'var(--color-purple-pale-23)'}`, background: open ? 'var(--color-surface-tint)' : 'transparent', cursor: 'pointer', }}>
        <Icon name="auto_awesome" size={14} color="var(--color-primary)" />
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 600, color: 'var(--color-primary)' }}>Ask AI</span>
      </MotionButton>

      {open && (
        <PopIn duration={140} style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 60, width: Math.min(280, window.innerWidth - 32), background: 'var(--color-white)', border: '1px solid var(--color-border)', borderRadius: 12, boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.16)', padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 700, color: 'var(--color-text-primary)' }}>Ask AI about this note</span>
            <button type="button" onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 2 }}>
              <Icon name="close" size={14} color="var(--color-text-quaternary)" />
            </button>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {actions.map((a) => (
              <button key={a.label} type="button" disabled={loading} onClick={() => void runAction(a.instruction)}
                style={{ padding: '4px 10px', borderRadius: 9999, border: '1px solid var(--color-purple-pale-23)', background: 'var(--color-purple-pale-7)', cursor: loading ? 'default' : 'pointer', fontFamily: 'var(--font-body)', fontSize: 11.5, fontWeight: 600, color: 'var(--color-primary)', opacity: loading ? 0.5 : 1 }}>
                {a.label}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && prompt.trim() && !loading) void runAction(prompt.trim()); }}
              disabled={loading}
              placeholder="Or type your own instruction…"
              style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 12.5, border: '1.5px solid var(--color-border)', borderRadius: 8, padding: '7px 9px', outline: 'none', minWidth: 0 }}
            />
            <button type="button" disabled={loading || !prompt.trim()} onClick={() => void runAction(prompt.trim())}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, borderRadius: 8, border: 'none', background: loading || !prompt.trim() ? 'var(--color-border-strong)' : 'var(--color-primary)', cursor: loading || !prompt.trim() ? 'default' : 'pointer', flexShrink: 0 }}>
              <Icon name={loading ? 'progress_activity' : 'arrow_upward'} size={15} color="var(--color-white)" />
            </button>
          </div>

          {error && <div style={{ marginTop: 8, fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-error)' }}>{error}</div>}
        </PopIn>
      )}
    </div>
  );
}

interface NotesEditorProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  minHeight?: number;
  /** When provided, shows a tiny "Ask AI" button scoped to this item's full context. */
  aiContext?: NoteAIContext;
  /** Workspace members that can be @-mentioned. Enables the mention typeahead. */
  mentionMembers?: MentionMember[];
}

export default function NotesEditor({ value, onChange, placeholder = 'Add notes, context, or any details…', minHeight = 120, aiContext, mentionMembers }: NotesEditorProps) {
  const [tab, setTab] = useState<'write' | 'preview'>('preview');
  const taRef = useRef<HTMLTextAreaElement>(null);

  // @-mention typeahead state (only active when mentionMembers is provided).
  const [mention, setMention] = useState<MentionContext | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionCandidates = mention && mentionMembers?.length
    ? filterMentionMembers(mentionMembers, mention.query)
    : [];
  const mentionActive = mention !== null && mentionCandidates.length > 0;

  // `[[` inline-link typeahead state — always available (unlike @-mentions it
  // needs no member list; the LinkPicker does its own async entity_index
  // search). Mutually exclusive with the mention popover: only one trigger
  // can be "at" the caret at a time.
  const [linkTrigger, setLinkTrigger] = useState<LinkTriggerContext | null>(null);
  const [linkIndex, setLinkIndex] = useState(0);
  const { results: linkResults, loading: linkLoading } = useEntitySearch(linkTrigger?.query ?? '');
  const linkTriggerActive = linkTrigger !== null;

  // Snapshot of the note right before an AI-generated replacement, so a quick
  // "Undo" is available without forcing the user to Cancel the whole dialog.
  const [undoNote, setUndoNote] = useState<string | null>(null);

  const resize = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => { if (tab === 'write') resize(); }, [tab, resize]);

  const applyFormat = (marker: Marker) => {
    const el = taRef.current;
    if (!el) return;
    const { next, selStart, selEnd } = toggleWrap(value, el.selectionStart ?? 0, el.selectionEnd ?? 0, marker);
    onChange(next);
    requestAnimationFrame(() => {
      const now = taRef.current;
      if (!now) return;
      now.focus();
      now.setSelectionRange(selStart, selEnd);
      resize();
    });
  };

  // Recompute mention context from the textarea's current value + caret.
  const refreshMention = (el: HTMLTextAreaElement) => {
    if (!mentionMembers?.length) { if (mention) setMention(null); return; }
    const ctx = detectMention(el.value, el.selectionStart ?? 0);
    setMention(ctx);
    setMentionIndex(0);
  };

  const pickMention = (m: MentionMember) => {
    const el = taRef.current;
    if (!el || !mention) return;
    const caret = el.selectionStart ?? el.value.length;
    const { value: nextVal, caret: nextCaret } = applyMention(value, mention.at, caret, m.username);
    onChange(nextVal);
    setUndoNote(null);
    setMention(null);
    requestAnimationFrame(() => {
      const now = taRef.current;
      if (!now) return;
      now.focus();
      now.setSelectionRange(nextCaret, nextCaret);
      resize();
    });
  };

  // Recompute the `[[` link-trigger context from the textarea's current value + caret.
  const refreshLinkTrigger = (el: HTMLTextAreaElement) => {
    const ctx = detectLinkTrigger(el.value, el.selectionStart ?? 0);
    setLinkTrigger(ctx);
    setLinkIndex(0);
  };

  const pickLink = (entity: EntityIndexEntry) => {
    const el = taRef.current;
    if (!el || !linkTrigger) return;
    const caret = el.selectionStart ?? el.value.length;
    const { value: nextVal, caret: nextCaret } = applyLinkToken(value, linkTrigger.at, caret, entity);
    onChange(nextVal);
    setUndoNote(null);
    setLinkTrigger(null);
    requestAnimationFrame(() => {
      const now = taRef.current;
      if (!now) return;
      now.focus();
      now.setSelectionRange(nextCaret, nextCaret);
      resize();
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionActive) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex(i => (i + 1) % mentionCandidates.length); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setMentionIndex(i => (i - 1 + mentionCandidates.length) % mentionCandidates.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionCandidates[mentionIndex]); return; }
      if (e.key === 'Escape')    { e.preventDefault(); setMention(null); return; }
    }
    if (linkTriggerActive && linkResults.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setLinkIndex(i => (i + 1) % linkResults.length); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setLinkIndex(i => (i - 1 + linkResults.length) % linkResults.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickLink(linkResults[linkIndex]); return; }
    }
    if (linkTriggerActive && e.key === 'Escape') { e.preventDefault(); setLinkTrigger(null); return; }
    const marker = formatMarkerForKeyDown(e);
    if (marker) { e.preventDefault(); applyFormat(marker); }
  };

  const showPreview = tab === 'preview';
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
  const mod = isMac ? '⌘' : 'Ctrl+';

  const fmtBtn = (icon: string, title: string, marker: Marker) => (
    <MotionButton
      type="button"
      title={title}
      disabled={showPreview}
      onMouseDown={e => e.preventDefault() /* keep the textarea selection */}
      onClick={() => applyFormat(marker)}
      transition={{ duration: 0.12 }} style={{ width: 26, height: 26, borderRadius: 7, border: 'none', background: 'transparent', cursor: showPreview ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: showPreview ? 0.35 : 1, }}
      onMouseEnter={e => { if (!showPreview) e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
      <Icon name={icon} size={16} color="var(--color-text-tertiary)" />
    </MotionButton>
  );

  return (
    <div>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, color: 'var(--color-border-strong)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Notes</div>
          <div style={{ display: 'inline-flex', background: 'var(--color-surface-tint-3)', border: '1px solid var(--color-purple-pale-23)', borderRadius: 8, padding: 2 }}>
            {(['write', 'preview'] as const).map(t => (
              <MotionButton
                key={t}
                type="button"
                onClick={() => setTab(t)}
                transition={{ duration: 0.12 }} style={{ padding: '3px 10px', borderRadius: 6, border: 'none', background: tab === t ? 'var(--color-white)' : 'transparent', boxShadow: tab === t ? '0 1px 3px rgba(var(--color-black-rgb), 0.08)' : 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: tab === t ? 'var(--color-primary)' : 'var(--color-text-tertiary)', textTransform: 'capitalize' }}>
                {t}
              </MotionButton>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {undoNote !== null && (
            <button type="button" onClick={() => { onChange(undoNote); setUndoNote(null); }}
              style={{ display: 'flex', alignItems: 'center', gap: 4, height: 26, padding: '0 9px', borderRadius: 7, border: '1px solid var(--color-purple-pale-23)', background: 'transparent', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 600, color: 'var(--color-text-tertiary)' }}>
              <Icon name="undo" size={13} color="var(--color-text-tertiary)" /> Undo AI edit
            </button>
          )}
          {aiContext && (
            <AiAssistButton aiContext={aiContext} value={value} onApply={(text) => { setUndoNote(value); onChange(text); }} />
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            {fmtBtn('format_bold', `Bold (${mod}B)`, '**')}
            {fmtBtn('format_italic', `Italic (${mod}I)`, '*')}
            {fmtBtn('strikethrough_s', `Strikethrough (${mod}⇧X)`, '~~')}
          </div>
          {value.trim() && <div><CopyButton text={value} title="Copy notes to clipboard" /></div>}
        </div>
      </div>

      {/* Body */}
      {showPreview ? (
        <div style={{ minHeight, padding: '2px 0' }}>
          {value.trim()
            ? <MarkdownView source={value} />
            : <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)', fontStyle: 'italic' }}>Nothing to preview yet.</div>}
        </div>
      ) : (
        <div style={{ position: 'relative' }}>
          <textarea
            ref={taRef}
            value={value}
            onChange={e => { onChange(e.target.value); setUndoNote(null); resize(); refreshMention(e.target); refreshLinkTrigger(e.target); }}
            onKeyDown={onKeyDown}
            onClick={e => { refreshMention(e.currentTarget); refreshLinkTrigger(e.currentTarget); }}
            onBlur={() => { /* let the popover's own mousedown handler pick first */ setTimeout(() => { setMention(null); setLinkTrigger(null); }, 120); }}
            placeholder={mentionMembers?.length ? `${placeholder}  •  type @ to tag someone, [[ to link` : `${placeholder}  •  type [[ to link`}
            style={{
              width: '100%', fontFamily: 'var(--font-mono)',
              fontSize: 13, color: 'var(--color-text-secondary)',
              background: 'transparent', border: 'none', outline: 'none', resize: 'none',
              lineHeight: 1.75, padding: 0, overflowY: 'hidden', minHeight,
            }}
            rows={4}
          />
          {mentionActive && (() => {
            // Anchor below the field by default, but flip above when the field's
            // bottom is close to the viewport bottom so the list stays on-screen
            // (e.g. inside the scroll-bounded TaskDialog body).
            const rect = taRef.current?.getBoundingClientRect();
            const flipUp = !!rect && rect.bottom + 252 > window.innerHeight;
            return (
              <MentionPopover
                members={mentionCandidates}
                activeIndex={mentionIndex}
                onPick={pickMention}
                onHover={setMentionIndex}
                style={flipUp ? { bottom: 'calc(100% + 4px)', left: 0 } : { top: 'calc(100% + 4px)', left: 0 }}
              />
            );
          })()}
          {!mentionActive && linkTriggerActive && (() => {
            const rect = taRef.current?.getBoundingClientRect();
            const flipUp = !!rect && rect.bottom + 300 > window.innerHeight;
            return (
              <LinkPicker
                query={linkTrigger!.query}
                results={linkResults}
                loading={linkLoading}
                activeIndex={linkIndex}
                onPick={pickLink}
                onHover={setLinkIndex}
                style={flipUp ? { bottom: 'calc(100% + 4px)', left: 0 } : { top: 'calc(100% + 4px)', left: 0 }}
              />
            );
          })()}
        </div>
      )}
    </div>
  );
}
