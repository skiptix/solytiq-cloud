// ---------------------------------------------------------------------------
// S5 — proxy trust boundary (proxyTrust.ts). `CF-Connecting-IP` must never be
// trusted by default (see the block comment above `clientKey` in index.ts) —
// these tests exercise the pure decision functions directly, no HTTP/DB
// needed. Each function accepts an injectable `env` object specifically so
// these tests never have to touch the real `process.env`.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { isCfConnectingIpTrusted, resolveClientIp, resolveTrustProxyHops } from '../proxyTrust';

describe('isCfConnectingIpTrusted', () => {
  it('defaults to false when TRUST_CF_CONNECTING_IP is unset', () => {
    expect(isCfConnectingIpTrusted({})).toBe(false);
  });

  it('is false for any value other than the exact string "true"', () => {
    expect(isCfConnectingIpTrusted({ TRUST_CF_CONNECTING_IP: 'false' })).toBe(false);
    expect(isCfConnectingIpTrusted({ TRUST_CF_CONNECTING_IP: '1' })).toBe(false);
    expect(isCfConnectingIpTrusted({ TRUST_CF_CONNECTING_IP: 'TRUE' })).toBe(false);
    expect(isCfConnectingIpTrusted({ TRUST_CF_CONNECTING_IP: 'yes' })).toBe(false);
  });

  it('is true only for the exact string "true"', () => {
    expect(isCfConnectingIpTrusted({ TRUST_CF_CONNECTING_IP: 'true' })).toBe(true);
  });
});

describe('resolveClientIp', () => {
  it('falls back to reqIp when trustCf is false, even if the header is present', () => {
    expect(resolveClientIp('9.9.9.9', '1.2.3.4', false)).toBe('1.2.3.4');
  });

  it('uses the header when trustCf is true and the header is a non-empty string', () => {
    expect(resolveClientIp('9.9.9.9', '1.2.3.4', true)).toBe('9.9.9.9');
  });

  it('falls back to reqIp when trustCf is true but the header is absent', () => {
    expect(resolveClientIp(undefined, '1.2.3.4', true)).toBe('1.2.3.4');
  });

  it('falls back to reqIp when trustCf is true but the header arrived as an array (repeated header — still attacker-controlled, never trusted)', () => {
    expect(resolveClientIp(['9.9.9.9', '8.8.8.8'], '1.2.3.4', true)).toBe('1.2.3.4');
  });

  it('falls back to reqIp when trustCf is true but the header is an empty string', () => {
    expect(resolveClientIp('', '1.2.3.4', true)).toBe('1.2.3.4');
  });

  it('returns an empty string when neither the header nor reqIp is available', () => {
    expect(resolveClientIp(undefined, undefined, true)).toBe('');
    expect(resolveClientIp(undefined, undefined, false)).toBe('');
  });
});

describe('resolveTrustProxyHops', () => {
  it('defaults to 1 (this repo\'s shipped nginx-in-front-of-backend topology) when unset', () => {
    expect(resolveTrustProxyHops({})).toBe(1);
  });

  it('parses a valid non-negative override', () => {
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '2' })).toBe(2);
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '0' })).toBe(0);
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '5' })).toBe(5);
  });

  it('falls back to 1 for a non-numeric value', () => {
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: 'not-a-number' })).toBe(1);
  });

  it('falls back to 1 for a negative value', () => {
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '-1' })).toBe(1);
  });

  it('falls back to 1 for an empty string', () => {
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '' })).toBe(1);
  });
});
