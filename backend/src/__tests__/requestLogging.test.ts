import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateRequestId, getOrAssignRequestId, requestLoggingMiddleware } from '../requestLogging';
import { globalRequestMetrics } from '../requestMetrics';

describe('generateRequestId', () => {
  it('generates a non-empty hex string', () => {
    const id = generateRequestId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(id).toMatch(/^[0-9a-f]+$/);
  });

  it('generates a DIFFERENT id on each call — collisions would make correlation useless', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateRequestId()));
    expect(ids.size).toBe(50);
  });
});

describe('getOrAssignRequestId', () => {
  it('honors a valid inbound header', () => {
    expect(getOrAssignRequestId('upstream-trace-123')).toBe('upstream-trace-123');
  });

  it('trims surrounding whitespace', () => {
    expect(getOrAssignRequestId('  spaced-id  ')).toBe('spaced-id');
  });

  it('mints a fresh id when the header is absent', () => {
    const id = getOrAssignRequestId(undefined);
    expect(id.length).toBeGreaterThan(0);
  });

  it('mints a fresh id when the header is an empty string', () => {
    const id = getOrAssignRequestId('');
    expect(id.length).toBeGreaterThan(0);
  });

  it('mints a fresh id when the header is absurdly long (defensive cap, avoids logging an unbounded attacker-controlled value)', () => {
    const huge = 'x'.repeat(500);
    const id = getOrAssignRequestId(huge);
    expect(id).not.toBe(huge.trim());
  });

  it('takes the first value when the header was sent as an array (duplicated header)', () => {
    expect(getOrAssignRequestId(['first-id', 'second-id'])).toBe('first-id');
  });
});

// A minimal fake Express req/res good enough to drive the middleware without
// pulling in a real HTTP server — mirrors this suite's existing convention
// of a small hand-rolled fake (see sseBackpressure.test.ts's FakeRes).
class FakeRes extends EventEmitter {
  statusCode = 200;
  locals: Record<string, unknown> = {};
  headers: Record<string, string> = {};
  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
}

function fakeReq(overrides: Partial<{ headers: Record<string, string | string[] | undefined>; method: string; path: string; baseUrl: string; route: { path: string }; userId: string }> = {}) {
  return {
    headers: overrides.headers ?? {},
    method: overrides.method ?? 'GET',
    path: overrides.path ?? '/api/tasks',
    baseUrl: overrides.baseUrl ?? '',
    route: overrides.route,
    userId: overrides.userId,
  } as unknown as Parameters<typeof requestLoggingMiddleware>[0];
}

describe('requestLoggingMiddleware', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('calls next() synchronously — never blocks the request pipeline', () => {
    const req = fakeReq();
    const res = new FakeRes() as unknown as Parameters<typeof requestLoggingMiddleware>[1];
    const next = vi.fn();
    requestLoggingMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('sets res.locals.requestId and the X-Request-Id response header', () => {
    const req = fakeReq({ headers: { 'x-request-id': 'trace-abc' } });
    const res = new FakeRes();
    requestLoggingMiddleware(req, res as unknown as Parameters<typeof requestLoggingMiddleware>[1], vi.fn());
    expect(res.locals.requestId).toBe('trace-abc');
    expect(res.headers['x-request-id']).toBe('trace-abc');
  });

  it('emits exactly one JSON log line on "finish", not before', () => {
    const req = fakeReq();
    const res = new FakeRes();
    requestLoggingMiddleware(req, res as unknown as Parameters<typeof requestLoggingMiddleware>[1], vi.fn());
    expect(logSpy).not.toHaveBeenCalled();
    res.statusCode = 200;
    res.emit('finish');
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(line.msg).toBe('http_request');
    expect(line.status).toBe(200);
    expect(line.method).toBe('GET');
    expect(typeof line.durationMs).toBe('number');
    expect(line.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('logs level "info" for 2xx/3xx, "warn" for 4xx, "error" for 5xx', () => {
    for (const [status, expectedLevel] of [[200, 'info'], [301, 'info'], [404, 'warn'], [500, 'error']] as const) {
      logSpy.mockClear();
      const req = fakeReq();
      const res = new FakeRes();
      requestLoggingMiddleware(req, res as unknown as Parameters<typeof requestLoggingMiddleware>[1], vi.fn());
      res.statusCode = status;
      res.emit('finish');
      const line = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(line.level).toBe(expectedLevel);
    }
  });

  it('reports the ROUTE PATTERN (req.route.path + baseUrl), not a raw id-bearing path', () => {
    const req = fakeReq({ baseUrl: '/api/tasks', route: { path: '/:id' }, path: '/api/tasks/9007199254740991' });
    const res = new FakeRes();
    requestLoggingMiddleware(req, res as unknown as Parameters<typeof requestLoggingMiddleware>[1], vi.fn());
    res.emit('finish');
    const line = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(line.route).toBe('/api/tasks/:id');
    expect(line.route).not.toContain('9007199254740991');
  });

  it('falls back to the raw path when no route matched (e.g. a 404 on an unknown path)', () => {
    const req = fakeReq({ path: '/api/does-not-exist' });
    const res = new FakeRes();
    requestLoggingMiddleware(req, res as unknown as Parameters<typeof requestLoggingMiddleware>[1], vi.fn());
    res.statusCode = 404;
    res.emit('finish');
    const line = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(line.route).toBe('/api/does-not-exist');
  });

  it('includes userId when the (later-running) auth middleware set req.userId, null otherwise', () => {
    const reqWithUser = fakeReq({ userId: 'user-123' });
    const res1 = new FakeRes();
    requestLoggingMiddleware(reqWithUser, res1 as unknown as Parameters<typeof requestLoggingMiddleware>[1], vi.fn());
    res1.emit('finish');
    expect(JSON.parse(logSpy.mock.calls[0][0] as string).userId).toBe('user-123');

    logSpy.mockClear();
    const reqAnon = fakeReq();
    const res2 = new FakeRes();
    requestLoggingMiddleware(reqAnon, res2 as unknown as Parameters<typeof requestLoggingMiddleware>[1], vi.fn());
    res2.emit('finish');
    expect(JSON.parse(logSpy.mock.calls[0][0] as string).userId).toBeNull();
  });

  it('records the sample into the shared metrics ring buffer on finish', () => {
    const before = globalRequestMetrics.snapshot().totalRequests;
    const req = fakeReq();
    const res = new FakeRes();
    requestLoggingMiddleware(req, res as unknown as Parameters<typeof requestLoggingMiddleware>[1], vi.fn());
    res.emit('finish');
    expect(globalRequestMetrics.snapshot().totalRequests).toBe(before + 1);
  });
});
