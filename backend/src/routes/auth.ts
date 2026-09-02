import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { query, pool } from '../db';
import { generateToken, hashPassword, comparePassword, generatePendingToken, verifyPendingToken } from '../auth';
import { authenticate } from '../middleware';
import { ensurePersonalWorkspace, wlog } from '../workspaceUtil';
import { logSetupToken, clearSetupToken } from '../setupToken';
import { getInstalledAppIds } from '../appsRegistry';
import { validatePassword } from '../passwordPolicy';
import { encryptTotpSecret, decryptTotpSecret } from '../totpCrypto';
import { mintAssetTicket, isValidAssetTicketScope } from '../assetTickets';
import { findPendingInvitation, hashInvitationToken } from '../userInvitations';

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
  keyboard_shortcuts: Record<string, { key?: string; enabled?: boolean }>;
  last_route: string | null;
  email_notification_prefs: Record<string, boolean>;
  meeting_reminder_lead_minutes: number;
  push_enabled: boolean;
  push_notification_prefs: Record<string, boolean>;
  ai_voice_mode: string | null;
}

function sanitizeUser(user: UserRow) {
  return {
    id:                        user.id,
    username:                  user.username,
    email:                     user.email,
    fullName:                  user.full_name,
    profileImage:              user.profile_image ?? null,
    isAdmin:                   user.is_admin,
    createdAt:                 user.created_at,
    totpEnabled:               user.totp_enabled,
    keyboardShortcuts:         user.keyboard_shortcuts ?? {},
    lastRoute:                 user.last_route ?? null,
    emailNotificationPrefs:    user.email_notification_prefs ?? {},
    meetingReminderLeadMinutes: user.meeting_reminder_lead_minutes ?? 30,
    // `push_enabled` is the master switch; `pushNotificationPrefs` is the same
    // sparse-override convention as the email map (absent type ⇒ the default in
    // push/send.ts's DEFAULT_PUSH_PREFS).
    pushEnabled:               user.push_enabled ?? true,
    pushNotificationPrefs:     user.push_notification_prefs ?? {},
    // null ⇒ "follow the platform default" (voice-only on mobile, hybrid on
    // desktop), NOT "off" — see the migration's comment for why an explicit
    // value is only ever written when the user actually picks one.
    aiVoiceMode:               user.ai_voice_mode ?? null,
  };
}

// A stored last-visited path is later handed straight to <Navigate to=…> —
// validate its shape defensively so only a genuine internal app path (never
// a full/protocol-relative URL) is ever persisted.
function isValidInternalRoute(route: string): boolean {
  if (typeof route !== 'string' || route.length === 0 || route.length > 500) return false;
  if (!route.startsWith('/') || route.startsWith('//')) return false;
  if (route.includes('://') || /[\s\\<>"'`]/.test(route)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Mobile app connections
//
// The mobile client (github.com/skiptix/solytiq-cloud-mobile) sends
// `client: 'mobile'` plus a `device` descriptor on login / 2FA verify. Each
// signed-in device gets a `mobile_connections` row whose id is embedded in the
// issued JWT (`connectionId`), letting the connection be listed and revoked.
// ---------------------------------------------------------------------------
interface DeviceInfo { name?: string; model?: string; osVersion?: string; appVersion?: string }

function trunc(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, 255) : null;
}

async function mobileAppEnabled(): Promise<boolean> {
  const r = await query<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = 'mobile_app_enabled'"
  );
  return r.rows[0] ? r.rows[0].value !== 'false' : true;
}

async function createMobileConnection(userId: string, device?: DeviceInfo): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO mobile_connections (user_id, device_name, device_model, os_version, app_version)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, trunc(device?.name) ?? 'Mobile device', trunc(device?.model), trunc(device?.osVersion), trunc(device?.appVersion)]
  );
  return r.rows[0].id;
}

