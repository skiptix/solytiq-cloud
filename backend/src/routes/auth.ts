import { Router, Request, Response } from 'express';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { query, pool } from '../db';
import { generateToken, hashPassword, comparePassword, generatePendingToken, verifyPendingToken } from '../auth';
import { authenticate } from '../middleware';

const router = Router();

interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  full_name: string | null;
  profile_image: string | null;
  is_admin: boolean;
  created_at: string;
  totp_secret: string | null;
  totp_enabled: boolean;
}

function sanitizeUser(user: UserRow) {
  return {
    id:           user.id,
    username:     user.username,
    email:        user.email,
    fullName:     user.full_name,
    profileImage: user.profile_image ?? null,
    isAdmin:      user.is_admin,
    createdAt:    user.created_at,
    totpEnabled:  user.totp_enabled,
  };
}

// GET /api/auth/setup-required
router.get('/setup-required', async (_req: Request, res: Response) => {
  try {
    const result = await query<{ count: string }>('SELECT COUNT(*) AS count FROM users');
    const count = parseInt(result.rows[0].count, 10);
    res.json({ required: count === 0 });
  } catch (err) {
    console.error('setup-required error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { username, email, password, fullName } = req.body as {
      username?: string;
      email?: string;
      password?: string;
      fullName?: string;
    };

    if (!username || !email || !password) {
      res.status(400).json({ error: 'username, email and password are required' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(123456789)');

      const existingCount = await client.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM users'
      );
      if (parseInt(existingCount.rows[0].count, 10) > 0) {
        await client.query('ROLLBACK');
        res.status(403).json({ error: 'Admin already registered' });
        return;
      }

      const passwordHash = await hashPassword(password);

      const inserted = await client.query<UserRow>(
        `INSERT INTO users (username, email, password_hash, full_name, is_admin)
         VALUES ($1, $2, $3, $4, true)
         RETURNING *`,
        [username, email, passwordHash, fullName ?? null]
      );
      await client.query('COMMIT');

      const user = inserted.rows[0];
      const token = generateToken(user.id);

      res.status(201).json({ token, user: sanitizeUser(user) });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('register error:', err);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { username, email, password } = req.body as {
      username?: string;
      email?: string;
      password?: string;
    };

    if (!password || (!username && !email)) {
      res.status(400).json({ error: 'password and username or email are required' });
      return;
    }

    const result = await query<UserRow>(
      'SELECT * FROM users WHERE username = $1 OR email = $2 LIMIT 1',
      [username ?? null, email ?? null]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const user = result.rows[0];
    const valid = await comparePassword(password, user.password_hash);

    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    if (user.totp_enabled) {
      const pendingToken = generatePendingToken(user.id);
      res.json({ requires2FA: true, pendingToken });
      return;
    }

    const token = generateToken(user.id);
    res.json({ token, user: sanitizeUser(user) });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await query<UserRow>(
      'SELECT * FROM users WHERE id = $1',
      [req.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user: sanitizeUser(result.rows[0]) });
  } catch (err) {
    console.error('me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/auth/profile
router.put('/profile', authenticate, async (req: Request, res: Response) => {
  try {
    const { fullName, email } = req.body as {
      fullName?: string;
      email?: string;
    };

    const result = await query<UserRow>(
      `UPDATE users
       SET full_name = COALESCE($1, full_name),
           email     = COALESCE($2, email)
       WHERE id = $3
       RETURNING *`,
      [fullName ?? null, email ?? null, req.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user: sanitizeUser(result.rows[0]) });
  } catch (err) {
    console.error('profile update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/auth/profile-image
router.put('/profile-image', authenticate, async (req: Request, res: Response) => {
  try {
    const { imageData } = req.body as { imageData?: string | null };

    if (imageData) {
      const match = imageData.match(/^data:(image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/=]+)$/);
      if (!match) {
        res.status(400).json({ error: 'Only PNG, JPEG, or WebP base64 images are allowed' });
        return;
      }

      const base64 = match[2];
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length > 512 * 1024) {
        res.status(400).json({ error: 'Profile image must be 512KB or smaller' });
        return;
      }
    }

    const result = await query<UserRow>(
      `UPDATE users SET profile_image = $1 WHERE id = $2 RETURNING *`,
      [imageData ?? null, req.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user: sanitizeUser(result.rows[0]) });
  } catch (err) {
    console.error('profile-image update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/members
router.get('/members', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await query<{ id: string; username: string; email: string; full_name: string | null; profile_image: string | null; is_admin: boolean }>(
      'SELECT id, username, email, full_name, profile_image, is_admin FROM users ORDER BY created_at ASC'
    );
    res.json({
      members: result.rows.map(u => ({
        id:           u.id,
        username:     u.username,
        email:        req.user?.isAdmin ? u.email : undefined,
        fullName:     u.full_name,
        profileImage: u.profile_image ?? null,
        isAdmin:      u.is_admin,
      })),
    });
  } catch (err) {
    console.error('members GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// 2FA Routes
// ---------------------------------------------------------------------------

// POST /api/auth/2fa/setup  — generate secret + QR code (does NOT enable yet)
router.post('/2fa/setup', authenticate, async (req: Request, res: Response) => {
  try {
    const userRes = await query<UserRow>('SELECT username FROM users WHERE id = $1', [req.userId]);
    if (!userRes.rows[0]) { res.status(404).json({ error: 'User not found' }); return; }

    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(userRes.rows[0].username, 'Solytiq Cloud', secret);
    await query('UPDATE users SET totp_secret = $1 WHERE id = $2', [secret, req.userId]);
    const qrCode = await QRCode.toDataURL(otpauth, { margin: 2, color: { dark: '#1c1b22', light: '#ffffff' } });

    res.json({ secret, qrCode });
  } catch (err) {
    console.error('2fa setup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/2fa/enable  — verify a code then flip totp_enabled = true
router.post('/2fa/enable', authenticate, async (req: Request, res: Response) => {
  try {
    const { code } = req.body as { code?: string };
    if (!code) { res.status(400).json({ error: 'code is required' }); return; }

    const userRes = await query<{ totp_secret: string | null; totp_enabled: boolean }>(
      'SELECT totp_secret, totp_enabled FROM users WHERE id = $1',
      [req.userId]
    );
    const user = userRes.rows[0];
    if (!user?.totp_secret) { res.status(400).json({ error: 'Run /2fa/setup first' }); return; }

    if (!authenticator.verify({ token: code, secret: user.totp_secret })) {
      res.status(400).json({ error: 'Invalid code — please try again' }); return;
    }

    await query('UPDATE users SET totp_enabled = true WHERE id = $1', [req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('2fa enable error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/2fa/disable  — verify a code then remove 2FA
router.post('/2fa/disable', authenticate, async (req: Request, res: Response) => {
  try {
    const { code } = req.body as { code?: string };
    if (!code) { res.status(400).json({ error: 'code is required' }); return; }

    const userRes = await query<{ totp_secret: string | null; totp_enabled: boolean }>(
      'SELECT totp_secret, totp_enabled FROM users WHERE id = $1',
      [req.userId]
    );
    const user = userRes.rows[0];
    if (!user?.totp_enabled) { res.status(400).json({ error: '2FA is not enabled' }); return; }
    if (!user.totp_secret) { res.status(400).json({ error: 'No 2FA secret found' }); return; }

    if (!authenticator.verify({ token: code, secret: user.totp_secret })) {
      res.status(400).json({ error: 'Invalid code — please try again' }); return;
    }

    await query('UPDATE users SET totp_enabled = false, totp_secret = NULL WHERE id = $1', [req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('2fa disable error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/2fa/verify  — complete a pending login (no auth middleware)
router.post('/2fa/verify', async (req: Request, res: Response) => {
  try {
    const { pendingToken, code } = req.body as { pendingToken?: string; code?: string };
    if (!pendingToken || !code) {
      res.status(400).json({ error: 'pendingToken and code are required' }); return;
    }

    let userId: string;
    try {
      ({ userId } = verifyPendingToken(pendingToken));
    } catch {
      res.status(401).json({ error: 'Session expired — please log in again' }); return;
    }

    const userRes = await query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];
    if (!user || !user.totp_enabled || !user.totp_secret) {
      res.status(400).json({ error: 'Invalid session' }); return;
    }

    if (!authenticator.verify({ token: code, secret: user.totp_secret })) {
      res.status(401).json({ error: 'Invalid code — please try again' }); return;
    }

    const token = generateToken(user.id);
    res.json({ token, user: sanitizeUser(user) });
  } catch (err) {
    console.error('2fa verify error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
