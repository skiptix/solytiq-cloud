import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
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
import adminReadApiRouter from './routes/adminReadApi';
import syncRouter from './routes/sync';
import searchRouter from './routes/search';
import templatesRouter from './routes/templates';
import appsRouter from './routes/apps';
import automationsRouter from './routes/automations';
import markdownListsRouter, { MARKDOWN_IMAGE_DIR } from './routes/markdownLists';
import { isAppInstalled } from './appsRegistry';
import { startSyncDispatcher, SYNC_CHANNEL } from './syncLog';
import { sweepScheduledAutomations } from './automationEngine';
import { getPublicBaseUrl } from './publicUrl';
import { comparePassword } from './auth';
import { query as dbQuery } from './db';
import { addSseClient, removeSseClient } from './sse';
import { verifyToken } from './auth';
import { ensureSetupTokenLogged } from './setupToken';

const app = express();
const PORT = parseInt(process.env.PORT ?? '3001', 10);

app.set('trust proxy', 1);
// API payloads are user/workspace-scoped and must never be conditionally
// revalidated as 304 responses. A 304 has no JSON body, which caused the
// frontend loaders to treat successful sidebar refreshes as failed requests
// and leave lists/folders/timelines empty after workspace switches.
app.set('etag', false);

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
//
// This deployment sits behind Cloudflare → an internal load balancer → nginx →
// the backend. `trust proxy` is 1, so `req.ip` resolves to the internal load
// balancer address, which is IDENTICAL for every visitor. Keying the limiters on
// `req.ip` therefore collapses the whole instance into a SINGLE bucket, so one
// busy tab can exhaust the global budget and every other request (including
// `/api/lists`) starts returning 429 — surfacing in the UI as "Couldn't refresh
// your data" with a blanked sidebar, even though the data is intact.
//
// Cloudflare sets `CF-Connecting-IP` to the real client address and OVERWRITES
// any client-supplied value, so prefer it and fall back to `req.ip`. The origin
// is only reachable through the internal proxy chain (not publicly), so a client
// cannot forge this header to evade the auth/setup limiters.
const clientKey = (req: express.Request): string => {
  const cf = req.headers['cf-connecting-ip'];
  const ip = (typeof cf === 'string' && cf.length > 0) ? cf : (req.ip ?? '');
  // Normalise (IPv6 addresses are grouped into a subnet) via the library helper.
  return ipKeyGenerator(ip);
};

// Authenticated traffic is keyed on the VERIFIED userId, not the IP. IP keying is
// the wrong primitive here: behind Cloudflare → LB → nginx the origin sees the
// shared LB address whenever `CF-Connecting-IP` is absent, collapsing everyone
// into one bucket (the 429 storm). A JWT is forgery-proof and per-user-fair, so
// one busy tab can only exhaust its own budget. We decode the token CHEAPLY here
// just to derive the key — full verification still happens in the auth middleware.
// Pre-auth requests (no/invalid token) fall back to the IP key.
const userKey = (req: express.Request): string => {
  const h = req.headers.authorization;
  const t = h?.startsWith('Bearer ') ? h.slice(7)
          : (typeof req.query.token === 'string' ? req.query.token : '');
  if (t) {
    try { return `u:${verifyToken(t).userId}`; } catch { /* fall through to IP */ }
  }
  return `ip:${clientKey(req)}`;
};

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 600, // 600 req / user / min — generous for a delta client, cheap to police
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  // The long-lived SSE stream, and the small/frequent delta-sync polls it drives
  // (focus/online/30s-sweep), must never count against the mutation budget.
  skip: (req) => req.originalUrl.startsWith('/api/events') || req.originalUrl.startsWith('/api/sync'),
  message: { error: 'Too many requests, please slow down.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each client to 10 attempts per 15 mins
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientKey,
  message: { error: 'Too many attempts. Please try again later.' },
});

const setupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Limit each client to 5 attempts per hour
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientKey,
  message: { error: 'Too many setup attempts. Please try again later.' },
});

