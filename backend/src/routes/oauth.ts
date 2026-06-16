// ---------------------------------------------------------------------------
// OAuth 2.1 authorization server for the Claude MCP connector.
//
// Implements the subset of the MCP authorization spec a custom connector needs:
//   - Dynamic Client Registration (RFC 7591)        POST /api/oauth/register
//   - Authorization endpoint (front channel)         GET  /api/oauth/authorize
//   - Consent approval (session-authenticated)       POST /api/oauth/approve
//   - Token endpoint (back channel)                  POST /api/oauth/token
//
// Security properties:
//   - PKCE (S256) is mandatory — codes are bound to a code_challenge and the
//     token exchange verifies the code_verifier.
//   - redirect_uri is strictly matched against the client's registered URIs.
//   - Authorization codes are single-use and expire after 5 minutes.
//   - The granted credential is an ordinary Solytiq PAT scoped to the
//     consenting user, so the connector can only ever do what that user can do.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db';
import { authenticate } from '../middleware';
import { generateApiToken } from '../apiToken';
import { getPublicBaseUrl } from '../publicUrl';

const router = Router();

const CODE_TTL_MS = 5 * 60 * 1000; // authorization codes live 5 minutes

// A redirect_uri must be an absolute https URL (http only for loopback dev).
function isValidRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return true;
  return false;
}

function base64UrlSha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('base64url');
}

// Build an OAuth error redirect back to the client (RFC 6749 §4.1.2.1).
function redirectError(res: Response, redirectUri: string, state: string | undefined, error: string, description?: string): void {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (description) url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
}

