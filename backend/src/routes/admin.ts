import { Router, Request, Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fsPromises from 'fs/promises';
import { query } from '../db';
import { authenticate, requireAdmin } from '../middleware';
import { hashPassword, comparePassword } from '../auth';
import { ensurePersonalWorkspace, wlog } from '../workspaceUtil';
import { generateAndLogSetupToken } from '../setupToken';
import { generateAdminApiKey, sanitizeScopes } from '../adminApiKey';
import { broadcastNukeToAll } from '../sse';
import { UPLOAD_DIR } from './files';
import { validatePassword } from '../passwordPolicy';
import { getResendApiKeyHint, setResendApiKey, sendEmail } from '../email/resendClient';
import { buildNotificationEmail, getAppBaseUrlForEmail } from '../email/templates';
import { createInvitation, listInvitations, revokeInvitation } from '../userInvitations';

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


interface AdminKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  scopes: unknown;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

function sanitizeAdminKey(row: AdminKeyRow) {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: sanitizeScopes(row.scopes),
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
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


// GET /api/admin/api-keys
router.get('/api-keys', authenticate, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await query<AdminKeyRow>(
      `SELECT id, name, key_prefix, scopes, last_used_at, revoked_at, created_at
       FROM admin_api_keys
       ORDER BY created_at DESC`
    );
    res.json({ keys: result.rows.map(sanitizeAdminKey) });
  } catch (err) {
    console.error('admin/api-keys GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/api-keys
router.post('/api-keys', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { name, scopes } = req.body as { name?: string; scopes?: unknown };
    const cleanName = name?.trim() || 'Admin API key';
    if (cleanName.length > 100) {
      res.status(400).json({ error: 'Name must be 100 characters or fewer' });
      return;
    }
    const cleanScopes = sanitizeScopes(scopes);

    const generated = generateAdminApiKey();
    const result = await query<AdminKeyRow>(
      `INSERT INTO admin_api_keys (name, key_hash, key_prefix, created_by, scopes)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, name, key_prefix, scopes, last_used_at, revoked_at, created_at`,
      [cleanName, generated.hash, generated.prefix, req.userId, JSON.stringify(cleanScopes)]
    );

    res.status(201).json({ key: sanitizeAdminKey(result.rows[0]), secret: generated.raw });
  } catch (err) {
    console.error('admin/api-keys POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin/api-keys/:id
router.delete('/api-keys/:id', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const result = await query(
      `UPDATE admin_api_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
      [req.params.id]
    );
    if (result.rows.length === 0) { res.status(404).json({ error: 'API key not found' }); return; }
    res.json({ success: true });
  } catch (err) {
    console.error('admin/api-keys DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

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
    const pwCheck = validatePassword(password);
    if (!pwCheck.ok) { res.status(400).json({ error: pwCheck.error }); return; }

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
      const pwCheck = validatePassword(password);
      if (!pwCheck.ok) { res.status(400).json({ error: pwCheck.error }); return; }
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

// ---------------------------------------------------------------------------
// User Invitations — admin invites a new person by email instead of setting
// a password for them directly (POST /users above still exists for that).
// The raw one-time link is returned to the admin exactly once, here, in the
// creation response — it is never persisted or retrievable again (see
// userInvitations.ts) — so the admin UI must show/copy it immediately.
// Sending the email is best-effort on top of that: creation always succeeds
// and always returns the link, `emailSent` just tells the admin whether
// Resend actually delivered it, so an unconfigured/failed Resend setup
// never blocks inviting someone — the admin can still copy-paste the link.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/admin/invitations
router.post('/invitations', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { email, isAdmin } = req.body as { email?: string; isAdmin?: boolean };
    if (!email || !email.trim()) {
      res.status(400).json({ error: 'email is required' });
      return;
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail.length > 255 || !EMAIL_RE.test(normalizedEmail)) {
      res.status(400).json({ error: 'Invalid email address' });
      return;
    }

    const existingUser = await query('SELECT id FROM users WHERE lower(email) = $1', [normalizedEmail]);
    if (existingUser.rows.length > 0) {
      res.status(409).json({ error: 'A user with this email already exists' });
      return;
    }

    const { id, rawToken, expiresAt } = await createInvitation(normalizedEmail, req.userId!, !!isAdmin);

    const baseUrl = getAppBaseUrlForEmail();
    const inviteUrl = baseUrl ? `${baseUrl}/invite/${rawToken}` : null;

    let emailSent = false;
    if (inviteUrl) {
      const inviterRow = await query<{ username: string; full_name: string | null }>(
        'SELECT username, full_name FROM users WHERE id = $1',
        [req.userId]
      );
      const inviterName = inviterRow.rows[0]?.full_name || inviterRow.rows[0]?.username || 'An admin';
      const { subject, html } = buildNotificationEmail({
        heading: "You've been invited to Solytiq Cloud",
        bodyText: `${inviterName} invited you to join their Solytiq Cloud instance. This link is valid for 7 days and can only be used once.`,
        ctaLabel: 'Accept invitation',
        ctaPath: `/invite/${rawToken}`,
      });
      const sendResult = await sendEmail({ to: normalizedEmail, subject, html });
      emailSent = sendResult.ok;
    }

    res.status(201).json({ id, inviteUrl, emailSent, expiresAt });
  } catch (err) {
    console.error('admin/invitations POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/invitations
router.get('/invitations', authenticate, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const rows = await listInvitations();
    res.json({
      invitations: rows.map(r => ({
        id: r.id,
        email: r.email,
        isAdmin: r.is_admin,
        invitedByUsername: r.invited_by_username,
        acceptedByUsername: r.accepted_by_username,
        acceptedAt: r.accepted_at,
        revokedAt: r.revoked_at,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('admin/invitations GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin/invitations/:id — revoke a still-pending invitation.
router.delete('/invitations/:id', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    await revokeInvitation(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('admin/invitations DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin/nuke — total instance reset. Only an authenticated admin
// who re-enters their password can trigger it (route-gated by `requireAdmin`
// above, password re-checked below). See CLAUDE.md "Admin Nuke" for the full
// design rationale.
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

    // 1. Truncate EVERY table in the schema, discovered dynamically rather than
    //    hardcoded — a fixed list silently stops covering new tables as the
    //    schema grows (the old version only ever cleared 5 of 31 tables, leaving
    //    orphaned admin settings, tokens, workspaces, GPS files, AI history,
    //    etc. behind). TRUNCATE...CASCADE on the full table set is atomic and
    //    order-independent regardless of FK relationships between them.
    const tablesRes = await query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
    );
    if (tablesRes.rows.length > 0) {
      const tableList = tablesRes.rows.map((r) => `"${r.tablename}"`).join(', ');
      await query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
    }

    // 2. Wipe every uploaded file on disk (shared files, task/milestone
    //    attachments, GPS/FIT tracks all live flatly under UPLOAD_DIR). A
    //    failure here must not undo step 1 or block the reset — the
    //    privacy-critical part (the data) is already gone; leftover orphan
    //    files are a lesser, logged issue.
    try {
      await fsPromises.rm(UPLOAD_DIR, { recursive: true, force: true });
      await fsPromises.mkdir(UPLOAD_DIR, { recursive: true });
    } catch (fileErr) {
      console.error('admin/nuke: failed to clear upload directory:', fileErr);
    }

    // 3. Fresh setup token so the wizard can re-provision immediately (the
    //    truncate above already cleared the old one out of app_settings).
    await generateAndLogSetupToken();

    // 4. Force every currently connected device — any user, any tab, any
    //    workspace — to drop its local cache and land back on /setup. This
    //    reaches everyone immediately rather than waiting for their next API
    //    call to 401 (which is what still happens for anyone who isn't
    //    connected at this exact moment, e.g. a mobile client between polls).
    broadcastNukeToAll();

    res.json({ success: true });

    // 5. Exit so Docker Compose's `restart: unless-stopped` policy relaunches
    //    a completely clean process — the only way to guarantee no in-memory
    //    state survives (the SSE registry, the rate limiter's counters, the
    //    sync dispatcher's LISTEN connection). Delayed so the HTTP response
    //    above and the SSE broadcast both finish flushing to clients first.
    //    Opt out with NUKE_SKIP_RESTART=true if running without a process
    //    supervisor that will bring the process back up.
    if (process.env.NUKE_SKIP_RESTART !== 'true') {
      setTimeout(() => process.exit(0), 1500);
    }
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
    // The Resend API key is encrypted at rest, but it's still never sent to
    // the client raw — replace it with a presence flag + a last-4 hint so the
    // admin UI can show "configured, ends in •••• ab12" without ever
    // round-tripping the actual secret.
    const hadKey = 'resend_api_key' in settings;
    delete settings.resend_api_key;
    settings.resend_api_key_configured = hadKey ? 'true' : 'false';
    settings.resend_api_key_hint = hadKey ? ((await getResendApiKeyHint()) ?? '') : '';
    res.json({ settings });
  } catch (err) {
    console.error('admin/settings GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/admin/settings
router.put('/settings', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const {
      storageQuotaPerUser, aiAssistantEnabled, aiModel, twoFAFeatureEnabled, mcpEnabled, mobileAppEnabled,
      aiVoiceEnabled, aiTtsModel, aiTtsVoice, aiSttModel,
      knowledgeSearchEnabled, embeddingBaseUrl, embeddingModel, embeddingMonthlyTokenBudget,
      resendEnabled, resendApiKey, resendFromEmail, resendFromName,
    } = req.body as {
      storageQuotaPerUser?: number;
      aiAssistantEnabled?: boolean;
      aiModel?: string;
      /** Sol Voice Mode — see aiVoice.ts. Blank strings are ignored rather
       *  than stored, so clearing a field in the UI falls back to the
       *  VOICE_DEFAULTS constant instead of writing an empty model id that
       *  every subsequent request would fail on. */
      aiVoiceEnabled?: boolean;
      aiTtsModel?: string;
      aiTtsVoice?: string;
      aiSttModel?: string;
      twoFAFeatureEnabled?: boolean;
      mcpEnabled?: boolean;
      mobileAppEnabled?: boolean;
      knowledgeSearchEnabled?: boolean;
      embeddingBaseUrl?: string;
      embeddingModel?: string;
      embeddingMonthlyTokenBudget?: number;
      resendEnabled?: boolean;
      /** New key to store. Omit to leave the current key untouched; pass an
       *  empty string to clear it — see setResendApiKey(). */
      resendApiKey?: string;
      resendFromEmail?: string;
      resendFromName?: string;
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
    if (aiVoiceEnabled !== undefined) {
      await query(
        `INSERT INTO app_settings (key, value) VALUES ('ai_voice_enabled', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [aiVoiceEnabled ? 'true' : 'false']
      );
    }
    for (const [key, value] of [
      ['ai_tts_model', aiTtsModel],
      ['ai_tts_voice', aiTtsVoice],
      ['ai_stt_model', aiSttModel],
    ] as const) {
      if (value !== undefined && value.trim()) {
        await query(
          `INSERT INTO app_settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = $2`,
          [key, value.trim()]
        );
      }
    }
    if (twoFAFeatureEnabled !== undefined) {
      await query(
        `INSERT INTO app_settings (key, value) VALUES ('two_fa_feature_enabled', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [twoFAFeatureEnabled ? 'true' : 'false']
      );
    }
    if (mcpEnabled !== undefined) {
      await query(
        `INSERT INTO app_settings (key, value) VALUES ('mcp_enabled', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [mcpEnabled ? 'true' : 'false']
      );
      // When MCP is disabled, revoke ALL API tokens for ALL users immediately.
      if (!mcpEnabled) {
        await query('DELETE FROM api_tokens');
      }
    }
    if (mobileAppEnabled !== undefined) {
      await query(
        `INSERT INTO app_settings (key, value) VALUES ('mobile_app_enabled', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [mobileAppEnabled ? 'true' : 'false']
      );
      // When mobile access is disabled, sign out ALL mobile devices immediately.
      if (!mobileAppEnabled) {
        await query('DELETE FROM mobile_connections');
      }
    }
    if (knowledgeSearchEnabled !== undefined) {
      await query(
        `INSERT INTO app_settings (key, value) VALUES ('knowledge_search_enabled', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [knowledgeSearchEnabled ? 'true' : 'false']
      );
    }
    if (embeddingBaseUrl !== undefined) {
      await query(
        `INSERT INTO app_settings (key, value) VALUES ('embedding_base_url', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [embeddingBaseUrl.trim()]
      );
    }
    if (embeddingModel !== undefined && embeddingModel.trim()) {
      await query(
        `INSERT INTO app_settings (key, value) VALUES ('embedding_model', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [embeddingModel.trim()]
      );
    }
    if (embeddingMonthlyTokenBudget !== undefined) {
      const tokens = Math.max(0, Math.round(Number(embeddingMonthlyTokenBudget)));
      await query(
        `INSERT INTO app_settings (key, value) VALUES ('embedding_monthly_token_budget', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [String(tokens)]
      );
    }
    if (resendEnabled !== undefined) {
      await query(
        `INSERT INTO app_settings (key, value) VALUES ('resend_enabled', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [resendEnabled ? 'true' : 'false']
      );
    }
    if (resendApiKey !== undefined) {
      await setResendApiKey(resendApiKey);
    }
    if (resendFromEmail !== undefined) {
      await query(
        `INSERT INTO app_settings (key, value) VALUES ('resend_from_email', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [resendFromEmail.trim()]
      );
    }
    if (resendFromName !== undefined) {
      await query(
        `INSERT INTO app_settings (key, value) VALUES ('resend_from_name', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [resendFromName.trim()]
      );
    }

    const result = await query<{ key: string; value: string }>('SELECT key, value FROM app_settings');
    const settings: Record<string, string> = {};
    for (const row of result.rows) settings[row.key] = row.value;
    const hadKey = 'resend_api_key' in settings;
    delete settings.resend_api_key;
    settings.resend_api_key_configured = hadKey ? 'true' : 'false';
    settings.resend_api_key_hint = hadKey ? ((await getResendApiKeyHint()) ?? '') : '';
    res.json({ settings });
  } catch (err) {
    console.error('admin/settings PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/settings/resend/test — send a test email to the calling
// admin's own address, so Resend configuration (key, sender domain
// verification) can be verified from the UI without leaving Settings.
router.post('/settings/resend/test', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const userResult = await query<{ email: string | null }>('SELECT email FROM users WHERE id = $1', [req.userId]);
    const to = userResult.rows[0]?.email;
    if (!to) {
      res.status(400).json({ error: 'Your account has no email address on file' });
      return;
    }
    const { subject, html } = buildNotificationEmail({
      heading: 'Test email',
      bodyText: 'This is a test email from Solytiq Cloud — if you got this, your Resend configuration works.',
    });
    const result = await sendEmail({ to, subject, html });
    if (!result.ok) {
      res.status(400).json({ error: result.error ?? 'Send failed' });
      return;
    }
    res.json({ success: true, to });
  } catch (err) {
    console.error('admin/settings/resend/test error:', err);
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
