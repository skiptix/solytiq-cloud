// ---------------------------------------------------------------------------
// /api/tokens — Personal Access Token management (session-JWT authenticated).
//
// Tokens are minted by the Claude OAuth flow (routes/oauth.ts); this router
// only lists the user's connected clients and lets them revoke (disconnect)
// one. The raw secret is never exposed here.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from 'express';
import { query } from '../db';
import { authenticate } from '../middleware';

const router = Router();
router.use(authenticate);

interface TokenRow {
  id: string;
  name: string;
  token_prefix: string;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

function sanitize(r: TokenRow) {
  return {
    id: r.id,
    name: r.name,
    prefix: r.token_prefix,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

// GET /api/tokens — list the user's tokens (never the secret)
router.get('/', async (req: Request, res: Response) => {
  try {
    const result = await query<TokenRow>(
      `SELECT id, name, token_prefix, last_used_at, expires_at, created_at
       FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json({ tokens: result.rows.map(sanitize) });
  } catch (err) {
    console.error('tokens GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/tokens/:id — revoke (disconnect) a token
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const result = await query(
      `DELETE FROM api_tokens WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Token not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('tokens DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
