import { useState, useRef, useEffect, useCallback } from 'react';
import Icon from './Icon';
import CopyButton from './CopyButton';
import MarkdownView from './MarkdownView';

// ── Shared Notes editor ─────────────────────────────────────────────────────
// Used by the item dialog (TaskDialog) and the milestone editor so both get
// identical behavior:
//   • ⌘/Ctrl+B → **bold**, ⌘/Ctrl+I → *italic*, ⌘/Ctrl+Shift+X (or S) →
//     ~~strikethrough~~ on the current selection (toggle: applies or removes),
//     plus a small B / I / S toolbar for discoverability.
//   • Notes are always treated as Markdown. A Write / Preview switch lets the
//     user flip between the raw source and the rendered (MarkdownView) form;
//     it opens on Preview by default.

type Marker = '**' | '*' | '~~';

function toggleWrap(value: string, start: number, end: number, marker: Marker): { next: string; selStart: number; selEnd: number } {
  const sel = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);
  const mLen = marker.length;
  // Selection already includes the markers → strip them.
  if (sel.length >= mLen * 2 && sel.startsWith(marker) && sel.endsWith(marker)) {
    const inner = sel.slice(mLen, sel.length - mLen);
    return { next: before + inner + after, selStart: start, selEnd: start + inner.length };
  }
  // Markers sit just outside the selection → strip them.
  if (before.endsWith(marker) && after.startsWith(marker)) {
    return { next: before.slice(0, -mLen) + sel + after.slice(mLen), selStart: start - mLen, selEnd: end - mLen };
  }
  return { next: before + marker + sel + marker + after, selStart: start + mLen, selEnd: end + mLen };
}

interface NotesEditorProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  minHeight?: number;
}

export default function NotesEditor({ value, onChange, placeholder = 'Add notes, context, or any details…', minHeight = 120 }: NotesEditorProps) {
  const [tab, setTab] = useState<'write' | 'preview'>('preview');
  const taRef = useRef<HTMLTextAreaElement>(null);

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
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'b' && !e.shiftKey) { e.preventDefault(); applyFormat('**'); }
    else if (k === 'i' && !e.shiftKey) { e.preventDefault(); applyFormat('*'); }
    else if (e.shiftKey && (k === 'x' || k === 's')) { e.preventDefault(); applyFormat('~~'); }
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
      onMouseEnter={e => { if (!showPreview) e.currentTarget.style.background = '#F5F3FF'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
      <Icon name={icon} size={16} color="#787584" />
    </button>
  );

  return (
    <div>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 700, color: '#c9c4d5', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Notes</div>
          <div style={{ display: 'inline-flex', background: '#faf9ff', border: '1px solid #F0EEF8', borderRadius: 8, padding: 2 }}>
            {(['write', 'preview'] as const).map(t => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                style={{ padding: '3px 10px', borderRadius: 6, border: 'none', background: tab === t ? '#fff' : 'transparent', boxShadow: tab === t ? '0 1px 3px rgba(0,0,0,0.08)' : 'none', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: tab === t ? '#5e4dbb' : '#787584', transition: 'all 120ms', textTransform: 'capitalize' }}>
                {t}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {fmtBtn('format_bold', `Bold (${mod}B)`, '**')}
          {fmtBtn('format_italic', `Italic (${mod}I)`, '*')}
          {fmtBtn('strikethrough_s', `Strikethrough (${mod}⇧X)`, '~~')}
          {value.trim() && <div style={{ marginLeft: 4 }}><CopyButton text={value} title="Copy notes to clipboard" /></div>}
        </div>
      </div>

      {/* Body */}
      {showPreview ? (
        <div style={{ minHeight, padding: '2px 0' }}>
          {value.trim()
            ? <MarkdownView source={value} />
            : <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', fontStyle: 'italic' }}>Nothing to preview yet.</div>}
        </div>
      ) : (
        <textarea
          ref={taRef}
          value={value}
          onChange={e => { onChange(e.target.value); resize(); }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          style={{
            width: '100%', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 13, color: '#484552',
            background: 'transparent', border: 'none', outline: 'none', resize: 'none',
            lineHeight: 1.75, padding: 0, overflowY: 'hidden', minHeight,
          }}
          rows={4}
        />
      )}
    </div>
  );
}
