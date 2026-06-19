import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import path from 'path';
import dns from 'dns';
import { pool } from './db';

// Containers often advertise IPv6 without working outbound IPv6 routing, which
// makes undici hang on AAAA records until timeout (seen with Overpass/Valhalla
// upstreams). Prefer IPv4 for outbound requests.
dns.setDefaultResultOrder('ipv4first');

import authRouter       from './routes/auth';
import tasksRouter      from './routes/tasks';
import listsRouter      from './routes/lists';
import trashRouter      from './routes/trash';
import adminRouter      from './routes/admin';
import foldersRouter    from './routes/folders';
import filesRouter, { UPLOAD_DIR } from './routes/files';
import aiRouter         from './routes/ai';
import workspacesRouter from './routes/workspaces';
import timelinesRouter  from './routes/timelines';
import gpsRouter from './routes/gps';
import meetingsRouter from './routes/meetings';
import caldavManageRouter from './routes/caldavManage';
import caldavHandler from './routes/caldav';
import taskAttachmentsRouter from './routes/taskAttachments';
import milestoneAttachmentsRouter from './routes/milestoneAttachments';
import tokensRouter from './routes/tokens';
import oauthRouter from './routes/oauth';
import mcpRouter from './routes/mcp';
import { getPublicBaseUrl } from './publicUrl';
import { comparePassword } from './auth';
import { query as dbQuery } from './db';
import { addSseClient, removeSseClient } from './sse';
import { verifyToken } from './auth';
import { ensureSetupTokenLogged } from './setupToken';

const app = express();
const PORT = parseInt(process.env.PORT ?? '3001', 10);

app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// CalDAV server (Apple Calendar / Thunderbird / …) — mounted FIRST, before the
// global cors()/helmet()/json middleware. CalDAV clients are not browsers, so
// they don't need CORS; more importantly, the cors() middleware answers every
// OPTIONS request with a bare 204 (no `DAV` header), which makes Apple's
// capability probe conclude the server isn't a calendar and fail verification.
// Handling OPTIONS in caldavHandler (200 + `DAV: calendar-access`) requires it
// to run before cors(). It enforces its own HTTP Basic auth, and the text body
// parser captures the XML/iCalendar bodies WebDAV uses.
// ---------------------------------------------------------------------------
app.use('/caldav', express.text({ type: () => true, limit: '1mb' }), caldavHandler);
// CalDAV service discovery: clients probe /.well-known/caldav for the real root.
app.use('/.well-known/caldav', (_req, res) => res.redirect(301, '/caldav/'));

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

const frontendUrl = process.env.FRONTEND_URL;
if (!frontendUrl) {
  console.error('FATAL: FRONTEND_URL environment variable is missing.');
  process.exit(1);
}

app.use(cors({
  origin: frontendUrl,
  credentials: true,
}));

app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(express.json({ limit: '4mb' }));
// The OAuth 2.1 token endpoint receives application/x-www-form-urlencoded bodies
// (RFC 6749), so parse those too — otherwise /api/oauth/token sees an empty body.
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // Limit each IP to 300 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 attempts per 15 mins
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

const setupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Limit each IP to 5 attempts per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many setup attempts. Please try again later.' },
});

app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/2fa/verify', authLimiter);
app.use('/api/auth/register', setupLimiter);
app.use('/api/auth/request-setup-token', setupLimiter);
app.use('/api/auth/admin-password-reset', setupLimiter);
app.use('/api/admin/nuke', setupLimiter);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use('/api/auth',       authRouter);
app.use('/api/tasks/:taskId/attachments', taskAttachmentsRouter);
app.use('/api/tasks',      tasksRouter);
app.use('/api/lists',      listsRouter);
app.use('/api/trash',      trashRouter);
app.use('/api/admin',      adminRouter);
app.use('/api/folders',    foldersRouter);
app.use('/api/files',      filesRouter);
app.use('/api/ai',         aiRouter);
app.use('/api/workspaces', workspacesRouter);
app.use('/api/timelines/milestones/:milestoneId/attachments', milestoneAttachmentsRouter);
app.use('/api/timelines',  timelinesRouter);
app.use('/api/gps',        gpsRouter);
app.use('/api/meetings',   meetingsRouter);
app.use('/api/caldav',     caldavManageRouter);
app.use('/api/tokens',     tokensRouter);
app.use('/api/oauth',      oauthRouter);

// Model Context Protocol endpoint for external AI agents (PAT-authenticated).
// Mounted outside /api so the per-IP apiLimiter does not throttle agent tool
// loops; the endpoint enforces its own bearer-token auth.
app.use('/mcp',            mcpRouter);

