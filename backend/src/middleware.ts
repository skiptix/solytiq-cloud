import { Request, Response, NextFunction } from 'express';
import { verifyToken } from './auth';
import { query } from './db';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      user?: {
        isAdmin: boolean;
      };
    }
  }
}

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const { userId } = verifyToken(token);

    const userResult = await query<{ is_admin: boolean }>(
      'SELECT is_admin FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    req.userId = userId;
    req.user = { isAdmin: userResult.rows[0].is_admin };

    // fire-and-forget: only update if last_online is null or older than 5 min
    query(
      `UPDATE users SET last_online = NOW() WHERE id = $1 AND (last_online IS NULL OR last_online < NOW() - INTERVAL '5 minutes')`,
      [userId]
    ).catch(() => {/* ignore */});
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user?.isAdmin) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
