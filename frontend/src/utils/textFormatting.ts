// Shared inline-Markdown selection-wrap logic for ⌘/Ctrl+B (bold), ⌘/Ctrl+I
// (italic), ⌘/Ctrl+Shift+S (strikethrough) keyboard shortcuts in any plain
// <textarea>-based editor — used by NotesEditor.tsx and MarkdownListScreen.tsx.

export type FormatMarker = '**' | '*' | '~~';

/** Wraps (or, if already wrapped, unwraps) the selection `[start,end)` of
 *  `value` with `marker`. Toggling is bidirectional: markers already inside
 *  the selection, or sitting just outside it, are stripped instead of
 *  double-applied. Returns the new full string plus where the selection
 *  should land afterward. */
export function toggleWrap(value: string, start: number, end: number, marker: FormatMarker): { next: string; selStart: number; selEnd: number } {
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

/** Reads ⌘/Ctrl+B/I/Shift+S off a keydown event, returning the marker to
 *  apply via `toggleWrap`, or null when the event isn't a format shortcut. */
export function formatMarkerForKeyDown(e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; key: string }): FormatMarker | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  const k = e.key.toLowerCase();
  if (k === 'b' && !e.shiftKey) return '**';
  if (k === 'i' && !e.shiftKey) return '*';
  if (e.shiftKey && (k === 'x' || k === 's')) return '~~';
  return null;
}
