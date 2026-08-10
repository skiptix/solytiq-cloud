// ---------------------------------------------------------------------------
// Short-lived, opaque, narrowly-scoped tickets for the handful of endpoints a
// BROWSER cannot attach an `Authorization` header to: the SSE stream
// (EventSource has no header API) and inline `<img>` tags (markdown-page /
// Knowledge-Base entry images). Both used to accept the user's full,
// long-lived (30-day) session JWT as a `?token=` query parameter instead —
// a real secret sitting in the URL, and therefore in browser history, the
// backend's own access logs, and any intermediate proxy's request log.
//
// A ticket here is NOT a session credential: it carries no ability to call
// any other endpoint (there is no generic "verify this ticket as a JWT" path
// — see index.ts / markdownLists.ts / knowledgeBase.ts, which each consume a
// ticket for exactly one specific, pre-declared purpose), it expires in
// minutes rather than weeks, and it is minted fresh from an ALREADY-
// authenticated request (POST /api/auth/asset-ticket, gated by the normal
// `authenticate` middleware + Authorization header) — so a leaked ticket in
// a log is a vastly smaller blast radius than a leaked session JWT ever was.
//
// In-memory, single-process — the same architectural precedent as sse.ts's
// client registry and syncLog.ts's dispatcher (see CLAUDE.md: "a single
// in-process dispatcher, deliberately isolated so a Redis backplane could
// replace it later without touching call sites"). A process restart simply
// invalidates all outstanding tickets; callers mint a new one on demand.
// ---------------------------------------------------------------------------

import crypto from 'crypto';

interface TicketRecord {
  userId: string;
  scope: string;
  expiresAt: number;
}

const tickets = new Map<string, TicketRecord>();

const SSE_TICKET_TTL_MS = 60 * 1000; // one connection attempt's worth of latency, generously
const ASSET_TICKET_TTL_MS = 5 * 60 * 1000; // images: reusable across a page's normal lifetime

function ttlForScope(scope: string): number {
  return scope === 'sse' ? SSE_TICKET_TTL_MS : ASSET_TICKET_TTL_MS;
}

/** Only these scope shapes may ever be minted — a fixed allowlist, not
 *  arbitrary caller-supplied strings, closes off any use of this mechanism
 *  as a general-purpose bearer-token substitute. `mdimg:<listId>` /
 *  `kbimg:<entryId>` are scoped per-DOCUMENT (every image on that one
 *  markdown page / Knowledge Base entry), not per-image — a deliberate
 *  trade-off that lets the frontend mint exactly ONE ticket per page view
 *  (in parallel with loading the document itself) and then build every
 *  `<img src>` on that page synchronously from the cached result, rather
 *  than needing an async round trip per image. Still meaningfully narrower
 *  than the raw session JWT it replaces: this ticket can only ever fetch
 *  images belonging to the one document it names, for a few minutes. */
const SCOPE_PATTERN = /^(sse|mdimg:[A-Za-z0-9_-]+|kbimg:[A-Za-z0-9_-]+)$/;

export function isValidAssetTicketScope(scope: string): boolean {
  return SCOPE_PATTERN.test(scope);
}

export function mintAssetTicket(userId: string, scope: string): { ticket: string; expiresAt: number } {
  const ticket = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + ttlForScope(scope);
  tickets.set(ticket, { userId, scope, expiresAt });
  return { ticket, expiresAt };
}

/**
 * Redeem a ticket for a specific expected scope. Returns the minting user's
 * id, or null if the ticket doesn't exist, has expired, or was minted for a
 * DIFFERENT scope (e.g. an image ticket can't be replayed against the SSE
 * endpoint, and a ticket for one image can't be reused for another).
 *
 * The `sse` scope is deleted on successful consumption (a true one-time
 * ticket — a stream only ever needs to authenticate once at connect time);
 * every other scope stays valid until it naturally expires, since a page
 * legitimately re-requests the same image several times (multiple `<img>`
 * tags, a retry, a second tab) within one short-lived ticket's window.
 */
export function consumeAssetTicket(ticket: string, expectedScope: string): { userId: string } | null {
  const record = tickets.get(ticket);
  if (!record) return null;
  if (record.expiresAt < Date.now()) { tickets.delete(ticket); return null; }
  if (record.scope !== expectedScope) return null;
  if (expectedScope === 'sse') tickets.delete(ticket);
  return { userId: record.userId };
}

/** Periodic sweep so an abandoned (never-consumed) ticket doesn't sit in
 *  memory forever. Safe to call repeatedly; cheap (one Map scan). */
export function sweepExpiredAssetTickets(): void {
  const now = Date.now();
  for (const [ticket, record] of tickets) {
    if (record.expiresAt < now) tickets.delete(ticket);
  }
}

/** Test-only escape hatch to reset state between test cases. */
export function __clearAllAssetTicketsForTests(): void {
  tickets.clear();
}
