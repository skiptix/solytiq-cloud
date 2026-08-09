// ---------------------------------------------------------------------------
// S5 — proxy trust boundary, extracted for direct unit testing (index.ts
// can't easily be imported in tests — see migrations.ts's own extraction
// comment for why).
//
// SECURITY: `CF-Connecting-IP` is a plain HTTP header — indistinguishable
// from any other client-supplied header UNLESS something at the network
// edge (a real Cloudflare deployment, verified by the operator) guarantees
// the origin is unreachable except through Cloudflare, which then
// overwrites any client-supplied value of this exact header. Nothing in
// THIS repository proves that: trusting it unconditionally lets any caller
// who reaches the origin directly set an arbitrary, freely-rotatable
// "client IP" on every request, defeating every IP-keyed rate limiter
// (login, setup, OAuth DCR, share-password brute force) outright — a fresh
// header value gets a fresh budget.
// ---------------------------------------------------------------------------

export function isCfConnectingIpTrusted(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TRUST_CF_CONNECTING_IP === 'true';
}

/**
 * Resolve the client IP to key a rate limiter on. `cfHeader` is whatever
 * `req.headers['cf-connecting-ip']` holds (a header can arrive as an array
 * if sent multiple times — that's ALSO client-controlled, so it's ignored,
 * not trusted just because trustCf is on). `reqIp` is Express's own
 * `req.ip`, itself governed by the `trust proxy` setting (TRUST_PROXY_HOPS).
 */
export function resolveClientIp(
  cfHeader: string | string[] | undefined,
  reqIp: string | undefined,
  trustCf: boolean
): string {
  const cf = trustCf && typeof cfHeader === 'string' && cfHeader.length > 0 ? cfHeader : undefined;
  return cf ?? (reqIp ?? '');
}

/** Parses TRUST_PROXY_HOPS, defaulting to 1 (this repo's own shipped
 *  nginx-in-front-of-backend topology — see docker-compose.yml/nginx.conf). */
export function resolveTrustProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRUST_PROXY_HOPS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 1;
}
