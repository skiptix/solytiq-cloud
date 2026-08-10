// ---------------------------------------------------------------------------
// S3 — live-Postgres, live-HTTP integration test for the OAuth 2.1 /
// Dynamic Client Registration flow: registration → /client-info trust
// verdict → consent approval → token exchange, proving (with a real
// database and real HTTP requests, not mocks) that:
//   1. A self-registered ("attacker") client is never shown as trusted.
//   2. The minted PAT carries a bounded TTL (not indefinite).
//   3. A token-exchange request whose `resource` doesn't match this
//      server's own MCP resource identifier is rejected (audience check).
//
// Same live-DB convention as objectPolicy.integration.test.ts — env vars are
// set before any dynamic import, and every test SKIPS (not passes) if no
// database is reachable. See that file's header for the exact setup this
// depends on.
// ---------------------------------------------------------------------------

import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.PGHOST     = process.env.TEST_PGHOST     ?? 'localhost';
process.env.PGPORT     = process.env.TEST_PGPORT     ?? '5432';
process.env.PGDATABASE = process.env.TEST_PGDATABASE ?? 'solytiq_test';
process.env.PGUSER     = process.env.TEST_PGUSER     ?? 'solytiq_test';
process.env.PGPASSWORD = process.env.TEST_PGPASSWORD ?? 'solytiq_test_pw';
process.env.OAUTH_TRUSTED_REDIRECT_HOSTS = 'trusted-mcp-client.example.com';
// PUBLIC_URL/FRONTEND_URL are deliberately left UNSET (see beforeAll) so
// getPublicBaseUrl(req) derives the resource audience from the request's own
// Host header — matching the test HTTP server's actual address.

let dbAvailable = false;
let pool: typeof import('../db').pool;

