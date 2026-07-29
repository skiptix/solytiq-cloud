import { useEffect, useState, useCallback } from 'react';
import Icon from '../Icon';
import EntityChip from '../EntityChip';
import LinkPicker from '../LinkPicker';
import type { GraphEntityType, LinkTypeDef, ResolvedLink } from '../../types';
import { apiGetEntityLinks, apiGetLinkTypes, apiCreateLink, apiDeleteLink } from '../../api/client';
import { formatSrn } from '../../utils/srn';
import { useEntitySearch } from '../../hooks/useEntitySearch';

// ── RelationsPanel ──────────────────────────────────────────────────────────
// Embeddable in any item editor (TaskDialog's properties panel, the milestone
// editor, MarkdownListScreen's header) to show + manage this entity's Graph
// Layer edges — both directions, grouped by link type, with a small
// "+ Add relation" flow. System-mirrored edges (the 5 legacy hard-linking
// mechanisms) are shown but never deletable from here — that's the whole
// point of `origin = 'system'` (see graph/links.ts).

interface RelationsPanelProps {
  entityType: GraphEntityType;
  entityId: string;
  workspaceId?: string;
  /** Compact mode drops the section header — used when the caller already labels this block itself. */
  compact?: boolean;
}

export default function RelationsPanel({ entityType, entityId, workspaceId, compact }: RelationsPanelProps) {
  const [linksByType, setLinksByType] = useState<Record<string, ResolvedLink[]> | null>(null);
  const [loading, setLoading] = useState(true);
  const [types, setTypes] = useState<LinkTypeDef[]>([]);
  const [adding, setAdding] = useState(false);
  const [newLinkType, setNewLinkType] = useState('references');
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [busy, setBusy] = useState(false);

  const src = formatSrn(entityType, entityId);

  const load = useCallback(() => {
    setLoading(true);
    apiGetEntityLinks(entityType, entityId)
      .then((r) => setLinksByType(r.linksByType))
      .catch(() => setLinksByType({}))
      .finally(() => setLoading(false));
  }, [entityType, entityId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { apiGetLinkTypes(workspaceId).then((r) => setTypes(r.types)).catch(() => setTypes([])); }, [workspaceId]);

  const excludeSrns = [src, ...Object.values(linksByType ?? {}).flat().map((l) => (l.direction === 'out' ? l.dst : l.src))];
  const { results: pickerResults, loading: pickerLoading } = useEntitySearch(adding ? query : '', { excludeSrns, workspaceId });

  const handlePick = async (entity: { srn: string }) => {
    setBusy(true);
    try {
      await apiCreateLink({ src, dst: entity.srn, linkType: newLinkType });
      setAdding(false);
      setQuery('');
      load();
    } catch {
      // best-effort — the picker just stays open so the user can retry
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (linkId: string) => {
    setBusy(true);
    try {
      await apiDeleteLink(linkId);
      load();
    } finally {
      setBusy(false);
    }
  };

  const groups = Object.entries(linksByType ?? {});
  const totalCount = groups.reduce((n, [, links]) => n + links.length, 0);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: compact ? 'flex-end' : 'space-between', marginBottom: 8 }}>
        {!compact && (
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, color: 'var(--color-border-strong)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Relations{totalCount > 0 ? ` (${totalCount})` : ''}
          </div>
        )}
        <button
          type="button"
          onClick={() => setAdding((a) => !a)}
          style={{ display: 'flex', alignItems: 'center', gap: 4, height: 24, padding: '0 8px', borderRadius: 7, border: '1px solid var(--color-purple-pale-23)', background: adding ? 'var(--color-surface-tint)' : 'transparent', cursor: 'pointer' }}
        >
          <Icon name="add_link" size={13} color="var(--color-primary)" />
          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-primary)' }}>Add relation</span>
        </button>
      </div>

      {adding && (
        <div style={{ position: 'relative', marginBottom: 10, padding: 8, borderRadius: 10, border: '1px solid var(--color-border)', background: 'var(--color-surface-tint-3)' }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <select
              value={newLinkType}
              onChange={(e) => setNewLinkType(e.target.value)}
              style={{ fontFamily: 'var(--font-body)', fontSize: 12, border: '1px solid var(--color-border)', borderRadius: 7, padding: '5px 6px', background: 'var(--color-white)' }}
            >
              {types.filter((t) => t.deletable).map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>
            <input
              autoFocus
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setAdding(false); setQuery(''); return; }
                if (!pickerResults.length) return;
                if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => (i + 1) % pickerResults.length); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => (i - 1 + pickerResults.length) % pickerResults.length); }
                else if (e.key === 'Enter') { e.preventDefault(); handlePick(pickerResults[activeIndex]); }
              }}
              placeholder="Search an item to link…"
              disabled={busy}
              style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 12.5, border: '1px solid var(--color-border)', borderRadius: 7, padding: '5px 8px', outline: 'none', minWidth: 0 }}
            />
          </div>
          <LinkPicker
            query={query}
            results={pickerResults}
            loading={pickerLoading}
            activeIndex={activeIndex}
            onHover={setActiveIndex}
            onPick={handlePick}
            style={{ position: 'static', width: '100%', boxShadow: 'none', border: 'none', padding: 0, animation: 'none' }}
          />
        </div>
      )}

      {loading && <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Loading…</div>}
      {!loading && groups.length === 0 && (
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-quaternary)', fontStyle: 'italic' }}>No connections yet.</div>
      )}
      {!loading && groups.map(([linkType, links]) => (
        <div key={linkType} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
            {linkType} ({links.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {links.map((l) => (
              <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name={l.direction === 'out' ? 'arrow_forward' : 'arrow_back'} size={13} color="var(--color-text-quaternary)" />
                <EntityChip entity={l.neighbor} />
                {l.origin !== 'system' && (
                  <button
                    type="button"
                    onClick={() => handleDelete(l.id)}
                    disabled={busy}
                    title="Remove relation"
                    style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: busy ? 'default' : 'pointer', display: 'flex', padding: 2, opacity: busy ? 0.5 : 1 }}
                  >
                    <Icon name="close" size={13} color="var(--color-text-quaternary)" />
                  </button>
                )}
                {l.origin === 'system' && (
                  <span style={{ marginLeft: 'auto', display: 'flex' }} title="Managed automatically — edit it from where it was created">
                    <Icon name="lock" size={11} color="var(--color-text-quaternary)" />
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