function sanitizeConnection(r: {
  id: string; device_name: string; device_model: string | null;
  os_version: string | null; app_version: string | null;
  created_at: string; last_seen_at: string;
}) {
  return {
    id:         r.id,
    deviceName: r.device_name,
    deviceModel: r.device_model,
    osVersion:  r.os_version,
    appVersion: r.app_version,
    createdAt:  r.created_at,
    lastSeenAt: r.last_seen_at,
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
    // SECURITY (S3): this creates the FIRST (admin) account — a one-character
    // password here was previously accepted outright. Same shared policy as
    // every other password entry point (passwordPolicy.ts).
    const pwCheck = validatePassword(password);
    if (!pwCheck.ok) {
      res.status(400).json({ error: pwCheck.error });
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

// ---------------------------------------------------------------------------
// User Invitations — public, unauthenticated endpoints reachable only via a
// one-time link an admin sent by email (see routes/admin.ts's POST
// /invitations for creation). Both endpoints return a PLAIN 404 for every
// invalid case (nonexistent / already accepted / revoked / expired token) —
// never a distinguishing error — so neither a phishing attempt nor a used
// link ever confirms it once pointed at something real. See
// userInvitations.ts's header comment for the full rationale.
// ---------------------------------------------------------------------------

// GET /api/auth/invitations/:token — check a raw invite token and, only
// when it's genuinely still pending, return the invited email for the
// registration screen to prefill (read-only — the email is fixed by the
// invite, not user-editable).
router.get('/invitations/:token', async (req: Request, res: Response) => {
  try {
    const invite = await findPendingInvitation(req.params.token);
    if (!invite) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({ email: invite.email });
  } catch (err) {
    console.error('invitations GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/invitations/:token/accept — complete registration from an
// invitation: pick a username and password, and become the user that
// invite's email belongs to. Deliberately does NOT auto-login (unlike
// /register) — a public, emailed link is not the place to silently
// establish a session; the frontend sends the new user to /login instead.
router.post('/invitations/:token/accept', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !username.trim() || !password) {
      res.status(400).json({ error: 'username and password are required' });
      return;
    }
    if (username.trim().length > 50) {
      res.status(400).json({ error: 'Username is too long' });
      return;
    }
    const pwCheck = validatePassword(password);
    if (!pwCheck.ok) {
      res.status(400).json({ error: pwCheck.error });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the invitation row for the duration of this transaction so two
      // concurrent accept requests for the same link can't both pass the
      // pending check and both create an account.
      const inviteRes = await client.query<{
        id: string; email: string; is_admin: boolean;
      }>(
        `SELECT id, email, is_admin FROM user_invitations
         WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
         FOR UPDATE`,
        [hashInvitationToken(req.params.token)]
      );
      const invite = inviteRes.rows[0];
      if (!invite) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Not found' });
        return;
      }

      const passwordHash = await hashPassword(password);

      let inserted;
      try {
        inserted = await client.query<UserRow>(
          `INSERT INTO users (username, email, password_hash, is_admin)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [username.trim(), invite.email, passwordHash, invite.is_admin]
        );
      } catch (err: unknown) {
        await client.query('ROLLBACK');
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('unique') || msg.includes('duplicate')) {
          res.status(409).json({ error: 'Username or email already taken' });
          return;
        }
        throw err;
      }

      const newUser = inserted.rows[0];
      const wsId = await ensurePersonalWorkspace((text, params) => client.query(text, params), newUser.id);
      wlog(`invitation accepted: user ${newUser.id} provisioned with workspace ${wsId}`);

      await client.query(
        `UPDATE user_invitations SET accepted_at = NOW(), accepted_by = $2 WHERE id = $1`,
        [invite.id, newUser.id]
      );

      await client.query('COMMIT');
      res.status(201).json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('invitations accept error:', err);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('invitations accept error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { username, email, password, client, device } = req.body as {
      username?: string;
      email?: string;
      password?: string;
      client?: string;
      device?: DeviceInfo;
    };

    if (!password || (!username && !email)) {
      res.status(400).json({ error: 'password and username or email are required' });
      return;
    }

    const isMobile = client === 'mobile';
    if (isMobile && !(await mobileAppEnabled())) {
      res.status(403).json({ error: 'Mobile access has been disabled by the administrator.' });
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

    if (isMobile) {
      const connectionId = await createMobileConnection(user.id, device);
      const token = generateToken(user.id, user.token_version, connectionId);
      res.json({ token, user: sanitizeUser(user), connectionId });
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

// PUT /api/auth/shortcuts — save this user's keyboard shortcut customizations.
// Body is a sparse map of actionId -> { key?, enabled? }; only overrides from the
// frontend's default registry are stored, so new shortcuts added later need no migration.
// PUT /api/auth/ai-voice-mode — how Sol's input surface behaves for this user.
// `null` clears the stored choice and returns the account to the per-platform
// default (voice-only on mobile, hybrid on desktop) rather than turning voice
// off — "off" is not one of the modes; a user who doesn't want the assistant
// at all hides the bubble (Account Settings → AI) or an admin disables it.
const AI_VOICE_MODES = new Set(['hybrid', 'voice']);

router.put('/ai-voice-mode', authenticate, async (req: Request, res: Response) => {
  try {
    const { mode } = req.body as { mode?: unknown };
    if (mode !== null && (typeof mode !== 'string' || !AI_VOICE_MODES.has(mode))) {
      res.status(400).json({ error: "mode must be 'hybrid', 'voice', or null" });
      return;
    }
    const result = await query<UserRow>(
      `UPDATE users SET ai_voice_mode = $1 WHERE id = $2 RETURNING *`,
      [mode ?? null, req.userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user: sanitizeUser(result.rows[0]) });
  } catch (err) {
    console.error('ai voice mode update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/shortcuts', authenticate, async (req: Request, res: Response) => {
  try {
    const { shortcuts } = req.body as { shortcuts?: unknown };
    if (!shortcuts || typeof shortcuts !== 'object' || Array.isArray(shortcuts)) {
      res.status(400).json({ error: 'shortcuts must be an object' });
      return;
    }

    const entries = Object.entries(shortcuts as Record<string, unknown>);
    if (entries.length > 50) {
      res.status(400).json({ error: 'Too many shortcut entries' });
      return;
    }
    for (const [id, v] of entries) {
      if (typeof id !== 'string' || id.length > 64) {
        res.status(400).json({ error: 'Invalid shortcut id' });
        return;
      }
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        res.status(400).json({ error: 'Invalid shortcut entry' });
        return;
      }
      const { key, enabled } = v as { key?: unknown; enabled?: unknown };
      if (key !== undefined && (typeof key !== 'string' || key.length === 0 || key.length > 32)) {
        res.status(400).json({ error: 'Invalid shortcut key' });
        return;
      }
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'Invalid shortcut enabled flag' });
        return;
      }
    }

    const result = await query<UserRow>(
      `UPDATE users SET keyboard_shortcuts = $1 WHERE id = $2 RETURNING *`,
      [JSON.stringify(shortcuts), req.userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user: sanitizeUser(result.rows[0]) });
  } catch (err) {
    console.error('shortcuts update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Every NotificationType email-notifications.ts knows how to gate on — kept
// as a plain string list (not an import from notifications.ts's type) so
// this validation stays a cheap allow-list check with no risk of a circular
// module dependency between auth.ts and notifications.ts.
const EMAIL_PREF_TYPES = new Set([
  'workspace_added', 'item_invite', 'meeting_invite', 'item_tagged', 'mention',
  'automation_run', 'meeting_reminder', 'deadline_overdue',
  'agent_run_complete', 'agent_proposal', 'agent_change',
  'item_added', 'milestone_changed', 'page_edited',
]);
// Push accepts the same set of types — one allow-list, so a new
// NotificationType can never end up configurable on one channel and silently
// rejected on the other.
const PUSH_PREF_TYPES = EMAIL_PREF_TYPES;
const ALLOWED_REMINDER_LEAD_MINUTES = new Set([0, 15, 30, 60, 120]);

// PUT /api/auth/email-notifications — save this user's per-type email
// preferences (sparse override map, same convention as /shortcuts above) and
// their meeting-reminder lead time. Either field may be omitted to leave it
// unchanged.
router.put('/email-notifications', authenticate, async (req: Request, res: Response) => {
  try {
    const { prefs, meetingReminderLeadMinutes } = req.body as {
      prefs?: unknown;
      meetingReminderLeadMinutes?: unknown;
    };

    let prefsJson: string | null = null;
    if (prefs !== undefined) {
      if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
        res.status(400).json({ error: 'prefs must be an object' });
        return;
      }
      const entries = Object.entries(prefs as Record<string, unknown>);
      if (entries.length > EMAIL_PREF_TYPES.size) {
        res.status(400).json({ error: 'Too many preference entries' });
        return;
      }
      for (const [type, v] of entries) {
        if (!EMAIL_PREF_TYPES.has(type)) {
          res.status(400).json({ error: `Unknown notification type: ${type}` });
          return;
        }
        if (typeof v !== 'boolean') {
          res.status(400).json({ error: 'Invalid preference value' });
          return;
        }
      }
      prefsJson = JSON.stringify(prefs);
    }

    let leadMinutes: number | null = null;
    if (meetingReminderLeadMinutes !== undefined) {
      if (typeof meetingReminderLeadMinutes !== 'number' || !ALLOWED_REMINDER_LEAD_MINUTES.has(meetingReminderLeadMinutes)) {
        res.status(400).json({ error: 'Invalid reminder lead time' });
        return;
      }
      leadMinutes = meetingReminderLeadMinutes;
    }

    const result = await query<UserRow>(
      `UPDATE users SET
         email_notification_prefs = COALESCE($1::jsonb, email_notification_prefs),
         meeting_reminder_lead_minutes = COALESCE($2::int, meeting_reminder_lead_minutes)
       WHERE id = $3 RETURNING *`,
      [prefsJson, leadMinutes, req.userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user: sanitizeUser(result.rows[0]) });
  } catch (err) {
    console.error('email-notifications update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/auth/push-notifications — save this user's push preferences: the
// master on/off switch and/or the sparse per-type override map. Either field
// may be omitted to leave it unchanged, exactly like /email-notifications.
//
// This is the "disable" control the Notifications settings tab drives. It is
// deliberately SEPARATE from unsubscribing a device: turning push off here
// stops delivery instantly for every device at once and survives a reinstall,
// whereas revoking the browser subscription only silences the one device and
// is re-created the next time the app asks. A user who wants quiet wants the
// former.
router.put('/push-notifications', authenticate, async (req: Request, res: Response) => {
  try {
    const { enabled, prefs } = req.body as { enabled?: unknown; prefs?: unknown };

    let enabledValue: boolean | null = null;
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be a boolean' });
        return;
      }
      enabledValue = enabled;
    }

    let prefsJson: string | null = null;
    if (prefs !== undefined) {
      if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
        res.status(400).json({ error: 'prefs must be an object' });
        return;
      }
      const entries = Object.entries(prefs as Record<string, unknown>);
      if (entries.length > PUSH_PREF_TYPES.size) {
        res.status(400).json({ error: 'Too many preference entries' });
        return;
      }
      for (const [type, v] of entries) {
        if (!PUSH_PREF_TYPES.has(type)) {
          res.status(400).json({ error: `Unknown notification type: ${type}` });
          return;
        }
        if (typeof v !== 'boolean') {
          res.status(400).json({ error: 'Invalid preference value' });
          return;
        }
      }
      prefsJson = JSON.stringify(prefs);
    }

    const result = await query<UserRow>(
      `UPDATE users SET
         push_enabled = COALESCE($1::boolean, push_enabled),
         push_notification_prefs = COALESCE($2::jsonb, push_notification_prefs)
       WHERE id = $3 RETURNING *`,
      [enabledValue, prefsJson, req.userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user: sanitizeUser(result.rows[0]) });
  } catch (err) {
    console.error('push-notifications update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/auth/last-route — remember the last in-app screen this user
// visited, so opening a new tab (or reloading) lands back there instead of
// always defaulting to the dashboard. Fired on every route change from
// AppLayout, so this stays a lightweight UPDATE with no RETURNING — the
// frontend already has the path it just sent, it doesn't need it echoed back.
router.put('/last-route', authenticate, async (req: Request, res: Response) => {
  try {
    const { route } = req.body as { route?: unknown };
    if (typeof route !== 'string' || !isValidInternalRoute(route)) {
      res.status(400).json({ error: 'Invalid route' });
      return;
    }
    await pool.query(`UPDATE users SET last_route = $1 WHERE id = $2`, [route, req.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('last-route update error:', err);
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
//
// SECURITY (S3 step-up): requires the account's CURRENT PASSWORD, not just a
// valid session. Before this check, any valid-but-stolen bearer token (e.g.
// leaked via an XSS payload, or simply not yet revoked) could silently call
// this endpoint and overwrite `totp_secret` — for an account with 2FA
// already enabled, that locks the real owner out on their next login
// (their authenticator app still holds the OLD secret) while the attacker,
// who already saw the new secret in this response, controls the new one.
// A fresh password re-entry is what a "stolen but not yet revoked session"
// specifically cannot produce.
router.post('/2fa/setup', authenticate, async (req: Request, res: Response) => {
  try {
    const { currentPassword } = req.body as { currentPassword?: string };
    if (!currentPassword) { res.status(400).json({ error: 'currentPassword is required' }); return; }

    const userRes = await query<UserRow>('SELECT username, password_hash FROM users WHERE id = $1', [req.userId]);
    if (!userRes.rows[0]) { res.status(404).json({ error: 'User not found' }); return; }
    const valid = await comparePassword(currentPassword, userRes.rows[0].password_hash);
    if (!valid) { res.status(401).json({ error: 'Current password is incorrect' }); return; }

    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(userRes.rows[0].username, 'Solytiq Cloud', secret);
    await query('UPDATE users SET totp_secret = $1 WHERE id = $2', [encryptTotpSecret(secret), req.userId]);
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

    if (!authenticator.verify({ token: code, secret: decryptTotpSecret(user.totp_secret) })) {
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

// POST /api/auth/2fa/disable  — step-up (current password) + a valid code,
// then remove 2FA. See the /2fa/setup comment above for why a stolen-but-
// unrevoked session alone must not be enough to turn off an account's
// second factor.
router.post('/2fa/disable', authenticate, async (req: Request, res: Response) => {
  try {
    const { code, currentPassword } = req.body as { code?: string; currentPassword?: string };
    if (!code) { res.status(400).json({ error: 'code is required' }); return; }
    if (!currentPassword) { res.status(400).json({ error: 'currentPassword is required' }); return; }

    const userRes = await query<{ totp_secret: string | null; totp_enabled: boolean; password_hash: string }>(
      'SELECT totp_secret, totp_enabled, password_hash FROM users WHERE id = $1',
      [req.userId]
    );
    const user = userRes.rows[0];
    if (!user?.totp_enabled) { res.status(400).json({ error: '2FA is not enabled' }); return; }
    if (!user.totp_secret) { res.status(400).json({ error: 'No 2FA secret found' }); return; }

    const validPassword = await comparePassword(currentPassword, user.password_hash);
    if (!validPassword) { res.status(401).json({ error: 'Current password is incorrect' }); return; }

    if (!authenticator.verify({ token: code, secret: decryptTotpSecret(user.totp_secret) })) {
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
    const { pendingToken, code, client, device } = req.body as {
      pendingToken?: string; code?: string; client?: string; device?: DeviceInfo;
    };
    if (!pendingToken || !code) {
      res.status(400).json({ error: 'pendingToken and code are required' }); return;
    }

    const isMobile = client === 'mobile';
    if (isMobile && !(await mobileAppEnabled())) {
      res.status(403).json({ error: 'Mobile access has been disabled by the administrator.' });
      return;
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

    if (!authenticator.verify({ token: code, secret: decryptTotpSecret(user.totp_secret) })) {
      res.status(401).json({ error: 'Invalid code — please try again' }); return;
    }

    if (isMobile) {
      const connectionId = await createMobileConnection(user.id, device);
      const token = generateToken(user.id, user.token_version, connectionId);
      res.json({ token, user: sanitizeUser(user), connectionId });
      return;
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
    const pwCheck = validatePassword(newPassword);
    if (!pwCheck.ok) { res.status(400).json({ error: pwCheck.error }); return; }
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
    const pwCheck = validatePassword(newPassword);
    if (!pwCheck.ok) { res.status(400).json({ error: pwCheck.error }); return; }

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

// GET /api/auth/mobile-connections — list this user's signed-in mobile devices
router.get('/mobile-connections', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await query<{
      id: string; device_name: string; device_model: string | null;
      os_version: string | null; app_version: string | null;
      created_at: string; last_seen_at: string;
    }>(
      `SELECT id, device_name, device_model, os_version, app_version, created_at, last_seen_at
       FROM mobile_connections WHERE user_id = $1 ORDER BY last_seen_at DESC`,
      [req.userId]
    );
    res.json({ connections: result.rows.map(sanitizeConnection) });
  } catch (err) {
    console.error('mobile-connections GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/auth/mobile-connections/:id — revoke (sign out) a mobile device
router.delete('/mobile-connections/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await query(
      `DELETE FROM mobile_connections WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('mobile-connections DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// iOS Home Screen ("Add to Home Screen") app connections
//
// A Home Screen install is just this same web app running in standalone
// display mode (`display-mode: standalone` / `navigator.standalone`) — there
// is no separate login flow or JWT `connectionId` to hang a session off, like
// the native mobile app above. Instead the frontend detects standalone mode
// on launch and pings this endpoint with a client-generated, locally-
// persisted `installId` (see `frontend/src/utils/homescreen.ts`), so repeat
// opens from the same Home Screen icon update one row rather than creating a
// new one every time.
// ---------------------------------------------------------------------------
function sanitizeHomescreenConnection(r: {
  id: string; device_name: string; os_version: string | null;
  created_at: string; last_seen_at: string;
}) {
  return {
    id:         r.id,
    deviceName: r.device_name,
    osVersion:  r.os_version,
    createdAt:  r.created_at,
    lastSeenAt: r.last_seen_at,
  };
}

// POST /api/auth/homescreen-connections/ping — record/refresh this device's
// Home Screen install. Idempotent per (user, installId): a re-ping from the
// same icon just bumps last_seen_at rather than creating a duplicate row.
router.post('/homescreen-connections/ping', authenticate, async (req: Request, res: Response) => {
  try {
    const installId = trunc(req.body?.installId);
    if (!installId) {
      res.status(400).json({ error: 'installId is required' });
      return;
    }
    const device = req.body?.device ?? {};
    const deviceName = trunc(device.deviceName) ?? 'Home Screen App';
    const osVersion = trunc(device.osVersion);
    await query(
      `INSERT INTO homescreen_connections (user_id, install_id, device_name, os_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, install_id) DO UPDATE SET
         device_name  = EXCLUDED.device_name,
         os_version   = EXCLUDED.os_version,
         last_seen_at = NOW()`,
      [req.userId, installId, deviceName, osVersion]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('homescreen-connections/ping error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/homescreen-connections — list this user's Home Screen installs
router.get('/homescreen-connections', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await query<{
      id: string; device_name: string; os_version: string | null;
      created_at: string; last_seen_at: string;
    }>(
      `SELECT id, device_name, os_version, created_at, last_seen_at
       FROM homescreen_connections WHERE user_id = $1 ORDER BY last_seen_at DESC`,
      [req.userId]
    );
    res.json({ connections: result.rows.map(sanitizeHomescreenConnection) });
  } catch (err) {
    console.error('homescreen-connections GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/auth/homescreen-connections/:id — forget a tracked Home Screen
// install. This only removes the tracked record; it can't "sign out" the
// device since there's no separate session to revoke (it's the same web
// login) — reopening the app from that Home Screen icon just re-creates it.
router.delete('/homescreen-connections/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await query(
      `DELETE FROM homescreen_connections WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('homescreen-connections DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/asset-ticket — mint a short-lived, narrowly-scoped ticket
// (assetTickets.ts) for the SSE stream or an inline image `<img>` tag,
// neither of which can attach an Authorization header. Requires the caller
// to already be authenticated the normal way; the minted ticket itself
// carries no ability to call anything else and expires in minutes.
router.post('/asset-ticket', authenticate, async (req: Request, res: Response) => {
  try {
    const { scope } = req.body as { scope?: string };
    if (!scope || !isValidAssetTicketScope(scope)) {
      res.status(400).json({ error: 'Invalid or missing scope' });
      return;
    }
    const { ticket, expiresAt } = mintAssetTicket(req.userId!, scope);
    res.json({ ticket, expiresAt });
  } catch (err) {
    console.error('asset-ticket error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/feature-flags — accessible to any authenticated user
router.get('/feature-flags', authenticate, async (_req: Request, res: Response) => {
  try {
    const result = await query<{ key: string; value: string }>(
      "SELECT key, value FROM app_settings WHERE key IN ('two_fa_feature_enabled', 'mcp_enabled', 'mobile_app_enabled')"
    );
    const map = Object.fromEntries(result.rows.map(r => [r.key, r.value]));
    const installedApps = await getInstalledAppIds();
    res.json({
      twoFAEnabled:  map['two_fa_feature_enabled'] !== 'false',
      mcpEnabled:    map['mcp_enabled'] !== 'false',
      mobileEnabled: map['mobile_app_enabled'] !== 'false',
      installedApps,
    });
  } catch (err) {
    console.error('feature-flags error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