try {
  const dbMod = await import('../db');
  pool = dbMod.pool;
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch (err) {
  console.warn(`⚠️  oauthFlow.integration.test.ts: no reachable Postgres — every test in this file is SKIPPED, not passed. (${(err as Error)?.message})`);
}

describe.skipIf(!dbAvailable)('OAuth flow — live DB + live HTTP', () => {
  let server: http.Server;
  let baseUrl: string;
  let userId: string;
  let userToken: string;

  const attackerRedirect = 'https://phishing-lookalike.example.com/callback';
  const trustedRedirect = 'https://trusted-mcp-client.example.com/callback';

  beforeAll(async () => {
    // Locked entry point, not raw runMigrations() — see objectPolicy.
    // integration.test.ts's beforeAll comment for why (concurrent test
    // files racing DDL on the shared solytiq_test database).
    const { runAllMigrations } = await import('../migrations');
    await runAllMigrations();

    const express = (await import('express')).default;
    const oauthRouter = (await import('../routes/oauth')).default;
    const { generateToken } = await import('../auth');
    const { hashPassword } = await import('../auth');

    userId = 'b0000000-0000-4000-8000-0000000000f1';
    await pool.query(`DELETE FROM api_tokens WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, full_name, is_admin)
       VALUES ($1, 'oauth_test_user', 'oauth-test@test.local', $2, 'OAuth Tester', false)`,
      [userId, await hashPassword('irrelevant-for-this-test-x')]
    );
    userToken = generateToken(userId, 0);

    const app = express();
    app.use(express.json());
    app.use('/api/oauth', oauthRouter);

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM oauth_codes WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM api_tokens WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM oauth_clients WHERE client_id LIKE 'mcp_test_%'`);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  async function registerClient(redirectUri: string): Promise<{ client_id: string }> {
    const res = await fetch(`${baseUrl}/api/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirectUri] }),
    });
    expect(res.status).toBe(201);
    return res.json();
  }

  it('an attacker-registered client claiming to be "Claude" is marked UNTRUSTED by client-info', async () => {
    const { client_id } = await registerClient(attackerRedirect);
    const res = await fetch(
      `${baseUrl}/api/oauth/client-info?client_id=${client_id}&redirect_uri=${encodeURIComponent(attackerRedirect)}`,
      { headers: { Authorization: `Bearer ${userToken}` } }
    );
    expect(res.status).toBe(200);
    const info = await res.json();
    // The registered name is still returned (so the frontend CAN show it),
    // but `trusted` — the one signal the UI is allowed to render "Claude"
    // from — must be false, because the redirect host is not on the
    // operator's allowlist, regardless of what client_name claims.
    expect(info.trusted).toBe(false);
    expect(info.redirectHost).toBe('phishing-lookalike.example.com');
  });

  it('a client registered with a genuinely trusted redirect host IS marked trusted', async () => {
    const { client_id } = await registerClient(trustedRedirect);
    const res = await fetch(
      `${baseUrl}/api/oauth/client-info?client_id=${client_id}&redirect_uri=${encodeURIComponent(trustedRedirect)}`,
      { headers: { Authorization: `Bearer ${userToken}` } }
    );
    const info = await res.json();
    expect(info.trusted).toBe(true);
  });

  it('client-info requires authentication (no anonymous client-identity probing)', async () => {
    const { client_id } = await registerClient(attackerRedirect);
    const res = await fetch(`${baseUrl}/api/oauth/client-info?client_id=${client_id}&redirect_uri=${encodeURIComponent(attackerRedirect)}`);
    expect(res.status).toBe(401);
  });

  it('the full authorize → approve → token exchange issues a PAT with a bounded expiry (not indefinite)', async () => {
    const crypto = await import('crypto');
    const { client_id } = await registerClient(trustedRedirect);
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    const approveRes = await fetch(`${baseUrl}/api/oauth/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({
        client_id, redirect_uri: trustedRedirect,
        code_challenge: codeChallenge, code_challenge_method: 'S256',
      }),
    });
    expect(approveRes.status).toBe(200);
    const { redirectUrl } = await approveRes.json();
    const code = new URL(redirectUrl).searchParams.get('code');
    expect(code).toBeTruthy();

    const tokenRes = await fetch(`${baseUrl}/api/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code', code, redirect_uri: trustedRedirect,
        client_id, code_verifier: codeVerifier,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = await tokenRes.json();
    expect(tokenBody.access_token).toMatch(/^solytiq_pat_/);
    // Before the fix, no expires_in was ever returned and api_tokens.expires_at
    // stayed NULL (never expires) for every OAuth-issued token.
    expect(tokenBody.expires_in).toBeGreaterThan(0);
    expect(tokenBody.expires_in).toBeLessThanOrEqual(90 * 24 * 60 * 60);

    const row = await pool.query<{ expires_at: string | null }>(
      `SELECT expires_at FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    expect(row.rows[0].expires_at).not.toBeNull();
  });

  it('rejects a token exchange whose authorize-time `resource` does not match this server (audience confusion)', async () => {
    const crypto = await import('crypto');
    const { client_id } = await registerClient(trustedRedirect);
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    const approveRes = await fetch(`${baseUrl}/api/oauth/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({
        client_id, redirect_uri: trustedRedirect,
        code_challenge: codeChallenge, code_challenge_method: 'S256',
        resource: 'https://a-totally-different-mcp-server.example.com/mcp',
      }),
    });
    expect(approveRes.status).toBe(200);
    const { redirectUrl } = await approveRes.json();
    const code = new URL(redirectUrl).searchParams.get('code');

    const tokenRes = await fetch(`${baseUrl}/api/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code', code, redirect_uri: trustedRedirect,
        client_id, code_verifier: codeVerifier,
      }),
    });
    expect(tokenRes.status).toBe(400);
    const body = await tokenRes.json();
    expect(body.error).toBe('invalid_target');
  });

  it('DCR (POST /register) rejects a non-https, non-loopback redirect_uri', async () => {
    const res = await fetch(`${baseUrl}/api/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Evil', redirect_uris: ['http://attacker.example.com/callback'] }),
    });
    expect(res.status).toBe(400);
  });
});
