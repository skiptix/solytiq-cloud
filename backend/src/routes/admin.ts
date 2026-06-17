import { Router, Request, Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { query } from '../db';
import { authenticate, requireAdmin } from '../middleware';
import { hashPassword, comparePassword } from '../auth';
import { ensurePersonalWorkspace, wlog } from '../workspaceUtil';
import { generateAndLogSetupToken } from '../setupToken';

const execFileAsync = promisify(execFile);

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

    // Provision a Personal workspace so the new user has a stable home for
    // their lists/items the moment they log in.
    const wsId = await ensurePersonalWorkspace(query, result.rows[0].id);
    wlog(`admin created user ${result.rows[0].id} with workspace ${wsId}`);

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

// PUT /api/admin/users/:id
router.put('/users/:id', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { username, password } = req.body as { username?: string; password?: string };

    if (!username && !password) {
      res.status(400).json({ error: 'Nothing to update' });
      return;
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (username?.trim()) { sets.push(`username = $${idx++}`); values.push(username.trim()); }
    if (password) {
      sets.push(`password_hash = $${idx++}`);
      values.push(await hashPassword(password));
      // FIND-03: Invalidate sessions when admin changes user password
      sets.push(`token_version = token_version + 1`);
    }
    values.push(id);

    const result = await query<UserRow>(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}
       RETURNING id, username, email, full_name, profile_image, is_admin, last_online, created_at`,
      values
    );

    if (result.rows.length === 0) { res.status(404).json({ error: 'User not found' }); return; }
    res.json({ user: sanitize(result.rows[0]) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('unique') || msg.includes('duplicate')) {
      res.status(409).json({ error: 'Username already taken' });
      return;
    }
    console.error('admin/users PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (id === req.userId) {
      res.status(400).json({ error: 'You cannot delete your own account' });
      return;
    }
    const result = await query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) { res.status(404).json({ error: 'User not found' }); return; }
    res.json({ success: true });
  } catch (err) {
    console.error('admin/users DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin/nuke
router.delete('/nuke', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { password } = req.body as { password?: string };
    if (!password) {
      res.status(400).json({ error: 'Password is required' });
      return;
    }

    const userResult = await query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.userId]
    );
    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const valid = await comparePassword(password, userResult.rows[0].password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    await query('TRUNCATE TABLE trash, tasks, sections, lists, users RESTART IDENTITY CASCADE');

    // Generate and display a fresh setup token so the system can be re-initialised.
    await generateAndLogSetupToken();

    res.json({ success: true });
  } catch (err) {
    console.error('admin/nuke DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/settings
router.get('/settings', authenticate, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await query<{ key: string; value: string }>('SELECT key, value FROM app_settings');
    const settings: Record<string, string> = {};
    for (const row of result.rows) settings[row.key] = row.value;
    res.json({ settings });
  } catch (err) {
    console.error('admin/settings GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/admin/settings
router.put('/settings', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { storageQuotaPerUser, aiAssistantEnabled, aiModel, twoFAFeatureEnabled } = req.body as {
      storageQuotaPerUser?: number;
      aiAssistantEnabled?: boolean;
      aiModel?: string;
      twoFAFeatureEnabled?: boolean;
    };
    if (storageQuotaPerUser !== undefined) {
      const bytes = Math.max(0, Math.round(Number(storageQuotaPerUser)));
      await query(
        `INSERT INTO app_settings (key, value) VALUES ('storage_quota_per_user', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [String(bytes)]
      );
    }
    if (aiAssistantEnabled !== undefined) {
      await query(
        `INSERT INTO app_settings (key, value) VALUES ('ai_assistant_enabled', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [aiAssistantEnabled ? 'true' : 'false']
      );
    }
    if (aiModel !== undefined && aiModel.trim()) {
      await query(
        `INSERT INTO app_settings (key, value) VALUES ('ai_model', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [aiModel.trim()]
      );
    }
    if (twoFAFeatureEnabled !== undefined) {
      await query(
        `INSERT INTO app_settings (key, value) VALUES ('two_fa_feature_enabled', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [twoFAFeatureEnabled ? 'true' : 'false']
      );
    }
    const result = await query<{ key: string; value: string }>('SELECT key, value FROM app_settings');
    const settings: Record<string, string> = {};
    for (const row of result.rows) settings[row.key] = row.value;
    res.json({ settings });
  } catch (err) {
    console.error('admin/settings PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/ai/usage — token usage stats for the last 30 days
router.get('/ai/usage', authenticate, requireAdmin, async (_req: Request, res: Response) => {
  try {
    // Daily breakdown by model (last 30 days)
    const daily = await query<{
      date: string;
      model: string;
      prompt_tokens: string;
      completion_tokens: string;
      total_tokens: string;
    }>(
      `SELECT
         TO_CHAR(DATE(created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date,
         model,
         SUM(prompt_tokens)::text     AS prompt_tokens,
         SUM(completion_tokens)::text AS completion_tokens,
         SUM(total_tokens)::text      AS total_tokens
       FROM ai_usage
       WHERE created_at >= NOW() - INTERVAL '30 days'
       GROUP BY DATE(created_at AT TIME ZONE 'UTC'), model
       ORDER BY date ASC`
    );

    // Per-model totals
    const byModel = await query<{
      model: string;
      prompt_tokens: string;
      completion_tokens: string;
      total_tokens: string;
      request_count: string;
    }>(
      `SELECT
         model,
         SUM(prompt_tokens)::text     AS prompt_tokens,
         SUM(completion_tokens)::text AS completion_tokens,
         SUM(total_tokens)::text      AS total_tokens,
         COUNT(*)::text               AS request_count
       FROM ai_usage
       WHERE created_at >= NOW() - INTERVAL '30 days'
       GROUP BY model
       ORDER BY SUM(total_tokens) DESC`
    );

    // Grand totals
    const totals = await query<{
      prompt_tokens: string;
      completion_tokens: string;
      total_tokens: string;
      request_count: string;
    }>(
      `SELECT
         SUM(prompt_tokens)::text     AS prompt_tokens,
         SUM(completion_tokens)::text AS completion_tokens,
         SUM(total_tokens)::text      AS total_tokens,
         COUNT(*)::text               AS request_count
       FROM ai_usage
       WHERE created_at >= NOW() - INTERVAL '30 days'`
    );

    const t = totals.rows[0] ?? { prompt_tokens: '0', completion_tokens: '0', total_tokens: '0', request_count: '0' };

    res.json({
      daily: daily.rows.map((r) => ({
        date:             r.date,
        model:            r.model,
        promptTokens:     parseInt(r.prompt_tokens, 10),
        completionTokens: parseInt(r.completion_tokens, 10),
        totalTokens:      parseInt(r.total_tokens, 10),
      })),
      byModel: byModel.rows.map((r) => ({
        model:            r.model,
        promptTokens:     parseInt(r.prompt_tokens, 10),
        completionTokens: parseInt(r.completion_tokens, 10),
        totalTokens:      parseInt(r.total_tokens, 10),
        requestCount:     parseInt(r.request_count, 10),
      })),
      totals: {
        promptTokens:     parseInt(t.prompt_tokens, 10),
        completionTokens: parseInt(t.completion_tokens, 10),
        totalTokens:      parseInt(t.total_tokens, 10),
        requestCount:     parseInt(t.request_count, 10),
      },
    });
  } catch (err) {
    console.error('admin/ai/usage GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/system/storage
router.get('/system/storage', authenticate, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const { stdout } = await execFileAsync('df', ['-P', '/']);
    const parts = stdout.trim().split('\n')[1].trim().split(/\s+/);
    const totalBytes = parseInt(parts[1]) * 1024;
    const usedBytes  = parseInt(parts[2]) * 1024;
    const availBytes = parseInt(parts[3]) * 1024;
    res.json({ total: totalBytes, used: usedBytes, available: availBytes });
  } catch (err) {
    console.error('admin/system/storage error:', err);
    res.status(500).json({ error: 'Failed to read disk usage' });
  }
});

export default router;
