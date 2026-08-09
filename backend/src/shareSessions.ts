// ---------------------------------------------------------------------------
// Short-lived share sessions (S4) — replaces a share link's password riding
// as `?password=<plaintext>` on every public GET request.
//
// Public share pages (files, lists, timelines, markdown pages, folders) are
// unauthenticated by design — anyone with the link and (optionally) the
// password can view them. Before this module existed, every content fetch
// AND every file download sent the plaintext password as a query parameter
// on every single request: it landed in browser history, this server's own
// access logs, and any intermediate proxy's request log, for as long as the
// visitor kept the tab open.
//
// The new flow: POST the password ONCE to /api/share/verify-password (a
// request body, never logged the way a URL is), get back an opaque,
// short-lived session ticket bound to that exact (kind, token) pair, and use
// THAT — never the password itself — as `?session=` on subsequent content/
// download requests. A leaked ticket in a log still isn't nothing, but it
// expires in under an hour and can only ever unlock the one share it was
// issued for, unlike a plaintext password which is the SAME secret reused
// across a share's entire lifetime.
// ---------------------------------------------------------------------------

import crypto from 'crypto';

export type ShareKind = 'file' | 'list' | 'timeline' | 'markdownList' | 'folder';

interface ShareSessionRecord {
  kind: ShareKind;
  token: string;
  expiresAt: number;
}

const sessions = new Map<string, ShareSessionRecord>();

// Long enough for a normal browsing session on a shared page without asking
// for the password again on every navigation; short enough that a leaked
// ticket in a log is a bounded, time-limited exposure rather than the
// share's password itself (best case, that password lives for the life of
// the whole share link — weeks or months).
const SHARE_SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

export function mintShareSession(kind: ShareKind, token: string): { session: string; expiresAt: number } {
  const session = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SHARE_SESSION_TTL_MS;
  sessions.set(session, { kind, token, expiresAt });
  return { session, expiresAt };
}

/** True if `sessionParam` is a live, unexpired session minted for this exact
 *  (kind, token) pair. Reusable within its TTL (a page reloads/re-fetches
 *  its content repeatedly during one visit). */
export function isValidShareSession(sessionParam: string, kind: ShareKind, token: string): boolean {
  const record = sessions.get(sessionParam);
  if (!record) return false;
  if (record.expiresAt < Date.now()) { sessions.delete(sessionParam); return false; }
  return record.kind === kind && record.token === token;
}

/** Periodic sweep for abandoned (never-revisited) sessions — same pattern as
 *  assetTickets.ts's sweepExpiredAssetTickets(). */
export function sweepExpiredShareSessions(): void {
  const now = Date.now();
  for (const [session, record] of sessions) {
    if (record.expiresAt < now) sessions.delete(session);
  }
}

/** Test-only escape hatch. */
export function __clearAllShareSessionsForTests(): void {
  sessions.clear();
}
