import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { query, pool } from '../db';
import { generateToken, hashPassword, comparePassword, generatePendingToken, verifyPendingToken } from '../auth';
import { authenticate } from '../middleware';
import { ensurePersonalWorkspace, wlog } from '../workspaceUtil';
import { logSetupToken, clearSetupToken } from '../setupToken';

// ---------------------------------------------------------------------------
// Admin password reset — in-memory, single active code, 15-min TTL
// ---------------------------------------------------------------------------
interface ResetEntry { code: string; expiresAt: Date }
let activeReset: ResetEntry | null = null;

function generateResetCode(): string {
  return crypto.randomBytes(4).toString('hex').toUpperCase(); // e.g. A3F2B1C8
}

function printResetBanner(code: string) {
  const display = `${code.slice(0, 4)}-${code.slice(4)}`;
  const line = '█'.repeat(62);
  console.log(`\n\x1b[45m\x1b[97m${line}\x1b[0m`);
  console.log(`\x1b[45m\x1b[97m█                                                            █\x1b[0m`);
  console.log(`\x1b[45m\x1b[97m█     !!  SOLYTIQ CLOUD — ADMIN PASSWORD RESET CODE  !!      █\x1b[0m`);
  console.log(`\x1b[45m\x1b[97m█                                                            █\x1b[0m`);
  console.log(`\x1b[45m\x1b[97m${line}\x1b[0m`);
  console.log(`\x1b[1m\x1b[97m\x1b[44m                    ${display}                    \x1b[0m`);
  console.log(`\x1b[45m\x1b[97m${line}\x1b[0m`);
  console.log(`\x1b[90m   Enter this code in the password reset wizard (valid 15 min).\x1b[0m\n`);
}

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
  token_version: number;
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
    const { username, email, password, fullName, setupToken } = req.body as {
      username?: string;
      email?: string;
      password?: string;
      fullName?: string;
      setupToken?: string;
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
      const userCount = parseInt(existingCount.rows[0].count, 10);
      if (userCount > 0) {
        await client.query('ROLLBACK');
        res.status(403).json({ error: 'Admin already registered' });
        return;
      }

      // Read setup token from DB (generated at startup / after nuke).
      const storedTokenRes = await client.query<{ value: string }>(
        `SELECT value FROM app_settings WHERE key = 'setup_token'`
      );
      if (!storedTokenRes.rows[0]) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'No setup token found — check backend logs or click "Show token in logs".' });
        return;
      }
      const storedToken = storedTokenRes.rows[0].value;

      const crypto = require('crypto');
      const safeBuf = Buffer.from(storedToken);
      const givenBuf = Buffer.from(setupToken || '');
      if (givenBuf.length !== safeBuf.length || !crypto.timingSafeEqual(givenBuf, safeBuf)) {
        await client.query('ROLLBACK');
        res.status(401).json({ error: 'Invalid setup token' });
        return;
      }

      const passwordHash = await hashPassword(password);

      const inserted = await client.query<UserRow>(
        `INSERT INTO users (username, email, password_hash, full_name, is_admin)
         VALUES ($1, $2, $3, $4, true)
         RETURNING *`,
        [username, email, passwordHash, fullName ?? null]
      );

      // Guarantee the new user owns a Personal workspace before we commit, so
      // the very first list/item they create has a real home to land in.
      const newUserId = inserted.rows[0].id;
      const personalWsId = await ensurePersonalWorkspace(
        (text, params) => client.query(text, params),
        newUserId
      );
      wlog(`register: user ${newUserId} provisioned with workspace ${personalWsId}`);

      // Invalidate the one-time setup token now that admin is registered.
      await client.query(`DELETE FROM app_settings WHERE key = 'setup_token'`);

      await client.query('COMMIT');

      const user = inserted.rows[0];
      const token = generateToken(user.id, user.token_version);

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

    const featureRes = await query<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = 'two_fa_feature_enabled'"
    );
    const twoFAFeatureOn = featureRes.rows[0] ? featureRes.rows[0].value !== 'false' : true;

    if (user.totp_enabled && twoFAFeatureOn) {
      const pendingToken = generatePendingToken(user.id);
      res.json({ requires2FA: true, pendingToken });
      return;
    }

    const token = generateToken(user.id, user.token_version);
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

    // Validate email format when provided (a non-empty change).
    let normalizedEmail: string | null = null;
    if (email !== undefined && email !== null) {
      const trimmed = email.trim();
      if (trimmed.length > 0) {
        const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) && trimmed.length <= 255;
        if (!emailOk) {
          res.status(400).json({ error: 'Please enter a valid email address.' });
          return;
        }
        normalizedEmail = trimmed.toLowerCase();
      }
    }

    const result = await query<UserRow>(
      `UPDATE users
       SET full_name = COALESCE($1, full_name),
           email     = COALESCE($2, email)
       WHERE id = $3
       RETURNING *`,
      [fullName ?? null, normalizedEmail, req.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user: sanitizeUser(result.rows[0]) });
  } catch (err) {
    // Unique violation → the email is already in use by another account.
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'That email is already in use.' });
      return;
    }
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

