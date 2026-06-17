import { describe, it, expect } from 'vitest';
import { hashApiToken, generateApiToken } from '../apiToken';

describe('hashApiToken', () => {
  it('returns a 64-char hex SHA-256 digest', () => {
    const hash = hashApiToken('solytiq_pat_test123');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', () => {
    const a = hashApiToken('solytiq_pat_abc');
    const b = hashApiToken('solytiq_pat_abc');
    expect(a).toBe(b);
  });

  it('produces different hashes for different inputs', () => {
    const a = hashApiToken('solytiq_pat_one');
    const b = hashApiToken('solytiq_pat_two');
    expect(a).not.toBe(b);
  });
});

describe('generateApiToken', () => {
  it('returns raw, hash, and prefix fields', () => {
    const tok = generateApiToken();
    expect(tok.raw).toBeDefined();
    expect(tok.hash).toBeDefined();
    expect(tok.prefix).toBeDefined();
  });

  it('raw starts with solytiq_pat_ prefix', () => {
    const tok = generateApiToken();
    expect(tok.raw.startsWith('solytiq_pat_')).toBe(true);
  });

  it('hash matches the SHA-256 of raw', () => {
    const tok = generateApiToken();
    expect(tok.hash).toBe(hashApiToken(tok.raw));
  });

  it('prefix is a truncated version of raw ending with …', () => {
    const tok = generateApiToken();
    expect(tok.prefix.endsWith('…')).toBe(true);
    // prefix starts with the same chars as raw
    const prefixWithout = tok.prefix.slice(0, -1);
    expect(tok.raw.startsWith(prefixWithout)).toBe(true);
  });

  it('generates unique tokens on each call', () => {
    const a = generateApiToken();
    const b = generateApiToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });
});
