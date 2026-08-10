import { describe, expect, it } from 'vitest';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  decodeCreatedAtCursor,
  encodeCreatedAtCursor,
  paginateRows,
  parsePageLimit,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
} from '../pagination';

describe('pagination — encode/decode round-trip', () => {
  it('round-trips a valid cursor exactly', () => {
    const cursor = { position: 42, createdAt: 1754721666.123457, id: '1751293847221' };
    const encoded = encodeKeysetCursor(cursor);
    expect(typeof encoded).toBe('string');
    expect(decodeKeysetCursor(encoded)).toEqual(cursor);
  });

  it('the encoded string is URL-safe base64 (no +, /, or = padding)', () => {
    const encoded = encodeKeysetCursor({ position: 0, createdAt: 1700000000, id: 'x'.repeat(50) });
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('handles a negative position (dash tasks can have negative-looking or zero positions)', () => {
    const cursor = { position: -5, createdAt: 1700000000.5, id: 'list_abc' };
    expect(decodeKeysetCursor(encodeKeysetCursor(cursor))).toEqual(cursor);
  });

  it('a `createdAt` with a microsecond-level fractional remainder round-trips EXACTLY — the regression this cursor shape exists to prevent (see the KeysetCursor doc comment: a JS-Date/ISO-string-based cursor truncates below millisecond precision and can re-include its own boundary row on the next page; a plain epoch-seconds float does not, per the ECMAScript Number#toString round-trip guarantee)', () => {
    const cursor = { position: 7, createdAt: 1754721666.123457, id: '99' };
    const decoded = decodeKeysetCursor(encodeKeysetCursor(cursor));
    expect(decoded).not.toBeNull();
    expect(decoded!.createdAt).toBe(1754721666.123457); // bit-exact, not merely "close"
  });
});

describe('pagination — CreatedAtCursor (position-less entities, e.g. shared_files/"Dateien")', () => {
  it('round-trips a valid 2-column cursor exactly', () => {
    const cursor = { createdAt: 1754721666.123457, id: 'sf_abc123' };
    const encoded = encodeCreatedAtCursor(cursor);
    expect(typeof encoded).toBe('string');
    expect(decodeCreatedAtCursor(encoded)).toEqual(cursor);
  });

  it('never confuses a KeysetCursor (3-column) encoding with a CreatedAtCursor (2-column) one — decodeCreatedAtCursor on a KeysetCursor-shaped payload still succeeds (extra `position` field is simply ignored), but decodeKeysetCursor on a CreatedAtCursor-shaped payload correctly fails (missing `position`)', () => {
    const taskCursor = encodeKeysetCursor({ position: 5, createdAt: 100, id: 'x' });
    expect(decodeCreatedAtCursor(taskCursor)).toEqual({ createdAt: 100, id: 'x' });

    const fileCursor = encodeCreatedAtCursor({ createdAt: 100, id: 'x' });
    expect(decodeKeysetCursor(fileCursor)).toBeNull();
  });

  it('degrades to null for malformed input, same fail-closed contract as decodeKeysetCursor', () => {
    expect(decodeCreatedAtCursor(undefined)).toBeNull();
    expect(decodeCreatedAtCursor('not-valid-base64!!!')).toBeNull();
    expect(decodeCreatedAtCursor(encodeCursorLike({ id: 'no-createdAt-field' }))).toBeNull();
  });
});

/** Test-local helper — encodes an arbitrary object the same way the module's
 *  own encode functions do, for constructing deliberately-malformed cursor
 *  payloads without reaching into the module's internals. */
function encodeCursorLike(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

describe('pagination — decodeKeysetCursor never throws, degrades to null', () => {
  it('undefined → null (no cursor supplied — first page)', () => {
    expect(decodeKeysetCursor(undefined)).toBeNull();
  });

  it('empty string → null', () => {
    expect(decodeKeysetCursor('')).toBeNull();
  });

  it('a non-string (e.g. an array from a duplicated query param) → null, not a throw', () => {
    expect(decodeKeysetCursor(['a', 'b'])).toBeNull();
  });

  it('garbage / non-base64 text → null, not a throw', () => {
    expect(decodeKeysetCursor('!!!not-valid-base64url!!!')).toBeNull();
  });

  it('valid base64url that decodes to non-JSON → null', () => {
    const notJson = Buffer.from('this is not json', 'utf8').toString('base64url');
    expect(decodeKeysetCursor(notJson)).toBeNull();
  });

  it('valid JSON but wrong shape (missing fields) → null', () => {
    const wrongShape = Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString('base64url');
    expect(decodeKeysetCursor(wrongShape)).toBeNull();
  });

  it('valid JSON, right keys, wrong types (position AND createdAt as strings) → null', () => {
    const wrongTypes = Buffer.from(JSON.stringify({ position: '42', createdAt: 'x', id: 'y' }), 'utf8').toString('base64url');
    expect(decodeKeysetCursor(wrongTypes)).toBeNull();
  });

  it('valid JSON but a bare array, not an object → null', () => {
    const arr = Buffer.from(JSON.stringify([1, 2, 3]), 'utf8').toString('base64url');
    expect(decodeKeysetCursor(arr)).toBeNull();
  });

  it('valid JSON but null → null', () => {
    const nul = Buffer.from('null', 'utf8').toString('base64url');
    expect(decodeKeysetCursor(nul)).toBeNull();
  });

  it('NaN position → null (Number.isFinite guard)', () => {
    // JSON itself can't encode NaN, so simulate the post-parse shape directly
    // via a manually-crafted base64url payload containing a non-finite marker
    // that JSON.parse would reject outright — confirms decode fails closed.
    const withNaNText = Buffer.from('{"position":NaN,"createdAt":1,"id":"y"}', 'utf8').toString('base64url');
    expect(decodeKeysetCursor(withNaNText)).toBeNull();
  });

  it('NaN createdAt → null (Number.isFinite guard applies to createdAt too)', () => {
    const withNaNText = Buffer.from('{"position":1,"createdAt":NaN,"id":"y"}', 'utf8').toString('base64url');
    expect(decodeKeysetCursor(withNaNText)).toBeNull();
  });
});

describe('pagination — spec-mandated bound (pins the literal numbers, not just the symbols)', () => {
  // The Phase 2 spec is explicit and numeric: "Default höchstens 50, hartes
  // Maximum 100." Every OTHER test in this file references the symbols
  // DEFAULT_PAGE_LIMIT/MAX_PAGE_LIMIT, which would happily keep passing even
  // if those constants silently drifted back to some other value (200/1000
  // shipped here once already, caught only by a human review reading the
  // spec side-by-side with the code) — this test is deliberately the ONE
  // place that asserts the actual spec numbers as LITERALS, so a future
  // change to the constants that violates the spec fails a test instead of
  // only failing a code review.
  it('DEFAULT_PAGE_LIMIT is exactly 50', () => {
    expect(DEFAULT_PAGE_LIMIT).toBe(50);
  });

  it('MAX_PAGE_LIMIT is exactly 100', () => {
    expect(MAX_PAGE_LIMIT).toBe(100);
  });

  it('a client-requested limit of 100 is honored exactly (the hard maximum, not clamped below it)', () => {
    expect(parsePageLimit('100')).toBe(100);
  });

  it('a client-requested limit of 101 (one over the hard maximum) is clamped down to 100', () => {
    expect(parsePageLimit('101')).toBe(100);
  });
});

describe('pagination — parsePageLimit', () => {
  it('returns the default when raw is undefined', () => {
    expect(parsePageLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
  });

  it('parses a valid numeric string', () => {
    expect(parsePageLimit('50')).toBe(50);
  });

  it('parses a valid number', () => {
    expect(parsePageLimit(50)).toBe(50);
  });

  it('clamps above MAX_PAGE_LIMIT down to the max — a client can never force an unbounded page', () => {
    expect(parsePageLimit('999999999')).toBe(MAX_PAGE_LIMIT);
  });

  it('zero falls back to the default, not zero (a zero-row page would look identical to "no results")', () => {
    expect(parsePageLimit('0')).toBe(DEFAULT_PAGE_LIMIT);
  });

  it('a negative number falls back to the default', () => {
    expect(parsePageLimit('-5')).toBe(DEFAULT_PAGE_LIMIT);
  });

  it('non-numeric garbage falls back to the default, never throws', () => {
    expect(parsePageLimit('not-a-number')).toBe(DEFAULT_PAGE_LIMIT);
  });

  it('truncates a fractional limit to an integer', () => {
    expect(parsePageLimit('10.9')).toBe(10);
  });

  it('honors a custom default/max pair (e.g. the bootstrap endpoint uses a larger cap)', () => {
    expect(parsePageLimit(undefined, { default: 2000, max: 5000 })).toBe(2000);
    expect(parsePageLimit('999999', { default: 2000, max: 5000 })).toBe(5000);
  });
});

describe('pagination — paginateRows', () => {
  const kOf = (r: { position: number; created_at: number; id: string }) => ({
    position: r.position,
    createdAt: r.created_at,
    id: r.id,
  });

  it('returns all rows with a null nextCursor when there is no overflow row', () => {
    const rows = [
      { position: 0, created_at: 100, id: '1' },
      { position: 1, created_at: 200, id: '2' },
    ];
    const { page, nextCursor } = paginateRows(rows, 5, kOf, encodeKeysetCursor);
    expect(page).toEqual(rows);
    expect(nextCursor).toBeNull();
  });

  it('exactly limit+1 rows: trims to limit and returns a nextCursor pointing at the LAST KEPT row (not the trimmed-off one)', () => {
    const rows = [
      { position: 0, created_at: 100, id: '1' },
      { position: 1, created_at: 200, id: '2' },
      { position: 2, created_at: 300, id: '3' }, // the "+1" overflow probe row
    ];
    const { page, nextCursor } = paginateRows(rows, 2, kOf, encodeKeysetCursor);
    expect(page).toHaveLength(2);
    expect(page).toEqual(rows.slice(0, 2));
    expect(nextCursor).not.toBeNull();
    expect(decodeKeysetCursor(nextCursor)).toEqual({ position: 1, createdAt: 200, id: '2' });
  });

  it('an empty row set returns an empty page and a null cursor', () => {
    const { page, nextCursor } = paginateRows([], 10, kOf, encodeKeysetCursor);
    expect(page).toEqual([]);
    expect(nextCursor).toBeNull();
  });

  it('a limit of 0 with any rows present is treated as "no more room" (page truncates to empty, no cursor)', () => {
    const rows = [{ position: 0, created_at: 100, id: '1' }];
    const { page, nextCursor } = paginateRows(rows, 0, kOf, encodeKeysetCursor);
    expect(page).toEqual([]);
    expect(nextCursor).toBeNull();
  });

  it('works identically with the 2-column CreatedAtCursor shape (files) — proves the generic refactor, not just the 3-column task shape', () => {
    const filesKOf = (r: { created_at: number; id: string }) => ({ createdAt: r.created_at, id: r.id });
    const rows = [
      { created_at: 300, id: 'sf_a' },
      { created_at: 200, id: 'sf_b' },
      { created_at: 100, id: 'sf_c' }, // the "+1" overflow probe row
    ];
    const { page, nextCursor } = paginateRows(rows, 2, filesKOf, encodeCreatedAtCursor);
    expect(page).toHaveLength(2);
    expect(page).toEqual(rows.slice(0, 2));
    expect(decodeCreatedAtCursor(nextCursor)).toEqual({ createdAt: 200, id: 'sf_b' });
  });
});
