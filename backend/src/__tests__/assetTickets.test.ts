// ---------------------------------------------------------------------------
// S4 — short-lived asset tickets replacing long-lived JWTs in URLs (SSE
// connect, markdown-page / Knowledge-Base image <img> tags).
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mintAssetTicket,
  consumeAssetTicket,
  isValidAssetTicketScope,
  sweepExpiredAssetTickets,
  __clearAllAssetTicketsForTests,
} from '../assetTickets';

beforeEach(() => { __clearAllAssetTicketsForTests(); vi.useRealTimers(); });
afterEach(() => { __clearAllAssetTicketsForTests(); vi.useRealTimers(); });

describe('isValidAssetTicketScope', () => {
  it('accepts the sse scope', () => expect(isValidAssetTicketScope('sse')).toBe(true));
  it('accepts a well-formed mdimg/kbimg scope', () => {
    expect(isValidAssetTicketScope('mdimg:list_abc123')).toBe(true);
    expect(isValidAssetTicketScope('kbimg:entry-xyz_789')).toBe(true);
  });
  it('rejects an arbitrary/unrecognized scope string — not a general-purpose bearer substitute', () => {
    expect(isValidAssetTicketScope('anything-goes')).toBe(false);
    expect(isValidAssetTicketScope('admin')).toBe(false);
    expect(isValidAssetTicketScope('')).toBe(false);
  });
  it('rejects a scope with an embedded colon/path-traversal-looking id', () => {
    expect(isValidAssetTicketScope('mdimg:../../etc/passwd')).toBe(false);
    expect(isValidAssetTicketScope('mdimg:a:b:c')).toBe(false);
  });
});

describe('mintAssetTicket / consumeAssetTicket', () => {
  it('a minted ticket is redeemable for its OWN scope and returns the minting user', () => {
    const { ticket } = mintAssetTicket('user-1', 'mdimg:list_a');
    const result = consumeAssetTicket(ticket, 'mdimg:list_a');
    expect(result).toEqual({ userId: 'user-1' });
  });

  it('rejects a ticket redeemed against a DIFFERENT scope — one image cannot unlock another document', () => {
    const { ticket } = mintAssetTicket('user-1', 'mdimg:list_a');
    expect(consumeAssetTicket(ticket, 'mdimg:list_b')).toBeNull();
    expect(consumeAssetTicket(ticket, 'sse')).toBeNull();
    expect(consumeAssetTicket(ticket, 'kbimg:list_a')).toBeNull();
  });

  it('rejects an unknown/garbage ticket string', () => {
    expect(consumeAssetTicket('not-a-real-ticket', 'sse')).toBeNull();
  });

  it('the `sse` scope is single-use — a second redemption of the same ticket fails', () => {
    const { ticket } = mintAssetTicket('user-1', 'sse');
    expect(consumeAssetTicket(ticket, 'sse')).toEqual({ userId: 'user-1' });
    expect(consumeAssetTicket(ticket, 'sse')).toBeNull();
  });

  it('an image-scope ticket IS reusable within its TTL (multiple <img> tags / a retry / a second tab)', () => {
    const { ticket } = mintAssetTicket('user-1', 'mdimg:list_a');
    expect(consumeAssetTicket(ticket, 'mdimg:list_a')).toEqual({ userId: 'user-1' });
    expect(consumeAssetTicket(ticket, 'mdimg:list_a')).toEqual({ userId: 'user-1' });
    expect(consumeAssetTicket(ticket, 'mdimg:list_a')).toEqual({ userId: 'user-1' });
  });

  it('an sse ticket expires after ~60s (short TTL, unlike the 30-day JWT it replaces)', () => {
    vi.useFakeTimers();
    const { ticket, expiresAt } = mintAssetTicket('user-1', 'sse');
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(60_000);
    vi.advanceTimersByTime(61_000);
    expect(consumeAssetTicket(ticket, 'sse')).toBeNull();
  });

  it('an image ticket expires after ~5 minutes', () => {
    vi.useFakeTimers();
    const { ticket, expiresAt } = mintAssetTicket('user-1', 'mdimg:list_a');
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    vi.advanceTimersByTime(5 * 60_000 + 1000);
    expect(consumeAssetTicket(ticket, 'mdimg:list_a')).toBeNull();
  });

  it('tickets minted for different users never collide', () => {
    const a = mintAssetTicket('user-a', 'mdimg:list_shared');
    const b = mintAssetTicket('user-b', 'mdimg:list_shared');
    expect(a.ticket).not.toBe(b.ticket);
    expect(consumeAssetTicket(a.ticket, 'mdimg:list_shared')).toEqual({ userId: 'user-a' });
    expect(consumeAssetTicket(b.ticket, 'mdimg:list_shared')).toEqual({ userId: 'user-b' });
  });

  it('sweepExpiredAssetTickets removes an abandoned (never-consumed) expired ticket', () => {
    vi.useFakeTimers();
    const { ticket } = mintAssetTicket('user-1', 'mdimg:list_a');
    vi.advanceTimersByTime(6 * 60_000);
    sweepExpiredAssetTickets();
    expect(consumeAssetTicket(ticket, 'mdimg:list_a')).toBeNull();
  });
});
