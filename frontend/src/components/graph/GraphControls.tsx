import type { GraphEntityType } from '../../types';
import Icon from '../Icon';
import useGraphStore from '../../store/useGraphStore';
import { nodeColor, ENTITY_TYPE_LABEL_PLURAL as TYPE_LABELS } from '../../utils/graphLayout';

const ALL_TYPES = Object.keys(TYPE_LABELS) as GraphEntityType[];

function CheckRow({ checked, label, onToggle }: { checked: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '4px 2px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', width: '100%' }}
    >
      <div style={{ width: 18, height: 18, borderRadius: 5, border: `1.5px solid ${checked ? 'var(--color-primary)' : 'var(--color-purple-tint-7, #d8d3ec)'}`, background: checked ? 'var(--color-primary)' : 'var(--color-white)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 120ms' }}>
        {checked && <Icon name="check" size={13} color="var(--color-white)" />}
      </div>
      <span style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-primary)' }}>{label}</span>
    </button>
  );
}

export default function GraphControls({ isMobile, onClose }: { isMobile: boolean; onClose?: () => void }) {
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
      width: isMobile ? 'min(300px, calc(100vw - 28px))' : 260, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 14,
      padding: 14, background: 'var(--color-white)', borderRadius: 14, border: '1px solid var(--color-border)',
      boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.14)',
      maxHeight: 'min(70vh, 480px)', overflowY: 'auto',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13, color: 'var(--color-text-primary)' }}>Filters</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={resetFilters} style={{ background: 'none', border: 'none', fontFamily: 'var(--font-heading)', color: 'var(--color-primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Reset</button>
          {onClose && (
            <button onClick={onClose} style={{ display: 'flex', border: 'none', background: 'none', cursor: 'pointer', padding: 0, color: 'var(--color-text-tertiary)' }}>
              <Icon name="close" size={16} />
            </button>
          )}
        </div>
      </div>

      <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
        Showing {visibleCount} of {allNodes.length} nodes
        {truncated && ' — truncated, narrow your filters'}
      </div>
      {(hidden.nodes > 0 || hidden.edges > 0) && (
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-warning)', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Icon name="lock" size={13} color="var(--color-warning)" />
          {hidden.edges} connection{hidden.edges === 1 ? '' : 's'} to content outside your access
        </div>
      )}

      <div>
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 6 }}>Entity types</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {ALL_TYPES.map((t) => {
            const active = filters.entityTypes.length === 0 || filters.entityTypes.includes(t);
            return (
              <button
                key={t}
                onClick={() => toggleType(t)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 6, border: 'none',
                  background: active ? 'var(--color-surface-tint)' : 'transparent', cursor: 'pointer', textAlign: 'left',
                  opacity: active ? 1 : 0.45, fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-primary)', transition: 'background 120ms, opacity 120ms',
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 4, background: nodeColor(t), flexShrink: 0 }} />
                {TYPE_LABELS[t]}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <CheckRow checked={filters.showCompleted} label="Show completed tasks" onToggle={() => setFilter('showCompleted', !filters.showCompleted)} />
        <CheckRow checked={filters.showOrphans} label="Show items without relations" onToggle={() => setFilter('showOrphans', !filters.showOrphans)} />
      </div>

      <div>
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
          Depth ({filters.depth})
        </div>
        <input
          type="range" min={1} max={4} step={1} value={filters.depth}
          onChange={(e) => setFilter('depth', Number(e.target.value))}
          style={{ width: '100%', accentColor: 'var(--color-primary)', cursor: 'pointer' }}
        />
      </div>
    </div>
  );
}
