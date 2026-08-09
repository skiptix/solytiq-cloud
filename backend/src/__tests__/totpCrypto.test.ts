// ---------------------------------------------------------------------------
// S3 — TOTP secret encryption at rest. Before this module existed,
// `users.totp_secret` was stored in PLAIN TEXT: a database leak (or a
// read-only SQL injection anywhere else in the app) handed an attacker every
// enrolled user's raw TOTP seed, letting them generate valid 6-digit codes
// indefinitely with no access to the user's phone at all.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptTotpSecret, decryptTotpSecret, isEncryptedTotpSecret } from '../totpCrypto';

const ORIGINAL_TOTP_KEY = process.env.TOTP_ENCRYPTION_KEY;
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

afterEach(() => {
  process.env.TOTP_ENCRYPTION_KEY = ORIGINAL_TOTP_KEY;
  process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
});

describe('encryptTotpSecret / decryptTotpSecret', () => {
  it('round-trips a real otplib-shaped secret', () => {
    const plain = 'NQCWSDY7E44V6W2P';
    const stored = encryptTotpSecret(plain);
    expect(stored).not.toBe(plain);
    expect(decryptTotpSecret(stored)).toBe(plain);
  });

  it('never stores the plaintext secret as a substring of the ciphertext', () => {
    const plain = 'SUPERSECRETTOTPSEED1234';
    const stored = encryptTotpSecret(plain);
    expect(stored).not.toContain(plain);
  });

  it('is tagged with the enc:v1: prefix', () => {
    const stored = encryptTotpSecret('ABCDEFGHIJKLMNOP');
    expect(isEncryptedTotpSecret(stored)).toBe(true);
    expect(stored.startsWith('enc:v1:')).toBe(true);
  });

  it('produces different ciphertext for the same plaintext on repeated calls (random IV)', () => {
    const plain = 'ABCDEFGHIJKLMNOP';
    const a = encryptTotpSecret(plain);
    const b = encryptTotpSecret(plain);
    expect(a).not.toBe(b);
    expect(decryptTotpSecret(a)).toBe(plain);
    expect(decryptTotpSecret(b)).toBe(plain);
  });

  it('treats a still-plaintext legacy value as already "decrypted" (backward-compat with pre-encryption rows)', () => {
    const legacyPlain = 'LEGACYPLAINTEXTSECRET12';
    expect(isEncryptedTotpSecret(legacyPlain)).toBe(false);
    expect(decryptTotpSecret(legacyPlain)).toBe(legacyPlain);
  });

  it('rejects a tampered ciphertext (GCM auth tag catches modification, not just hides the secret)', () => {
    const stored = encryptTotpSecret('ABCDEFGHIJKLMNOP');
    // Flip one character deep in the base64url payload — corrupts either the
    // ciphertext or the auth tag depending on position, either way GCM must
    // reject it rather than silently returning wrong/garbage plaintext.
    const tampered = stored.slice(0, -4) + (stored.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    expect(() => decryptTotpSecret(tampered)).toThrow();
  });

  it('derives a usable key purely from JWT_SECRET when no dedicated TOTP_ENCRYPTION_KEY is set', () => {
    delete process.env.TOTP_ENCRYPTION_KEY;
    process.env.JWT_SECRET = 'a-sufficiently-long-jwt-secret-for-this-test-1234567890';
    const stored = encryptTotpSecret('ROUNDTRIPSECRET1234');
    expect(decryptTotpSecret(stored)).toBe('ROUNDTRIPSECRET1234');
  });

  it('a value encrypted under one key cannot be decrypted under a different key', () => {
    process.env.TOTP_ENCRYPTION_KEY = 'key-one-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const stored = encryptTotpSecret('CROSSKEYTEST12345678');
    process.env.TOTP_ENCRYPTION_KEY = 'key-two-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';
    expect(() => decryptTotpSecret(stored)).toThrow();
  });
});
