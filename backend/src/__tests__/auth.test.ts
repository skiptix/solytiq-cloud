import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  generateToken,
  verifyToken,
  generatePendingToken,
  verifyPendingToken,
  hashPassword,
  comparePassword
} from '../auth';

const JWT_SECRET = process.env.JWT_SECRET || 'changeme-secret';

describe('Auth functions', () => {
  describe('Tokens', () => {
    it('should generate and verify a token', () => {
      const token = generateToken('user123', 5);
      const decoded = verifyToken(token);
      expect(decoded.userId).toBe('user123');
      expect(decoded.tokenVersion).toBe(5);
    });

    it('should default tokenVersion to 0 if not provided when verified', () => {
      // Create a token without tokenVersion manually
      const token = jwt.sign({ userId: 'user456' }, JWT_SECRET);
      const decoded = verifyToken(token);
      expect(decoded.userId).toBe('user456');
      expect(decoded.tokenVersion).toBe(0);
    });

    it('should throw when verifying an invalid token', () => {
      expect(() => verifyToken('invalid-token')).toThrow();
    });

    it('should generate and verify a pending token', () => {
      const token = generatePendingToken('user789');
      const decoded = verifyPendingToken(token);
      expect(decoded.userId).toBe('user789');
    });

    it('should throw when verifying a pending token without p2fa set', () => {
      const token = jwt.sign({ userId: 'user789' }, JWT_SECRET);
      expect(() => verifyPendingToken(token)).toThrow('Not a 2FA pending token');
    });
  });

  describe('Passwords', () => {
    it('should hash and verify a password', async () => {
      const hash = await hashPassword('my-secret-password');
      const isValid = await comparePassword('my-secret-password', hash);
      expect(isValid).toBe(true);
    });

    it('should reject an incorrect password', async () => {
      const hash = await hashPassword('my-secret-password');
      const isValid = await comparePassword('wrong-password', hash);
      expect(isValid).toBe(false);
    });
  });
});
