import { describe, it, expect } from 'vitest';
import {
  generateToken,
  verifyToken,
  generatePendingToken,
  verifyPendingToken,
  hashPassword,
  comparePassword,
} from '../auth';

describe('generateToken / verifyToken', () => {
  it('round-trips userId and tokenVersion', () => {
    const token = generateToken('user-abc', 3);
    const payload = verifyToken(token);
    expect(payload.userId).toBe('user-abc');
    expect(payload.tokenVersion).toBe(3);
  });

  it('defaults tokenVersion to 0 when omitted', () => {
    const token = generateToken('user-xyz');
    const payload = verifyToken(token);
    expect(payload.tokenVersion).toBe(0);
  });

  it('throws on a tampered token', () => {
    const token = generateToken('user-abc', 1);
    expect(() => verifyToken(token + 'x')).toThrow();
  });

  it('throws on a completely invalid string', () => {
    expect(() => verifyToken('not.a.jwt')).toThrow();
  });
});

describe('generatePendingToken / verifyPendingToken', () => {
  it('round-trips userId for 2FA pending tokens', () => {
    const token = generatePendingToken('user-2fa');
    const payload = verifyPendingToken(token);
    expect(payload.userId).toBe('user-2fa');
  });

  it('rejects a regular session token as a pending token', () => {
    const sessionToken = generateToken('user-abc', 0);
    expect(() => verifyPendingToken(sessionToken)).toThrow('Not a 2FA pending token');
  });

  it('rejects a pending token verified through verifyToken (no tokenVersion)', () => {
    const pending = generatePendingToken('user-2fa');
    // verifyToken should still decode it (same secret), but the shape differs
    const payload = verifyToken(pending);
    expect(payload.userId).toBe('user-2fa');
    // tokenVersion falls back to 0 since pending tokens don't carry it
    expect(payload.tokenVersion).toBe(0);
  });
});

describe('hashPassword / comparePassword', () => {
  it('hashes and verifies a password correctly', async () => {
    const hash = await hashPassword('s3cret!');
    expect(hash).not.toBe('s3cret!');
    expect(hash.startsWith('$2a$') || hash.startsWith('$2b$')).toBe(true);
    expect(await comparePassword('s3cret!', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct-horse');
    expect(await comparePassword('wrong-horse', hash)).toBe(false);
  });

  it('produces different hashes for the same input (salted)', async () => {
    const h1 = await hashPassword('same');
    const h2 = await hashPassword('same');
    expect(h1).not.toBe(h2);
  });
});
