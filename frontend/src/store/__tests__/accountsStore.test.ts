import { describe, expect, it } from 'vitest';
import {
  isSessionFresh,
  pruneAccounts,
  upsertAccount,
  removeAccount,
  SESSION_MAX_AGE_MS,
  type StoredAccount,
} from '../useAccountsStore';

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0);

function acct(userId: string, overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    userId,
    username: userId,
    fullName: `${userId} name`,
    email: `${userId}@example.com`,
    profileImage: null,
    isAdmin: false,
    token: `token-${userId}`,
    addedAt: NOW,
    ...overrides,
  };
}

describe('isSessionFresh', () => {
  it('accepts a session inside the 30-day window', () => {
    expect(isSessionFresh(acct('a', { addedAt: NOW - 29 * 24 * 3600_000 }), NOW)).toBe(true);
  });

  it('rejects a session once the 30-day window has elapsed', () => {
    expect(isSessionFresh(acct('a', { addedAt: NOW - SESSION_MAX_AGE_MS }), NOW)).toBe(false);
    expect(isSessionFresh(acct('a', { addedAt: NOW - SESSION_MAX_AGE_MS - 1 }), NOW)).toBe(false);
  });
});

describe('pruneAccounts', () => {
  it('drops only the entries past their window', () => {
    const fresh = acct('fresh', { addedAt: NOW - 1000 });
    const stale = acct('stale', { addedAt: NOW - SESSION_MAX_AGE_MS - 1 });
    expect(pruneAccounts([fresh, stale], NOW)).toEqual([fresh]);
  });

  it('is a no-op when everything is fresh', () => {
    const list = [acct('a'), acct('b')];
    expect(pruneAccounts(list, NOW)).toEqual(list);
  });
});

describe('upsertAccount', () => {
  it('appends a genuinely new account', () => {
    const result = upsertAccount([acct('a')], acct('b'));
    expect(result.map(a => a.userId)).toEqual(['a', 'b']);
  });

  it('replaces an existing account in place, keeping list order stable', () => {
    const result = upsertAccount(
      [acct('a'), acct('b'), acct('c')],
      acct('b', { token: 'refreshed', fullName: 'Renamed' })
    );
    expect(result.map(a => a.userId)).toEqual(['a', 'b', 'c']);
    expect(result[1].token).toBe('refreshed');
    expect(result[1].fullName).toBe('Renamed');
  });

  it('never stores the same user twice', () => {
    let list = [acct('a')];
    list = upsertAccount(list, acct('a', { token: 't2' }));
    list = upsertAccount(list, acct('a', { token: 't3' }));
    expect(list).toHaveLength(1);
    expect(list[0].token).toBe('t3');
  });
});

describe('removeAccount', () => {
  it('drops the named account and leaves the rest untouched', () => {
    const result = removeAccount([acct('a'), acct('b')], 'a');
    expect(result.map(x => x.userId)).toEqual(['b']);
  });

  it('is a no-op for an unknown id', () => {
    const list = [acct('a')];
    expect(removeAccount(list, 'nope')).toEqual(list);
  });
});
