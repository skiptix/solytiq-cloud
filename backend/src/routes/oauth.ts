import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db';
import { authenticate } from '../middleware';
import { generateApiToken } from '../apiToken';

const router = Router();

// POST /api/oauth/register
// Stateless dummy endpoint for Dynamic Client Registration (DCR).
// Simply returns a static JSON response.
router.post('/register', (req: Request, res: Response) => {
  res.json({ client_id: 'claude_auto_client' });
});

// GET /api/oauth/authorize
// Called by Claude. We don't authenticate here (it's a browser redirect).
// We simply redirect to the frontend with the OAuth parameters.
router.get('/authorize', (req: Request, res: Response) => {
  const { client_id, redirect_uri, state } = req.query;

  if (!redirect_uri || !state) {
    res.status(400).json({ error: 'Missing redirect_uri or state' });
    return;
  }

  const baseFrontendUrl = process.env.FRONTEND_URL || (req.protocol + '://' + req.get('host'));

  // Construct the absolute URL using FRONTEND_URL if available.
  // This ensures that the browser correctly navigates to the React frontend
  // when the backend and frontend are hosted on different origins.
  const targetUrl = new URL('/oauth/consent', baseFrontendUrl);
  targetUrl.searchParams.set('redirect_uri', redirect_uri as string);
  targetUrl.searchParams.set('state', state as string);

  res.redirect(targetUrl.toString());
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

    res.json({ redirectUrl: callbackUrl.toString() });
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
