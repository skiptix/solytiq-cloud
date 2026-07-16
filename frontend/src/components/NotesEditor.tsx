import { useState, useRef, useEffect, useCallback } from 'react';
import Icon from './Icon';
import CopyButton from './CopyButton';
import MarkdownView from './MarkdownView';
import { toggleWrap, formatMarkerForKeyDown, type FormatMarker as Marker } from '../utils/textFormatting';
import useAIStore from '../store/useAIStore';
import { apiGetAISettings, apiAIChat } from '../api/client';

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
      <button
        type="button"
        title="Ask AI"
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 4, height: 26, padding: '0 9px', borderRadius: 7, border: `1px solid ${open ? 'var(--color-primary)' : 'var(--color-purple-pale-23)'}`, background: open ? 'var(--color-surface-tint)' : 'transparent', cursor: 'pointer', transition: 'all 120ms' }}>
        <Icon name="auto_awesome" size={14} color="var(--color-primary)" />
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 600, color: 'var(--color-primary)' }}>Ask AI</span>
      </button>

      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 60, width: Math.min(280, window.innerWidth - 32), background: 'var(--color-white)', border: '1px solid var(--color-border)', borderRadius: 12, boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.16)', padding: 12, animation: 'menuIn 140ms ease both' }}>
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
        </div>
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
}

export default function NotesEditor({ value, onChange, placeholder = 'Add notes, context, or any details…', minHeight = 120, aiContext }: NotesEditorProps) {
  const [tab, setTab] = useState<'write' | 'preview'>('preview');
  const taRef = useRef<HTMLTextAreaElement>(null);
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

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const marker = formatMarkerForKeyDown(e);
    if (marker) { e.preventDefault(); applyFormat(marker); }
  };

  const showPreview = tab === 'preview';
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
  const mod = isMac ? '⌘' : 'Ctrl+';

  const fmtBtn = (icon: string, title: string, marker: Marker) => (
    <button
      type="button"
      title={title}
      disabled={showPreview}
      onMouseDown={e => e.preventDefault() /* keep the textarea selection */}
      onClick={() => applyFormat(marker)}
      style={{ width: 26, height: 26, borderRadius: 7, border: 'none', background: 'transparent', cursor: showPreview ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: showPreview ? 0.35 : 1, transition: 'background 120ms' }}
      onMouseEnter={e => { if (!showPreview) e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
      <Icon name={icon} size={16} color="var(--color-text-tertiary)" />
    </button>
  );

  return (
    <div>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, color: 'var(--color-border-strong)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Notes</div>
          <div style={{ display: 'inline-flex', background: 'var(--color-surface-tint-3)', border: '1px solid var(--color-purple-pale-23)', borderRadius: 8, padding: 2 }}>
            {(['write', 'preview'] as const).map(t => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                style={{ padding: '3px 10px', borderRadius: 6, border: 'none', background: tab === t ? 'var(--color-white)' : 'transparent', boxShadow: tab === t ? '0 1px 3px rgba(var(--color-black-rgb), 0.08)' : 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: tab === t ? 'var(--color-primary)' : 'var(--color-text-tertiary)', transition: 'all 120ms', textTransform: 'capitalize' }}>
                {t}
              </button>
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
        <textarea
          ref={taRef}
          value={value}
          onChange={e => { onChange(e.target.value); setUndoNote(null); resize(); }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          style={{
            width: '100%', fontFamily: 'var(--font-mono)',
            fontSize: 13, color: 'var(--color-text-secondary)',
            background: 'transparent', border: 'none', outline: 'none', resize: 'none',
            lineHeight: 1.75, padding: 0, overflowY: 'hidden', minHeight,
          }}
          rows={4}
        />
      )}
    </div>
  );
}
