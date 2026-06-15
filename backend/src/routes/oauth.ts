import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db';
import { authenticate } from '../middleware';
import { generateApiToken } from '../apiToken';

const router = Router();

// GET /api/oauth/authorize
// Called by Claude. We don't authenticate here (it's a browser redirect).
// We simply redirect to the frontend with the OAuth parameters.
router.get('/authorize', (req: Request, res: Response) => {
  const { client_id, redirect_uri, state } = req.query;

  if (!redirect_uri || !state) {
    res.status(400).json({ error: 'Missing redirect_uri or state' });
    return;
  }

  // Assuming frontend is running on the same domain in production.
  // We can just use an absolute path for the redirect, or derive it from the request.
  // In development, the frontend is on port 5173 and backend on 3001.
  // Using an absolute path is safe because it will resolve relative to the host.
  const frontendUrl = new URL(req.protocol + '://' + req.get('host'));

  // If we are proxying in dev, or it's production, this works best by just doing a relative redirect
  // Actually, we can just do a relative redirect and let the browser handle it if they share the same origin
  // Wait, if backend is API only, we might need to know the frontend origin.
  // Let's check how other routes handle frontend URLs (like share links).
  // Actually, wait, let's just use /oauth/consent?redirect_uri=...&state=...
  // The frontend dev server proxies /api to backend, so a redirect to /oauth/consent will work on the same origin.

  res.redirect(`/oauth/consent?redirect_uri=${encodeURIComponent(redirect_uri as string)}&state=${encodeURIComponent(state as string)}`);
});

// POST /api/oauth/approve
// Called by the frontend when the user clicks "Allow". Authenticated.
router.post('/approve', authenticate, async (req: Request, res: Response) => {
  try {
    const { redirect_uri, state } = req.body;

    if (!redirect_uri || !state) {
      res.status(400).json({ error: 'Missing redirect_uri or state' });
      return;
    }

    // Generate a secure random code
    const code = crypto.randomBytes(32).toString('base64url');

    // Expires in 5 minutes
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 5);

    await query(
      `INSERT INTO oauth_codes (code, user_id, redirect_uri, state, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [code, req.userId, redirect_uri, state, expiresAt.toISOString()]
    );

    const callbackUrl = new URL(redirect_uri as string);
    callbackUrl.searchParams.append('code', code);
    callbackUrl.searchParams.append('state', state as string);

    res.json({ callbackUrl: callbackUrl.toString() });
  } catch (err) {
    console.error('oauth approve error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/oauth/token
// Server-to-server call from Claude to exchange the code for a PAT.
router.post('/token', async (req: Request, res: Response) => {
  try {
    const { code } = req.body;

    if (!code) {
      res.status(400).json({ error: 'Missing code' });
      return;
    }

    // Lookup the code
    const codeResult = await query<{ id: string; user_id: string; expires_at: string }>(
      `SELECT id, user_id, expires_at FROM oauth_codes WHERE code = $1`,
      [code]
    );

    if (codeResult.rows.length === 0) {
      res.status(400).json({ error: 'Invalid or expired code' });
      return;
    }

    const row = codeResult.rows[0];

    // Delete the code so it cannot be reused
    await query(`DELETE FROM oauth_codes WHERE id = $1`, [row.id]);

    // Check expiration
    if (new Date(row.expires_at) < new Date()) {
      res.status(400).json({ error: 'Code expired' });
      return;
    }

    // Generate a real PAT
    const { raw, hash, prefix } = generateApiToken();

    // Insert PAT
    const tokenName = 'Claude Connector';
    await query(
      `INSERT INTO api_tokens (user_id, name, token_hash, token_prefix)
       VALUES ($1, $2, $3, $4)`,
      [row.user_id, tokenName, hash, prefix]
    );

    // Return in standard OAuth 2.0 JSON format
    res.json({
      access_token: raw,
      token_type: 'bearer'
    });
  } catch (err) {
    console.error('oauth token error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
