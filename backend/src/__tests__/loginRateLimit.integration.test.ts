// ---------------------------------------------------------------------------
// S5 — account-scoped login rate limiters (loginRateLimit.ts), proven at the
// real HTTP level: a distributed attack (many different source IPs, one
// target account) must still get blocked, which an IP-only limiter like
// authLimiter cannot do on its own. No live DB needed — express-rate-limit's
// default store is in-memory and the mounted handler here is a dummy stand-in
// for the real /login and /2fa/verify routes (those routes' own DB-backed
// correctness is exercised elsewhere; this file is purely about the rate
// limiter wiring). Real HTTP requests via http.createServer + fetch, same
// convention as oauthFlow.integration.test.ts / shareSession.integration.test.ts.
// ---------------------------------------------------------------------------

import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountLoginLimiter, accountTwoFaLimiter } from '../loginRateLimit';
import { generatePendingToken } from '../auth';

describe('account-scoped login rate limiting — live HTTP', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    // Trust the X-Forwarded-For header we set on each request below, so
    // req.ip (and therefore the limiter's own IP fallback) reflects the
    // spoofed per-request "source IP" rather than the test runner's loopback
    // address for every single call.
    app.set('trust proxy', true);
    app.use(express.json());
    app.post('/login', accountLoginLimiter, (_req, res) => res.status(200).json({ ok: true }));
    app.post('/2fa/verify', accountTwoFaLimiter, (_req, res) => res.status(200).json({ ok: true }));

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function loginAttempt(body: Record<string, unknown>, ip: string): Promise<Response> {
    return fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify(body),
    });
  }

  async function twoFaAttempt(body: Record<string, unknown>, ip: string): Promise<Response> {
    return fetch(`${baseUrl}/2fa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify(body),
    });
  }

  it('blocks a distributed attack against one account even though every single request comes from a DIFFERENT source IP', async () => {
    const target = 'victim-account-distributed';
    const statuses: number[] = [];
    for (let i = 0; i < 16; i++) {
      const res = await loginAttempt({ username: target, password: 'guess' }, `10.0.1.${i}`);
      statuses.push(res.status);
    }
    // max is 15 for this bucket — the 16th attempt, from a brand-new IP that
    // has never been seen before, must STILL be blocked, because the budget
    // is tracked per ACCOUNT, not per IP.
    expect(statuses.slice(0, 15).every((s) => s === 200)).toBe(true);
    expect(statuses[15]).toBe(429);
  });

  it('username and email for the same account share one budget (case/whitespace-insensitive)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await loginAttempt({ username: '  Shared.Account  ', password: 'x' }, `10.0.2.${i}`);
      statuses.push(res.status);
    }
    for (let i = 8; i < 16; i++) {
      const res = await loginAttempt({ email: 'SHARED.ACCOUNT', password: 'x' }, `10.0.2.${i}`);
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 15).every((s) => s === 200)).toBe(true);
    expect(statuses[15]).toBe(429);
  });

  it('does not rate-limit an unrelated account, even once a different account\'s budget is exhausted', async () => {
    const res = await loginAttempt({ username: 'completely-unrelated-account', password: 'x' }, '10.0.3.1');
    expect(res.status).toBe(200);
  });

  it('does not apply an account-scoped block to a request with no identifiable account (skip — the route itself would 400 this)', async () => {
    const res = await loginAttempt({ password: 'no-username-or-email' }, '10.0.4.1');
    expect(res.status).toBe(200);
  });

  it('2FA: blocks a distributed attack against one pendingToken\'s decoded account, across many source IPs', async () => {
    const pendingToken = generatePendingToken('user-under-2fa-attack');
    const statuses: number[] = [];
    for (let i = 0; i < 16; i++) {
      const res = await twoFaAttempt({ pendingToken, code: '000000' }, `10.1.0.${i}`);
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 15).every((s) => s === 200)).toBe(true);
    expect(statuses[15]).toBe(429);
  });

  it('2FA: a different pendingToken (different account) has its own independent budget', async () => {
    const pendingToken = generatePendingToken('a-completely-different-user');
    const res = await twoFaAttempt({ pendingToken, code: '111111' }, '10.1.1.1');
    expect(res.status).toBe(200);
  });

  it('2FA: does not apply an account-scoped block to an invalid/unverifiable pendingToken (skip — the route itself would 401 this)', async () => {
    const res = await twoFaAttempt({ pendingToken: 'not-a-real-token', code: '000000' }, '10.1.2.1');
    expect(res.status).toBe(200);
  });
});
