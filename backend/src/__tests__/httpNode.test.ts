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
});
