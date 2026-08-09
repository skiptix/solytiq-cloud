// ---------------------------------------------------------------------------
// S5 — MCP endpoint (/mcp) concurrency cap.
//
// /mcp is deliberately mounted OUTSIDE /api (see index.ts) so a legitimate
// multi-step agent tool-calling loop is never throttled by the generic
// per-user apiLimiter meant for browser-tab traffic. That exemption
// previously meant /mcp had no budget at all beyond bearer-token auth itself
// — nothing bounded how many requests a client (valid token, invalid token,
// or none at all) could have in flight AT ONCE, each one holding open a DB
// connection + a stateless MCP server/transport pair for its duration. A
// rate limiter alone doesn't catch this shape (a client comfortably under
// its per-minute budget can still open dozens of slow/long-running requests
// simultaneously) — this module adds a companion per-client concurrency cap,
// mirroring sse.ts's MAX_CONNECTIONS_PER_USER precedent for the same reason:
// an in-memory Map is enough for a single-process deployment, and the guard
// closes on process restart along with everything else in it.
// ---------------------------------------------------------------------------

import { hashApiToken } from './apiToken';

/**
 * Stable, non-secret limiter/concurrency key for a raw Authorization header
 * value. Works for both a genuinely valid PAT and garbage/guessed input —
 * either way the caller lands in a key derived from what THEY sent, never a
 * shared bucket, so token-guessing traffic can't borrow a legitimate
 * client's budget or vice versa. Returns null when there's no bearer token
 * at all, so the caller can fall back to an IP-keyed bucket.
 */
export function mcpTokenKey(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) return null;
  const raw = authorizationHeader.slice('Bearer '.length).trim();
  if (!raw) return null;
  return hashApiToken(raw);
}

const MAX_CONCURRENT_MCP_REQUESTS = 4;
const inFlight = new Map<string, number>();

/** Reserves a concurrency slot for `key` if under the cap. Returns false
 *  (reserves nothing) if the caller already has MAX_CONCURRENT_MCP_REQUESTS
 *  requests in flight. Always pair a `true` result with releaseMcpSlot(). */
export function acquireMcpSlot(key: string): boolean {
  const current = inFlight.get(key) ?? 0;
  if (current >= MAX_CONCURRENT_MCP_REQUESTS) return false;
  inFlight.set(key, current + 1);
  return true;
}

export function releaseMcpSlot(key: string): void {
  const current = inFlight.get(key) ?? 0;
  if (current <= 1) inFlight.delete(key);
  else inFlight.set(key, current - 1);
}

/** Test-only introspection/reset. */
export function __mcpInFlightForTests(key: string): number {
  return inFlight.get(key) ?? 0;
}
export function __clearMcpSlotsForTests(): void {
  inFlight.clear();
}
