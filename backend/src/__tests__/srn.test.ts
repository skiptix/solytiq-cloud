import { describe, expect, it } from 'vitest';
import { parseSrn, formatSrn, isValidEntityType, ENTITY_TYPES } from '../graph/srn';

describe('isValidEntityType', () => {
  it('accepts every registered entity type', () => {
    for (const t of ENTITY_TYPES) expect(isValidEntityType(t)).toBe(true);
  });

  it('rejects unknown types, including "workspace" (a container, not a graph node)', () => {
    expect(isValidEntityType('workspace')).toBe(false);
    expect(isValidEntityType('bogus')).toBe(false);
    expect(isValidEntityType('')).toBe(false);
  });
});

describe('parseSrn', () => {
  it('parses a plain SRN', () => {
    expect(parseSrn('srn:list:list_7f3a9c21')).toEqual({ entityType: 'list', entityId: 'list_7f3a9c21' });
  });

  it('parses a BIGINT task id serialized as a decimal string', () => {
    expect(parseSrn('srn:task:1751293847221')).toEqual({ entityType: 'task', entityId: '1751293847221' });
  });

  it('parses an SRN with a block anchor', () => {
    expect(parseSrn('srn:markdownList:md_a91c#blk_h2_intro')).toEqual({
      entityType: 'markdownList',
      entityId: 'md_a91c',
      blockId: 'blk_h2_intro',
    });
  });

  it('accepts uuid-based ids (hyphens)', () => {
    const parsed = parseSrn('srn:list:list_7f3a9c21-4b2e-4c1a-9d3e-abcdef123456');
    expect(parsed?.entityId).toBe('list_7f3a9c21-4b2e-4c1a-9d3e-abcdef123456');
  });

  it('returns null for an unknown entity type', () => {
    expect(parseSrn('srn:workspace:ws_1')).toBeNull();
    expect(parseSrn('srn:bogus:x')).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(parseSrn('list:list_1')).toBeNull();
    expect(parseSrn('srn:list:')).toBeNull();
    expect(parseSrn('srn::list_1')).toBeNull();
    expect(parseSrn('not-an-srn')).toBeNull();
  });

  it('returns null for non-string input without throwing', () => {
    // @ts-expect-error deliberately wrong type — callers may pass unchecked query params
    expect(parseSrn(undefined)).toBeNull();
    // @ts-expect-error deliberately wrong type
    expect(parseSrn(123)).toBeNull();
  });

  it('rejects an id containing SQL/path-hostile characters (defense in depth for downstream SQL)', () => {
    expect(parseSrn("srn:list:list_1' OR '1'='1")).toBeNull();
    expect(parseSrn('srn:list:../../etc/passwd')).toBeNull();
  });
});

describe('formatSrn', () => {
  it('formats a plain SRN', () => {
    expect(formatSrn('list', 'list_1')).toBe('srn:list:list_1');
  });

  it('formats a numeric task id', () => {
    expect(formatSrn('task', 1751293847221)).toBe('srn:task:1751293847221');
  });

  it('formats an SRN with a block anchor', () => {
    expect(formatSrn('markdownList', 'md_1', 'blk_1')).toBe('srn:markdownList:md_1#blk_1');
  });

  it('omits the block anchor when null/undefined', () => {
    expect(formatSrn('list', 'list_1', null)).toBe('srn:list:list_1');
    expect(formatSrn('list', 'list_1', undefined)).toBe('srn:list:list_1');
  });

  it('round-trips through parseSrn', () => {
    const srn = formatSrn('milestone', 'ms_4412');
    expect(parseSrn(srn)).toEqual({ entityType: 'milestone', entityId: 'ms_4412' });
  });

  it('throws on an unknown entity type (programmer error, never user input)', () => {
    // @ts-expect-error deliberately wrong type
    expect(() => formatSrn('workspace', 'ws_1')).toThrow();
  });
});
