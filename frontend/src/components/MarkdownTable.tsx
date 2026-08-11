import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MarkdownTableBlock, MarkdownTableRow, MarkdownTableAggregate } from '../types';
import Icon from './Icon';
import PopIn from './animate-ui/PopIn';
import {
  MIN_COL_W, MIN_ROW_H, DEFAULT_COL_W, DEFAULT_ROW_H, AGG_LABELS, AGG_ORDER,
  tblId, columnValues, computeAggregate, formatAggregate,
} from '../utils/markdownTable';

// ── A resizable, aggregatable table block for Markdown Pages ──────────────────
// Shared by the authenticated editor (MarkdownListScreen — pass `onChange`) and
// the read-only public share page (SharedMarkdownListPage — omit `onChange`).
// `rows[0]` is the bold header row and is excluded from column aggregation.
// Pure math + defaults (incl. makeEmptyTableBlock) live in utils/markdownTable.ts.

interface AggMenuState { colIndex: number; x: number; y: number; }

interface MarkdownTableProps {
  block: MarkdownTableBlock;
  /** Omit for a read-only render (public share page). */
  onChange?: (next: MarkdownTableBlock) => void;
}

export default function MarkdownTable({ block, onChange }: MarkdownTableProps) {
  const editable = typeof onChange === 'function';
  const columns = block.columns ?? [];
  const rows = block.rows ?? [];

  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const [aggMenu, setAggMenu] = useState<AggMenuState | null>(null);

  useEffect(() => {
    if (!aggMenu) return;
    const close = () => setAggMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [aggMenu]);

  if (columns.length === 0 || rows.length === 0) return null;

  const emit = (next: MarkdownTableBlock) => onChange?.(next);
  const cellAt = (row: MarkdownTableRow, ci: number) => row.cells[ci] ?? '';

  const setCell = (rowIndex: number, colIndex: number, value: string) => {
    emit({ ...block, rows: rows.map((r, ri) => ri === rowIndex
      ? { ...r, cells: columns.map((_, ci) => ci === colIndex ? value : cellAt(r, ci)) }
      : r) });
  };
  const addColumn = () => emit({
    ...block,
    columns: [...columns, { id: tblId('col'), width: DEFAULT_COL_W, aggregate: null }],
    rows: rows.map(r => ({ ...r, cells: [...columns.map((_, ci) => cellAt(r, ci)), ''] })),
  });
  const addRow = () => emit({
    ...block,
    rows: [...rows, { id: tblId('row'), height: DEFAULT_ROW_H, cells: columns.map(() => '') }],
  });
  const removeColumn = (ci: number) => {
    if (columns.length <= 1) return;
    emit({
      ...block,
      columns: columns.filter((_, i) => i !== ci),
      rows: rows.map(r => ({ ...r, cells: columns.map((_, i) => cellAt(r, i)).filter((_, i) => i !== ci) })),
    });
  };
  const removeRow = (ri: number) => {
    if (rows.length <= 1) return;
    emit({ ...block, rows: rows.filter((_, i) => i !== ri) });
  };
  const setAggregate = (ci: number, agg: MarkdownTableAggregate | null) => {
    emit({ ...block, columns: columns.map((c, i) => i === ci ? { ...c, aggregate: agg } : c) });
    setAggMenu(null);
  };

  // Snapshot the block at drag start: a pointer drag is single-touch, so no cell
  // edit races it, and each resized dimension is derived absolutely from the
  // start size — so re-deriving from the snapshot every move stays correct.
  const startColResize = (ci: number) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const base = block;
    const startX = e.clientX;
    const startW = base.columns[ci]?.width ?? DEFAULT_COL_W;
    const move = (ev: PointerEvent) => {
      const w = Math.max(MIN_COL_W, Math.round(startW + ev.clientX - startX));
      emit({ ...base, columns: base.columns.map((c, i) => i === ci ? { ...c, width: w } : c) });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const startRowResize = (ri: number) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const base = block;
    const startY = e.clientY;
    const startH = base.rows[ri]?.height ?? DEFAULT_ROW_H;
    const move = (ev: PointerEvent) => {
      const h = Math.max(MIN_ROW_H, Math.round(startH + ev.clientY - startY));
      emit({ ...base, rows: base.rows.map((r, i) => i === ri ? { ...r, height: h } : r) });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const openAggMenu = (ci: number, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setAggMenu({ colIndex: ci, x: Math.min(rect.left, window.innerWidth - 176), y: rect.bottom + 4 });
  };

  const showFooter = editable || columns.some(c => c.aggregate);
  const gridTemplateColumns = columns.map(c => `${Math.max(MIN_COL_W, c.width || DEFAULT_COL_W)}px`).join(' ');
  const rowTracks = rows.map(r => `${Math.max(MIN_ROW_H, r.height || DEFAULT_ROW_H)}px`);
  const gridTemplateRows = showFooter ? [...rowTracks, 'minmax(34px, auto)'].join(' ') : rowTracks.join(' ');

  const textCellStyle = (isHeader: boolean): React.CSSProperties => ({
    width: '100%', height: '100%', boxSizing: 'border-box', border: 'none', outline: 'none',
    background: 'transparent', resize: 'none', padding: '6px 8px', overflow: 'auto',
    fontFamily: 'var(--font-body)', fontSize: 13.5, lineHeight: 1.4,
    color: 'var(--color-text-primary)', fontWeight: isHeader ? 700 : 400,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  });
  const handleBase: React.CSSProperties = { position: 'absolute', zIndex: 2, background: 'transparent' };
  const cornerBtn: React.CSSProperties = {
    position: 'absolute', zIndex: 3, width: 16, height: 16, borderRadius: 5, padding: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
    background: 'var(--color-white)', border: '1px solid var(--color-border)',
  };

  const dataCells: React.ReactNode[] = [];
  rows.forEach((row, ri) => {
    const isHeader = ri === 0;
    columns.forEach((col, ci) => {
      dataCells.push(
        <div key={`${row.id}-${col.id}`}
          onMouseEnter={editable ? () => setHover({ r: ri, c: ci }) : undefined}
          style={{
            position: 'relative', display: 'flex', minWidth: 0,
            background: isHeader ? 'var(--color-surface-tint)' : 'var(--color-white)',
          }}>
          {editable ? (
            <textarea value={cellAt(row, ci)} rows={1} spellCheck={false}
              onChange={e => setCell(ri, ci, e.target.value)}
              placeholder={isHeader ? 'Header' : ''}
              style={textCellStyle(isHeader)} />
          ) : (
            <div style={textCellStyle(isHeader)}>{cellAt(row, ci)}</div>
          )}

          {editable && isHeader && (
            <div onPointerDown={startColResize(ci)} title="Drag to resize column"
              style={{ ...handleBase, top: 0, bottom: 0, right: -4, width: 8, cursor: 'col-resize' }} />
          )}
          {editable && ci === 0 && (
            <div onPointerDown={startRowResize(ri)} title="Drag to resize row"
              style={{ ...handleBase, left: 0, right: 0, bottom: -4, height: 8, cursor: 'row-resize' }} />
          )}
          {editable && isHeader && columns.length > 1 && hover?.c === ci && (
            <button onClick={() => removeColumn(ci)} title="Delete column"
              style={{ ...cornerBtn, top: 2, right: 2 }}>
              <Icon name="close" size={11} color="var(--color-text-tertiary)" />
            </button>
          )}
          {editable && ci === 0 && rows.length > 1 && hover?.r === ri && (
            <button onClick={() => removeRow(ri)} title="Delete row"
              style={{ ...cornerBtn, top: 2, left: 2 }}>
              <Icon name="close" size={11} color="var(--color-text-tertiary)" />
            </button>
          )}
        </div>
      );
    });
  });

  const footerCells: React.ReactNode[] = showFooter ? columns.map((col, ci) => {
    const agg = col.aggregate ?? null;
    const value = agg ? computeAggregate(agg, columnValues(rows, ci)) : null;
    const display = agg
      ? <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ fontWeight: 700 }}>{AGG_LABELS[agg]}</span> {value !== null ? formatAggregate(value) : '—'}
        </span>
      : null;
    return (
      <div key={`foot-${col.id}`} style={{ position: 'relative', display: 'flex', alignItems: 'stretch', minWidth: 0, background: 'var(--color-purple-pale-7)' }}>
        {editable ? (
          <button onClick={e => openAggMenu(ci, e)} title="Choose an aggregate for this column"
            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 5, padding: '4px 8px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', overflow: 'hidden', whiteSpace: 'nowrap', fontFamily: 'var(--font-body)', fontSize: 12.5, color: agg ? 'var(--color-text-primary)' : 'var(--color-text-quaternary)' }}>
            {agg ? display : <><Icon name="functions" size={13} color="var(--color-text-quaternary)" /> Summarize</>}
          </button>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px', fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-primary)', overflow: 'hidden' }}>{display}</div>
        )}
      </div>
    );
  }) : [];

  const dashedBtn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
    background: 'transparent', border: '1px dashed var(--color-border-strong)', borderRadius: 6,
    color: 'var(--color-text-tertiary)', padding: 0,
  };

  return (
    <div style={{ overflowX: 'auto', maxWidth: '100%', padding: '4px 0' }}>
      <div style={{ width: 'max-content' }}>
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 4 }}>
          <div onMouseLeave={editable ? () => setHover(null) : undefined}
            style={{ display: 'grid', gridTemplateColumns, gridTemplateRows, gap: 1, background: 'var(--color-border)', border: '1px solid var(--color-border)', borderRadius: 8 }}>
            {dataCells}
            {footerCells}
          </div>
          {editable && (
            <button onClick={addColumn} title="Add column" style={{ ...dashedBtn, width: 24, alignSelf: 'stretch' }}>
              <Icon name="add" size={16} color="var(--color-text-tertiary)" />
            </button>
          )}
        </div>
        {editable && (
          <button onClick={addRow} title="Add row" style={{ ...dashedBtn, width: '100%', height: 22, marginTop: 4 }}>
            <Icon name="add" size={16} color="var(--color-text-tertiary)" />
          </button>
        )}
      </div>

      {aggMenu && createPortal(
        <>
          <div onClick={() => setAggMenu(null)} onContextMenu={e => { e.preventDefault(); setAggMenu(null); }}
            style={{ position: 'fixed', inset: 0, zIndex: 1000 }} />
          <PopIn duration={140} style={{ position: 'fixed', left: aggMenu.x, top: aggMenu.y, zIndex: 1001, minWidth: 168, background: 'var(--color-white)', borderRadius: 10, boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', border: '1px solid var(--color-border)', padding: 5 }}>
            {([{ fn: null as MarkdownTableAggregate | null, label: 'None' }, ...AGG_ORDER.map(fn => ({ fn, label: AGG_LABELS[fn] }))]).map(opt => {
              const active = (columns[aggMenu.colIndex]?.aggregate ?? null) === opt.fn;
              return (
                <button key={opt.label} onClick={() => setAggregate(aggMenu.colIndex, opt.fn)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 12px', background: active ? 'var(--color-surface-tint)' : 'none', border: 'none', borderRadius: 7, cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: active ? 600 : 500, color: active ? 'var(--color-primary)' : 'var(--color-text-primary)' }}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = active ? 'var(--color-surface-tint)' : 'none'; }}>
                  <span style={{ flex: 1 }}>{opt.label}</span>
                  {active && <Icon name="check" size={15} color="var(--color-primary)" />}
                </button>
              );
            })}
          </PopIn>
        </>,
        document.body,
      )}
    </div>
  );
}
