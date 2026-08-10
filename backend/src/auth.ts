import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const JWT_SECRET_ENV = process.env.JWT_SECRET;
// SECURITY (S3): the placeholder-string check alone doesn't stop a weak
// secret — `JWT_SECRET=x` or `JWT_SECRET=12345` passes it outright and is
// then brute-forceable offline against any captured token, forging a session
// for any user. A minimum length is a coarse but real entropy floor; 32
// bytes (256 bits) as a MINIMUM CHARACTER count is deliberately generous —
// even a low-entropy 32-character string (e.g. all lowercase) still clears
// ~150 bits of keyspace, and `.env.example` documents generating this with
// `openssl rand -hex 32` (64 hex chars), comfortably above the floor.
const MIN_JWT_SECRET_LENGTH = 32;
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  'changeme-secret',
  'change_this_secret_in_production',
  'solytiq_secret',
]);
if (process.env.NODE_ENV === 'production') {
  if (!JWT_SECRET_ENV || KNOWN_PLACEHOLDER_SECRETS.has(JWT_SECRET_ENV)) {
    throw new Error('JWT_SECRET must be set to a secure, non-default value in production!');
  }
  if (JWT_SECRET_ENV.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters in production (got ${JWT_SECRET_ENV.length}) — a short secret is brute-forceable offline against any captured token.`);
  }
  // A trivially low-entropy secret (e.g. "aaaaaaaa...a" or "01010101...")
  // clears the length floor but not a real entropy bar. Count distinct
  // characters as a cheap, dependency-free approximation — genuine random
  // hex/base64 secrets clear this easily; a repeated/patterned string does not.
  if (new Set(JWT_SECRET_ENV).size < 8) {
    throw new Error('JWT_SECRET has too little character variety to be a real secret — generate one with `openssl rand -hex 32`.');
  }
}
const JWT_SECRET = JWT_SECRET_ENV || 'changeme-secret';

/**
 * How long an issued session token stays valid.
 *
 * 30 days rather than the original 7 so the frontend's multi-account switcher
 * (see CLAUDE.md's "Account Switching") can keep a second signed-in account
 * usable for that long without re-entering credentials. Length alone is not the
 * security boundary: `users.token_version` still invalidates every outstanding
 * token for a user the moment their password changes or they force a logout,
 * and `middleware.ts` re-checks that on every single request.
 */
export const SESSION_TTL = '30d';

export function generateToken(userId: string, tokenVersion: number = 0, connectionId?: string): string {
  const payload: Record<string, unknown> = { userId, tokenVersion };
  // Mobile-app sessions carry the id of their `mobile_connections` row so the
  // connection can be listed and individually revoked (see middleware.ts).
  if (connectionId) payload.connectionId = connectionId;
  return jwt.sign(payload, JWT_SECRET, { expiresIn: SESSION_TTL });
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
