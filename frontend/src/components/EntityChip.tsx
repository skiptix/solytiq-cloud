import { useNavigate } from 'react-router-dom';
import Icon from './Icon';
import type { EntityIndexEntry, GraphEntityType } from '../types';
import { nodeColor, ENTITY_TYPE_ICON } from '../utils/graphLayout';

// ── EntityChip ──────────────────────────────────────────────────────────────
// A small, live-titled pill for one graph entity — used anywhere an SRN needs
// a real, clickable representation instead of raw `[[type:id]]` text: the
// Markdown/notes editor's rendered inline links, RelationsPanel/BacklinksPanel
// rows, and LinkPicker results. A neighbor the caller couldn't resolve (not
// visible, or since deleted) renders as a muted, non-interactive
// "(restricted)" placeholder — never a broken link, never a leak of what it
// might have been.

interface EntityChipProps {
  entity: EntityIndexEntry | null;
  /** Fallback type/label to render while `entity` is still null but a type is known (e.g. an unresolved [[type:id]] token). */
  fallbackType?: GraphEntityType;
  onClick?: () => void;
  size?: 'sm' | 'md';
}

export default function EntityChip({ entity, fallbackType, onClick, size = 'sm' }: EntityChipProps) {
  const navigate = useNavigate();
  const type = entity?.entityType ?? fallbackType;
  const restricted = !entity;
  const pad = size === 'sm' ? '2px 8px 2px 6px' : '4px 10px 4px 7px';
  const fontSize = size === 'sm' ? 12 : 13;
  const iconSize = size === 'sm' ? 13 : 14;

  const handleClick = () => {
    if (restricted) return;
    if (onClick) { onClick(); return; }
    if (entity?.deepLink) navigate(entity.deepLink);
  };

  return (
    <span
      onClick={handleClick}
      title={restricted ? 'This item is not accessible' : entity.title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, padding: pad, borderRadius: 9999,
        border: `1px solid ${restricted ? 'var(--color-border)' : 'var(--color-purple-pale-23, #e8e4f0)'}`,
        background: restricted ? 'var(--color-surface-tint-3)' : 'var(--color-surface-tint)',
        cursor: restricted ? 'default' : 'pointer', maxWidth: '100%', verticalAlign: 'middle',
        opacity: restricted ? 0.6 : 1,
      }}
    >
      {type && (
        entity?.emoji
          ? <span style={{ fontSize: iconSize }}>{entity.emoji}</span>
          : <Icon name={type ? ENTITY_TYPE_ICON[type] : 'link'} size={iconSize} color={restricted ? 'var(--color-text-quaternary)' : nodeColor(type)} />
      )}
      <span style={{
        fontFamily: 'var(--font-body)', fontSize, fontWeight: 500,
        color: restricted ? 'var(--color-text-quaternary)' : 'var(--color-text-primary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {restricted ? '(restricted)' : entity.title || 'Untitled'}
      </span>
    </span>
  );
}
