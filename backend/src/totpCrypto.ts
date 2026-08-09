// ---------------------------------------------------------------------------
// TOTP secret encryption at rest (S3).
//
// `users.totp_secret` used to be stored in plain text — a database leak (or
// even a read-only SQL injection elsewhere) would hand an attacker every
// enrolled user's raw TOTP seed, letting them generate valid 6-digit codes
// forever without ever touching the user's phone. This module encrypts the
// secret with AES-256-GCM (authenticated — tampering is detected, not just
// hidden) using a key that lives OUTSIDE the database: `TOTP_ENCRYPTION_KEY`
// if set, or else a key deterministically DERIVED (HKDF-SHA256, a fixed
// context string) from JWT_SECRET so a fresh install with no extra
// configuration still gets real encryption rather than silently falling back
// to plaintext. Deriving (not reusing JWT_SECRET raw) keeps the TOTP
// encryption key cryptographically distinct from the JWT signing key even
// though both are rooted in the same operator-supplied secret.
//
// Every encrypted value is tagged `enc:v1:` so `migrateTotpSecretsToEncrypted()`
// (see index.ts's startup heal) can tell an already-encrypted row from a
// still-plaintext legacy one and skip it — safe to re-run on every boot.
// ---------------------------------------------------------------------------

import crypto from 'crypto';

const ENC_PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce, the GCM-recommended size

function deriveKey(): Buffer {
  const dedicated = process.env.TOTP_ENCRYPTION_KEY;
  if (dedicated && dedicated.length > 0) {
    // A dedicated key may be any length/format an operator supplies —
    // normalize it through the same HKDF so it always yields exactly 32 bytes.
    return Buffer.from(
      crypto.hkdfSync('sha256', Buffer.from(dedicated, 'utf8'), Buffer.alloc(0), 'solytiq-totp-encryption-v1', 32)
    );
  }
  // No dedicated key configured — derive one from JWT_SECRET (also an env
  // var, also outside the database) rather than falling back to plaintext.
  // auth.ts already validates JWT_SECRET's strength in production; this
  // module never re-validates it, it only derives from whatever is present.
  const jwtSecret = process.env.JWT_SECRET || 'changeme-secret';
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(jwtSecret, 'utf8'), Buffer.alloc(0), 'solytiq-totp-encryption-v1', 32)
  );
}

/** True if `value` is already in this module's encrypted-at-rest format. */
export function isEncryptedTotpSecret(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

/** Encrypt a raw TOTP secret (e.g. `authenticator.generateSecret()`'s output)
 *  for storage. Returns the `enc:v1:`-prefixed, base64url-packed ciphertext. */
export function encryptTotpSecret(plain: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, authTag, ciphertext]).toString('base64url');
  return `${ENC_PREFIX}${packed}`;
}

/**
 * Decrypt a value stored in `users.totp_secret`. Transparently handles a
 * still-plaintext legacy row (returns it unchanged) so a partially-migrated
 * database (or one where the startup heal hasn't run yet this boot) never
 * hard-fails a login — see migrateTotpSecretsToEncrypted().
 */
export function decryptTotpSecret(stored: string): string {
  if (!isEncryptedTotpSecret(stored)) return stored; // legacy plaintext row
  const key = deriveKey();
  const packed = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64url');
  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = packed.subarray(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
}
