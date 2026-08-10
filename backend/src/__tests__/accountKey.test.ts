// ---------------------------------------------------------------------------
// S5 — account-scoped login rate-limit keys (accountKey.ts). Pure functions,
// no DB/JWT-secret setup needed — verifyFn is injected for twoFaAccountKey
// specifically so this file never has to construct a real pending token.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest';
import { normalizeAccountIdentifier, loginAccountKey, twoFaAccountKey } from '../accountKey';

describe('normalizeAccountIdentifier', () => {
  it('lowercases and trims', () => {
    expect(normalizeAccountIdentifier('  Alice@Example.com  ')).toBe('alice@example.com');
  });

  it('returns null for undefined/null/empty/whitespace-only input', () => {
    expect(normalizeAccountIdentifier(undefined)).toBeNull();
    expect(normalizeAccountIdentifier(null)).toBeNull();
    expect(normalizeAccountIdentifier('')).toBeNull();
    expect(normalizeAccountIdentifier('   ')).toBeNull();
  });
});

describe('loginAccountKey', () => {
  it('prefers username over email when both are present', () => {
    expect(loginAccountKey('alice', 'someone-else@example.com')).toBe('acct:alice');
  });

  it('falls back to email when username is absent', () => {
    expect(loginAccountKey(undefined, 'Bob@Example.com')).toBe('acct:bob@example.com');
  });

  it('two different-case/whitespace submissions of the same account collapse to the same key', () => {
    expect(loginAccountKey('  Alice  ', undefined)).toBe(loginAccountKey('alice', undefined));
    expect(loginAccountKey(undefined, 'ALICE@EXAMPLE.COM')).toBe(loginAccountKey(undefined, 'alice@example.com'));
  });

  it('returns null when neither username nor email is present (nothing to protect — the route 400s this itself)', () => {
    expect(loginAccountKey(undefined, undefined)).toBeNull();
    expect(loginAccountKey('', '')).toBeNull();
  });

  it('a distributed attack against one account (many IPs, same username) always keys the same', () => {
    const attempts = ['1.2.3.4', '5.6.7.8', '9.9.9.9'].map(() => loginAccountKey('victim', undefined));
    expect(new Set(attempts).size).toBe(1);
  });
});

describe('twoFaAccountKey', () => {
  it('returns an acct-prefixed key from a valid pending token', () => {
    const verifyFn = vi.fn().mockReturnValue({ userId: 'user-123' });
    expect(twoFaAccountKey('some-token', verifyFn)).toBe('acct:user-123');
    expect(verifyFn).toHaveBeenCalledWith('some-token');
  });

  it('returns null when pendingToken is absent', () => {
    const verifyFn = vi.fn();
    expect(twoFaAccountKey(undefined, verifyFn)).toBeNull();
    expect(twoFaAccountKey(null, verifyFn)).toBeNull();
    expect(verifyFn).not.toHaveBeenCalled();
  });

  it('returns null (never throws) when verifyFn throws — an expired/invalid/malformed token', () => {
    const verifyFn = vi.fn().mockImplementation(() => { throw new Error('jwt expired'); });
    expect(() => twoFaAccountKey('bad-token', verifyFn)).not.toThrow();
    expect(twoFaAccountKey('bad-token', verifyFn)).toBeNull();
  });

  it('returns null if verifyFn somehow returns an empty userId', () => {
    const verifyFn = vi.fn().mockReturnValue({ userId: '' });
    expect(twoFaAccountKey('token', verifyFn)).toBeNull();
  });
});
