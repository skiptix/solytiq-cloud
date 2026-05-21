import { Router, Request, Response } from 'express';
import { query } from '../db';
import { authenticate, requireAdmin } from '../middleware';
import { hashPassword } from '../auth';

const router = Router();

interface UserRow {
  id: string;
  username: string;
  email: string;
  full_name: string | null;
  profile_image: string | null;
  is_admin: boolean;
  last_online: string | null;
  created_at: string;
}

function sanitize(u: UserRow) {
  return {
    id:           u.id,
    username:     u.username,
    email:        u.email,
    fullName:     u.full_name,
    profileImage: u.profile_image ?? null,
    isAdmin:      u.is_admin,
    lastOnline:   u.last_online,
    createdAt:    u.created_at,
  };
}

// GET /api/admin/users
router.get('/users', authenticate, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await query<UserRow>(
      `SELECT id, username, email, full_name, profile_image, is_admin, last_online, created_at
       FROM users ORDER BY created_at ASC`
    );
    res.json({ users: result.rows.map(sanitize) });
  } catch (err) {
    console.error('admin/users GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/users
router.post('/users', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { username, email, password, fullName } = req.body as {
      username?: string;
      email?: string;
      password?: string;
      fullName?: string;
    };

    if (!username || !password) {
      res.status(400).json({ error: 'username and password are required' });
      return;
    }

    const passwordHash = await hashPassword(password);
    const resolvedEmail = email?.trim() || `${username}@local`;

    const result = await query<UserRow>(
      `INSERT INTO users (username, email, password_hash, full_name, is_admin)
       VALUES ($1, $2, $3, $4, false)
       RETURNING id, username, email, full_name, profile_image, is_admin, last_online, created_at`,
      [username.trim(), resolvedEmail, passwordHash, fullName?.trim() ?? null]
    );

    res.status(201).json({ user: sanitize(result.rows[0]) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('unique') || msg.includes('duplicate')) {
      res.status(409).json({ error: 'Username or email already taken' });
      return;
    }
    console.error('admin/users POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