// OAuth discovery for the Claude MCP connector.
// Protected Resource Metadata (RFC 9728) — the /mcp endpoint is the resource;
// it points clients at this server as its authorization server.
function protectedResourceMetadata(req: express.Request, res: express.Response) {
  const baseUrl = getPublicBaseUrl(req);
  res.json({
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ['header'],
  });
}
app.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);
app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata);

// Authorization Server Metadata (RFC 8414).
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const baseUrl = getPublicBaseUrl(req);
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/api/oauth/authorize`,
    token_endpoint: `${baseUrl}/api/oauth/token`,
    registration_endpoint: `${baseUrl}/api/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
});

// Public share endpoints — no auth required
interface ShareFileRow { id: string; original_name: string; title: string | null; note: string | null; mime_type: string; file_size: number; file_path: string; is_public: boolean; password_hash: string | null; expires_at: string | null; created_at: string; shared_by_name: string | null; shared_by_username: string; shared_by_image: string | null; }

async function resolveShareFile(token: string): Promise<ShareFileRow | null> {
  const result = await dbQuery<ShareFileRow>(
    `SELECT sf.*, u.full_name AS shared_by_name, u.username AS shared_by_username, u.profile_image AS shared_by_image
     FROM shared_files sf JOIN users u ON sf.user_id = u.id
     WHERE sf.share_token = $1`,
    [token]
  );
  return result.rows[0] ?? null;
}

