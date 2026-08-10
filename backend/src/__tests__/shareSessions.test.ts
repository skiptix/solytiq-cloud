// ---------------------------------------------------------------------------
// S4 — public share-link session tickets (shareSessions.ts), the anonymous
// counterpart to assetTickets.ts, used to replace `?password=` on every
// public share content/download/image request.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintShareSession, isValidShareSession, sweepExpiredShareSessions, __clearAllShareSessionsForTests } from '../shareSessions';

beforeEach(() => { __clearAllShareSessionsForTests(); vi.useRealTimers(); });
afterEach(() => { __clearAllShareSessionsForTests(); vi.useRealTimers(); });

describe('mintShareSession / isValidShareSession', () => {
  it('a minted session is valid for its own (kind, token) pair', () => {
    const { session } = mintShareSession('list', 'list_a');
    expect(isValidShareSession(session, 'list', 'list_a')).toBe(true);
  });

  it('rejects the session for a different token', () => {
    const { session } = mintShareSession('list', 'list_a');
    expect(isValidShareSession(session, 'list', 'list_b')).toBe(false);
  });

  it('rejects the session for a different kind, even with the same token string', () => {
    const { session } = mintShareSession('list', 'shared_token_1');
    expect(isValidShareSession(session, 'timeline', 'shared_token_1')).toBe(false);
    expect(isValidShareSession(session, 'folder', 'shared_token_1')).toBe(false);
    expect(isValidShareSession(session, 'markdownList', 'shared_token_1')).toBe(false);
    expect(isValidShareSession(session, 'file', 'shared_token_1')).toBe(false);
  });

  it('rejects an unknown session string', () => {
    expect(isValidShareSession('not-a-real-session', 'list', 'list_a')).toBe(false);
  });

  it('is reusable within its TTL (a visitor reloading/navigating the shared page repeatedly)', () => {
    const { session } = mintShareSession('list', 'list_a');
    expect(isValidShareSession(session, 'list', 'list_a')).toBe(true);
    expect(isValidShareSession(session, 'list', 'list_a')).toBe(true);
    expect(isValidShareSession(session, 'list', 'list_a')).toBe(true);
  });

  it('expires after its TTL (~1 hour)', () => {
    vi.useFakeTimers();
    const { session, expiresAt } = mintShareSession('list', 'list_a');
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(60 * 60_000);
    vi.advanceTimersByTime(60 * 60_000 + 1000);
    expect(isValidShareSession(session, 'list', 'list_a')).toBe(false);
  });

  it('sweepExpiredShareSessions removes an abandoned expired session', () => {
    vi.useFakeTimers();
    const { session } = mintShareSession('list', 'list_a');
    vi.advanceTimersByTime(61 * 60_000);
    sweepExpiredShareSessions();
    expect(isValidShareSession(session, 'list', 'list_a')).toBe(false);
  });

  it('two mints for the same (kind, token) produce different, independently-valid sessions', () => {
    const a = mintShareSession('list', 'list_a');
    const b = mintShareSession('list', 'list_a');
    expect(a.session).not.toBe(b.session);
    expect(isValidShareSession(a.session, 'list', 'list_a')).toBe(true);
    expect(isValidShareSession(b.session, 'list', 'list_a')).toBe(true);
  });
});
