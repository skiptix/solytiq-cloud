import { useEffect, useState } from 'react';
import Icon from '../Icon';
import EntityChip from '../EntityChip';
import type { GraphEntityType, ResolvedLink } from '../../types';
import { apiGetBacklinks } from '../../api/client';

// ── BacklinksPanel ──────────────────────────────────────────────────────────
// Read-only "what links here" — the incoming half of an entity's edges (both
// manual relations pointing at it and inline `[[...]]` references from other
// pages). Unlike RelationsPanel there is nothing to add/remove here: a
// backlink is a byproduct of some OTHER entity's own outgoing edge, so it's
// managed from that entity's own Relations panel or its source text.

interface BacklinksPanelProps {
  entityType: GraphEntityType;
  entityId: string;
  compact?: boolean;
}

export default function BacklinksPanel({ entityType, entityId, compact }: BacklinksPanelProps) {
  const [backlinks, setBacklinks] = useState<ResolvedLink[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBacklinks(null);
    apiGetBacklinks(entityType, entityId)
      .then((r) => { if (!cancelled) setBacklinks(r.backlinks); })
      .catch(() => { if (!cancelled) setBacklinks([]); });
    return () => { cancelled = true; };
  }, [entityType, entityId]);

  if (backlinks !== null && backlinks.length === 0 && compact) return null;

  return (
    <div>
      {!compact && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 8 }}>
          <Icon name="keyboard_return" size={13} color="var(--color-text-quaternary)" />
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, color: 'var(--color-border-strong)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Linked from{backlinks && backlinks.length > 0 ? ` (${backlinks.length})` : ''}
          </div>
        </div>
      )}
      {backlinks === null && <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Loading…</div>}
      {backlinks !== null && backlinks.length === 0 && !compact && (
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-quaternary)', fontStyle: 'italic' }}>Nothing links here yet.</div>
      )}
      {backlinks !== null && backlinks.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {backlinks.map((l) => <EntityChip key={l.id} entity={l.neighbor} />)}
        </div>
      )}
    </div>
  );
}
