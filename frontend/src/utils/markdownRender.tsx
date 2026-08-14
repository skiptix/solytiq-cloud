// Pure markdown helpers, split out of components/MarkdownView.tsx.
//
// A module exporting BOTH a component and plain functions breaks Fast
// Refresh — the same reason utils/markdownBlocks.ts exists (see CLAUDE.md's
// note on the shared BlockEditor). MarkdownView keeps the component; the
// text/inline transforms live here.
import type { ReactNode } from 'react';

const INLINE_TOKEN = /(`[^`]+`)|(\*\*(?:[^*]|\*(?!\*))+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/;

export function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let i = 0;
  while (rest.length > 0) {
    const m = INLINE_TOKEN.exec(rest);
    if (!m || m.index === undefined) { out.push(rest); break; }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (tok.startsWith('`')) {
      out.push(
        <code key={key} style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9em', background: 'var(--color-surface-tint)', color: 'var(--color-primary)', borderRadius: 4, padding: '1px 5px' }}>
          {tok.slice(1, -1)}
        </code>
      );
    } else if (tok.startsWith('**')) {
      out.push(<strong key={key} style={{ fontWeight: 700, color: 'var(--color-text-primary)' }}>{renderInline(tok.slice(2, -2), key)}</strong>);
    } else if (tok.startsWith('~~')) {
      out.push(<s key={key} style={{ opacity: 0.65 }}>{renderInline(tok.slice(2, -2), key)}</s>);
    } else if (tok.startsWith('*') || tok.startsWith('_')) {
      out.push(<em key={key}>{renderInline(tok.slice(1, -1), key)}</em>);
    } else if (tok.startsWith('[')) {
      const close = tok.indexOf('](');
      const label = tok.slice(1, close);
      const url = tok.slice(close + 2, -1);
      out.push(
        <a key={key} href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)', textDecoration: 'underline', textUnderlineOffset: 2 }}>
          {renderInline(label, key)}
        </a>
      );
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}
export function markdownToPlainText(source: string): string {
  return source
    .replace(/\r\n/g, '\n')
    .replace(/```([\s\S]*?)```/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s)]+\)/g, '$1')
    .replace(/\n+/g, ' ')
    .trim();
}
