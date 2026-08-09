// ---------------------------------------------------------------------------
// S5 — account-scoped login rate limiters, extracted so they're directly
// importable in an HTTP-level integration test (index.ts itself can't be
// imported in tests — see migrations.ts's own extraction comment for why).
//
// SECURITY: `authLimiter` (index.ts) keys purely on IP — 10 attempts / 15 min
// per address. That alone does NOT bound a DISTRIBUTED credential-stuffing
// attack against ONE account: an attacker spreading attempts across many IPs
// (a botnet, a rotating proxy pool) never crosses any single IP's budget
// while accumulating an effectively unlimited number of guesses against the
// target account. These two limiters key on the ACCOUNT being attacked
// instead, and are mounted ON TOP OF (not instead of) authLimiter in
// index.ts — a request must clear BOTH budgets, the same "additional tier on
// top of a base one" pattern as linksLimiter/graphLimiter/knowledgeLimiter/
// agentLimiter layering on top of apiLimiter elsewhere in that file.
//
// `skip` opts a request out only when there is no identifiable account to
// protect — the route itself rejects that case anyway (400 for a missing
// username/email, 401 for an unverifiable pendingToken), so nothing is left
// unprotected by skipping here. Because `skip` is what actually filters
// those requests out, `keyGenerator`'s own `?? fallbackIpKey(req)` branch is
// unreachable in ordinary operation — kept only so this limiter can never
// silently become one shared/global bucket if that assumption ever changes.
// ---------------------------------------------------------------------------

import { rateLimit } from 'express-rate-limit';
import type { Request } from 'express';
import { loginAccountKey, twoFaAccountKey } from './accountKey';
import { verifyPendingToken } from './auth';

function fallbackIpKey(req: Request): string {
  return req.ip ?? 'unknown';
}

export const accountLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15, // slightly above authLimiter's per-IP 10: this tier exists to catch a real distributed attempt, not a shared/family account's normal multi-device typos
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const { username, email } = req.body as { username?: string; email?: string };
    return loginAccountKey(username, email) ?? fallbackIpKey(req);
  },
  skip: (req) => {
    const { username, email } = req.body as { username?: string; email?: string };
    return loginAccountKey(username, email) === null;
  },
  message: { error: 'Too many attempts for this account. Please try again later.' },
});

export const accountTwoFaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const { pendingToken } = req.body as { pendingToken?: string };
    return twoFaAccountKey(pendingToken, verifyPendingToken) ?? fallbackIpKey(req);
  },
  skip: (req) => {
    const { pendingToken } = req.body as { pendingToken?: string };
    return twoFaAccountKey(pendingToken, verifyPendingToken) === null;
  },
  message: { error: 'Too many 2FA attempts for this account. Please try again later.' },
});
