// ---------------------------------------------------------------------------
// B4 — reorder validation. Pure, no DB.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { validateReorderIds, MAX_REORDER_ITEMS } from '../reorderUtil';

describe('validateReorderIds', () => {
  it('accepts a well-formed string-id array', () => {
    const r = validateReorderIds(['a', 'b', 'c'], 'string');
    expect(r).toEqual({ ok: true, ids: ['a', 'b', 'c'] });
  });

  it('accepts a well-formed integer-id array', () => {
    const r = validateReorderIds([1, 2, 3], 'number');
    expect(r).toEqual({ ok: true, ids: [1, 2, 3] });
  });

  it('accepts an empty array', () => {
    const r = validateReorderIds([], 'string');
    expect(r).toEqual({ ok: true, ids: [] });
  });

  it('rejects a non-array', () => {
    expect(validateReorderIds('not-an-array', 'string')).toEqual({ ok: false, status: 400, error: 'ids must be an array' });
    expect(validateReorderIds(null, 'string')).toEqual({ ok: false, status: 400, error: 'ids must be an array' });
    expect(validateReorderIds(undefined, 'string')).toEqual({ ok: false, status: 400, error: 'ids must be an array' });
    expect(validateReorderIds({ ids: ['a'] }, 'string')).toEqual({ ok: false, status: 400, error: 'ids must be an array' });
  });

  it('rejects an array over the server-side maximum, regardless of what the client requests', () => {
    const tooMany = Array.from({ length: MAX_REORDER_ITEMS + 1 }, (_, i) => `id_${i}`);
    const r = validateReorderIds(tooMany, 'string');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('accepts exactly the maximum', () => {
    const exactlyMax = Array.from({ length: MAX_REORDER_ITEMS }, (_, i) => `id_${i}`);
    expect(validateReorderIds(exactlyMax, 'string').ok).toBe(true);
  });

  it('rejects a non-string entry when idKind is "string"', () => {
    expect(validateReorderIds(['a', 1, 'c'], 'string').ok).toBe(false);
    expect(validateReorderIds(['a', '', 'c'], 'string').ok).toBe(false); // empty string
    expect(validateReorderIds(['a', null, 'c'], 'string').ok).toBe(false);
  });

  it('rejects a non-integer/NaN/Infinity entry when idKind is "number"', () => {
    expect(validateReorderIds([1, 'x', 3], 'number').ok).toBe(false);
    expect(validateReorderIds([1, NaN, 3], 'number').ok).toBe(false);
    expect(validateReorderIds([1, Infinity, 3], 'number').ok).toBe(false);
    expect(validateReorderIds([1, 2.5, 3], 'number').ok).toBe(false);
  });

  it('rejects a duplicate id', () => {
    const r = validateReorderIds(['a', 'b', 'a'], 'string');
    expect(r).toEqual({ ok: false, status: 400, error: 'ids must not contain duplicate entries' });
  });

  it('rejects duplicate numeric ids too', () => {
    expect(validateReorderIds([1, 2, 2], 'number').ok).toBe(false);
  });
});
