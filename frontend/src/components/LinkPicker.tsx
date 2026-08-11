import Icon from './Icon';
import PopIn from './animate-ui/PopIn';
import type { EntityIndexEntry, GraphEntityType } from '../types';
import { ENTITY_TYPE_LABEL } from '../utils/graphLayout';

// ── Graph Layer entity-link suggestion popover ────────────────────────────────
// Mirrors MentionPopover exactly: a pure, caller-positioned results list with
// no data-fetching of its own. The caller drives `results`/`loading` — usually
// via the useEntitySearch hook — and owns keyboard nav (`activeIndex`), so
// Enter/Tab/Arrow keys can be handled in one place regardless of whether the
// query text lives in a textarea (NotesEditor's `[[` trigger) or a dedicated
// search input (RelationsPanel's "+ Add relation" flow).

interface LinkPickerProps {
  results: EntityIndexEntry[];
  loading: boolean;
  query: string;
  activeIndex: number;
  onPick: (entity: EntityIndexEntry) => void;
  onHover: (index: number) => void;
  style?: React.CSSProperties;
  emptyHint?: string;
  /** Header icon + label — defaults to the `[[...]]` inline-linking copy; override for reuse in a plain "jump to" search (e.g. the Net view's toolbar). */
  headerIcon?: string;
  headerLabel?: string;
}

export default function LinkPicker({ results, loading, query, activeIndex, onPick, onHover, style, emptyHint, headerIcon = 'link', headerLabel = 'Link to…' }: LinkPickerProps) {
  if (query.trim().length === 0 && results.length === 0 && !loading) return null;

  const width = Math.min(300, (typeof window !== 'undefined' ? window.innerWidth : 400) - 32);
  return (
    <PopIn
      duration={120}
      style={{
        position: 'absolute', zIndex: 220, width, maxHeight: 280, overflowY: 'auto',
        background: 'var(--color-white)', border: '1px solid var(--color-border)', borderRadius: 12,
        boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.16)', padding: 6,
        ...style,
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '2px 6px 6px' }}>
        <Icon name={headerIcon} size={12} color="var(--color-primary)" />
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 10.5, fontWeight: 700, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {headerLabel}
        </span>
      </div>

      {loading && (
        <div style={{ padding: '10px 8px', fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-quaternary)' }}>Searching…</div>
      )}
      {!loading && results.length === 0 && (
        <div style={{ padding: '10px 8px', fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-quaternary)' }}>
          {emptyHint ?? (query.trim() ? 'No matches' : 'Type to search…')}
        </div>
      )}
      {!loading && results.map((r, i) => (
        <button
          key={r.srn}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(r)}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8,
            border: 'none', cursor: 'pointer', textAlign: 'left',
            background: i === activeIndex ? 'var(--color-surface-tint-3)' : 'transparent',
          }}
        >
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
            {r.emoji && <span style={{ fontSize: 14 }}>{r.emoji}</span>}
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.title || 'Untitled'}
            </span>
          </div>
          <span style={{ flexShrink: 0, fontFamily: 'var(--font-heading)', fontSize: 10, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase' }}>
            {ENTITY_TYPE_LABEL[r.entityType as GraphEntityType]}
          </span>
        </button>
      ))}
    </PopIn>
  );
}
