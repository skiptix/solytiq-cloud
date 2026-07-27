import type { MarkdownTableBlock, MarkdownTableColumn, MarkdownTableRow, MarkdownTableAggregate } from '../types';

// Pure helpers + constants for the Markdown Page `table` block, kept out of the
// React component so the aggregation math is unit-testable on its own.

export const MIN_COL_W = 56;
export const MIN_ROW_H = 32;
export const DEFAULT_COL_W = 160;
export const DEFAULT_ROW_H = 40;

export const AGG_LABELS: Record<MarkdownTableAggregate, string> = {
  sum: 'Sum', avg: 'Average', median: 'Median', max: 'Max', min: 'Min',
};
export const AGG_ORDER: MarkdownTableAggregate[] = ['sum', 'avg', 'median', 'max', 'min'];

let tblSeq = 0;
export function tblId(prefix: string): string {
  tblSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${tblSeq}`;
}

/** A fresh 3×3 table (1 header row + 2 body rows), all cells empty. */
export function makeEmptyTableBlock(id: string): MarkdownTableBlock {
  const columns: MarkdownTableColumn[] = [0, 1, 2].map(() => ({ id: tblId('col'), width: DEFAULT_COL_W, aggregate: null }));
  const rows: MarkdownTableRow[] = [0, 1, 2].map(() => ({ id: tblId('row'), height: DEFAULT_ROW_H, cells: columns.map(() => '') }));
  return { id, type: 'table', columns, rows };
}

/** Parse a cell into a number (tolerating thousands separators); null if blank/non-numeric. */
export function toNumber(raw: string): number | null {
  const t = (raw ?? '').trim().replace(/,/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Numeric values in a column, over BODY rows only (skips the header row + blanks). */
export function columnValues(rows: MarkdownTableRow[], colIndex: number): number[] {
  return rows.slice(1)
    .map(r => toNumber(r.cells[colIndex] ?? ''))
    .filter((n): n is number => n !== null);
}

export function computeAggregate(fn: MarkdownTableAggregate, nums: number[]): number | null {
  if (nums.length === 0) return null;
  if (fn === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (fn === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (fn === 'max') return Math.max(...nums);
  if (fn === 'min') return Math.min(...nums);
  // median
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Trim floating-point noise without forcing decimals onto integers. */
export function formatAggregate(n: number): string {
  return String(Math.round(n * 1e4) / 1e4);
}
