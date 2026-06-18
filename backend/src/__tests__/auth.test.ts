import { describe, it, expect } from 'vitest';
import { hashPassword, comparePassword } from '../auth';

describe('auth utilities', () => {
  describe('hashPassword and comparePassword', () => {
    it('should hash a password to a different string', async () => {
      const password = 'mySecretPassword';
      const hash = await hashPassword(password);
      expect(hash).not.toBe(password);
      expect(hash).toBeTypeOf('string');
    });

    it('should return true when comparing a valid password and hash', async () => {
      const password = 'mySecretPassword';
      const hash = await hashPassword(password);
      const isValid = await comparePassword(password, hash);
      expect(isValid).toBe(true);
    });

    it('should return false when comparing an invalid password and hash', async () => {
      const password = 'mySecretPassword';
      const wrongPassword = 'wrongPassword';
      const hash = await hashPassword(password);
      const isValid = await comparePassword(wrongPassword, hash);
      expect(isValid).toBe(false);
    });

    it('should generate different hashes for the same password but both should be valid', async () => {
      const password = 'mySecretPassword';
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);
      expect(hash1).not.toBe(hash2);

      const isValid1 = await comparePassword(password, hash1);
      const isValid2 = await comparePassword(password, hash2);
      expect(isValid1).toBe(true);
      expect(isValid2).toBe(true);
    });
  });
});
