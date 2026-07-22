import { describe, it, expect } from 'vitest';
import { detectMention, applyMention, filterMentionMembers, type MentionMember } from '../mention';

describe('detectMention', () => {
  it('detects a mention being typed at the caret', () => {
    const text = 'hey @al';
    expect(detectMention(text, text.length)).toEqual({ at: 4, query: 'al' });
  });

  it('detects a bare @ (empty query) to open the picker immediately', () => {
    const text = 'ping @';
    expect(detectMention(text, text.length)).toEqual({ at: 5, query: '' });
  });

  it('does not detect once the mention is closed by a space', () => {
    const text = '@alice ';
    expect(detectMention(text, text.length)).toBeNull();
  });

  it('does not treat an email @ as a mention', () => {
    const text = 'bob@example';
    expect(detectMention(text, text.length)).toBeNull();
  });

  it('only considers the token immediately before the caret', () => {
    const text = '@bob and @ca';
    expect(detectMention(text, text.length)).toEqual({ at: 9, query: 'ca' });
  });

  it('returns null when the caret is not inside a mention', () => {
    expect(detectMention('nothing here', 5)).toBeNull();
  });
});

describe('applyMention', () => {
  it('replaces the @query token with @username and a trailing space', () => {
    const text = 'hey @al done';
    const { value, caret } = applyMention(text, 4, 7, 'alice');
    expect(value).toBe('hey @alice  done');
    expect(caret).toBe('hey @alice '.length);
  });

  it('works when the mention is at the very end', () => {
    const text = 'cc @b';
    const { value, caret } = applyMention(text, 3, 5, 'bob');
    expect(value).toBe('cc @bob ');
    expect(caret).toBe('cc @bob '.length);
  });
});

describe('filterMentionMembers', () => {
  const members: MentionMember[] = [
    { id: '1', username: 'alice', fullName: 'Alice Adams' },
    { id: '2', username: 'bob', fullName: 'Bob Brown' },
    { id: '3', username: 'carol', fullName: 'Carol Alvarez' },
  ];

  it('returns all members (capped) for an empty query', () => {
    expect(filterMentionMembers(members, '').map(m => m.id)).toEqual(['1', '2', '3']);
  });

  it('ranks username prefix matches ahead of full-name substring matches', () => {
    // "al" prefixes alice's username and appears in Carol's full name (Alvarez).
    const out = filterMentionMembers(members, 'al').map(m => m.username);
    expect(out[0]).toBe('alice');
    expect(out).toContain('carol');
  });

  it('is case-insensitive', () => {
    expect(filterMentionMembers(members, 'BOB').map(m => m.username)).toEqual(['bob']);
  });

  it('respects the result limit', () => {
    expect(filterMentionMembers(members, '', 2)).toHaveLength(2);
  });
});
