// ---------------------------------------------------------------------------
// CalDAV connection management (REST, session-JWT authenticated).
// Backs the "Calendar Sync" tab in User Settings.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware';
import { query } from '../db';
import { getPublicBaseUrl } from '../publicUrl';
import { getCaldavStatus, setCaldavPassword, revokeCaldav, generateCaldavPassword } from '../caldav/credentials';

const router = Router();
router.use(authenticate);

async function getEmail(userId: string): Promise<string> {
  const r = await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId]);
  return r.rows[0]?.email ?? '';
}

const serverUrl = (req: Request) => `${getPublicBaseUrl(req)}/caldav/`;

// GET /api/caldav — connection status + how-to info.
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { userId: string }).userId;
    const [status, email] = await Promise.all([getCaldavStatus(userId), getEmail(userId)]);
    res.json({ ...status, username: email, serverUrl: serverUrl(req) });
  } catch (err) {
    console.error('caldav status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/caldav/password — (re)generate the CalDAV app password. Shown once.
router.post('/password', async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { userId: string }).userId;
    const password = generateCaldavPassword();
    await setCaldavPassword(userId, password);
    const email = await getEmail(userId);
    res.status(201).json({ password, username: email, serverUrl: serverUrl(req) });
  } catch (err) {
    console.error('caldav password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/caldav — revoke the connection.
router.delete('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { userId: string }).userId;
    await revokeCaldav(userId);
    res.json({ success: true });
  } catch (err) {
    console.error('caldav revoke error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
