// ---------------------------------------------------------------------------
// Resend API key encryption at rest.
//
// The admin configures the Resend API key from the Settings UI rather than an
// env var (so it can be changed without a redeploy), which means it has to
// live in `app_settings` — a table any DB read (or read-only SQL injection
// elsewhere) could otherwise expose in plaintext. This mirrors totpCrypto.ts's
// approach exactly: AES-256-GCM (authenticated) with a key that lives OUTSIDE
// the database — `RESEND_ENCRYPTION_KEY` if set, or else derived (HKDF-SHA256,
// a fixed context string distinct from every other module's) from JWT_SECRET,
// so a fresh install with no extra configuration still gets real encryption.
//
// Every encrypted value is tagged `enc:v1:` so a legacy/foreign value never
// gets mistaken for ciphertext.
// ---------------------------------------------------------------------------

import crypto from 'crypto';

const ENC_PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce, the GCM-recommended size

function deriveKey(): Buffer {
  const dedicated = process.env.RESEND_ENCRYPTION_KEY;
  if (dedicated && dedicated.length > 0) {
    return Buffer.from(
      crypto.hkdfSync('sha256', Buffer.from(dedicated, 'utf8'), Buffer.alloc(0), 'solytiq-resend-encryption-v1', 32)
    );
  }
  const jwtSecret = process.env.JWT_SECRET || 'changeme-secret';
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(jwtSecret, 'utf8'), Buffer.alloc(0), 'solytiq-resend-encryption-v1', 32)
  );
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

/** Encrypt a raw secret (e.g. a Resend API key) for storage in app_settings. */
export function encryptSecret(plain: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, authTag, ciphertext]).toString('base64url');
  return `${ENC_PREFIX}${packed}`;
}

/** Decrypt a value stored by encryptSecret(). Returns a still-plaintext
 *  legacy/foreign value unchanged rather than throwing. */
export function decryptSecret(stored: string): string {
  if (!isEncryptedSecret(stored)) return stored;
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
