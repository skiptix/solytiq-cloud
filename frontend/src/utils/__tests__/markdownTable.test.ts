import { describe, it, expect } from 'vitest';
import type { MarkdownTableRow } from '../../types';
import { toNumber, columnValues, computeAggregate, formatAggregate, makeEmptyTableBlock } from '../markdownTable';

const row = (cells: string[]): MarkdownTableRow => ({ id: 'r', height: 40, cells });

describe('toNumber', () => {
  it('parses plain and thousands-separated numbers', () => {
    expect(toNumber('5')).toBe(5);
    expect(toNumber(' 1,234.5 ')).toBe(1234.5);
    expect(toNumber('-3')).toBe(-3);
  });
  it('returns null for blank or non-numeric', () => {
    expect(toNumber('')).toBeNull();
    expect(toNumber('   ')).toBeNull();
    expect(toNumber('abc')).toBeNull();
  });
});

describe('columnValues', () => {
  const rows: MarkdownTableRow[] = [
    row(['Header', 'Price']),   // header row — always skipped
    row(['a', '10']),
    row(['b', '']),             // blank — skipped
    row(['c', 'n/a']),          // non-numeric — skipped
    row(['d', '5.5']),
  ];
  it('collects numeric BODY cells only, skipping the header and blanks', () => {
    expect(columnValues(rows, 1)).toEqual([10, 5.5]);
  });
  it('is empty for a fully non-numeric column', () => {
    expect(columnValues(rows, 0)).toEqual([]);
  });
});

describe('computeAggregate', () => {
  const nums = [4, 1, 3, 2];
  it('computes sum/avg/max/min', () => {
    expect(computeAggregate('sum', nums)).toBe(10);
    expect(computeAggregate('avg', nums)).toBe(2.5);
    expect(computeAggregate('max', nums)).toBe(4);
    expect(computeAggregate('min', nums)).toBe(1);
  });
  it('computes median for even and odd counts', () => {
    expect(computeAggregate('median', [4, 1, 3, 2])).toBe(2.5); // even → mean of middle two
    expect(computeAggregate('median', [5, 1, 3])).toBe(3);      // odd → middle
  });
  it('returns null for an empty set', () => {
    expect(computeAggregate('sum', [])).toBeNull();
    expect(computeAggregate('median', [])).toBeNull();
  });
});

describe('formatAggregate', () => {
  it('keeps integers clean and trims float noise', () => {
    expect(formatAggregate(10)).toBe('10');
    expect(formatAggregate(0.1 + 0.2)).toBe('0.3');
    expect(formatAggregate(1 / 3)).toBe('0.3333');
  });
});

describe('makeEmptyTableBlock', () => {
  it('creates a 3-column, 3-row (header + 2 body) grid with the given id', () => {
    const b = makeEmptyTableBlock('blk1');
    expect(b.id).toBe('blk1');
    expect(b.type).toBe('table');
    expect(b.columns).toHaveLength(3);
    expect(b.rows).toHaveLength(3);
    expect(b.rows.every(r => r.cells.length === 3)).toBe(true);
    expect(b.columns.every(c => c.aggregate === null)).toBe(true);
  });
});
