import { Request, Response, NextFunction } from 'express';
import { verifyToken } from './auth';
import { query } from './db';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const { userId } = verifyToken(token);
    req.userId = userId;
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

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await query<{ is_admin: boolean }>(
      'SELECT is_admin FROM users WHERE id = $1',
      [req.userId]
    );
    if (!result.rows[0]?.is_admin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    next();
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
}
