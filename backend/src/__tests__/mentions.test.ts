import { describe, it, expect } from 'vitest';
import { extractMentionUsernames } from '../mentions';

// The mention parser is the security-relevant surface: it decides which
// usernames a note "mentions". It must never over-match (turning an email into
// a mention) and must normalise/dedupe so the resolver only ever does a bounded,
// case-insensitive lookup against real workspace members.

describe('extractMentionUsernames', () => {
  it('extracts a mention at the start of the text', () => {
    expect([...extractMentionUsernames('@alice please review')]).toEqual(['alice']);
  });

  it('extracts a mention after whitespace', () => {
    expect([...extractMentionUsernames('cc @bob thanks')]).toEqual(['bob']);
  });

  it('does NOT treat an email address as a mention', () => {
    expect([...extractMentionUsernames('email me at bob@example.com')]).toEqual([]);
  });

  it('does NOT match an @ glued to the end of a word', () => {
    expect([...extractMentionUsernames('foo@bar')]).toEqual([]);
  });

  it('lower-cases and dedupes repeated mentions', () => {
    expect([...extractMentionUsernames('@Alice and @alice and @ALICE')]).toEqual(['alice']);
  });

  it('collects multiple distinct mentions', () => {
    expect(new Set(extractMentionUsernames('@alice @bob @carol'))).toEqual(new Set(['alice', 'bob', 'carol']));
  });

  it('handles usernames with dots, dashes and underscores', () => {
    expect([...extractMentionUsernames('ping @jane_doe-01 now')]).toEqual(['jane_doe-01']);
  });

  it('trims trailing sentence punctuation', () => {
    expect([...extractMentionUsernames('thanks @bob.')]).toEqual(['bob']);
    expect([...extractMentionUsernames('hi @carol, and @dave!')]).toEqual(['carol', 'dave']);
  });

  it('returns an empty set for null/empty/no-mention text', () => {
    expect(extractMentionUsernames(null).size).toBe(0);
    expect(extractMentionUsernames('').size).toBe(0);
    expect(extractMentionUsernames('no mentions here').size).toBe(0);
    expect(extractMentionUsernames('bare @ symbol').size).toBe(0);
  });

  it('caps an overly long token at the max username length (so it can never resolve)', () => {
    const long = 'a'.repeat(60);
    const result = [...extractMentionUsernames(`@${long}`)];
    expect(result).toHaveLength(1);
    expect(result[0].length).toBe(50);
  });

  it('works across newlines (markdown blocks joined by \\n)', () => {
    expect(new Set(extractMentionUsernames('para one @alice\npara two @bob'))).toEqual(new Set(['alice', 'bob']));
  });
});
