// ---------------------------------------------------------------------------
// Automation Hub — HTTP action node: an outbound request to a user-supplied
// URL, with SSRF protection.
//
// SECURITY: this request is issued directly FROM THE SERVER, not the user's
// browser — a workspace member typing in a URL could otherwise use it to
// probe internal services (this container's own Docker network, a sibling
// Postgres container, a cloud metadata endpoint, etc.). assertPublicUrl
// resolves the hostname and allow-lists ONLY 'unicast' (ordinary, globally
// routable) addresses via ipaddr.js's range classifier — fail-closed:
// anything that ISN'T plain public unicast (loopback, link-local — which
// covers the 169.254.169.254 cloud metadata address too — private/RFC1918,
// multicast, reserved, IPv6 unique-local, ...) is rejected, rather than
// trying to enumerate every bad range by hand.
//
// Known, documented residual limitation: this is a resolve-then-check-then-
// fetch guard, not a rebinding-proof pinned-socket implementation — the DNS
// answer could theoretically change between the check and the request
// (TOCTOU). Accepted as a deliberate V1 scope decision; it blocks the
// overwhelming majority of real-world SSRF attempts (anyone just typing a
// private URL directly).
// ---------------------------------------------------------------------------

import dns from 'dns';
import ipaddr from 'ipaddr.js';

const MAX_RESPONSE_CHARS = 1_000_000; // ~1MB cap on the response body we read/store
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 20_000;
// SECURITY (S5): a redirect target gets the FULL assertPublicUrl check again
// (every DNS answer for it, not just the original URL's) before it is ever
// followed — see performHttpRequest's manual redirect loop below. This cap
// bounds a malicious/misconfigured server chaining redirects indefinitely.
const MAX_REDIRECTS = 5;

export type AssertPublicUrlResult = { ok: true; url: URL } | { ok: false; error: string };

export async function assertPublicUrl(rawUrl: string): Promise<AssertPublicUrlResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http:// and https:// URLs are allowed' };
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname.toLowerCase() === 'localhost') {
    return { ok: false, error: 'Requests to localhost are not allowed' };
  }

  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(hostname, { all: true });
  } catch {
    return { ok: false, error: 'Could not resolve host' };
  }
  if (addresses.length === 0) {
    return { ok: false, error: 'Could not resolve host' };
  }

  for (const { address } of addresses) {
    if (!ipaddr.isValid(address)) {
      return { ok: false, error: 'Resolved to an invalid address' };
    }
    const parsed = ipaddr.process(address); // collapses IPv4-mapped IPv6 into plain IPv4
    if (parsed.range() !== 'unicast') {
      return { ok: false, error: 'URL resolves to a private/internal address, which automations are not allowed to reach' };
    }
  }

  return { ok: true, url };
}

export function clampTimeoutMs(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 10_000;
  return Math.min(Math.max(n, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

export interface HttpNodeRequest {
  url: string;
  method: string;
  headers: Array<{ key: string; value: string }>;
  queryParams: Array<{ key: string; value: string }>;
  bodyType: 'none' | 'json' | 'text';
  body?: string;
  timeoutMs: number;
}

export interface HttpNodeOutput {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
}

export type PerformHttpResult = { ok: true; output: HttpNodeOutput } | { ok: false; error: string };

/**
 * Read a fetch Response body up to `maxBytes`, aborting the underlying
 * stream (never buffering past the limit) the moment it's exceeded.
 *
 * SECURITY (S5): `await response.text()` (the pre-fix implementation) reads
 * the ENTIRE body into memory before this module ever gets to look at its
 * length — a malicious or merely huge upstream response could exhaust
 * server memory regardless of the post-hoc truncation that followed. This
 * streams via the body's own ReadableStream reader and stops pulling more
 * chunks (and cancels the stream) as soon as the limit is crossed.
 */
async function readBodyUpToLimit(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body) return { text: '', truncated: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        const keep = maxBytes - (total - value.byteLength);
        if (keep > 0) chunks.push(value.subarray(0, keep));
        truncated = true;
        await reader.cancel().catch(() => { /* best-effort */ });
        break;
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released via cancel */ }
  }

  const combined = new Uint8Array(chunks.reduce((sum, c) => sum + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) { combined.set(c, offset); offset += c.byteLength; }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(combined), truncated };
}

export async function performHttpRequest(req: HttpNodeRequest): Promise<PerformHttpResult> {
  const headers: Record<string, string> = {};
  for (const { key, value } of req.headers) {
    if (key) headers[key] = value;
  }

  let body: string | undefined;
  if (req.bodyType === 'json') {
    const raw = req.body ?? '';
    if (raw.trim()) {
      try {
        JSON.parse(raw);
      } catch {
        return { ok: false, error: 'Request body is not valid JSON' };
      }
    }
    body = raw;
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  } else if (req.bodyType === 'text') {
    body = req.body ?? '';
  }

  // SECURITY (S5): redirects are followed MANUALLY, not by fetch's default
  // `redirect: 'follow'`. The original SSRF guard only ever validated the
  // FIRST URL — a server that passed the check could still respond
  // `302 Location: http://169.254.169.254/...` (or any other private
  // target) and the default fetch behavior would transparently follow it,
  // completely bypassing assertPublicUrl for every hop after the first.
  // Every redirect target here is re-validated (fresh DNS lookup, same
  // unicast-only allow-list) before it is ever requested, exactly like the
  // original URL was, and the chain is capped at MAX_REDIRECTS.
  let currentUrl = req.url;
  let response: Response;
  const timeoutMs = clampTimeoutMs(req.timeoutMs);
  for (let hop = 0; ; hop++) {
    const guard = await assertPublicUrl(currentUrl);
    if (!guard.ok) return { ok: false, error: guard.error };

    const url = guard.url;
    if (hop === 0) {
      for (const { key, value } of req.queryParams) {
        if (key) url.searchParams.append(key, value);
      }
    }

    try {
      response = await fetch(url, {
        method: req.method,
        headers,
        body: req.bodyType === 'none' ? undefined : body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { ok: false, error: 'Request timed out' };
      }
      return { ok: false, error: `Request failed: ${(err as Error)?.message ?? 'unknown error'}` };
    }

    // undici surfaces a manually-not-followed redirect as an "opaqueredirect"
    // type response with status 0; the Location header is still readable.
    const isRedirect = response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
    if (!isRedirect) break;

    const location = response.headers.get('location');
    if (!location) break; // a redirect status with no Location — nothing to follow, return as-is
    if (hop + 1 >= MAX_REDIRECTS) {
      return { ok: false, error: `Too many redirects (max ${MAX_REDIRECTS})` };
    }
    // Resolve relative to the CURRENT url, not the original — a chain can
    // legitimately change host at each hop.
    currentUrl = new URL(location, url).toString();
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  const { text, truncated } = await readBodyUpToLimit(response, MAX_RESPONSE_CHARS);

  let parsedBody: unknown = text;
  const contentType = responseHeaders['content-type'] ?? '';
  const looksJson = contentType.includes('application/json') || (!truncated && /^[[{]/.test(text.trim()));
  if (looksJson) {
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = text;
    }
  }
  if (truncated && typeof parsedBody === 'string') {
    parsedBody = `${parsedBody}\n…[truncated]`;
  }

  return {
    ok: true,
    output: { status: response.status, statusText: response.statusText, headers: responseHeaders, body: parsedBody },
  };
}