// GET /api/share/:token — file info (JSON, no download)
app.get('/api/share/:token', async (req, res) => {
  try {
    const file = await resolveShareFile(req.params.token);
    if (!file) { res.status(404).json({ error: 'File not found' }); return; }
    if (!file.is_public) { res.status(403).json({ error: 'This file is private' }); return; }
    const expired = file.expires_at && new Date(file.expires_at) < new Date();
    res.json({
      name: file.original_name,
      title: file.title ?? null,
      note: file.note ?? null,
      mimeType: file.mime_type,
      size: file.file_size,
      hasPassword: file.password_hash !== null,
      expiresAt: file.expires_at ?? null,
      isExpired: Boolean(expired),
      createdAt: file.created_at,
      sharedBy: file.shared_by_name || file.shared_by_username,
      sharedByImage: file.shared_by_image ?? null,
    });
  } catch (err) {
    console.error('share info error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/share/:token/download — actual file download
app.get('/api/share/:token/download', async (req, res) => {
  try {
    const { token } = req.params;
    const pw = (req.query.password ?? '') as string;
    const file = await resolveShareFile(token);
    if (!file) { res.status(404).json({ error: 'File not found' }); return; }
    if (!file.is_public) { res.status(403).json({ error: 'This file is private' }); return; }
    if (file.expires_at && new Date(file.expires_at) < new Date()) { res.status(410).json({ error: 'Share link has expired' }); return; }
    if (file.password_hash) {
      if (!pw) { res.status(401).json({ error: 'Password required', passwordRequired: true }); return; }
      const valid = await comparePassword(pw, file.password_hash);
      if (!valid) { res.status(401).json({ error: 'Invalid password' }); return; }
    }
    const filePath = path.join(path.resolve(UPLOAD_DIR), path.basename(file.file_path));
    if (!require('fs').existsSync(filePath)) { res.status(404).json({ error: 'File not found on disk' }); return; }

    const sanitizedName = file.original_name.replace(/[^\w\s\-_.]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(sanitizedName)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.sendFile(filePath);
  } catch (err) {
    console.error('share download error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Public list / timeline share endpoints — no auth required
// ---------------------------------------------------------------------------

interface ShareListRow {
  id: string; name: string; emoji: string | null; color: string | null; color_bg: string | null;
  subtitle: string | null; share_enabled: boolean; share_password_hash: string | null;
  share_expires_at: string | null; share_subpages: boolean; created_at: string;
  shared_by_name: string | null; shared_by_username: string; shared_by_image: string | null;
}
interface ShareTimelineRow {
  id: string; name: string; emoji: string | null; color: string | null; color_bg: string | null;
  subtitle: string | null; layout: string; share_enabled: boolean; share_password_hash: string | null;
  share_expires_at: string | null; created_at: string;
  shared_by_name: string | null; shared_by_username: string; shared_by_image: string | null;
}

async function resolveShareList(token: string): Promise<ShareListRow | null> {
  const result = await dbQuery<ShareListRow>(
    `SELECT l.id, l.name, l.emoji, l.color, l.color_bg, l.subtitle, l.share_enabled,
            l.share_password_hash, l.share_expires_at, l.share_subpages, l.created_at,
            u.full_name AS shared_by_name, u.username AS shared_by_username, u.profile_image AS shared_by_image
     FROM lists l JOIN users u ON l.user_id = u.id
     WHERE l.share_token = $1`,
    [token]
  );
  return result.rows[0] ?? null;
}

async function resolveShareTimeline(token: string): Promise<ShareTimelineRow | null> {
  const result = await dbQuery<ShareTimelineRow>(
    `SELECT t.id, t.name, t.emoji, t.color, t.color_bg, t.subtitle, t.layout, t.share_enabled,
            t.share_password_hash, t.share_expires_at, t.created_at,
            u.full_name AS shared_by_name, u.username AS shared_by_username, u.profile_image AS shared_by_image
     FROM timelines t JOIN users u ON t.user_id = u.id
     WHERE t.share_token = $1`,
    [token]
  );
  return result.rows[0] ?? null;
}

function shareOwnerMeta(row: { shared_by_name: string | null; shared_by_username: string; shared_by_image: string | null; created_at: string; share_password_hash: string | null; share_expires_at: string | null }) {
  const expired = row.share_expires_at && new Date(row.share_expires_at) < new Date();
  return {
    hasPassword: row.share_password_hash !== null,
    expiresAt: row.share_expires_at ?? null,
    isExpired: Boolean(expired),
    createdAt: row.created_at,
    sharedBy: row.shared_by_name || row.shared_by_username,
    sharedByImage: row.shared_by_image ?? null,
  };
}

// GET /api/share/list/:token — list metadata (no content)
app.get('/api/share/list/:token', async (req, res) => {
  try {
    const list = await resolveShareList(req.params.token);
    if (!list || !list.share_enabled) { res.status(404).json({ error: 'List not found' }); return; }
    res.json({
      name: list.name,
      emoji: list.emoji,
      color: list.color,
      colorBg: list.color_bg,
      subtitle: list.subtitle,
      ...shareOwnerMeta(list),
    });
  } catch (err) {
    console.error('share list info error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/share/list/:token/content — full list content (password-gated)
app.get('/api/share/list/:token/content', async (req, res) => {
  try {
    const pw = (req.query.password ?? '') as string;
    const list = await resolveShareList(req.params.token);
    if (!list || !list.share_enabled) { res.status(404).json({ error: 'List not found' }); return; }
    if (list.share_expires_at && new Date(list.share_expires_at) < new Date()) { res.status(410).json({ error: 'Share link has expired' }); return; }
    if (list.share_password_hash) {
      if (!pw) { res.status(401).json({ error: 'Password required', passwordRequired: true }); return; }
      const valid = await comparePassword(pw, list.share_password_hash);
      if (!valid) { res.status(401).json({ error: 'Invalid password' }); return; }
    }

    const sectionsRes = await dbQuery<{ id: string; label: string; emoji: string | null; position: number }>(
      `SELECT id, label, emoji, position FROM sections WHERE list_id = $1 ORDER BY position ASC`,
      [list.id]
    );
    const tasksRes = await dbQuery<{
      id: string; title: string; checked: boolean; note: string | null; deadline: string | null;
      time_val: string | null; priority: string | null; badge: string | null; section_id: string | null;
      position: number; linked_list_id: string | null; linked_list_type: string | null;
    }>(
      `SELECT id, title, checked, note, deadline, time_val, priority, badge, section_id, position, linked_list_id, linked_list_type
       FROM tasks WHERE list_id = $1 AND source = 'list' ORDER BY position ASC, created_at ASC`,
      [list.id]
    );

    // For linked sublists, expose the child's share token (when it is itself
    // shared & live) so the public page can deep-link to the subpage, plus a
    // small progress summary for the ring indicator.
    const linkedIds = [...new Set(tasksRes.rows.map(t => t.linked_list_id).filter((x): x is string => !!x))];
    const linkedInfo: Record<string, { token: string | null; total: number; completed: number }> = {};
    if (linkedIds.length > 0) {
      const childRes = await dbQuery<{ id: string; share_token: string | null; share_enabled: boolean; share_expires_at: string | null }>(
        `SELECT id, share_token, share_enabled, share_expires_at FROM lists WHERE id = ANY($1::varchar[])`,
        [linkedIds]
      );
      const progRes = await dbQuery<{ list_id: string; total: string; completed: string }>(
        `SELECT list_id, COUNT(*) AS total, COUNT(*) FILTER (WHERE checked) AS completed
         FROM tasks WHERE list_id = ANY($1::varchar[]) AND source = 'list' GROUP BY list_id`,
        [linkedIds]
      );
      const progByList: Record<string, { total: number; completed: number }> = {};
      for (const p of progRes.rows) progByList[p.list_id] = { total: parseInt(p.total, 10), completed: parseInt(p.completed, 10) };
      for (const c of childRes.rows) {
        const live = c.share_enabled && !(c.share_expires_at && new Date(c.share_expires_at) < new Date());
        linkedInfo[c.id] = {
          token: live ? c.share_token : null,
          total: progByList[c.id]?.total ?? 0,
          completed: progByList[c.id]?.completed ?? 0,
        };
      }
    }

    const sections = sectionsRes.rows.map(s => ({
      id: s.id,
      label: s.label,
      emoji: s.emoji,
      tasks: tasksRes.rows
        .filter(t => (t.section_id ?? '__none__') === s.id)
        .map(t => ({
          id: t.id,
          title: t.title,
          checked: t.checked,
          note: t.note,
          deadline: t.deadline,
          time: t.time_val,
          priority: t.priority,
          badge: t.badge,
          linkedListType: t.linked_list_type,
          linkedShareToken: t.linked_list_id ? (linkedInfo[t.linked_list_id]?.token ?? null) : null,
          linkedProgress: t.linked_list_id ? { total: linkedInfo[t.linked_list_id]?.total ?? 0, completed: linkedInfo[t.linked_list_id]?.completed ?? 0 } : null,
        })),
    }));

    res.json({
      list: { name: list.name, emoji: list.emoji, color: list.color, colorBg: list.color_bg, subtitle: list.subtitle },
      sections,
    });
  } catch (err) {
    console.error('share list content error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/share/timeline/:token — timeline metadata (no content)
app.get('/api/share/timeline/:token', async (req, res) => {
  try {
    const tl = await resolveShareTimeline(req.params.token);
    if (!tl || !tl.share_enabled) { res.status(404).json({ error: 'Timeline not found' }); return; }
    res.json({
      name: tl.name,
      emoji: tl.emoji,
      color: tl.color,
      colorBg: tl.color_bg,
      subtitle: tl.subtitle,
      layout: tl.layout,
      ...shareOwnerMeta(tl),
    });
  } catch (err) {
    console.error('share timeline info error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/share/timeline/:token/content — milestones (password-gated)
app.get('/api/share/timeline/:token/content', async (req, res) => {
  try {
    const pw = (req.query.password ?? '') as string;
    const tl = await resolveShareTimeline(req.params.token);
    if (!tl || !tl.share_enabled) { res.status(404).json({ error: 'Timeline not found' }); return; }
    if (tl.share_expires_at && new Date(tl.share_expires_at) < new Date()) { res.status(410).json({ error: 'Share link has expired' }); return; }
    if (tl.share_password_hash) {
      if (!pw) { res.status(401).json({ error: 'Password required', passwordRequired: true }); return; }
      const valid = await comparePassword(pw, tl.share_password_hash);
      if (!valid) { res.status(401).json({ error: 'Invalid password' }); return; }
    }

    const msRes = await dbQuery<{
      id: string; title: string; description: string | null; milestone_date: string | null;
      time_val: string | null; status: string; emoji: string | null; color: string | null; position: number;
    }>(
      `SELECT id, title, description, milestone_date, time_val, status, emoji, color, position
       FROM milestones WHERE timeline_id = $1 ORDER BY milestone_date ASC NULLS LAST, position ASC, created_at ASC`,
      [tl.id]
    );

    res.json({
      timeline: { name: tl.name, emoji: tl.emoji, color: tl.color, colorBg: tl.color_bg, subtitle: tl.subtitle, layout: tl.layout },
      milestones: msRes.rows.map(m => ({
        id: m.id,
        title: m.title,
        description: m.description,
        date: m.milestone_date,
        time: m.time_val,
        status: m.status,
        emoji: m.emoji,
        color: m.color,
      })),
    });
  } catch (err) {
    console.error('share timeline content error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// SSE — real-time sync endpoint
app.get('/api/events', async (req, res) => {
  const token =
    (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null) ??
    (req.query.token as string | undefined) ?? '';

  let userId: string;
  try {
    ({ userId } = verifyToken(token));
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(': connected\n\n');

  addSseClient(userId, res);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeSseClient(userId, res);
  });
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function runMigrations() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username      VARCHAR(50)  UNIQUE NOT NULL,
      email         VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      full_name     VARCHAR(255),
      is_admin      BOOLEAN NOT NULL DEFAULT false,
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image TEXT
  `);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0
  `);

  // Personal Access Tokens — long-lived, individually revocable credentials for
  // external AI agents (MCP). Only the SHA-256 hash of each secret is stored.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name         VARCHAR(100) NOT NULL,
      token_hash   VARCHAR(100) NOT NULL UNIQUE,
      token_prefix VARCHAR(30)  NOT NULL,
      last_used_at TIMESTAMPTZ,
      expires_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS api_tokens_user_idx ON api_tokens(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS api_tokens_hash_idx ON api_tokens(token_hash)`);

  // OAuth 2.1 for the Claude MCP connector. Registered clients (Dynamic Client
  // Registration) and single-use, PKCE-bound authorization codes.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id     TEXT PRIMARY KEY,
      client_name   TEXT,
      redirect_uris JSONB NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code                  TEXT PRIMARY KEY,
      user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id             TEXT NOT NULL,
      redirect_uri          TEXT NOT NULL,
      code_challenge        TEXT NOT NULL,
      code_challenge_method TEXT NOT NULL DEFAULT 'S256',
      scope                 TEXT,
      resource              TEXT,
      expires_at            TIMESTAMPTZ NOT NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Heal databases created by the earlier (pre-PKCE) draft of this feature.
  await pool.query(`ALTER TABLE oauth_codes ADD COLUMN IF NOT EXISTS client_id TEXT`);
  await pool.query(`ALTER TABLE oauth_codes ADD COLUMN IF NOT EXISTS code_challenge TEXT`);
  await pool.query(`ALTER TABLE oauth_codes ADD COLUMN IF NOT EXISTS code_challenge_method TEXT DEFAULT 'S256'`);
  await pool.query(`ALTER TABLE oauth_codes ADD COLUMN IF NOT EXISTS scope TEXT`);
  await pool.query(`ALTER TABLE oauth_codes ADD COLUMN IF NOT EXISTS resource TEXT`);
  // The original draft had a NOT NULL `state` column; the PKCE flow doesn't use
  // it. Drop the dead column so inserts don't trip its constraint.
  await pool.query(`ALTER TABLE oauth_codes DROP COLUMN IF EXISTS state`);
  await pool.query(`CREATE INDEX IF NOT EXISTS oauth_codes_expires_idx ON oauth_codes(expires_at)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id         VARCHAR(100) PRIMARY KEY,
      user_id    UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       VARCHAR(255) NOT NULL,
      emoji      VARCHAR(10),
      color      VARCHAR(50),
      color_bg   VARCHAR(50),
      subtitle   VARCHAR(500),
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE lists ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false`);

  // Public link sharing for lists — independent of the workspace `is_public` flag.
  // `share_enabled` opens an opaque, unauthenticated read-only link at /share/list/:token.
  // `share_subpages` cascades sharing onto nested sublists so the public page can link to them.
  await pool.query(`ALTER TABLE lists ADD COLUMN IF NOT EXISTS share_token VARCHAR(100) UNIQUE`);
  await pool.query(`ALTER TABLE lists ADD COLUMN IF NOT EXISTS share_enabled BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE lists ADD COLUMN IF NOT EXISTS share_password_hash VARCHAR(255)`);
  await pool.query(`ALTER TABLE lists ADD COLUMN IF NOT EXISTS share_expires_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE lists ADD COLUMN IF NOT EXISTS share_subpages BOOLEAN NOT NULL DEFAULT false`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS folders (
      id         VARCHAR(100) PRIMARY KEY,
      user_id    UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       VARCHAR(255) NOT NULL,
      emoji      VARCHAR(10),
      color      VARCHAR(50),
      position   INTEGER      NOT NULL DEFAULT 0,
      collapsed  BOOLEAN      NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      is_public  BOOLEAN      NOT NULL DEFAULT false
    )
  `);

  await pool.query(`ALTER TABLE lists ADD COLUMN IF NOT EXISTS folder_id VARCHAR(100) REFERENCES folders(id) ON DELETE SET NULL`);

  await pool.query(`ALTER TABLE folders ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shared_files (
      id            VARCHAR(100) PRIMARY KEY,
      user_id       UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      original_name VARCHAR(500) NOT NULL,
      mime_type     VARCHAR(100) NOT NULL DEFAULT 'application/octet-stream',
      file_size     BIGINT       NOT NULL DEFAULT 0,
      file_path     VARCHAR(500) NOT NULL,
      is_public     BOOLEAN      NOT NULL DEFAULT false,
      password_hash VARCHAR(255),
      expires_at    TIMESTAMPTZ,
      share_token   VARCHAR(100) UNIQUE NOT NULL,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE shared_files ALTER COLUMN is_public SET DEFAULT false`);

  await pool.query(`ALTER TABLE shared_files ADD COLUMN IF NOT EXISTS title VARCHAR(500)`);

  await pool.query(`ALTER TABLE shared_files ADD COLUMN IF NOT EXISTS note TEXT`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_attachments (
      id              VARCHAR(100) PRIMARY KEY,
      task_id         BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id         UUID   NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
      attachment_type VARCHAR(20) NOT NULL DEFAULT 'upload'
                        CHECK (attachment_type IN ('upload','linked')),
      original_name   VARCHAR(500),
      mime_type       VARCHAR(100) NOT NULL DEFAULT 'application/octet-stream',
      file_size       BIGINT NOT NULL DEFAULT 0,
      file_path       VARCHAR(500),
      shared_file_id  VARCHAR(100) REFERENCES shared_files(id) ON DELETE CASCADE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_online TIMESTAMPTZ`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Default storage quota: 15 GB per user
  await pool.query(`
    INSERT INTO app_settings (key, value)
    VALUES ('storage_quota_per_user', '${15 * 1024 * 1024 * 1024}')
    ON CONFLICT (key) DO NOTHING
  `);

  // AI assistant defaults
  await pool.query(`
    INSERT INTO app_settings (key, value) VALUES ('ai_assistant_enabled', 'true')
    ON CONFLICT (key) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO app_settings (key, value) VALUES ('ai_model', 'openai/gpt-4o-mini')
    ON CONFLICT (key) DO NOTHING
  `);

  // AI chat sessions (one per conversation, expires after 30 days)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_chat_sessions (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title      VARCHAR(200),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
    )
  `);

  // AI chat history table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_chats (
      id         SERIAL PRIMARY KEY,
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       VARCHAR(20) NOT NULL,
      content    TEXT NOT NULL,
      tool_calls JSONB,
      metadata   JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Link ai_chats to sessions
  await pool.query(`ALTER TABLE ai_chats ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES ai_chat_sessions(id) ON DELETE CASCADE`);

  // AI chat file attachments (30-day TTL, auto-deleted with session)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_chat_files (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id   UUID REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
      filename     VARCHAR(500) NOT NULL,
      mime_type    VARCHAR(100) NOT NULL DEFAULT 'application/octet-stream',
      file_size    BIGINT NOT NULL DEFAULT 0,
      content_text TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
    )
  `);

  // AI token usage tracking (one row per OpenRouter API call)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      id                SERIAL PRIMARY KEY,
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id        UUID REFERENCES ai_chat_sessions(id) ON DELETE SET NULL,
      model             VARCHAR(150) NOT NULL,
      prompt_tokens     INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens      INTEGER NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Widen color columns if they were created with the old VARCHAR(20) size
  await pool.query(`ALTER TABLE lists ALTER COLUMN color TYPE VARCHAR(50)`);
  await pool.query(`ALTER TABLE lists ALTER COLUMN color_bg TYPE VARCHAR(50)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sections (
      id       VARCHAR(100) PRIMARY KEY,
      list_id  VARCHAR(100) NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      label    VARCHAR(255) NOT NULL,
      emoji    VARCHAR(10),
      position INTEGER NOT NULL DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id         BIGINT PRIMARY KEY,
      user_id    UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title      VARCHAR(1000) NOT NULL,
      note       TEXT,
      checked    BOOLEAN NOT NULL DEFAULT false,
      deadline   DATE,
      time_val   VARCHAR(20),
      priority   VARCHAR(10) CHECK (priority IN ('High', 'Medium', 'Low')),
      badge      VARCHAR(50),
      source     VARCHAR(10)   NOT NULL DEFAULT 'dash' CHECK (source IN ('dash', 'list')),
      list_id    VARCHAR(100)  REFERENCES lists(id)    ON DELETE SET NULL,
      section_id VARCHAR(100)  REFERENCES sections(id) ON DELETE SET NULL,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trash (
      id         SERIAL PRIMARY KEY,
      task_id    BIGINT NOT NULL,
      user_id    UUID   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task_data  JSONB  NOT NULL,
      meta       JSONB,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trash_lists (
      id          SERIAL PRIMARY KEY,
      list_id     VARCHAR(100) NOT NULL,
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      list_data   JSONB NOT NULL,
      deleted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trash_folders (
      id           SERIAL PRIMARY KEY,
      folder_id    VARCHAR(100) NOT NULL,
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      folder_data  JSONB NOT NULL,
      deleted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
    )
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION update_tasks_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  await pool.query(`
    DROP TRIGGER IF EXISTS tasks_updated_at_trigger ON tasks
  `);

  await pool.query(`
    CREATE TRIGGER tasks_updated_at_trigger
      BEFORE UPDATE ON tasks
      FOR EACH ROW
      EXECUTE FUNCTION update_tasks_updated_at()
  `);

  // Sublists & linked lists
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS linked_list_id VARCHAR(100) REFERENCES lists(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS linked_list_type VARCHAR(10) CHECK (linked_list_type IN ('sublist', 'link'))`);
  await pool.query(`ALTER TABLE lists ADD COLUMN IF NOT EXISTS parent_task_id BIGINT REFERENCES tasks(id) ON DELETE CASCADE`);
  await pool.query(`ALTER TABLE lists ADD COLUMN IF NOT EXISTS depth INTEGER NOT NULL DEFAULT 0`);

  // TOTP 2FA
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(100)`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false`);

  // Feature flags
  await pool.query(`
    INSERT INTO app_settings (key, value) VALUES ('two_fa_feature_enabled', 'true')
    ON CONFLICT (key) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO app_settings (key, value) VALUES ('mcp_enabled', 'true')
    ON CONFLICT (key) DO NOTHING
  `);

  // ── Workspaces ──────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id          VARCHAR(100) PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      description TEXT,
      emoji       VARCHAR(10),
      image       TEXT,
      visibility  VARCHAR(20) NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
      owner_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id VARCHAR(100) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role         VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
      joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (workspace_id, user_id)
    )
  `);

  await pool.query(`ALTER TABLE lists   ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(100) REFERENCES workspaces(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE folders ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(100) REFERENCES workspaces(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE tasks   ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(100) REFERENCES workspaces(id) ON DELETE SET NULL`);

  // Seed: create "Personal" workspace for every user that doesn't have one yet
  {
    const usersWithoutWs = await pool.query<{ id: string }>(
      `SELECT u.id FROM users u WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id = u.id)`
    );
    for (const user of usersWithoutWs.rows) {
      const wsId = `ws_${user.id.replace(/-/g, '')}`;
      await pool.query(
        `INSERT INTO workspaces (id, name, emoji, visibility, owner_id)
         VALUES ($1, 'Personal', '🏠', 'private', $2)
         ON CONFLICT DO NOTHING`,
        [wsId, user.id]
      );
      await pool.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role)
         VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`,
        [wsId, user.id]
      );
    }

    // Assign existing unassigned lists/folders/tasks to their owner's workspace
    await pool.query(`
      UPDATE lists l
      SET workspace_id = (SELECT w.id FROM workspaces w WHERE w.owner_id = l.user_id LIMIT 1)
      WHERE l.workspace_id IS NULL
    `);
    await pool.query(`
      UPDATE folders f
      SET workspace_id = (SELECT w.id FROM workspaces w WHERE w.owner_id = f.user_id LIMIT 1)
      WHERE f.workspace_id IS NULL
    `);
    await pool.query(`
      UPDATE tasks t
      SET workspace_id = (SELECT w.id FROM workspaces w WHERE w.owner_id = t.user_id LIMIT 1)
      WHERE t.workspace_id IS NULL
    `);

    // Consistency heal: a list item must always live in the SAME workspace as
    // its parent list. Fix any historical drift so items can't be filtered out
    // of the workspace view their list belongs to.
    const drift = await pool.query(`
      UPDATE tasks t
      SET workspace_id = l.workspace_id
      FROM lists l
      WHERE t.list_id = l.id
        AND t.source = 'list'
        AND t.workspace_id IS DISTINCT FROM l.workspace_id
    `);
    if (drift.rowCount && drift.rowCount > 0) {
      console.log(`📋 migration: re-synced ${drift.rowCount} list item(s) to their list's workspace`);
    }
  }

  // ── Timelines ───────────────────────────────────────────────────────────────
  // A Timeline behaves like a List in the sidebar (accessibility, color, emoji,
  // folder), but holds an ordered set of dated milestones instead of sections.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS timelines (
      id           VARCHAR(100) PRIMARY KEY,
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name         VARCHAR(255) NOT NULL,
      emoji        VARCHAR(10),
      color        VARCHAR(50),
      color_bg     VARCHAR(50),
      subtitle     VARCHAR(500),
      layout       VARCHAR(20) NOT NULL DEFAULT 'vertical' CHECK (layout IN ('vertical', 'compact', 'detailed')),
      is_public    BOOLEAN NOT NULL DEFAULT false,
      folder_id    VARCHAR(100) REFERENCES folders(id) ON DELETE SET NULL,
      workspace_id VARCHAR(100) REFERENCES workspaces(id) ON DELETE SET NULL,
      position     INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS milestones (
      id          VARCHAR(100) PRIMARY KEY,
      timeline_id VARCHAR(100) NOT NULL REFERENCES timelines(id) ON DELETE CASCADE,
      title       VARCHAR(500) NOT NULL,
      description TEXT,
      milestone_date DATE,
      time_val    VARCHAR(20),
      status      VARCHAR(20) NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'in-progress', 'done')),
      emoji       VARCHAR(10),
      color       VARCHAR(50),
      position    INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS milestones_timeline_idx ON milestones(timeline_id)`);

  // Public link sharing for timelines — mirrors the lists sharing model.
  await pool.query(`ALTER TABLE timelines ADD COLUMN IF NOT EXISTS share_token VARCHAR(100) UNIQUE`);
  await pool.query(`ALTER TABLE timelines ADD COLUMN IF NOT EXISTS share_enabled BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE timelines ADD COLUMN IF NOT EXISTS share_password_hash VARCHAR(255)`);
  await pool.query(`ALTER TABLE timelines ADD COLUMN IF NOT EXISTS share_expires_at TIMESTAMPTZ`);

  // Milestone attachments — mirrors task_attachments (upload or linked shared file).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS milestone_attachments (
      id              VARCHAR(100) PRIMARY KEY,
      milestone_id    VARCHAR(100) NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
      user_id         UUID   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      attachment_type VARCHAR(20) NOT NULL DEFAULT 'upload'
                        CHECK (attachment_type IN ('upload','linked')),
      original_name   VARCHAR(500),
      mime_type       VARCHAR(100) NOT NULL DEFAULT 'application/octet-stream',
      file_size       BIGINT NOT NULL DEFAULT 0,
      file_path       VARCHAR(500),
      shared_file_id  VARCHAR(100) REFERENCES shared_files(id) ON DELETE CASCADE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS milestone_attachments_milestone_idx ON milestone_attachments(milestone_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trash_timelines (
      id            SERIAL PRIMARY KEY,
      timeline_id   VARCHAR(100) NOT NULL,
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      timeline_data JSONB NOT NULL,
      deleted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
    )
  `);

  // Individually deleted milestones are soft-deleted here so they can be
  // restored into their parent timeline (which must still exist on restore).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trash_milestones (
      id             SERIAL PRIMARY KEY,
      milestone_id   VARCHAR(100) NOT NULL,
      timeline_id    VARCHAR(100) NOT NULL,
      user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      milestone_data JSONB NOT NULL,
      deleted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at     TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
    )
  `);

  // GPS files table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gps_files (
      id            VARCHAR(100) PRIMARY KEY,
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      original_name VARCHAR(500) NOT NULL,
      file_type     VARCHAR(10) NOT NULL DEFAULT 'gpx',
      file_path     VARCHAR(500) NOT NULL,
      file_size     BIGINT NOT NULL DEFAULT 0,
      metadata      JSONB,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS gps_files_user_idx ON gps_files(user_id)`);
  await pool.query(`ALTER TABLE gps_files ADD COLUMN IF NOT EXISTS smoothed BOOLEAN NOT NULL DEFAULT false`);
  // Route Planner State v1 — rich editing state (POIs, controls, spans) alongside the GPX
  await pool.query(`ALTER TABLE gps_files ADD COLUMN IF NOT EXISTS route_state JSONB`);

  // Calendar meetings — standalone events with no list/timeline/workspace.
  // Scoped strictly to the owning user (no sharing, no workspace).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meetings (
      id            VARCHAR(100) PRIMARY KEY,
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title         VARCHAR(500) NOT NULL,
      description   TEXT,
      location      VARCHAR(500),
      meeting_date  DATE NOT NULL,
      start_time    VARCHAR(20),
      end_time      VARCHAR(20),
      all_day       BOOLEAN NOT NULL DEFAULT false,
      color         VARCHAR(50),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS meetings_user_date_idx ON meetings(user_id, meeting_date)`);
  // Resource name a CalDAV client assigned to a meeting it created (so GET/PUT/
  // DELETE by that href map back to the right row).
  await pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS caldav_uid VARCHAR(255)`);

  // CalDAV app-specific credentials (email + generated password; only a hash is
  // stored). One per user; regenerating replaces it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS caldav_credentials (
      user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      password_hash VARCHAR(255) NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at  TIMESTAMPTZ
    )
  `);

  console.log('Database migrations applied.');
}

async function start() {
  try {
    await pool.query('SELECT 1');
    console.log('Database connection verified.');
  } catch (err) {
    console.error('Failed to connect to the database:', err);
    process.exit(1);
  }

  try {
    await runMigrations();
  } catch (err) {
    console.error('Failed to apply database migrations:', err);
    process.exit(1);
  }

  // Show setup token in logs if no users are registered yet.
  try {
    const { rows } = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM users');
    if (parseInt(rows[0].count, 10) === 0) {
      await ensureSetupTokenLogged();
    }
  } catch (err) {
    console.error('Failed to check setup token:', err);
  }

  // Cleanup expired AI chat files (run once on start, then every 6 hours)
  const cleanupAiFiles = async () => {
    try {
      const result = await pool.query(`DELETE FROM ai_chat_files WHERE expires_at < NOW()`);
      if (result.rowCount && result.rowCount > 0) {
        console.log(`Cleaned up ${result.rowCount} expired AI chat file(s).`);
      }
    } catch (err) {
      console.error('AI file cleanup error:', err);
    }
  };
  cleanupAiFiles();
  setInterval(cleanupAiFiles, 6 * 60 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`Solytiq Cloud API listening on port ${PORT}`);
  });
}

start();
