import { Router, Request, Response } from 'express';
import { query, pool } from '../db';
import { generateToken, hashPassword, comparePassword } from '../auth';
import { authenticate } from '../middleware';

const router = Router();

// Shape of a user row returned from the DB
interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  full_name: string | null;
  profile_image: string | null;
  is_admin: boolean;
  created_at: string;
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

    // Use a transaction and locking to prevent race conditions during setup
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Lock the table to prevent concurrent inserts
      await client.query('LOCK TABLE users IN EXCLUSIVE MODE');

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
      // Basic validation for base64 images
      if (!imageData.startsWith('data:image/')) {
        res.status(400).json({ error: 'Invalid image format' });
        return;
      }
      // Check size (base64 is ~33% larger than binary, so 4MB JSON limit is already tight)
      // 2MB binary is approx 2.7MB base64.
      if (imageData.length > 3 * 1024 * 1024) {
        res.status(400).json({ error: 'Image too large (max 2MB)' });
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

// GET /api/auth/members  — public user info for all members (authenticated)
router.get('/members', authenticate, async (_req: Request, res: Response) => {
  try {
    const result = await query<{ id: string; username: string; email: string; full_name: string | null; profile_image: string | null; is_admin: boolean }>(
      'SELECT id, username, email, full_name, profile_image, is_admin FROM users ORDER BY created_at ASC'
    );
    res.json({
      members: result.rows.map(u => ({
        id:           u.id,
        username:     u.username,
        email:        u.email,
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

export default router;
