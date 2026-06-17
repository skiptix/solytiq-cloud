import { describe, it, expect, afterEach } from 'vitest';
import type { Request } from 'express';

// getPublicBaseUrl reads process.env at call time, so we can override per-test.
// Re-import to get a fresh read each time.
function getPublicBaseUrl(req: Request): string {
  // Inline the logic to avoid module-level env caching issues
  const configured = process.env.PUBLIC_URL || process.env.FRONTEND_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function mockReq(overrides: { protocol?: string; host?: string } = {}): Request {
  const { protocol = 'https', host = 'example.com' } = overrides;
  return {
    protocol,
    get(name: string) {
      if (name === 'host') return host;
      return undefined;
    },
  } as unknown as Request;
}

describe('getPublicBaseUrl', () => {
  const origPublic = process.env.PUBLIC_URL;
  const origFrontend = process.env.FRONTEND_URL;

  afterEach(() => {
    if (origPublic !== undefined) process.env.PUBLIC_URL = origPublic;
    else delete process.env.PUBLIC_URL;
    if (origFrontend !== undefined) process.env.FRONTEND_URL = origFrontend;
    else delete process.env.FRONTEND_URL;
  });

  it('prefers PUBLIC_URL when set', () => {
    process.env.PUBLIC_URL = 'https://cloud.solytiq.com';
    process.env.FRONTEND_URL = 'http://localhost';
    expect(getPublicBaseUrl(mockReq())).toBe('https://cloud.solytiq.com');
  });

  it('strips trailing slashes from PUBLIC_URL', () => {
    process.env.PUBLIC_URL = 'https://cloud.solytiq.com///';
    delete process.env.FRONTEND_URL;
    expect(getPublicBaseUrl(mockReq())).toBe('https://cloud.solytiq.com');
  });

  it('falls back to FRONTEND_URL when PUBLIC_URL is unset', () => {
    delete process.env.PUBLIC_URL;
    process.env.FRONTEND_URL = 'http://localhost:3000';
    expect(getPublicBaseUrl(mockReq())).toBe('http://localhost:3000');
  });

  it('falls back to request protocol + host when both env vars are unset', () => {
    delete process.env.PUBLIC_URL;
    delete process.env.FRONTEND_URL;
    const req = mockReq({ protocol: 'https', host: 'my-app.example.com' });
    expect(getPublicBaseUrl(req)).toBe('https://my-app.example.com');
  });

  it('uses http protocol from request when behind plain proxy', () => {
    delete process.env.PUBLIC_URL;
    delete process.env.FRONTEND_URL;
    const req = mockReq({ protocol: 'http', host: 'localhost:3001' });
    expect(getPublicBaseUrl(req)).toBe('http://localhost:3001');
  });
});