// ---------------------------------------------------------------------------
// POST /api/oauth/register — Dynamic Client Registration (RFC 7591)
// Claude registers itself as a public PKCE client and gets back a client_id.
// ---------------------------------------------------------------------------
router.post('/register', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      client_name?: unknown;
      redirect_uris?: unknown;
    };

    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every(isValidRedirectUri)) {
      res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be a non-empty array of https URLs' });
      return;
    }
    if (redirectUris.length > 10) {
      res.status(400).json({ error: 'invalid_client_metadata', error_description: 'too many redirect_uris' });
      return;
    }

    const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : 'MCP Client';
    const clientId = 'mcp_' + crypto.randomBytes(24).toString('base64url');
    const issuedAt = Math.floor(Date.now() / 1000);

    await query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)`,
      [clientId, clientName, JSON.stringify(redirectUris)]
    );

    // Public client using PKCE — no client secret is issued.
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: issuedAt,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  } catch (err) {
    console.error('oauth register error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/oauth/authorize — front-channel entry point (browser redirect).
// Validates the request, then hands off to the in-app consent screen.
// ---------------------------------------------------------------------------
router.get('/authorize', async (req: Request, res: Response) => {
  try {
    const clientId = typeof req.query.client_id === 'string' ? req.query.client_id : '';
    const redirectUri = typeof req.query.redirect_uri === 'string' ? req.query.redirect_uri : '';
    const responseType = typeof req.query.response_type === 'string' ? req.query.response_type : '';
    const codeChallenge = typeof req.query.code_challenge === 'string' ? req.query.code_challenge : '';
    const codeChallengeMethod = typeof req.query.code_challenge_method === 'string' ? req.query.code_challenge_method : '';
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const scope = typeof req.query.scope === 'string' ? req.query.scope : undefined;
    const resource = typeof req.query.resource === 'string' ? req.query.resource : undefined;

    // The client and redirect_uri must check out before we trust redirect_uri
    // enough to send an OAuth error back to it.
    const clientRes = await query<{ redirect_uris: string[] }>(
      `SELECT redirect_uris FROM oauth_clients WHERE client_id = $1`,
      [clientId]
    );
    const client = clientRes.rows[0];
    if (!client || !redirectUri || !client.redirect_uris.includes(redirectUri)) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Unknown client or redirect_uri' });
      return;
    }

    // From here on, errors are reported to the client via redirect.
    if (responseType !== 'code') {
      redirectError(res, redirectUri, state, 'unsupported_response_type');
      return;
    }
    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      redirectError(res, redirectUri, state, 'invalid_request', 'PKCE with S256 is required');
      return;
    }

    // Hand off to the React consent screen, preserving the request parameters.
    const consentUrl = new URL('/oauth/consent', getPublicBaseUrl(req));
    consentUrl.searchParams.set('client_id', clientId);
    consentUrl.searchParams.set('redirect_uri', redirectUri);
    consentUrl.searchParams.set('code_challenge', codeChallenge);
    consentUrl.searchParams.set('code_challenge_method', codeChallengeMethod);
    if (state) consentUrl.searchParams.set('state', state);
    if (scope) consentUrl.searchParams.set('scope', scope);
    if (resource) consentUrl.searchParams.set('resource', resource);
    res.redirect(consentUrl.toString());
  } catch (err) {
    console.error('oauth authorize error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/oauth/approve — the logged-in user consents. Mints a single-use
// authorization code bound to the user, client, redirect_uri and PKCE challenge.
// ---------------------------------------------------------------------------
router.post('/approve', authenticate, async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      client_id?: string;
      redirect_uri?: string;
      code_challenge?: string;
      code_challenge_method?: string;
      state?: string;
      scope?: string;
      resource?: string;
    };
    const { client_id, redirect_uri, code_challenge, code_challenge_method, state, scope, resource } = body;

    if (!client_id || !redirect_uri || !code_challenge || code_challenge_method !== 'S256') {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    // Re-validate the client/redirect_uri pairing server-side.
    const clientRes = await query<{ redirect_uris: string[] }>(
      `SELECT redirect_uris FROM oauth_clients WHERE client_id = $1`,
      [client_id]
    );
    const client = clientRes.rows[0];
    if (!client || !client.redirect_uris.includes(redirect_uri)) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Unknown client or redirect_uri' });
      return;
    }

    const code = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

    await query(
      `INSERT INTO oauth_codes (code, user_id, client_id, redirect_uri, code_challenge, code_challenge_method, scope, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [code, req.userId, client_id, redirect_uri, code_challenge, code_challenge_method, scope ?? null, resource ?? null, expiresAt]
    );

    const callbackUrl = new URL(redirect_uri);
    callbackUrl.searchParams.set('code', code);
    if (state) callbackUrl.searchParams.set('state', state);

    res.json({ redirectUrl: callbackUrl.toString() });
  } catch (err) {
    console.error('oauth approve error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/oauth/token — back-channel code exchange. Verifies PKCE and
// returns a Solytiq PAT scoped to the consenting user.
// ---------------------------------------------------------------------------
router.post('/token', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      grant_type?: string;
      code?: string;
      redirect_uri?: string;
      client_id?: string;
      code_verifier?: string;
    };
    const { grant_type, code, redirect_uri, client_id, code_verifier } = body;

    if (grant_type !== 'authorization_code') {
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }
    if (!code || !redirect_uri || !client_id || !code_verifier) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    // Atomically consume the code so it can never be replayed.
    const codeRes = await query<{
      user_id: string;
      client_id: string;
      redirect_uri: string;
      code_challenge: string;
      scope: string | null;
      expires_at: string;
    }>(
      `DELETE FROM oauth_codes WHERE code = $1
       RETURNING user_id, client_id, redirect_uri, code_challenge, scope, expires_at`,
      [code]
    );
    const row = codeRes.rows[0];

    if (!row) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired' });
      return;
    }
    if (row.client_id !== client_id || row.redirect_uri !== redirect_uri) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'client_id / redirect_uri mismatch' });
      return;
    }
    // PKCE verification (S256). Constant-time compare of the derived challenge.
    const derived = base64UrlSha256(code_verifier);
    const expected = Buffer.from(row.code_challenge);
    const actual = Buffer.from(derived);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      return;
    }

    // Name the token after the registered client so it's recognisable in the
    // "Connected" list under Settings.
    const nameRes = await query<{ client_name: string | null }>(
      `SELECT client_name FROM oauth_clients WHERE client_id = $1`,
      [client_id]
    );
    const tokenName = nameRes.rows[0]?.client_name?.trim() || 'Claude';

    const { raw, hash, prefix } = generateApiToken();
    await query(
      `INSERT INTO api_tokens (user_id, name, token_hash, token_prefix) VALUES ($1, $2, $3, $4)`,
      [row.user_id, tokenName.slice(0, 100), hash, prefix]
    );

    res.json({
      access_token: raw,
      token_type: 'Bearer',
      scope: row.scope ?? undefined,
    });
  } catch (err) {
    console.error('oauth token error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
