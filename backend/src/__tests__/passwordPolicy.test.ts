import { describe, expect, it } from 'vitest';
import { validatePassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '../passwordPolicy';

describe('validatePassword (S3 shared password policy)', () => {
  it('rejects a one-character password — the pre-fix setup-wizard gap', () => {
    const result = validatePassword('a');
    expect(result.ok).toBe(false);
  });

  it('rejects an empty password', () => {
    expect(validatePassword('').ok).toBe(false);
  });

  it('rejects missing/non-string input without throwing', () => {
    expect(validatePassword(undefined).ok).toBe(false);
    expect(validatePassword(null).ok).toBe(false);
    expect(validatePassword(12345678).ok).toBe(false);
  });

  it(`rejects a password one character below the minimum (${MIN_PASSWORD_LENGTH})`, () => {
    expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1)).ok).toBe(false);
  });

  it(`accepts a password exactly at the minimum (${MIN_PASSWORD_LENGTH})`, () => {
    expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH)).ok).toBe(true);
  });

  it(`rejects a password beyond the maximum (${MAX_PASSWORD_LENGTH}) — bcrypt-truncation DoS guard`, () => {
    expect(validatePassword('a'.repeat(MAX_PASSWORD_LENGTH + 1)).ok).toBe(false);
  });

  it(`accepts a password exactly at the maximum (${MAX_PASSWORD_LENGTH})`, () => {
    expect(validatePassword('a'.repeat(MAX_PASSWORD_LENGTH)).ok).toBe(true);
  });

  it('accepts an ordinary real-world passphrase', () => {
    expect(validatePassword('correct horse battery staple').ok).toBe(true);
  });
});
