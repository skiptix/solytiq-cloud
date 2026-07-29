import type { GraphEntityType } from '../../types';
import Icon from '../Icon';
import useGraphStore from '../../store/useGraphStore';
import { nodeColor, ENTITY_TYPE_LABEL_PLURAL as TYPE_LABELS } from '../../utils/graphLayout';

const ALL_TYPES = Object.keys(TYPE_LABELS) as GraphEntityType[];

export default function GraphControls({ isMobile }: { isMobile: boolean }) {
  const filters = useGraphStore((s) => s.filters);
  const setFilter = useGraphStore((s) => s.setFilter);
  const resetFilters = useGraphStore((s) => s.resetFilters);
  const hidden = useGraphStore((s) => s.hidden);
  const truncated = useGraphStore((s) => s.truncated);
  const allNodes = useGraphStore((s) => s.allNodes);
  const visibleCount = useGraphStore((s) => s.visibleNodes().length);

  const toggleType = (t: GraphEntityType) => {
    const has = filters.entityTypes.includes(t);
    setFilter('entityTypes', has ? filters.entityTypes.filter((x) => x !== t) : [...filters.entityTypes, t]);
  };

  return (
    <div style={{
      width: isMobile ? '100%' : 240, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 14,
      padding: 14, background: 'var(--color-surface-gray, #f9fafb)', borderRadius: 14, border: '1px solid var(--color-border)',
      maxHeight: isMobile ? undefined : '100%', overflowY: 'auto',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13 }}>Filters</span>
        <button onClick={resetFilters} style={{ background: 'none', border: 'none', color: 'var(--color-primary)', fontSize: 12, cursor: 'pointer' }}>Reset</button>
      </div>

      <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
        Showing {visibleCount} of {allNodes.length} nodes
        {truncated && ' — truncated, narrow your filters'}
      </div>
      {(hidden.nodes > 0 || hidden.edges > 0) && (
        <div style={{ fontSize: 11.5, color: 'var(--color-warning)', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Icon name="lock" size={13} />
          {hidden.edges} connection{hidden.edges === 1 ? '' : 's'} to content outside your access
        </div>
      )}

      <div>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 6 }}>Entity types</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {ALL_TYPES.map((t) => {
            const active = filters.entityTypes.length === 0 || filters.entityTypes.includes(t);
            return (
              <button
                key={t}
                onClick={() => toggleType(t)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', borderRadius: 6, border: 'none',
                  background: active ? 'var(--color-surface-tint)' : 'transparent', cursor: 'pointer', textAlign: 'left',
                  opacity: active ? 1 : 0.45, fontSize: 12.5,
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 4, background: nodeColor(t), flexShrink: 0 }} />
                {TYPE_LABELS[t]}
              </button>
            );
          })}
        </div>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
        <input type="checkbox" checked={filters.showCompleted} onChange={(e) => setFilter('showCompleted', e.target.checked)} />
        Show completed tasks
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
        <input type="checkbox" checked={filters.showOrphans} onChange={(e) => setFilter('showOrphans', e.target.checked)} />
        Show unconnected nodes
      </label>

      <div>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 6 }}>
          Depth ({filters.depth})
        </div>
        <input
          type="range" min={1} max={4} step={1} value={filters.depth}
          onChange={(e) => setFilter('depth', Number(e.target.value))}
          style={{ width: '100%' }}
        />
      </div>
    </div>
  );
}
