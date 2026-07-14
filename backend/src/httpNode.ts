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

export async function performHttpRequest(req: HttpNodeRequest): Promise<PerformHttpResult> {
  const guard = await assertPublicUrl(req.url);
  if (!guard.ok) return { ok: false, error: guard.error };

  const url = guard.url;
  for (const { key, value } of req.queryParams) {
    if (key) url.searchParams.append(key, value);
  }

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

  let response: Response;
  try {
    response = await fetch(url, {
      method: req.method,
      headers,
      body: req.bodyType === 'none' ? undefined : body,
      signal: AbortSignal.timeout(clampTimeoutMs(req.timeoutMs)),
    });
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, error: 'Request timed out' };
    }
    return { ok: false, error: `Request failed: ${(err as Error)?.message ?? 'unknown error'}` };
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  let text = await response.text();
  let truncated = false;
  if (text.length > MAX_RESPONSE_CHARS) {
    text = text.slice(0, MAX_RESPONSE_CHARS);
    truncated = true;
  }

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
