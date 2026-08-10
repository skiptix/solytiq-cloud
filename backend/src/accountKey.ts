// ---------------------------------------------------------------------------
// S5 — account-scoped login rate-limit keys.
//
// SECURITY: `authLimiter` (index.ts) keys purely on IP — 10 attempts / 15 min
// per address. That alone does NOT bound a DISTRIBUTED credential-stuffing /
// password-guessing attack against ONE account: an attacker spreading
// attempts across many IPs (a botnet, a rotating proxy pool) never crosses
// any single IP's budget while accumulating an effectively unlimited number
// of guesses against the target account. These pure helpers derive a
// per-ACCOUNT key so a second limiter (accountLoginLimiter /
// accountTwoFaLimiter in index.ts) can be layered ON TOP OF the existing
// IP-based one — a login request must clear BOTH budgets, exactly like
// linksLimiter/graphLimiter/knowledgeLimiter/agentLimiter already layer on
// top of apiLimiter elsewhere in this file.
//
// Pure and dependency-injectable (no Express/JWT import here) so these are
// directly unit-testable, matching this codebase's established convention
// for security-decision logic (see proxyTrust.ts, objectPolicy.ts).
// ---------------------------------------------------------------------------

/** Lowercases + trims a raw username/email; empty/whitespace-only → null. */
export function normalizeAccountIdentifier(raw: string | undefined | null): string | null {
  const trimmed = (raw ?? '').trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Rate-limit key for a `/login` attempt, from whichever identifier the
 * request supplied. Prefers `username`, then `email` — mirrors the route
 * handler's own `WHERE username = $1 OR email = $2` lookup, so the same
 * account collapses to the same key regardless of which field the client
 * happened to send. Returns null when neither is present (the route itself
 * 400s in that case — nothing to protect with an account-scoped budget).
 */
export function loginAccountKey(username: string | undefined | null, email: string | undefined | null): string | null {
  const id = normalizeAccountIdentifier(username) ?? normalizeAccountIdentifier(email);
  return id ? `acct:${id}` : null;
}

/**
 * Rate-limit key for a `/2fa/verify` attempt. The request body carries no
 * plain account identifier (by design — see `pendingToken`'s own doc in
 * auth.ts), only a short-lived pending token binding the request to a
 * specific `userId`. `verifyFn` is the caller's `verifyPendingToken` (or a
 * test double) — injected rather than imported directly so this stays a
 * pure, DB/JWT-secret-free function. An invalid/expired/malformed token
 * yields null (the route itself will 401 it) rather than throwing.
 */
export function twoFaAccountKey(
  pendingToken: string | undefined | null,
  verifyFn: (token: string) => { userId: string }
): string | null {
  if (!pendingToken) return null;
  try {
    const { userId } = verifyFn(pendingToken);
    return userId ? `acct:${userId}` : null;
  } catch {
    return null;
  }
}
