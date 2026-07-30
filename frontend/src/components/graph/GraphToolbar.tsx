import { useCallback, useRef, useState } from 'react';
import Icon from '../Icon';
import LinkPicker from '../LinkPicker';
import GraphControls from './GraphControls';
import { useEntitySearch } from '../../hooks/useEntitySearch';
import type { EntityIndexEntry } from '../../types';

/** Floating top-right toolbar over the full-size Net canvas: search, a
 *  Filters dropdown (wrapping the existing GraphControls panel), and Reset
 *  layout — replaces the old fixed-width sidebar so the graph itself gets
 *  the whole box. */
export default function GraphToolbar({
  workspaceId, hasCustomLayout, onResetLayout, onPickResult, isMobile,
}: {
  workspaceId: string;
  hasCustomLayout: boolean;
  onResetLayout: () => void;
  onPickResult: (entity: EntityIndexEntry) => void;
  isMobile: boolean;
}) {
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const { results, loading } = useEntitySearch(searchOpen ? query : '', { workspaceId, limit: 8 });

  const pill: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6, height: 36, padding: '0 12px', borderRadius: 9,
    border: '1px solid var(--color-border)', background: 'var(--color-white)',
    boxShadow: '0 2px 8px rgba(var(--color-black-rgb), 0.06)', fontFamily: 'var(--font-heading)',
    fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-secondary)', cursor: 'pointer', transition: 'all 150ms',
  };
  const onEnter = (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.color = 'var(--color-primary)'; };
  const onLeave = (e: React.MouseEvent<HTMLButtonElement>, active: boolean) => { if (!active) { e.currentTarget.style.borderColor = 'var(--color-border)'; e.currentTarget.style.color = 'var(--color-text-secondary)'; } };

  const pick = useCallback((entity: EntityIndexEntry) => {
    onPickResult(entity);
    setQuery('');
    setSearchOpen(false);
    setActiveIndex(0);
  }, [onPickResult]);

  return (
    <div style={{ position: 'absolute', top: 14, right: 14, zIndex: 6, display: 'flex', alignItems: 'flex-start', gap: 8, maxWidth: isMobile ? 'calc(100% - 28px)' : undefined }}>
      <div ref={searchWrapRef} style={{ position: 'relative' }}>
        <div style={{ ...pill, width: isMobile ? 150 : 220, cursor: 'text' }}>
          <Icon name="search" size={15} color="var(--color-text-quaternary)" />
          <input
            value={query}
            onFocus={() => setSearchOpen(true)}
            onChange={(e) => { setQuery(e.target.value); setSearchOpen(true); setActiveIndex(0); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setSearchOpen(false); (e.target as HTMLInputElement).blur(); return; }
              if (!results.length) return;
              if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => (i + 1) % results.length); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => (i - 1 + results.length) % results.length); }
              else if (e.key === 'Enter') { e.preventDefault(); pick(results[activeIndex]); }
            }}
            placeholder="Search the Net…"
            style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', fontFamily: 'var(--font-body)', fontSize: 12.5, fontWeight: 400, color: 'var(--color-text-primary)', background: 'transparent' }}
          />
          {query && (
            <button
              onClick={() => { setQuery(''); setSearchOpen(false); }}
              style={{ display: 'flex', border: 'none', background: 'none', cursor: 'pointer', padding: 0, color: 'var(--color-text-quaternary)' }}
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
        {searchOpen && query.trim().length > 0 && (
          <LinkPicker
            query={query}
            results={results}
            loading={loading}
            activeIndex={activeIndex}
            onHover={setActiveIndex}
            onPick={pick}
            emptyHint="Search boards, pages, tasks, milestones…"
            headerIcon="search"
            headerLabel="Jump to…"
            style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, width: 'auto' }}
          />
        )}
      </div>

      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setFiltersOpen((v) => !v)}
          style={{ ...pill, color: filtersOpen ? 'var(--color-primary)' : 'var(--color-text-secondary)', borderColor: filtersOpen ? 'var(--color-primary)' : 'var(--color-border)' }}
          onMouseEnter={onEnter}
          onMouseLeave={(e) => onLeave(e, filtersOpen)}
        >
          <Icon name="tune" size={15} color={filtersOpen ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
          {!isMobile && 'Filters'}
        </button>
        {filtersOpen && (
          <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 7, animation: 'menuIn 160ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <GraphControls isMobile={isMobile} onClose={() => setFiltersOpen(false)} />
          </div>
        )}
      </div>

      {hasCustomLayout && (
        <button
          onClick={onResetLayout}
          title="Release every manually-dragged node back into the flow"
          style={pill}
          onMouseEnter={onEnter}
          onMouseLeave={(e) => onLeave(e, false)}
        >
          <Icon name="restart_alt" size={15} color="var(--color-text-tertiary)" />
          {!isMobile && 'Reset layout'}
        </button>
      )}
    </div>
  );
}
