// ---------------------------------------------------------------------------
// S5 — /mcp concurrency cap (mcpLimits.ts). The rate-limiting side of S5's
// MCP fix is exercised via express-rate-limit itself (a well-tested library;
// see mcpLimiter's keyGenerator wiring in index.ts, unit-testable here only
// through mcpTokenKey, its actual security-relevant logic); this file covers
// mcpTokenKey's key-derivation and the concurrency-slot bookkeeping.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from 'vitest';
import { hashApiToken } from '../apiToken';
import {
  mcpTokenKey,
  acquireMcpSlot,
  releaseMcpSlot,
  __mcpInFlightForTests,
  __clearMcpSlotsForTests,
} from '../mcpLimits';

afterEach(() => { __clearMcpSlotsForTests(); });

describe('mcpTokenKey', () => {
  it('returns null when there is no Authorization header', () => {
    expect(mcpTokenKey(undefined)).toBeNull();
  });

  it('returns null for a non-Bearer scheme', () => {
    expect(mcpTokenKey('Basic dXNlcjpwYXNz')).toBeNull();
  });

  it('returns null for a Bearer header with no token', () => {
    expect(mcpTokenKey('Bearer ')).toBeNull();
    expect(mcpTokenKey('Bearer    ')).toBeNull();
  });

  it('returns the SHA-256 hash of the raw token for a valid PAT', () => {
    const raw = 'solytiq_pat_abc123';
    expect(mcpTokenKey(`Bearer ${raw}`)).toBe(hashApiToken(raw));
  });

  it('hashes garbage/guessed tokens too, so a guessing attempt gets its own bucket rather than a shared one', () => {
    const key1 = mcpTokenKey('Bearer totally-made-up-guess-1');
    const key2 = mcpTokenKey('Bearer totally-made-up-guess-2');
    expect(key1).not.toBeNull();
    expect(key2).not.toBeNull();
    expect(key1).not.toBe(key2);
  });

  it('is deterministic — the same raw token always yields the same key', () => {
    const raw = 'solytiq_pat_same_value';
    expect(mcpTokenKey(`Bearer ${raw}`)).toBe(mcpTokenKey(`Bearer ${raw}`));
  });

  it('never returns the raw token itself (the key must not be usable to reconstruct the credential)', () => {
    const raw = 'solytiq_pat_super_secret_value';
    expect(mcpTokenKey(`Bearer ${raw}`)).not.toContain(raw);
  });
});

describe('acquireMcpSlot / releaseMcpSlot (concurrency cap)', () => {
  it('allows up to the concurrency cap (4) simultaneous slots for one key', () => {
    const key = 'k1';
    expect(acquireMcpSlot(key)).toBe(true);
    expect(acquireMcpSlot(key)).toBe(true);
    expect(acquireMcpSlot(key)).toBe(true);
    expect(acquireMcpSlot(key)).toBe(true);
    expect(__mcpInFlightForTests(key)).toBe(4);
  });

  it('rejects the 5th concurrent request for the same key', () => {
    const key = 'k2';
    for (let i = 0; i < 4; i++) expect(acquireMcpSlot(key)).toBe(true);
    expect(acquireMcpSlot(key)).toBe(false);
    expect(__mcpInFlightForTests(key)).toBe(4);
  });

  it('releasing a slot allows a new request in', () => {
    const key = 'k3';
    for (let i = 0; i < 4; i++) expect(acquireMcpSlot(key)).toBe(true);
    expect(acquireMcpSlot(key)).toBe(false);
    releaseMcpSlot(key);
    expect(acquireMcpSlot(key)).toBe(true);
  });

  it('different keys have independent budgets — one client cannot exhaust another\'s', () => {
    const keyA = 'clientA';
    const keyB = 'clientB';
    for (let i = 0; i < 4; i++) expect(acquireMcpSlot(keyA)).toBe(true);
    expect(acquireMcpSlot(keyA)).toBe(false);
    // keyB is completely unaffected by keyA being exhausted.
    expect(acquireMcpSlot(keyB)).toBe(true);
  });

  it('releasing more times than acquired never goes negative / never poisons the map', () => {
    const key = 'k4';
    releaseMcpSlot(key);
    releaseMcpSlot(key);
    expect(__mcpInFlightForTests(key)).toBe(0);
    // Still fully usable afterward.
    expect(acquireMcpSlot(key)).toBe(true);
    expect(__mcpInFlightForTests(key)).toBe(1);
  });

  it('__clearMcpSlotsForTests resets all tracked keys', () => {
    acquireMcpSlot('a');
    acquireMcpSlot('b');
    __clearMcpSlotsForTests();
    expect(__mcpInFlightForTests('a')).toBe(0);
    expect(__mcpInFlightForTests('b')).toBe(0);
  });
});
