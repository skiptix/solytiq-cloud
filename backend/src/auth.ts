import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const JWT_SECRET_ENV = process.env.JWT_SECRET;
if (process.env.NODE_ENV === 'production') {
  if (!JWT_SECRET_ENV || JWT_SECRET_ENV === 'changeme-secret' || JWT_SECRET_ENV === 'change_this_secret_in_production' || JWT_SECRET_ENV === 'solytiq_secret') {
    throw new Error('JWT_SECRET must be set to a secure, non-default value in production!');
  }
}
const JWT_SECRET = JWT_SECRET_ENV || 'changeme-secret';

export function generateToken(userId: string, tokenVersion: number = 0, connectionId?: string): string {
  const payload: Record<string, unknown> = { userId, tokenVersion };
  // Mobile-app sessions carry the id of their `mobile_connections` row so the
  // connection can be listed and individually revoked (see middleware.ts).
  if (connectionId) payload.connectionId = connectionId;
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token: string): { userId: string; tokenVersion: number; connectionId?: string } {
  const payload = jwt.verify(token, JWT_SECRET) as { userId: string; tokenVersion?: number; connectionId?: string };
  return { userId: payload.userId, tokenVersion: payload.tokenVersion ?? 0, connectionId: payload.connectionId };
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
