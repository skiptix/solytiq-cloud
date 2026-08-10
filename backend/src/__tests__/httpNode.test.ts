import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const lookupMock = vi.fn();
vi.mock('dns', () => ({
  default: { promises: { lookup: (...args: unknown[]) => lookupMock(...args) } },
  promises: { lookup: (...args: unknown[]) => lookupMock(...args) },
}));

// vi.mock is hoisted above imports, so this static import already sees the mocked dns module.
import { assertPublicUrl, clampTimeoutMs, performHttpRequest } from '../httpNode';

beforeEach(() => {
  lookupMock.mockReset();
});

describe('assertPublicUrl', () => {
  it('rejects an invalid URL', async () => {
    const result = await assertPublicUrl('not a url');
    expect(result.ok).toBe(false);
  });

  it('rejects non-http(s) protocols', async () => {
    const result = await assertPublicUrl('file:///etc/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/http/i);
  });

  it('rejects the literal hostname "localhost"', async () => {
    const result = await assertPublicUrl('http://localhost/admin');
    expect(result.ok).toBe(false);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects when DNS resolution fails', async () => {
    lookupMock.mockRejectedValueOnce(new Error('ENOTFOUND'));
    const result = await assertPublicUrl('https://does-not-resolve.invalid/');
    expect(result.ok).toBe(false);
  });

  it.each([
    ['loopback', '127.0.0.1'],
    ['private RFC1918 10/8', '10.0.0.5'],
    ['private RFC1918 172.16/12', '172.16.5.5'],
    ['private RFC1918 192.168/16', '192.168.1.1'],
    ['link-local / cloud metadata', '169.254.169.254'],
    ['carrier-grade NAT', '100.64.0.1'],
  ])('rejects a hostname resolving to a private IPv4 address (%s: %s)', async (_label, ip) => {
    lookupMock.mockResolvedValueOnce([{ address: ip, family: 4 }]);
    const result = await assertPublicUrl('http://internal.example/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/private|internal/i);
  });

  it.each([
    ['loopback ::1', '::1'],
    ['unique-local fc00::/7', 'fc00::1'],
    ['link-local fe80::/10', 'fe80::1'],
    ['v4-mapped private', '::ffff:10.0.0.5'],
  ])('rejects a hostname resolving to a private IPv6 address (%s: %s)', async (_label, ip) => {
    lookupMock.mockResolvedValueOnce([{ address: ip, family: 6 }]);
    const result = await assertPublicUrl('http://internal.example/');
    expect(result.ok).toBe(false);
  });

  it('accepts a hostname resolving to an ordinary public address', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const result = await assertPublicUrl('https://example.com/path?x=1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.hostname).toBe('example.com');
  });

  it('rejects if ANY resolved address (of several) is private', async () => {
    lookupMock.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    const result = await assertPublicUrl('https://mixed.example/');
    expect(result.ok).toBe(false);
  });
});

describe('clampTimeoutMs', () => {
  it('defaults to 10000 when not a finite number', () => {
    expect(clampTimeoutMs(undefined)).toBe(10_000);
    expect(clampTimeoutMs('abc')).toBe(10_000);
    expect(clampTimeoutMs(NaN)).toBe(10_000);
  });

  it('clamps below the minimum', () => {
    expect(clampTimeoutMs(10)).toBe(1_000);
  });

  it('clamps above the maximum', () => {
    expect(clampTimeoutMs(999_999)).toBe(20_000);
  });

  it('passes through an in-range value', () => {
    expect(clampTimeoutMs(5_000)).toBe(5_000);
  });
});

describe('performHttpRequest', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('rejects (without calling fetch) when the URL fails the SSRF guard', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await performHttpRequest({
      url: 'http://internal.example/',
      method: 'GET',
      headers: [],
      queryParams: [],
      bodyType: 'none',
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('performs a GET, appends query params, and parses a JSON response', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ hello: 'world' }), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await performHttpRequest({
      url: 'https://example.com/api',
      method: 'GET',
      headers: [{ key: 'X-Test', value: '1' }],
      queryParams: [{ key: 'q', value: 'milk' }],
      bodyType: 'none',
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.status).toBe(200);
    expect(result.output.body).toEqual({ hello: 'world' });

    const [calledUrl, calledOptions] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toBe('https://example.com/api?q=milk');
    expect((calledOptions.headers as Record<string, string>)['X-Test']).toBe('1');
  });

  it('treats a non-2xx HTTP response as a completed request, not a failure', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = vi.fn().mockResolvedValueOnce(new Response('not found', { status: 404 })) as unknown as typeof fetch;

    const result = await performHttpRequest({
      url: 'https://example.com/missing',
      method: 'GET',
      headers: [],
      queryParams: [],
      bodyType: 'none',
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.status).toBe(404);
  });

  it('rejects an invalid JSON body before making any request', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await performHttpRequest({
      url: 'https://example.com/api',
      method: 'POST',
      headers: [],
      queryParams: [],
      bodyType: 'json',
      body: '{not valid json',
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a fetch timeout/abort to a clean error', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const abortError = new Error('The operation was aborted');
    abortError.name = 'TimeoutError';
    global.fetch = vi.fn().mockRejectedValueOnce(abortError) as unknown as typeof fetch;

    const result = await performHttpRequest({
      url: 'https://example.com/slow',
      method: 'GET',
      headers: [],
      queryParams: [],
      bodyType: 'none',
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/timed out/i);
  });

  // -------------------------------------------------------------------------
  // S5 — redirect-SSRF: the ORIGINAL URL passing assertPublicUrl must not be
  // enough. A server that's publicly reachable itself can still respond
  // with a redirect to a private/internal target; before this fix, fetch's
  // default `redirect: 'follow'` transparently followed it, bypassing the
  // SSRF guard entirely for every hop after the first.
  // -------------------------------------------------------------------------
  it('rejects a redirect from a public URL to a private/internal target (169.254.169.254 metadata address)', async () => {
    // Hop 1: the original URL resolves to a public address and returns a
    // redirect to the cloud-metadata address.
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(redirectResponse);
    global.fetch = fetchMock as unknown as typeof fetch;
    // Hop 2 (the redirect target) resolves to the metadata address — must be
    // rejected by assertPublicUrl before a second fetch call is ever made.
    lookupMock.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);

    const result = await performHttpRequest({
      url: 'https://public-looking.example/redirects-to-metadata',
      method: 'GET',
      headers: [],
      queryParams: [],
      bodyType: 'none',
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/private|internal/i);
    // Only the FIRST hop was ever actually requested — the redirect target
    // was never fetched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a redirect to a private RFC1918 address', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const redirectResponse = new Response(null, { status: 301, headers: { Location: 'http://internal-service.local/admin' } });
    const fetchMock = vi.fn().mockResolvedValueOnce(redirectResponse);
    global.fetch = fetchMock as unknown as typeof fetch;
    lookupMock.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);

    const result = await performHttpRequest({
      url: 'https://public-looking.example/redirects-internally',
      method: 'GET',
      headers: [],
      queryParams: [],
      bodyType: 'none',
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows a redirect chain where every hop is genuinely public, and re-resolves DNS for the FINAL hop (a DNS change between hops is re-checked, not cached from hop 1)', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]); // hop 1 (original)
    lookupMock.mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }]);       // hop 2 (redirect target) — a DIFFERENT public IP
    const redirectResponse = new Response(null, { status: 302, headers: { Location: 'https://public-2.example/final' } });
    const finalResponse = new Response('ok', { status: 200 });
    const fetchMock = vi.fn().mockResolvedValueOnce(redirectResponse).mockResolvedValueOnce(finalResponse);
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await performHttpRequest({
      url: 'https://public-1.example/start',
      method: 'GET',
      headers: [],
      queryParams: [],
      bodyType: 'none',
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lookupMock).toHaveBeenCalledTimes(2); // proves hop 2's host was independently re-resolved
  });

  it('caps a redirect chain at MAX_REDIRECTS rather than following indefinitely', async () => {
    // Every hop resolves publicly and redirects to the next — an endless chain.
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      call += 1;
      return Promise.resolve(new Response(null, { status: 302, headers: { Location: `https://public.example/hop-${call}` } }));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await performHttpRequest({
      url: 'https://public.example/start',
      method: 'GET',
      headers: [],
      queryParams: [],
      bodyType: 'none',
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/redirect/i);
    // Bounded, not unbounded — proves the loop actually terminates.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(6);
  });

  // -------------------------------------------------------------------------
  // S5 — unbounded response buffering: the response body must be STREAMED
  // and abandoned once the size cap is hit, not read into memory in full
  // (`await response.text()`) before any truncation is ever applied.
  // -------------------------------------------------------------------------
  it('streams and truncates a response body larger than the cap, WITHOUT reading it to completion', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);

    const CHUNK = new Uint8Array(200_000).fill(65); // 200,000 'A' bytes per chunk
    let chunksServed = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (cancelled) { controller.close(); return; }
        chunksServed += 1;
        controller.enqueue(CHUNK);
        // A well-behaved infinite/huge stream keeps producing chunks forever
        // until told to stop — exactly the shape a malicious/misbehaving
        // upstream could exploit if nothing ever cancels the read.
        if (chunksServed > 100) controller.close(); // safety valve for the test itself
      },
      cancel() { cancelled = true; },
    });
    const response = new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } });
    global.fetch = vi.fn().mockResolvedValueOnce(response) as unknown as typeof fetch;

    const result = await performHttpRequest({
      url: 'https://public.example/huge',
      method: 'GET',
      headers: [],
      queryParams: [],
      bodyType: 'none',
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.output.body).toBe('string');
    expect((result.output.body as string).length).toBeLessThan(1_100_000); // ~1MB cap + truncation notice
    expect((result.output.body as string)).toContain('truncated');
    // The critical assertion: far fewer than 100 chunks (20MB) were ever
    // pulled from the stream — it was abandoned once the ~1MB cap was hit,
    // not drained to completion first.
    expect(chunksServed).toBeLessThan(10);
    expect(cancelled).toBe(true);
  });

  it('does not truncate a response body under the cap', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = vi.fn().mockResolvedValueOnce(new Response('a small response', { status: 200 })) as unknown as typeof fetch;

    const result = await performHttpRequest({
      url: 'https://public.example/small',
      method: 'GET',
      headers: [],
      queryParams: [],
      bodyType: 'none',
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.body).toBe('a small response');
  });
});