// Lightweight members list — the same rows as /members but WITHOUT the base64
// `profile_image` blobs, which made the full payload ~100 KB and got refetched
// on every page load / SSE reload (a real driver of the rate-limit pressure).
// The members store uses this; avatars are lazy-loaded per member via
// /members/:id/avatar only for members actually rendered on screen.
router.get('/members/basic', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await query<{ id: string; username: string; email: string; full_name: string | null; has_image: boolean; is_admin: boolean }>(
      `SELECT id, username, email, full_name, (profile_image IS NOT NULL) AS has_image, is_admin
       FROM users ORDER BY created_at ASC`
    );
    res.json({
      members: result.rows.map(u => ({
        id:       u.id,
        username: u.username,
        email:    req.user?.isAdmin ? u.email : undefined,
        fullName: u.full_name,
        hasImage: u.has_image,
        isAdmin:  u.is_admin,
      })),
    });
  } catch (err) {
    console.error('members basic GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Single member's avatar (base64 data URL). Fetched lazily and cached client-side
// so the full members list can stay small. Exposure matches /members, which
// already returns every user's profile image to any authenticated user.
router.get('/members/:id/avatar', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await query<{ profile_image: string | null }>(
      'SELECT profile_image FROM users WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) { res.status(404).json({ error: 'User not found' }); return; }
    res.json({ profileImage: result.rows[0].profile_image ?? null });
  } catch (err) {
    console.error('member avatar GET error:', err);
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

    // FIND-03: Increment token_version on 2FA enable
    await query('UPDATE users SET totp_enabled = true, token_version = token_version + 1 WHERE id = $1', [req.userId]);
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

    // FIND-03: Increment token_version on 2FA disable
    await query('UPDATE users SET totp_enabled = false, totp_secret = NULL, token_version = token_version + 1 WHERE id = $1', [req.userId]);
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

    const token = generateToken(user.id, user.token_version);
    res.json({ token, user: sanitizeUser(user) });
  } catch (err) {
    console.error('2fa verify error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/auth/password  — change own password (requires current password)
router.put('/password', authenticate, async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: 'currentPassword and newPassword are required' }); return;
    }
    if (newPassword.length < 8) {
      res.status(400).json({ error: 'New password must be at least 8 characters' }); return;
    }
    const userRes = await query<UserRow>('SELECT * FROM users WHERE id = $1', [req.userId]);
    const user = userRes.rows[0];
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }

    const valid = await comparePassword(currentPassword, user.password_hash);
    if (!valid) { res.status(400).json({ error: 'Current password is incorrect' }); return; }

    const newHash = await hashPassword(newPassword);
    // FIND-03: Increment token_version on password change
    await query('UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2', [newHash, req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('password change error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/request-setup-token — re-logs the current setup token to backend console
// Only works while no users exist (i.e., setup is not yet complete).
router.post('/request-setup-token', async (_req: Request, res: Response) => {
  try {
    const countRes = await query<{ count: string }>('SELECT COUNT(*) AS count FROM users');
    if (parseInt(countRes.rows[0].count, 10) > 0) {
      res.status(403).json({ error: 'Setup already complete' });
      return;
    }
    const found = await logSetupToken();
    if (!found) {
      res.status(404).json({ error: 'No setup token found. Restart the backend to generate one.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('request-setup-token error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Admin password reset (unauthenticated — for locked-out admins)
// ---------------------------------------------------------------------------

// POST /api/auth/admin-password-reset/request
// Generates a fresh code, prints it to backend logs, and stores it in memory.
// Rate-limited by setupLimiter in index.ts.
router.post('/admin-password-reset/request', async (_req: Request, res: Response) => {
  try {
    // Only allow if at least one admin exists
    const adminRes = await query<{ count: string }>('SELECT COUNT(*) AS count FROM users WHERE is_admin = true');
    if (parseInt(adminRes.rows[0].count, 10) === 0) {
      res.status(404).json({ error: 'No admin account found' });
      return;
    }
    const code = generateResetCode();
    activeReset = { code, expiresAt: new Date(Date.now() + 15 * 60 * 1000) };
    printResetBanner(code);
    res.json({ ok: true });
  } catch (err) {
    console.error('admin-password-reset/request error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/admin-password-reset/confirm
// Verifies the code and sets a new password for the first admin.
// Rate-limited by setupLimiter in index.ts.
router.post('/admin-password-reset/confirm', async (req: Request, res: Response) => {
  try {
    const { code, newPassword } = req.body as { code?: string; newPassword?: string };
    if (!code || !newPassword) {
      res.status(400).json({ error: 'code and newPassword are required' });
      return;
    }
    if (newPassword.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }

    if (!activeReset) {
      res.status(400).json({ error: 'No reset code is active — request one first' });
      return;
    }
    if (new Date() > activeReset.expiresAt) {
      activeReset = null;
      res.status(400).json({ error: 'Reset code has expired — request a new one' });
      return;
    }

    const givenBuf  = Buffer.from(code.replace(/-/g, '').toUpperCase());
    const activeBuf = Buffer.from(activeReset.code);
    const match = givenBuf.length === activeBuf.length && crypto.timingSafeEqual(givenBuf, activeBuf);
    if (!match) {
      res.status(401).json({ error: 'Invalid reset code' });
      return;
    }

    // Code is valid — reset the first admin's password and invalidate all sessions
    const adminRes = await query<UserRow>(
      'SELECT * FROM users WHERE is_admin = true ORDER BY created_at ASC LIMIT 1'
    );
    if (!adminRes.rows[0]) {
      res.status(404).json({ error: 'No admin account found' });
      return;
    }
    const newHash = await hashPassword(newPassword);
    await query(
      'UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2',
      [newHash, adminRes.rows[0].id]
    );

    // Consume the code
    activeReset = null;
    console.log(`\x1b[32m[admin-reset] Password reset successfully for admin "${adminRes.rows[0].username}".\x1b[0m`);
    res.json({ ok: true });
  } catch (err) {
    console.error('admin-password-reset/confirm error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/feature-flags — accessible to any authenticated user
router.get('/feature-flags', authenticate, async (_req: Request, res: Response) => {
  try {
    const result = await query<{ key: string; value: string }>(
      "SELECT key, value FROM app_settings WHERE key IN ('two_fa_feature_enabled', 'mcp_enabled')"
    );
    const map = Object.fromEntries(result.rows.map(r => [r.key, r.value]));
    res.json({
      twoFAEnabled: map['two_fa_feature_enabled'] !== 'false',
      mcpEnabled:   map['mcp_enabled'] !== 'false',
    });
  } catch (err) {
    console.error('feature-flags error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
