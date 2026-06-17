import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const JWT_SECRET_ENV = process.env.JWT_SECRET;
const INSECURE_DEFAULTS = ['changeme-secret', 'change_this_secret_in_production', 'change_this_to_a_long_random_secret', 'solytiq_secret'];
if (!JWT_SECRET_ENV || INSECURE_DEFAULTS.includes(JWT_SECRET_ENV)) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set to a secure, non-default value in production!');
  }
  console.warn('⚠️  WARNING: JWT_SECRET is not set or uses an insecure default. Set a strong secret before deploying.');
}
const JWT_SECRET = JWT_SECRET_ENV || 'changeme-secret';

export function generateToken(userId: string, tokenVersion: number = 0): string {
  return jwt.sign({ userId, tokenVersion }, JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token: string): { userId: string; tokenVersion: number } {
  const payload = jwt.verify(token, JWT_SECRET) as { userId: string; tokenVersion?: number };
  return { userId: payload.userId, tokenVersion: payload.tokenVersion ?? 0 };
}

export function generatePendingToken(userId: string): string {
  return jwt.sign({ userId, p2fa: true }, JWT_SECRET, { expiresIn: '5m' });
}

export function verifyPendingToken(token: string): { userId: string } {
  const payload = jwt.verify(token, JWT_SECRET) as { userId: string; p2fa?: boolean };
  if (!payload.p2fa) throw new Error('Not a 2FA pending token');
  return { userId: payload.userId };
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function comparePassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
