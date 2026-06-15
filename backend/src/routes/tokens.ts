// ---------------------------------------------------------------------------
// /api/tokens — Personal Access Token management (session-JWT authenticated).
//
// Users generate long-lived AI access tokens here for use with external MCP
// clients. The raw secret is returned exactly once (on creation); afterwards
// only metadata (name, prefix, last used, expiry) is ever exposed.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from 'express';
import { query } from '../db';
import { authenticate } from '../middleware';
import { generateApiToken } from '../apiToken';

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

// POST /api/tokens — create a token; returns the raw secret ONCE
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, expiresInDays } = req.body as { name?: string; expiresInDays?: number | null };
    const trimmed = (name ?? '').trim();
    if (!trimmed) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (trimmed.length > 100) {
      res.status(400).json({ error: 'name must be 100 characters or fewer' });
      return;
    }

    // Cap the number of active tokens per user to keep the surface small.
    const countRes = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM api_tokens WHERE user_id = $1`,
      [req.userId]
    );
    if (parseInt(countRes.rows[0].count, 10) >= 20) {
      res.status(400).json({ error: 'Token limit reached (20). Revoke an unused token first.' });
      return;
    }

    let expiresAt: string | null = null;
    if (expiresInDays != null && Number.isFinite(expiresInDays) && expiresInDays > 0) {
      const d = new Date();
      d.setDate(d.getDate() + Math.floor(expiresInDays));
      expiresAt = d.toISOString();
    }

    const { raw, hash, prefix } = generateApiToken();
    const result = await query<TokenRow>(
      `INSERT INTO api_tokens (user_id, name, token_hash, token_prefix, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, token_prefix, last_used_at, expires_at, created_at`,
      [req.userId, trimmed, hash, prefix, expiresAt]
    );

    res.status(201).json({
      token: { ...sanitize(result.rows[0]), secret: raw },
    });
  } catch (err) {
    console.error('tokens POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/tokens/:id — revoke a token
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