app.use('/api/', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
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
app.use('/api/admin-read', adminReadApiRouter);
app.use('/api/sync',       syncRouter);
app.use('/api/search',     searchRouter);
app.use('/api/templates',  templatesRouter);
app.use('/api/apps',       appsRouter);
app.use('/api/automations', automationsRouter);
app.use('/api/markdown-lists', markdownListsRouter);

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
interface ShareFileRow { id: string; original_name: string; title: string | null; note: string | null; mime_type: string; file_size: number; file_path: string; is_public: boolean; password_hash: string | null; expires_at: string | null; created_at: string; share_token: string; bundle_id: string | null; bundle_name: string | null; shared_by_name: string | null; shared_by_username: string; shared_by_image: string | null; }

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
    if (!(await isAppInstalled('files'))) { res.status(404).json({ error: 'File not found' }); return; }
    const file = await resolveShareFile(req.params.token);
    if (!file) { res.status(404).json({ error: 'File not found' }); return; }
    if (!file.is_public) { res.status(403).json({ error: 'This file is private' }); return; }
    const expired = file.expires_at && new Date(file.expires_at) < new Date();
    const bundleResult = await dbQuery<Pick<ShareFileRow, 'id' | 'original_name' | 'mime_type' | 'file_size' | 'created_at'>>(
      'SELECT id, original_name, mime_type, file_size, created_at FROM shared_files WHERE share_token = $1 ORDER BY created_at ASC',
      [req.params.token]
    );
    const files = bundleResult.rows.map(row => ({
      id: row.id,
      name: row.original_name,
      mimeType: row.mime_type,
      size: Number(row.file_size),
      createdAt: row.created_at,
    }));
    res.json({
      name: file.bundle_name || file.title || (files.length > 1 ? `${files.length} shared files` : file.original_name),
      title: file.title ?? file.bundle_name ?? null,
      note: file.note ?? null,
      mimeType: file.mime_type,
      size: files.reduce((sum, item) => sum + item.size, 0),
      files,
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

// GET /api/share/:token/download/:fileId — download one file from a shared bundle
app.get('/api/share/:token/download/:fileId', async (req, res) => {
  try {
    if (!(await isAppInstalled('files'))) { res.status(404).json({ error: 'File not found' }); return; }
    const { token, fileId } = req.params;
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
    const result = await dbQuery<ShareFileRow>('SELECT * FROM shared_files WHERE share_token = $1 AND id = $2', [token, fileId]);
    const target = result.rows[0];
    if (!target) { res.status(404).json({ error: 'File not found' }); return; }
    const filePath = path.join(path.resolve(UPLOAD_DIR), path.basename(target.file_path));
    if (!require('fs').existsSync(filePath)) { res.status(404).json({ error: 'File not found on disk' }); return; }
    const sanitizedName = target.original_name.replace(/[^\w\s\-_.]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(sanitizedName)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.sendFile(filePath);
  } catch (err) {
    console.error('share bundled download error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/share/:token/download — actual file download
app.get('/api/share/:token/download', async (req, res) => {
  try {
    if (!(await isAppInstalled('files'))) { res.status(404).json({ error: 'File not found' }); return; }
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
      id: string; title: string; checked: boolean; note: string | null; note_markdown: boolean; deadline: string | null;
      time_val: string | null; priority: string | null; badge: string | null; section_id: string | null;
      position: number; linked_list_id: string | null; linked_list_type: string | null;
    }>(
      `SELECT id, title, checked, note, note_markdown, deadline, time_val, priority, badge, section_id, position, linked_list_id, linked_list_type
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
          noteMarkdown: t.note_markdown ?? false,
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
      id: string; title: string; description: string | null; description_markdown: boolean; milestone_date: string | null;
      time_val: string | null; status: string; emoji: string | null; color: string | null; position: number;
    }>(
      `SELECT id, title, description, description_markdown, milestone_date, time_val, status, emoji, color, position
       FROM milestones WHERE timeline_id = $1 ORDER BY milestone_date ASC NULLS LAST, position ASC, created_at ASC`,
      [tl.id]
    );

    res.json({
      timeline: { name: tl.name, emoji: tl.emoji, color: tl.color, colorBg: tl.color_bg, subtitle: tl.subtitle, layout: tl.layout },
      milestones: msRes.rows.map(m => ({
        id: m.id,
        title: m.title,
        description: m.description,
        descriptionMarkdown: m.description_markdown ?? false,
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

interface ShareMarkdownListRow {
  id: string; name: string; emoji: string | null; color: string | null; color_bg: string | null;
  subtitle: string | null; share_enabled: boolean; share_password_hash: string | null;
  share_expires_at: string | null; created_at: string; todo_list_id: string | null;
  shared_by_name: string | null; shared_by_username: string; shared_by_image: string | null;
}

async function resolveShareMarkdownList(token: string): Promise<ShareMarkdownListRow | null> {
  const result = await dbQuery<ShareMarkdownListRow>(
    `SELECT m.id, m.name, m.emoji, m.color, m.color_bg, m.subtitle, m.share_enabled,
            m.share_password_hash, m.share_expires_at, m.created_at, m.todo_list_id,
            u.full_name AS shared_by_name, u.username AS shared_by_username, u.profile_image AS shared_by_image
     FROM markdown_lists m JOIN users u ON m.user_id = u.id
     WHERE m.share_token = $1`,
    [token]
  );
  return result.rows[0] ?? null;
}

// GET /api/share/markdown-list/:token — markdown list metadata (no content)
app.get('/api/share/markdown-list/:token', async (req, res) => {
  try {
    const md = await resolveShareMarkdownList(req.params.token);
    if (!md || !md.share_enabled) { res.status(404).json({ error: 'Markdown list not found' }); return; }
    res.json({
      name: md.name,
      emoji: md.emoji,
      color: md.color,
      colorBg: md.color_bg,
      subtitle: md.subtitle,
      ...shareOwnerMeta(md),
    });
  } catch (err) {
    console.error('share markdown-list info error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/share/markdown-list/:token/content — blocks (password-gated)
app.get('/api/share/markdown-list/:token/content', async (req, res) => {
  try {
    const pw = (req.query.password ?? '') as string;
    const md = await resolveShareMarkdownList(req.params.token);
    if (!md || !md.share_enabled) { res.status(404).json({ error: 'Markdown list not found' }); return; }
    if (md.share_expires_at && new Date(md.share_expires_at) < new Date()) { res.status(410).json({ error: 'Share link has expired' }); return; }
    if (md.share_password_hash) {
      if (!pw) { res.status(401).json({ error: 'Password required', passwordRequired: true }); return; }
      const valid = await comparePassword(pw, md.share_password_hash);
      if (!valid) { res.status(401).json({ error: 'Invalid password' }); return; }
    }

    const contentRes = await dbQuery<{ content: { version: 1; blocks: Array<Record<string, unknown>> } }>(
      `SELECT content FROM markdown_lists WHERE id = $1`,
      [md.id]
    );
    let blocks = contentRes.rows[0]?.content?.blocks ?? [];

    // Overlay live checked state from the linked Todo list — same
    // read-through rule as the authenticated path; the JSONB copy is never
    // trusted for `checked`.
    if (md.todo_list_id) {
      const tasksRes = await dbQuery<{ id: string; checked: boolean }>(
        `SELECT id, checked FROM tasks WHERE list_id = $1 AND source = 'list'`,
        [md.todo_list_id]
      );
      const checkedByTaskId: Record<string, boolean> = {};
      for (const t of tasksRes.rows) checkedByTaskId[String(t.id)] = t.checked;
      blocks = blocks.map((b) => (b.type === 'todo' && typeof b.taskId === 'string' && b.taskId in checkedByTaskId)
        ? { ...b, checked: checkedByTaskId[b.taskId as string] }
        : b);
    }
    // Strip taskId — an internal reference to a private Todo list the
    // anonymous visitor has no access to; not needed by the read-only page.
    blocks = blocks.map((b) => { const { taskId: _taskId, ...rest } = b; return rest; });

    res.json({
      markdownList: { name: md.name, emoji: md.emoji, color: md.color, colorBg: md.color_bg, subtitle: md.subtitle },
      content: { version: 1, blocks },
    });
  } catch (err) {
    console.error('share markdown-list content error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/share/markdown-list/:token/images/:imageId — inline image serve
// for the public share page. Same password/expiry gate as the content route
// above; an anonymous visitor has no JWT, so this can't reuse the
// auth-gated `/api/markdown-lists/:id/images/:imageId` route.
app.get('/api/share/markdown-list/:token/images/:imageId', async (req, res) => {
  try {
    const pw = (req.query.password ?? '') as string;
    const md = await resolveShareMarkdownList(req.params.token);
    if (!md || !md.share_enabled) { res.status(404).json({ error: 'Not found' }); return; }
    if (md.share_expires_at && new Date(md.share_expires_at) < new Date()) { res.status(410).json({ error: 'Share link has expired' }); return; }
    if (md.share_password_hash) {
      if (!pw) { res.status(401).json({ error: 'Password required', passwordRequired: true }); return; }
      const valid = await comparePassword(pw, md.share_password_hash);
      if (!valid) { res.status(401).json({ error: 'Invalid password' }); return; }
    }

    const imgRes = await dbQuery<{ file_path: string; mime_type: string }>(
      'SELECT file_path, mime_type FROM markdown_list_images WHERE id = $1 AND markdown_list_id = $2',
      [req.params.imageId, md.id]
    );
    if (imgRes.rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
    const img = imgRes.rows[0];
    const filePath = path.join(path.resolve(MARKDOWN_IMAGE_DIR), path.basename(img.file_path));
    if (!require('fs').existsSync(filePath)) { res.status(404).json({ error: 'Not found on disk' }); return; }

    res.setHeader('Content-Type', img.mime_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.sendFile(filePath);
  } catch (err) {
    console.error('share markdown-list image error:', err);
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



  // Instance-wide read-only API keys created by admins for external reporting tools.
  // Only hashes are stored; generated secrets are shown once in the admin UI.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_api_keys (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name         VARCHAR(100) NOT NULL,
      key_hash     VARCHAR(100) NOT NULL UNIQUE,
      key_prefix   VARCHAR(40)  NOT NULL,
      created_by   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_used_at TIMESTAMPTZ,
      revoked_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS admin_api_keys_hash_idx ON admin_api_keys(key_hash)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS admin_api_keys_active_idx ON admin_api_keys(revoked_at) WHERE revoked_at IS NULL`);
  // Per-key permission scopes (JSONB array). Existing keys were read-only, so
  // they inherit ["read"] to preserve their exact prior capability.
  await pool.query(`ALTER TABLE admin_api_keys ADD COLUMN IF NOT EXISTS scopes JSONB NOT NULL DEFAULT '["read"]'::jsonb`);

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
      share_token   VARCHAR(100) NOT NULL,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE shared_files ALTER COLUMN is_public SET DEFAULT false`);

  await pool.query(`ALTER TABLE shared_files ADD COLUMN IF NOT EXISTS title VARCHAR(500)`);

  await pool.query(`ALTER TABLE shared_files ADD COLUMN IF NOT EXISTS note TEXT`);

  await pool.query(`ALTER TABLE shared_files ADD COLUMN IF NOT EXISTS bundle_id VARCHAR(100)`);

  await pool.query(`ALTER TABLE shared_files ADD COLUMN IF NOT EXISTS bundle_name VARCHAR(500)`);

  await pool.query(`ALTER TABLE shared_files DROP CONSTRAINT IF EXISTS shared_files_share_token_key`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_shared_files_share_token ON shared_files(share_token)`);

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

  // Must come after `tasks` — it has a FK to tasks(id).
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

  // Markdown mode for item notes
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS note_markdown BOOLEAN NOT NULL DEFAULT false`);

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

    // Heal missing owner memberships for all owned workspaces. Without this,
    // a workspace can become invisible to its owner while its lists/timelines
    // remain in the database and never appear in trash. Guarded (see
    // ensureOwnedWorkspaceMemberships in workspaceUtil.ts) so this startup
    // pass doesn't fire the workspace_members sync_log trigger for every
    // already-correct row on every restart.
    await pool.query(`
      INSERT INTO workspace_members (workspace_id, user_id, role)
      SELECT w.id, w.owner_id, 'owner'
      FROM workspaces w
      ON CONFLICT (workspace_id, user_id) DO UPDATE
        SET role = 'owner'
        WHERE workspace_members.role IS DISTINCT FROM 'owner'
    `);

    // Assign existing unassigned lists/folders/tasks to their owner's workspace.
    // ORDER BY makes the pick deterministic (first-created = Personal). A bare
    // LIMIT 1 let PostgreSQL choose an ARBITRARY owned workspace, scattering
    // healed items into workspaces the user wasn't looking at — one of the
    // causes of "my list disappeared but the AI still sees it".
    await pool.query(`
      UPDATE lists l
      SET workspace_id = (SELECT w.id FROM workspaces w WHERE w.owner_id = l.user_id ORDER BY w.created_at ASC LIMIT 1)
      WHERE l.workspace_id IS NULL
    `);
    await pool.query(`
      UPDATE folders f
      SET workspace_id = (SELECT w.id FROM workspaces w WHERE w.owner_id = f.user_id ORDER BY w.created_at ASC LIMIT 1)
      WHERE f.workspace_id IS NULL
    `);
    await pool.query(`
      UPDATE tasks t
      SET workspace_id = (SELECT w.id FROM workspaces w WHERE w.owner_id = t.user_id ORDER BY w.created_at ASC LIMIT 1)
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

  // Markdown mode for milestone descriptions
  await pool.query(`ALTER TABLE milestones ADD COLUMN IF NOT EXISTS description_markdown BOOLEAN NOT NULL DEFAULT false`);

  await pool.query(`
    UPDATE timelines t
    SET workspace_id = (SELECT w.id FROM workspaces w WHERE w.owner_id = t.user_id ORDER BY w.created_at ASC LIMIT 1)
    WHERE t.workspace_id IS NULL
  `);

  // ── Stranded-content self-heal ─────────────────────────────────────────────
  // Content whose OWNER can no longer access its workspace (removed from a
  // private workspace, workspace went private, historical drift) is invisible
  // in every workspace view while still being returned by the user-scoped AI
  // tools. Move it back to the owner's first (Personal) workspace. Idempotent:
  // a second run matches zero rows. This also repairs data stranded before the
  // re-homing fixes in routes/workspaces.ts existed.
  {
    const strandedCondition = (alias: string) => `
      ${alias}.workspace_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM workspace_members wm
        WHERE wm.workspace_id = ${alias}.workspace_id AND wm.user_id = ${alias}.user_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.id = ${alias}.workspace_id
          AND (w.owner_id = ${alias}.user_id OR w.visibility = 'public')
      )`;
    const personalFor = (alias: string) =>
      `(SELECT w.id FROM workspaces w WHERE w.owner_id = ${alias}.user_id ORDER BY w.created_at ASC LIMIT 1)`;

    const strandedLists = await pool.query(
      `UPDATE lists l SET workspace_id = ${personalFor('l')} WHERE ${strandedCondition('l')}`
    );
    const strandedTimelines = await pool.query(
      `UPDATE timelines t SET workspace_id = ${personalFor('t')} WHERE ${strandedCondition('t')}`
    );
    const strandedFolders = await pool.query(
      `UPDATE folders f SET workspace_id = ${personalFor('f')} WHERE ${strandedCondition('f')}`
    );
    // Dash tasks follow their owner; list items are re-synced to their list below.
    const strandedTasks = await pool.query(
      `UPDATE tasks t SET workspace_id = ${personalFor('t')}
       WHERE (t.source = 'dash' OR t.list_id IS NULL) AND ${strandedCondition('t')}`
    );
    const healed =
      (strandedLists.rowCount ?? 0) + (strandedTimelines.rowCount ?? 0) +
      (strandedFolders.rowCount ?? 0) + (strandedTasks.rowCount ?? 0);
    if (healed > 0) {
      console.log(
        `📋 migration: re-homed stranded content to owners' Personal workspace — ` +
        `${strandedLists.rowCount} list(s), ${strandedTimelines.rowCount} timeline(s), ` +
        `${strandedFolders.rowCount} folder(s), ${strandedTasks.rowCount} dash task(s)`
      );
    }

    // Re-sync list items to their (possibly just-moved) list's workspace.
    await pool.query(`
      UPDATE tasks t
      SET workspace_id = l.workspace_id
      FROM lists l
      WHERE t.list_id = l.id
        AND t.source = 'list'
        AND t.workspace_id IS DISTINCT FROM l.workspace_id
    `);

    // Folder-consistency heal: an item can only sit in a folder of its OWN
    // workspace — a cross-workspace folder_id makes the item unplaceable in
    // the sidebar (it renders nowhere), so detach it.
    const danglingLists = await pool.query(`
      UPDATE lists l SET folder_id = NULL
      FROM folders f
      WHERE l.folder_id = f.id AND l.workspace_id IS DISTINCT FROM f.workspace_id
    `);
    const danglingTimelines = await pool.query(`
      UPDATE timelines t SET folder_id = NULL
      FROM folders f
      WHERE t.folder_id = f.id AND t.workspace_id IS DISTINCT FROM f.workspace_id
    `);
    const detached = (danglingLists.rowCount ?? 0) + (danglingTimelines.rowCount ?? 0);
    if (detached > 0) {
      console.log(`📋 migration: detached ${detached} item(s) from cross-workspace folders`);
    }
  }

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
  // Recurring meetings: repeat presets (daily/weekly/monthly/yearly) are
  // materialized into one row per occurrence at creation time, all sharing
  // the first occurrence's id here — no live RRULE to expand at read time.
  await pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS recurrence_id VARCHAR(100)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS meetings_recurrence_idx ON meetings(recurrence_id) WHERE recurrence_id IS NOT NULL`);

  // Meeting invitees — any instance user the organizer invites gets the
  // meeting on their own calendar too (read-only: only the organizer,
  // meetings.user_id, can edit/delete/re-invite). No RSVP state; an invitee
  // either has the row (sees it) or doesn't (removed it / never invited).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meeting_attendees (
      meeting_id  VARCHAR(100) NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (meeting_id, user_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS meeting_attendees_user_idx ON meeting_attendees(user_id)`);

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

  // Mobile-app device connections. Each row is one signed-in mobile device;
  // its id is embedded in the device's JWT (`connectionId`) so the connection
  // can be listed in Account Settings and revoked individually (or wiped
  // instance-wide when an admin disables mobile access).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mobile_connections (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_name  VARCHAR(255) NOT NULL DEFAULT 'Mobile device',
      device_model VARCHAR(255),
      os_version   VARCHAR(255),
      app_version  VARCHAR(255),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS mobile_connections_user_idx ON mobile_connections(user_id)`);
  // Instance-wide switch for the mobile app (default on). Admins toggle it from
  // Settings → Mobile; disabling wipes all connections and blocks new logins.
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ('mobile_app_enabled', 'true') ON CONFLICT (key) DO NOTHING`);

  // ── Templates ────────────────────────────────────────────────────────────
  // User-owned, workspace-agnostic snapshots of a list's or timeline's full
  // structure (sections/tasks incl. nested sublists, or milestones), reusable
  // to create new lists/timelines. `is_shared` makes a template visible
  // (read-only for non-owners) to every other user of this instance — a
  // simple public toggle, not a share link. `structure` is a versioned JSONB
  // tree built/consumed by templateUtil.ts.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS templates (
      id          VARCHAR(100) PRIMARY KEY,
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type        VARCHAR(20) NOT NULL CHECK (type IN ('list', 'timeline')),
      name        VARCHAR(255) NOT NULL,
      description TEXT,
      emoji       VARCHAR(20),
      color       VARCHAR(20),
      color_bg    VARCHAR(20),
      is_shared   BOOLEAN NOT NULL DEFAULT FALSE,
      structure   JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS templates_user_idx ON templates(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS templates_shared_idx ON templates(is_shared) WHERE is_shared = true`);

  // ── Automation Hub ───────────────────────────────────────────────────────
  // Per-workspace, flow-chart-style automations (e.g. "delete a task once
  // it's checked" or "archive a list once everything on it is done").
  // `graph` is the versioned nodes/edges JSON (validated server-side by
  // automationGraph.ts on every write); trigger_type/trigger_scope are
  // denormalized out of it purely so the hot path — fired on every task
  // check/create — can do an indexed lookup instead of a JSONB scan.
  // Editable only by its creator (or an admin); visible read-only to every
  // workspace member. See automationEngine.ts for execution + loop
  // prevention and CLAUDE.md's "Automation Hub" section for the full design.
  await pool.query(`ALTER TABLE lists ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE lists ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
  await pool.query(`CREATE INDEX IF NOT EXISTS lists_archived_idx ON lists (workspace_id) WHERE is_archived = true`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS automations (
      id             VARCHAR(100) PRIMARY KEY,
      workspace_id   VARCHAR(100) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name           VARCHAR(255) NOT NULL,
      description    TEXT,
      enabled        BOOLEAN NOT NULL DEFAULT TRUE,
      graph          JSONB NOT NULL,
      trigger_type   VARCHAR(40) NOT NULL,
      trigger_scope  JSONB NOT NULL DEFAULT '{}'::jsonb,
      next_fire_at   TIMESTAMPTZ,
      version        INT NOT NULL DEFAULT 1,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS automations_trigger_lookup_idx ON automations (workspace_id, trigger_type) WHERE enabled = true`);
  await pool.query(`CREATE INDEX IF NOT EXISTS automations_next_fire_idx ON automations (next_fire_at) WHERE enabled = true AND trigger_type = 'schedule'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS automations_workspace_idx ON automations (workspace_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id              VARCHAR(100) PRIMARY KEY,
      automation_id   VARCHAR(100) NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      workspace_id    VARCHAR(100) NOT NULL,
      trigger_type    VARCHAR(40) NOT NULL,
      trigger_context JSONB NOT NULL,
      status          VARCHAR(20) NOT NULL DEFAULT 'running',
      steps           JSONB NOT NULL DEFAULT '[]'::jsonb,
      error           TEXT,
      is_test         BOOLEAN NOT NULL DEFAULT FALSE,
      started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at     TIMESTAMPTZ
    )
  `);
  // Manually triggered from the editor's per-node "Test" button — a real run
  // (same engine, real side effects) tagged so Run History can label it.
  await pool.query(`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`CREATE INDEX IF NOT EXISTS automation_runs_automation_idx ON automation_runs (automation_id, started_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS automation_notifications (
      id             VARCHAR(100) PRIMARY KEY,
      user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      automation_id  VARCHAR(100) NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      run_id         VARCHAR(100) NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
      message        TEXT NOT NULL,
      read_at        TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS automation_notifications_user_idx ON automation_notifications (user_id, created_at DESC)`);

  // ── Markdown Lists ───────────────────────────────────────────────────────
  // A block-based document type ("Markdown List"): headings, paragraphs,
  // bulleted/numbered list items, quotes, dividers, images, links and todo
  // items authored via `/` slash commands — parallel to `lists`/`timelines`,
  // not a mode of List. `content` is a versioned JSONB block array (see
  // MarkdownListContent in frontend/src/types.ts). `todo_list_id` points at
  // an auto-managed regular `lists` row that mirrors every `/todo` block as
  // a real task — created lazily on the first todo block and kept in sync on
  // every content save (see routes/markdownLists.ts) — so the Todo summary
  // can be browsed/checked off like any other To-Do list and folded out
  // under the Markdown List in the Sidebar.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS markdown_lists (
      id           VARCHAR(100) PRIMARY KEY,
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name         VARCHAR(255) NOT NULL,
      emoji        VARCHAR(10),
      color        VARCHAR(50),
      color_bg     VARCHAR(50),
      subtitle     VARCHAR(500),
      is_public    BOOLEAN NOT NULL DEFAULT false,
      folder_id    VARCHAR(100) REFERENCES folders(id) ON DELETE SET NULL,
      workspace_id VARCHAR(100) REFERENCES workspaces(id) ON DELETE SET NULL,
      position     INTEGER NOT NULL DEFAULT 0,
      content      JSONB NOT NULL DEFAULT '{"version":1,"blocks":[]}'::jsonb,
      todo_list_id VARCHAR(100) REFERENCES lists(id) ON DELETE SET NULL,
      version      INTEGER NOT NULL DEFAULT 1,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS markdown_lists_user_idx ON markdown_lists(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS markdown_lists_workspace_idx ON markdown_lists(workspace_id)`);

  // Public read-only link sharing — same shape/semantics as lists/timelines
  // (an opaque token minted on first enable, optional bcrypt password,
  // optional expiry). No `share_subpages` — markdown lists have no nesting.
  await pool.query(`ALTER TABLE markdown_lists ADD COLUMN IF NOT EXISTS share_token VARCHAR(64)`);
  await pool.query(`ALTER TABLE markdown_lists ADD COLUMN IF NOT EXISTS share_enabled BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE markdown_lists ADD COLUMN IF NOT EXISTS share_password_hash VARCHAR(255)`);
  await pool.query(`ALTER TABLE markdown_lists ADD COLUMN IF NOT EXISTS share_expires_at TIMESTAMPTZ`);
  await pool.query(`CREATE INDEX IF NOT EXISTS markdown_lists_share_token_idx ON markdown_lists(share_token) WHERE share_token IS NOT NULL`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trash_markdown_lists (
      id                 SERIAL PRIMARY KEY,
      markdown_list_id   VARCHAR(100) NOT NULL,
      user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      markdown_list_data JSONB NOT NULL,
      deleted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at         TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
    )
  `);

  // Dedicated inline-image store for /image blocks — deliberately separate
  // from shared_files: doesn't count against the user's storage quota and
  // isn't reachable via /api/share/:token (served auth-gated, see
  // routes/markdownLists.ts).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS markdown_list_images (
      id               VARCHAR(100) PRIMARY KEY,
      user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      markdown_list_id VARCHAR(100) NOT NULL REFERENCES markdown_lists(id) ON DELETE CASCADE,
      original_name    VARCHAR(500),
      mime_type        VARCHAR(100) NOT NULL DEFAULT 'application/octet-stream',
      file_size        BIGINT NOT NULL DEFAULT 0,
      file_path        VARCHAR(500) NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS markdown_list_images_list_idx ON markdown_list_images(markdown_list_id)`);

  // ── Optimistic concurrency ──────────────────────────────────────────────────
  // A `version` that auto-increments on every UPDATE (BEFORE trigger). Clients
  // echo the version they edited; a conditional PUT then 409s instead of
  // silently clobbering a concurrent edit. Applied to the entities with buffered
  // multi-field editors (lists, timelines) where blind overwrite is the risk.
  await pool.query(`ALTER TABLE lists     ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1`);
  await pool.query(`ALTER TABLE timelines ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1`);
  await pool.query(`
    CREATE OR REPLACE FUNCTION bump_version() RETURNS trigger AS $$
    BEGIN NEW.version = OLD.version + 1; RETURN NEW; END;
    $$ LANGUAGE plpgsql
  `);
  for (const table of ['lists', 'timelines', 'automations', 'markdown_lists']) {
    await pool.query(`DROP TRIGGER IF EXISTS bump_version_${table} ON ${table}`);
    await pool.query(
      `CREATE TRIGGER bump_version_${table} BEFORE UPDATE ON ${table}
       FOR EACH ROW EXECUTE FUNCTION bump_version()`
    );
  }

  // ── Delta-sync outbox (sync_log) ────────────────────────────────────────────
  // A single monotonic BIGSERIAL `seq` is the global cursor. DB triggers append
  // one row per committed mutation (transactional + impossible to forget), and
  // pg_notify a compact descriptor so the in-process dispatcher can fan out a
  // realtime nudge. Payloads are NOT stored — the delta endpoint re-serializes
  // each changed entity fresh (scoped to the reader), so data can never drift
  // and access is always re-checked. Rows are pruned after 7 days.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_log (
      seq          BIGSERIAL PRIMARY KEY,
      entity       VARCHAR(24)  NOT NULL,
      entity_id    VARCHAR(100) NOT NULL,
      op           VARCHAR(8)   NOT NULL,
      workspace_id VARCHAR(100),
      owner_id     UUID         NOT NULL,
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sync_log_ws_seq      ON sync_log (workspace_id, seq)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sync_log_owner_seq   ON sync_log (owner_id, seq)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sync_log_created_at  ON sync_log (created_at)`);

  // Emit helper: append to the outbox and notify the dispatcher in one place.
  await pool.query(`
    CREATE OR REPLACE FUNCTION sync_emit(p_entity text, p_entity_id text, p_op text, p_ws text, p_owner uuid)
    RETURNS void AS $$
    DECLARE v_seq bigint;
    BEGIN
      INSERT INTO sync_log (entity, entity_id, op, workspace_id, owner_id)
      VALUES (p_entity, p_entity_id, p_op, p_ws, p_owner)
      RETURNING seq INTO v_seq;
      PERFORM pg_notify('${SYNC_CHANNEL}', json_build_object(
        'seq', v_seq, 'entity', p_entity, 'entityId', p_entity_id,
        'op', p_op, 'workspaceId', p_ws, 'ownerId', p_owner
      )::text);
    END;
    $$ LANGUAGE plpgsql
  `);

  // Per-table trigger functions. Sections/list-tasks surface as a change to their
  // parent LIST, milestones as a change to their parent TIMELINE — matching how
  // the frontend nests them — so the delta re-serializes the whole aggregate.
  await pool.query(`
    CREATE OR REPLACE FUNCTION trg_synclog_lists() RETURNS trigger AS $$
    BEGIN
      IF (TG_OP = 'DELETE') THEN PERFORM sync_emit('list', OLD.id, 'delete', OLD.workspace_id, OLD.user_id); RETURN OLD; END IF;
      PERFORM sync_emit('list', NEW.id, 'upsert', NEW.workspace_id, NEW.user_id); RETURN NEW;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION trg_synclog_folders() RETURNS trigger AS $$
    BEGIN
      IF (TG_OP = 'DELETE') THEN PERFORM sync_emit('folder', OLD.id, 'delete', OLD.workspace_id, OLD.user_id); RETURN OLD; END IF;
      PERFORM sync_emit('folder', NEW.id, 'upsert', NEW.workspace_id, NEW.user_id); RETURN NEW;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION trg_synclog_timelines() RETURNS trigger AS $$
    BEGIN
      IF (TG_OP = 'DELETE') THEN PERFORM sync_emit('timeline', OLD.id, 'delete', OLD.workspace_id, OLD.user_id); RETURN OLD; END IF;
      PERFORM sync_emit('timeline', NEW.id, 'upsert', NEW.workspace_id, NEW.user_id); RETURN NEW;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION trg_synclog_tasks() RETURNS trigger AS $$
    DECLARE r RECORD; v_op text;
    BEGIN
      IF (TG_OP = 'DELETE') THEN r := OLD; v_op := 'delete'; ELSE r := NEW; v_op := 'upsert'; END IF;
      IF (r.source = 'list' AND r.list_id IS NOT NULL) THEN
        PERFORM sync_emit('list', r.list_id, 'upsert', r.workspace_id, r.user_id);
      ELSE
        PERFORM sync_emit('task', r.id::text, v_op, r.workspace_id, r.user_id);
      END IF;
      RETURN r;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION trg_synclog_sections() RETURNS trigger AS $$
    DECLARE v_list text; v_ws text; v_owner uuid;
    BEGIN
      IF (TG_OP = 'DELETE') THEN v_list := OLD.list_id; ELSE v_list := NEW.list_id; END IF;
      SELECT workspace_id, user_id INTO v_ws, v_owner FROM lists WHERE id = v_list;
      IF v_owner IS NOT NULL THEN PERFORM sync_emit('list', v_list, 'upsert', v_ws, v_owner); END IF;
      IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION trg_synclog_milestones() RETURNS trigger AS $$
    DECLARE v_tl text; v_ws text; v_owner uuid;
    BEGIN
      IF (TG_OP = 'DELETE') THEN v_tl := OLD.timeline_id; ELSE v_tl := NEW.timeline_id; END IF;
      SELECT workspace_id, user_id INTO v_ws, v_owner FROM timelines WHERE id = v_tl;
      IF v_owner IS NOT NULL THEN PERFORM sync_emit('timeline', v_tl, 'upsert', v_ws, v_owner); END IF;
      IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION trg_synclog_workspaces() RETURNS trigger AS $$
    BEGIN
      IF (TG_OP = 'DELETE') THEN PERFORM sync_emit('workspace', OLD.id, 'delete', OLD.id, OLD.owner_id); RETURN OLD; END IF;
      PERFORM sync_emit('workspace', NEW.id, 'upsert', NEW.id, NEW.owner_id); RETURN NEW;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION trg_synclog_members() RETURNS trigger AS $$
    DECLARE v_ws text; v_owner uuid;
    BEGIN
      IF (TG_OP = 'DELETE') THEN v_ws := OLD.workspace_id; v_owner := OLD.user_id;
      ELSE v_ws := NEW.workspace_id; v_owner := NEW.user_id; END IF;
      PERFORM sync_emit('workspace', v_ws, 'upsert', v_ws, v_owner);
      IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION trg_synclog_meetings() RETURNS trigger AS $$
    BEGIN
      IF (TG_OP = 'DELETE') THEN PERFORM sync_emit('meeting', OLD.id, 'delete', NULL, OLD.user_id); RETURN OLD; END IF;
      PERFORM sync_emit('meeting', NEW.id, 'upsert', NULL, NEW.user_id); RETURN NEW;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION trg_synclog_files() RETURNS trigger AS $$
    BEGIN
      IF (TG_OP = 'DELETE') THEN PERFORM sync_emit('file', OLD.id, 'delete', NULL, OLD.user_id); RETURN OLD; END IF;
      PERFORM sync_emit('file', NEW.id, 'upsert', NULL, NEW.user_id); RETURN NEW;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION trg_synclog_trash() RETURNS trigger AS $$
    DECLARE v_owner uuid;
    BEGIN
      IF (TG_OP = 'DELETE') THEN v_owner := OLD.user_id; ELSE v_owner := NEW.user_id; END IF;
      PERFORM sync_emit('trash', '', 'upsert', NULL, v_owner);
      IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION trg_synclog_templates() RETURNS trigger AS $$
    DECLARE v_owner uuid;
    BEGIN
      IF (TG_OP = 'DELETE') THEN v_owner := OLD.user_id; ELSE v_owner := NEW.user_id; END IF;
      PERFORM sync_emit('template', '', 'upsert', NULL, v_owner);
      IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION trg_synclog_automations() RETURNS trigger AS $$
    BEGIN
      IF (TG_OP = 'DELETE') THEN PERFORM sync_emit('automation', OLD.id, 'delete', OLD.workspace_id, OLD.user_id); RETURN OLD; END IF;
      PERFORM sync_emit('automation', NEW.id, 'upsert', NEW.workspace_id, NEW.user_id); RETURN NEW;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION trg_synclog_markdown_lists() RETURNS trigger AS $$
    BEGIN
      IF (TG_OP = 'DELETE') THEN PERFORM sync_emit('markdownList', OLD.id, 'delete', OLD.workspace_id, OLD.user_id); RETURN OLD; END IF;
      PERFORM sync_emit('markdownList', NEW.id, 'upsert', NEW.workspace_id, NEW.user_id); RETURN NEW;
    END; $$ LANGUAGE plpgsql
  `);

  // Attach every trigger idempotently (DROP + CREATE so re-runs are safe).
  const syncTriggers: Array<[string, string]> = [
    ['lists', 'lists'], ['folders', 'folders'], ['timelines', 'timelines'],
    ['tasks', 'tasks'], ['sections', 'sections'], ['milestones', 'milestones'],
    ['workspaces', 'workspaces'], ['workspace_members', 'members'],
    ['meetings', 'meetings'], ['shared_files', 'files'],
    ['trash', 'trash'], ['trash_lists', 'trash'], ['trash_folders', 'trash'],
    ['trash_timelines', 'trash'], ['trash_milestones', 'trash'], ['trash_markdown_lists', 'trash'],
    ['templates', 'templates'], ['automations', 'automations'], ['markdown_lists', 'markdown_lists'],
  ];
  for (const [table, fn] of syncTriggers) {
    await pool.query(`DROP TRIGGER IF EXISTS synclog_${table} ON ${table}`);
    await pool.query(
      `CREATE TRIGGER synclog_${table} AFTER INSERT OR UPDATE OR DELETE ON ${table}
       FOR EACH ROW EXECUTE FUNCTION trg_synclog_${fn}()`
    );
  }

  // Per-user keyboard shortcut customizations (overrides only; any action not
  // present here falls back to the frontend registry's default binding).
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS keyboard_shortcuts JSONB NOT NULL DEFAULT '{}'::jsonb`);

  // Admin-installable apps (Settings → System → Discover Apps). The catalog
  // itself lives in code (appsRegistry.ts); this table just tracks which
  // ones are currently switched on. Apps start uninstalled — see
  // requireAppInstalled() for how routes are gated on this.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS installed_apps (
      app_id       VARCHAR(50) PRIMARY KEY,
      installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      installed_by UUID REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // Per-list layout preference — the To-Do screen's List/Kanban tab switcher.
  // Persisted (not just local UI state) so it's the same on every device.
  await pool.query(`ALTER TABLE lists ADD COLUMN IF NOT EXISTS view_mode VARCHAR(20) NOT NULL DEFAULT 'list'`);

  console.log('Database migrations applied.');
}

/** Prune sync_log rows past the 7-day retention window (clients older than that
 *  re-bootstrap instead of applying deltas — see /api/sync/delta `reset`). */
async function pruneSyncLog(): Promise<void> {
  try {
    const r = await pool.query(`DELETE FROM sync_log WHERE created_at < NOW() - INTERVAL '7 days'`);
    if (r.rowCount) console.log(`🧹 pruned ${r.rowCount} sync_log row(s) older than 7 days`);
  } catch (err) {
    console.error('sync_log prune failed:', err);
  }
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

  // Automation Hub: fire any due 'schedule'-trigger automations. 5-minute
  // granularity is plenty for daily/weekly schedules; event-driven triggers
  // (task_completed/task_created/list_all_completed) fire inline from
  // routes/lists.ts and don't go through this sweep.
  sweepScheduledAutomations();
  setInterval(sweepScheduledAutomations, 5 * 60 * 1000);

  // Delta-sync: prune the outbox daily, and start the realtime dispatcher that
  // fans committed changes out to every affected user's devices.
  pruneSyncLog();
  setInterval(pruneSyncLog, 24 * 60 * 60 * 1000);
  await startSyncDispatcher();

  app.listen(PORT, () => {
    console.log(`Solytiq Cloud API listening on port ${PORT}`);
  });
}

start();
