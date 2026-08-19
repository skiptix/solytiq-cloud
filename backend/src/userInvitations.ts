// ---------------------------------------------------------------------------
// User Invitations — an admin invites a new person by email; the invite is a
// single-use link (`/invite/:token`) to a registration screen that ONLY that
// link can reach. Security model mirrors apiToken.ts exactly: the raw token
// is a high-entropy random value, shown to the admin exactly once at
// creation, and only its SHA-256 hash is ever persisted — a database leak
// never exposes a usable invite link.
//
// A row is "pending" (still redeemable) exactly when `accepted_at` AND
// `revoked_at` are both NULL and `expires_at` is in the future. Every other
// state — already accepted, revoked by an admin, expired, or a token that
// never existed at all — is deliberately collapsed into the SAME "not
// found" outcome by findPendingInvitation(): the public endpoints in
// routes/auth.ts must never let an unauthenticated caller distinguish
// "this link was already used" from "this link never existed", both for
// the security reason (don't confirm a guessed prefix corresponds to a real
// invite) and because the product requirement is literally "show a 404".
// ---------------------------------------------------------------------------

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { query } from './db';

/** Single-use link tokens stay valid for a week — long enough for someone to
 *  notice the email and act on it, short enough that a stale, unactioned
 *  invite doesn't linger indefinitely as a standing credential. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashInvitationToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Mint a new random invitation token. The raw value is only ever available
 *  from this call — callers must return it to the admin and never persist
 *  it themselves. */
export function generateInvitationToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export interface InvitationRow {
  id: string;
  email: string;
  is_admin: boolean;
  invited_by: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
  expires_at: string;
  created_at: string;
}

/**
 * Creates a fresh invitation for `email`. Any still-pending invitation for
 * the same address is revoked first, so at most one link is ever valid per
 * email at a time — re-inviting someone (e.g. because they lost the email)
 * cleanly supersedes the old link rather than leaving two valid ones.
 */
export async function createInvitation(
  email: string,
  invitedBy: string,
  isAdmin: boolean
): Promise<{ id: string; rawToken: string; expiresAt: Date }> {
  const normalizedEmail = email.trim().toLowerCase();

  await query(
    `UPDATE user_invitations SET revoked_at = NOW()
     WHERE lower(email) = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [normalizedEmail]
  );

  const id = `invite_${uuidv4()}`;
  const rawToken = generateInvitationToken();
  const tokenHash = hashInvitationToken(rawToken);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  await query(
    `INSERT INTO user_invitations (id, email, token_hash, is_admin, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, normalizedEmail, tokenHash, isAdmin, invitedBy, expiresAt]
  );

  return { id, rawToken, expiresAt };
}

/**
 * Look up a PENDING invitation by its raw token. Returns null for every
 * invalid case uniformly (doesn't exist / already accepted / revoked /
 * expired) — see this module's header comment for why that's load-bearing,
 * not an oversight.
 */
export async function findPendingInvitation(rawToken: string): Promise<InvitationRow | null> {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const tokenHash = hashInvitationToken(rawToken);
  const result = await query<InvitationRow>(
    `SELECT * FROM user_invitations
     WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`,
    [tokenHash]
  );
  return result.rows[0] ?? null;
}

export interface InvitationListRow extends InvitationRow {
  invited_by_username: string | null;
  accepted_by_username: string | null;
}

/** Admin-facing list — every invitation regardless of status, newest first.
 *  The frontend derives pending/accepted/revoked/expired from the four
 *  timestamp columns rather than a separate stored status, so there is only
 *  ever one source of truth for which bucket a row is in. */
export async function listInvitations(): Promise<InvitationListRow[]> {
  const result = await query<InvitationListRow>(
    `SELECT ui.*, inviter.username AS invited_by_username, accepter.username AS accepted_by_username
     FROM user_invitations ui
     LEFT JOIN users inviter ON inviter.id = ui.invited_by
     LEFT JOIN users accepter ON accepter.id = ui.accepted_by
     ORDER BY ui.created_at DESC
     LIMIT 200`
  );
  return result.rows;
}

/** Revoke a still-pending invitation. Returns false if it doesn't exist or
 *  is no longer pending (already accepted/revoked) — revoking is a no-op on
 *  a settled row, not an error, since the admin's intent ("this link should
 *  no longer work") is already satisfied either way. */
export async function revokeInvitation(id: string): Promise<boolean> {
  const result = await query(
    `UPDATE user_invitations SET revoked_at = NOW()
     WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}
