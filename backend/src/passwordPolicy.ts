// ---------------------------------------------------------------------------
// One shared password policy (S3) for every account-password entry point:
// self-registration/setup, admin create-user, admin password reset, the
// admin-password-reset email-token flow, and self-service password change.
//
// Before this module existed, only PUT /api/auth/password enforced a minimum
// length — the setup wizard (which creates the FIRST, ADMIN account) and the
// admin create/reset endpoints accepted a one-character password outright.
// A single validator closes all of them at once and stops a future new entry
// point from silently reintroducing the gap.
//
// MAX_PASSWORD_LENGTH exists because bcrypt silently truncates input beyond
// 72 BYTES — without an upstream cap, a client could submit a
// multi-megabyte "password" that bcryptjs still reads in full before
// truncating, wasting CPU/memory on every hash call. 256 chars is far above
// any real passphrase while staying trivially cheap to hash/compare.
// ---------------------------------------------------------------------------

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;

export type PasswordPolicyResult = { ok: true } | { ok: false; error: string };

export function validatePassword(password: unknown): PasswordPolicyResult {
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, error: 'Password is required' };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters` };
  }
  return { ok: true };
}
