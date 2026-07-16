import type { ReactNode, CSSProperties } from 'react';

// ── Safe, dependency-free Markdown renderer ────────────────────────────────
// Renders a small, well-defined Markdown subset straight to React elements —
// no innerHTML anywhere, so untrusted note text can never inject markup.
//
// Supported:
//   Blocks:  # / ## / ### headings, - or * bullet lists, 1. numbered lists,
//            > blockquotes, ``` fenced code blocks, paragraphs
//   Inline:  **bold**, *italic* / _italic_, ~~strikethrough~~, `code`,
//            [label](https://link)

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

// Strips Markdown syntax down to plain text — for single-line, truncated
// snippets (task/list row previews) where rendering block/inline elements
// doesn't apply, but showing raw `**`/`#`/`~~` markers would look broken.
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

type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'code'; lines: string[] }
  | { kind: 'p'; lines: string[] };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    if (line.trimStart().startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) { code.push(lines[i]); i++; }
      i++; // skip closing fence
      blocks.push({ kind: 'code', lines: code });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3, text: heading[2] });
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; }
      blocks.push({ kind: 'ul', items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
      blocks.push({ kind: 'ol', items });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quoted.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      blocks.push({ kind: 'quote', lines: quoted });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length && lines[i].trim() !== '' &&
      !/^(#{1,3})\s+/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) &&
      !lines[i].trimStart().startsWith('```')
    ) { para.push(lines[i]); i++; }
    blocks.push({ kind: 'p', lines: para });
  }
  return blocks;
}

const HEADING_STYLE: Record<number, CSSProperties> = {
  1: { fontSize: 18, margin: '14px 0 6px' },
  2: { fontSize: 16, margin: '12px 0 5px' },
  3: { fontSize: 14.5, margin: '10px 0 4px' },
};

interface MarkdownViewProps {
  source: string;
  /** Base font size of body text (defaults to 14, matching notes). */
  fontSize?: number;
}

export default function MarkdownView({ source, fontSize = 14 }: MarkdownViewProps) {
  const blocks = parseBlocks(source);
  const bodyStyle: CSSProperties = { fontFamily: 'var(--font-body)', fontSize, color: 'var(--color-text-secondary)', lineHeight: 1.7, margin: '0 0 8px', overflowWrap: 'anywhere', wordBreak: 'break-word' };
  return (
    <div>
      {blocks.map((b, bi) => {
        const key = `blk-${bi}`;
        switch (b.kind) {
          case 'heading':
            return (
              <div key={key} style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, color: 'var(--color-text-primary)', lineHeight: 1.35, ...HEADING_STYLE[b.level] }}>
                {renderInline(b.text, key)}
              </div>
            );
          case 'ul':
            return (
              <ul key={key} style={{ ...bodyStyle, paddingLeft: 22, listStyle: 'disc' }}>
                {b.items.map((it, ii) => <li key={`${key}-${ii}`} style={{ marginBottom: 2 }}>{renderInline(it, `${key}-${ii}`)}</li>)}
              </ul>
            );
          case 'ol':
            return (
              <ol key={key} style={{ ...bodyStyle, paddingLeft: 22, listStyle: 'decimal' }}>
                {b.items.map((it, ii) => <li key={`${key}-${ii}`} style={{ marginBottom: 2 }}>{renderInline(it, `${key}-${ii}`)}</li>)}
              </ol>
            );
          case 'quote':
            return (
              <blockquote key={key} style={{ ...bodyStyle, borderLeft: '3px solid var(--color-accent-purple-soft-alt)', background: 'var(--color-surface-tint-3)', borderRadius: '0 8px 8px 0', padding: '6px 12px', marginLeft: 0, marginRight: 0, color: 'var(--color-text-tertiary)' }}>
                {b.lines.map((l, li) => <div key={`${key}-${li}`}>{renderInline(l, `${key}-${li}`)}</div>)}
              </blockquote>
            );
          case 'code':
            return (
              <pre key={key} style={{ fontFamily: 'var(--font-mono)', fontSize: fontSize - 1.5, background: 'var(--color-surface-tint)', border: '1px solid var(--color-border)', color: 'var(--color-purple-deep-3)', borderRadius: 10, padding: '10px 14px', margin: '0 0 8px', overflowX: 'auto', lineHeight: 1.6 }}>
                {b.lines.join('\n')}
              </pre>
            );
          case 'p':
            return (
              <p key={key} style={bodyStyle}>
                {b.lines.map((l, li) => (
                  <span key={`${key}-${li}`}>
                    {li > 0 && <br />}
                    {renderInline(l, `${key}-${li}`)}
                  </span>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
