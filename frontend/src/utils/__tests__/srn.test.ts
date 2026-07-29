import { describe, expect, it } from 'vitest';
import { parseSrn, formatSrn, isValidEntityType, ENTITY_TYPES } from '../srn';

describe('isValidEntityType', () => {
  it('accepts every registered entity type', () => {
    for (const t of ENTITY_TYPES) expect(isValidEntityType(t)).toBe(true);
  });

  it('rejects unknown types, including "workspace" (a container, not a graph node)', () => {
    expect(isValidEntityType('workspace')).toBe(false);
    expect(isValidEntityType('bogus')).toBe(false);
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

  it('returns null for an unknown entity type or malformed input', () => {
    expect(parseSrn('srn:workspace:ws_1')).toBeNull();
    expect(parseSrn('list:list_1')).toBeNull();
    expect(parseSrn('not-an-srn')).toBeNull();
  });
});

describe('formatSrn', () => {
  it('formats and round-trips through parseSrn', () => {
    const srn = formatSrn('milestone', 'ms_4412');
    expect(srn).toBe('srn:milestone:ms_4412');
    expect(parseSrn(srn)).toEqual({ entityType: 'milestone', entityId: 'ms_4412' });
  });

  it('formats an SRN with a block anchor', () => {
    expect(formatSrn('markdownList', 'md_1', 'blk_1')).toBe('srn:markdownList:md_1#blk_1');
  });

  it('throws on an unknown entity type', () => {
    // @ts-expect-error deliberately wrong type
    expect(() => formatSrn('workspace', 'ws_1')).toThrow();
  });
});
