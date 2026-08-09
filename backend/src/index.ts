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
import notificationsRouter from './routes/notifications';
import taskTagsRouter from './routes/taskTags';
import itemSharesRouter from './routes/itemShares';
import linksRouter from './routes/links';
import graphRouter from './routes/graph';
import canvasesRouter from './routes/canvases';
import knowledgeRouter from './routes/knowledge';
import knowledgeBaseRouter from './routes/knowledgeBase';
import aiSkillsRouter from './routes/aiSkills';
import { sweepEmbeddingQueue } from './knowledge/embeddingWorker';
import agentRouter from './routes/agent';
import { sweepExpiredProposals } from './agent/runtime';
import { sweepMigrationVerification } from './graph/verifyMigration';
import { sweepGraphMetrics } from './graph/metrics';
import { isAppInstalled } from './appsRegistry';
import { startSyncDispatcher, SYNC_CHANNEL } from './syncLog';
import { sweepScheduledAutomations } from './automationEngine';
import { sweepOverdueDeadlines } from './notifications';
import { getPublicBaseUrl } from './publicUrl';
import { comparePassword } from './auth';
import { mintShareSession, isValidShareSession, sweepExpiredShareSessions, type ShareKind } from './shareSessions';
import { query as dbQuery } from './db';
import { handleSseEventsRequest, sweepStaleSseConnections } from './sse';
import { sweepExpiredAssetTickets } from './assetTickets';
import { isCfConnectingIpTrusted, resolveClientIp, resolveTrustProxyHops } from './proxyTrust';
import { mcpTokenKey, acquireMcpSlot, releaseMcpSlot } from './mcpLimits';
import { accountLoginLimiter, accountTwoFaLimiter } from './loginRateLimit';
import { verifyToken } from './auth';
import { ensureSetupTokenLogged } from './setupToken';

const app = express();
const PORT = parseInt(process.env.PORT ?? '3001', 10);

// SECURITY (S5): the number of reverse-proxy hops Express trusts when
// deriving `req.ip`/`req.protocol` from X-Forwarded-* headers. Defaults to 1,
// matching this repo's own shipped topology (docker-compose.yml: nginx sits
// directly in front of the backend — exactly one hop). Configurable via
// TRUST_PROXY_HOPS for an operator whose real deployment has a different,
// verified hop count (e.g. an additional load balancer in front of nginx) —
// trusting MORE hops than actually exist lets a client's own forged
// X-Forwarded-For entries masquerade as a trusted proxy's. See proxyTrust.ts.
app.set('trust proxy', resolveTrustProxyHops());
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
// SECURITY (S5): `CF-Connecting-IP` is trusted ONLY when an operator
// explicitly opts in via TRUST_CF_CONNECTING_IP=true. The previous
// unconditional trust rested on an assumption ("the origin is only
// reachable through the internal proxy chain, not publicly") that is NOT
// provable from anything in this repository — nginx.conf does not strip or
// validate the header, docker-compose.yml exposes the frontend/backend
// ports directly, and there is no Cloudflare-specific network allow-list
// anywhere in this codebase. Left as the default behavior, any client that
// can reach this origin directly (which, per the above, is not ruled out by
// anything checked into this repo) could set `CF-Connecting-IP` to an
// arbitrary, attacker-chosen, freely-rotatable value on every request —
// trivially bypassing the login/setup/oauth-register/share-password brute-
// force limiters that key on this function, since a "new IP" gets a fresh
// budget every time.
//
// `req.ip` (governed by Express's own `trust proxy` setting below, which
// DOES match this repo's actual, provable topology — nginx is the one hop
// directly in front of the backend per docker-compose.yml) is always a safe
// default: at worst it collapses distinct visitors behind the same
// upstream proxy into one bucket (a availability inconvenience), which is
// what happens today for any operator who hasn't opted in. An operator who
// verifies their OWN deployment truly sits behind Cloudflare (and that
// Cloudflare is the only way to reach the origin) can set
// TRUST_CF_CONNECTING_IP=true to restore accurate per-visitor keying.
const TRUST_CF_CONNECTING_IP = isCfConnectingIpTrusted();
const clientKey = (req: express.Request): string => {
  const ip = resolveClientIp(req.headers['cf-connecting-ip'], req.ip, TRUST_CF_CONNECTING_IP);
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

// SECURITY (S5): authLimiter above is IP-keyed only — it does not bound a
// distributed credential-stuffing attack against one account. accountLoginLimiter/
// accountTwoFaLimiter (imported from loginRateLimit.ts — extracted for direct
// HTTP-level testability, see that module's own header comment for the full
// rationale) key on the ACCOUNT being attacked instead, and are mounted ON TOP
// OF (not instead of) authLimiter below — a request must clear both budgets,
// the same "additional tier on top of a base one" pattern as
// linksLimiter/graphLimiter/knowledgeLimiter/agentLimiter on top of apiLimiter
// elsewhere in this file.

// Graph layer: entity_links reads/writes are more expensive than typical CRUD
// (visibility joins, batch resolution) — a tighter, dedicated budget on top of
// (not instead of) the general apiLimiter, same pattern as auth/setup above.
const linksLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { error: 'Too many requests, please slow down.' },
});

// /api/graph/* queries are the most expensive Graph Layer reads (recursive
// CTEs, batch metrics) — stricter than linksLimiter, NOT exempted like
// /api/sync/* (unlike delta-sync polls, a graph fetch is genuinely costly).
const graphLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { error: 'Too many requests, please slow down.' },
});

// Knowledge Layer search can trigger a live query-embedding call to an
// external provider — meaningfully pricier than a plain trigram lookup, so it
// gets its own tighter budget on top of apiLimiter, same pattern as links/graph.
const knowledgeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { error: 'Too many requests, please slow down.' },
});

// Agent Runtime: starting a run kicks off a multi-turn LLM tool-calling loop —
// far pricier than any other endpoint in this app. A tight budget on top of
// apiLimiter, same pattern as links/graph/knowledge above.
const agentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { error: 'Too many requests, please slow down.' },
});

// SECURITY (S5): /mcp previously had NO rate limiter at all — it's mounted
// outside /api specifically so the generic per-user apiLimiter (built for
// browser-tab traffic) never throttles a legitimate multi-step agent
// tool-calling loop, but that exemption left the endpoint's only defense as
// bearer-token authentication itself, which bounds WHO can call it, not HOW
// OFTEN. Keyed per-TOKEN (via mcpTokenKey, hashing whatever raw bearer value
// was sent — including an invalid/guessed one, so a token-guessing attempt
// gets its own small bucket rather than sharing the unauthenticated IP
// bucket with every other unauthenticated caller) and falling back to
// per-IP only when no bearer token was sent at all. 300/min is generous for
// a real tool-calling loop (well above agentLimiter's 20/min, since a single
// agent run can legitimately make many individual tool calls) while still
// bounding a runaway or malicious client.
const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => mcpTokenKey(req.headers.authorization) ?? `ip:${clientKey(req)}`,
  message: { error: 'Too many MCP requests, please slow down.' },
});

// SECURITY (S5): a companion CONCURRENCY cap, independent of the rate limiter
// above — a client comfortably under 300/min can still open many slow/
// long-running requests simultaneously (each holding a DB connection + a
// stateless MCP server/transport pair open for its duration), which a
// per-minute count alone doesn't bound. Mirrors sse.ts's per-user connection
// cap for the same reason. See mcpLimits.ts.
function mcpConcurrencyGuard(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const key = mcpTokenKey(req.headers.authorization) ?? `ip:${clientKey(req)}`;
  if (!acquireMcpSlot(key)) {
    res.status(429).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Too many concurrent MCP requests for this client.' },
      id: null,
    });
    return;
  }
  let released = false;
  const release = () => { if (!released) { released = true; releaseMcpSlot(key); } };
  res.on('close', release);
  res.on('finish', release);
  next();
}

app.use('/api/', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});
app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter, accountLoginLimiter);
app.use('/api/auth/2fa/verify', authLimiter, accountTwoFaLimiter);
app.use('/api/auth/register', setupLimiter);
app.use('/api/auth/request-setup-token', setupLimiter);
app.use('/api/auth/admin-password-reset', setupLimiter);
app.use('/api/admin/nuke', setupLimiter);
// SECURITY (S3): Dynamic Client Registration (POST /api/oauth/register) is
// unauthenticated by design (RFC 7591 — any MCP client must be able to
// self-register before it has ever talked to this server). Without a tight
// budget it otherwise falls under the generic 600/min apiLimiter, which is
// far too generous for an endpoint whose whole job is minting new OAuth
// client identities — reusing setupLimiter's 5/hour keeps automated
// client-farming (a prerequisite for the consent-phishing scenario
// /client-info's `trusted` flag defends against) from being cheap to attempt
// at scale, without blocking a legitimate one-time connector setup.
app.use('/api/oauth/register', setupLimiter);
// SECURITY (S4/S5): a share password is guessable the same way a login
// password is — this is the one endpoint that ever checks one, so it gets
// the same tight per-IP budget as /api/auth/login rather than the generic
// 600/min apiLimiter (which also doesn't apply here at all, since this is
// outside /api's rate-limited... no — /api/share/verify-password DOES start
// with /api/, so apiLimiter's per-user keying would fall back to per-IP for
// this always-anonymous endpoint anyway; authLimiter is still the tighter,
// more appropriate budget for a password-guessing surface).
app.use('/api/share/verify-password', authLimiter);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use('/api/auth',       authRouter);
app.use('/api/tasks/:taskId/attachments', taskAttachmentsRouter);
app.use('/api/tasks/:taskId/tags', taskTagsRouter);
app.use('/api/tasks',      tasksRouter);
app.use('/api/lists',      listsRouter);
app.use('/api/trash',      trashRouter);
app.use('/api/admin/ai-skills', aiSkillsRouter);
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
app.use('/api/notifications', notificationsRouter);
app.use('/api', itemSharesRouter);
app.use('/api/links', linksLimiter, linksRouter);
app.use('/api/graph', graphLimiter, graphRouter);
app.use('/api/canvases', canvasesRouter);
app.use('/api/knowledge', knowledgeLimiter, knowledgeRouter);
// Distinct from /api/knowledge above (the RAG layer). Express only matches an
// app.use prefix at a path-segment boundary, so `-base` never collides with it.
// Plain CRUD behind the global apiLimiter only, like /api/canvases — the pricier
// tiers exist for endpoints that fan out to an external provider or a recursive
// CTE, and neither applies here.
app.use('/api/knowledge-base', knowledgeBaseRouter);
app.use('/api/agent', agentLimiter, agentRouter);

// Model Context Protocol endpoint for external AI agents (PAT-authenticated).
// Mounted outside /api so the per-IP apiLimiter does not throttle agent tool
// loops; the endpoint enforces its own bearer-token auth, plus its own
// dedicated rate + concurrency limits (mcpLimiter / mcpConcurrencyGuard —
// see S5 comments above).
app.use('/mcp', mcpLimiter, mcpConcurrencyGuard, mcpRouter);

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
//
// SECURITY (S4): every password-gated share endpoint below used to accept
// the share's PLAINTEXT password as a `?password=` query parameter on every
// single request — sitting in the visitor's browser history and this
// server's own access logs for as long as they kept the tab open. It now
// accepts a short-lived, opaque `?session=` ticket instead (shareSessions.ts),
// obtained ONCE via POST /api/share/verify-password (a request body, never
// logged the way a URL is). checkSharePasswordGate() is the one place this
// is enforced; every content/download/image route below calls it instead of
// re-deriving its own password check.
function checkSharePasswordGate(
  req: express.Request,
  res: express.Response,
  kind: ShareKind,
  token: string,
  passwordHash: string | null
): boolean {
  if (!passwordHash) return true;
  const sessionParam = typeof req.query.session === 'string' ? req.query.session : '';
  if (sessionParam && isValidShareSession(sessionParam, kind, token)) return true;
  res.status(401).json({ error: 'Password required', passwordRequired: true });
  return false;
}

interface ShareFileRow { id: string; original_name: string; title: string | null; note: string | null; mime_type: string; file_size: number; file_path: string; is_public: boolean; password_hash: string | null; expires_at: string | null; created_at: string; share_token: string; bundle_id: string | null; bundle_name: string | null; shared_by_name: string | null; shared_by_username: string; shared_by_image: string | null; }

// POST /api/share/verify-password — the ONE place a share visitor's password
// submission is ever accepted, as a request body (never a URL). Returns a
// short-lived `session` ticket (shareSessions.ts) the public page then uses
// as `?session=` on every subsequent content/download/image request for
// that exact share, instead of the plaintext password. `kind`/`token` name
// WHICH share is being unlocked; the 5 resolver functions below (hoisted —
// function declarations, not const — so referencing them here before their
// textual definition is safe) are the single source of truth for each
// share type's own password hash, expiry, and enabled state.
app.post('/api/share/verify-password', async (req, res) => {
  try {
    const { kind, token, password } = req.body as { kind?: string; token?: string; password?: string };
    if (!kind || !token || !password) { res.status(400).json({ error: 'kind, token and password are required' }); return; }
    if (!['file', 'list', 'timeline', 'markdownList', 'folder'].includes(kind)) {
      res.status(400).json({ error: 'Invalid kind' });
      return;
    }

    let passwordHash: string | null = null;
    let notFound = false;
    let expired = false;
    switch (kind as ShareKind) {
      case 'file': {
        const row = await resolveShareFile(token);
        if (!row || !row.is_public) notFound = true;
        else { passwordHash = row.password_hash; expired = !!(row.expires_at && new Date(row.expires_at) < new Date()); }
        break;
      }
      case 'list': {
        const row = await resolveShareList(token);
        if (!row || !row.share_enabled) notFound = true;
        else { passwordHash = row.share_password_hash; expired = !!(row.share_expires_at && new Date(row.share_expires_at) < new Date()); }
        break;
      }
      case 'timeline': {
        const row = await resolveShareTimeline(token);
        if (!row || !row.share_enabled) notFound = true;
        else { passwordHash = row.share_password_hash; expired = !!(row.share_expires_at && new Date(row.share_expires_at) < new Date()); }
        break;
      }
      case 'markdownList': {
        const row = await resolveShareMarkdownList(token);
        if (!row || !row.share_enabled) notFound = true;
        else { passwordHash = row.share_password_hash; expired = !!(row.share_expires_at && new Date(row.share_expires_at) < new Date()); }
        break;
      }
      case 'folder': {
        const row = await resolveShareFolder(token);
        if (!row || !row.share_enabled) notFound = true;
        else { passwordHash = row.share_password_hash; expired = !!(row.share_expires_at && new Date(row.share_expires_at) < new Date()); }
        break;
      }
    }
    if (notFound) { res.status(404).json({ error: 'Not found' }); return; }
    if (expired) { res.status(410).json({ error: 'Share link has expired' }); return; }
    if (!passwordHash) { res.status(400).json({ error: 'This share is not password-protected' }); return; }

    const valid = await comparePassword(password, passwordHash);
    if (!valid) { res.status(401).json({ error: 'Invalid password' }); return; }

    const { session, expiresAt } = mintShareSession(kind as ShareKind, token);
    res.json({ session, expiresAt });
  } catch (err) {
    console.error('share verify-password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

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
    const file = await resolveShareFile(token);
    if (!file) { res.status(404).json({ error: 'File not found' }); return; }
    if (!file.is_public) { res.status(403).json({ error: 'This file is private' }); return; }
    if (file.expires_at && new Date(file.expires_at) < new Date()) { res.status(410).json({ error: 'Share link has expired' }); return; }
    if (!checkSharePasswordGate(req, res, 'file', token, file.password_hash)) return;
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
    const file = await resolveShareFile(token);
    if (!file) { res.status(404).json({ error: 'File not found' }); return; }
    if (!file.is_public) { res.status(403).json({ error: 'This file is private' }); return; }
    if (file.expires_at && new Date(file.expires_at) < new Date()) { res.status(410).json({ error: 'Share link has expired' }); return; }
    if (!checkSharePasswordGate(req, res, 'file', token, file.password_hash)) return;
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
  view_mode: string; share_view_mode: string | null;
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
            l.view_mode, l.share_view_mode,
            u.full_name AS shared_by_name, u.username AS shared_by_username, u.profile_image AS shared_by_image
     FROM lists l JOIN users u ON l.user_id = u.id
     WHERE l.share_token = $1`,
    [token]
  );
  return result.rows[0] ?? null;
}

// Which List/Kanban/Timeline layout the public page renders for a shared list —
// the owner's explicit `share_view_mode` override, falling back to whatever
// layout they currently have the list set to in-app.
function resolveListViewMode(row: { view_mode: string; share_view_mode: string | null }): 'list' | 'kanban' | 'timeline' {
  const v = row.share_view_mode || row.view_mode;
  return v === 'kanban' || v === 'timeline' ? v : 'list';
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
      viewMode: resolveListViewMode(list),
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
    const list = await resolveShareList(req.params.token);
    if (!list || !list.share_enabled) { res.status(404).json({ error: 'List not found' }); return; }
    if (list.share_expires_at && new Date(list.share_expires_at) < new Date()) { res.status(410).json({ error: 'Share link has expired' }); return; }
    if (!checkSharePasswordGate(req, res, 'list', req.params.token, list.share_password_hash)) return;

    const sectionsRes = await dbQuery<{ id: string; label: string; emoji: string | null; position: number }>(
      `SELECT id, label, emoji, position FROM sections WHERE list_id = $1 ORDER BY position ASC`,
      [list.id]
    );
    const tasksRes = await dbQuery<{
      id: string; title: string; checked: boolean; note: string | null; note_markdown: boolean; deadline: string | null;
      time_val: string | null; priority: string | null; badge: string | null; section_id: string | null;
      position: number; linked_list_id: string | null; linked_list_type: string | null;
      created_at: string; completed_at: string | null;
    }>(
      `SELECT id, title, checked, note, note_markdown, deadline, time_val, priority, badge, section_id, position, linked_list_id, linked_list_type, created_at, completed_at
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
          createdAt: t.created_at,
          completedAt: t.completed_at ?? null,
        })),
    }));

    res.json({
      list: { name: list.name, emoji: list.emoji, color: list.color, colorBg: list.color_bg, subtitle: list.subtitle, viewMode: resolveListViewMode(list) },
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
    const tl = await resolveShareTimeline(req.params.token);
    if (!tl || !tl.share_enabled) { res.status(404).json({ error: 'Timeline not found' }); return; }
    if (tl.share_expires_at && new Date(tl.share_expires_at) < new Date()) { res.status(410).json({ error: 'Share link has expired' }); return; }
    if (!checkSharePasswordGate(req, res, 'timeline', req.params.token, tl.share_password_hash)) return;

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
  subtitle: string | null; full_width: boolean; share_enabled: boolean; share_password_hash: string | null;
  share_expires_at: string | null; created_at: string; todo_list_id: string | null;
  shared_by_name: string | null; shared_by_username: string; shared_by_image: string | null;
}

async function resolveShareMarkdownList(token: string): Promise<ShareMarkdownListRow | null> {
  const result = await dbQuery<ShareMarkdownListRow>(
    `SELECT m.id, m.name, m.emoji, m.color, m.color_bg, m.subtitle, m.full_width, m.share_enabled,
            m.share_password_hash, m.share_expires_at, m.created_at, m.todo_list_id,
            u.full_name AS shared_by_name, u.username AS shared_by_username, u.profile_image AS shared_by_image
     FROM markdown_lists m JOIN users u ON m.user_id = u.id
     WHERE m.share_token = $1`,
    [token]
  );
  return result.rows[0] ?? null;
}

// GET /api/share/markdown-list/:token — markdown page metadata (no content)
app.get('/api/share/markdown-list/:token', async (req, res) => {
  try {
    const md = await resolveShareMarkdownList(req.params.token);
    if (!md || !md.share_enabled) { res.status(404).json({ error: 'Markdown page not found' }); return; }
    res.json({
      name: md.name,
      emoji: md.emoji,
      color: md.color,
      colorBg: md.color_bg,
      subtitle: md.subtitle,
      fullWidth: md.full_width ?? false,
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
    const md = await resolveShareMarkdownList(req.params.token);
    if (!md || !md.share_enabled) { res.status(404).json({ error: 'Markdown page not found' }); return; }
    if (md.share_expires_at && new Date(md.share_expires_at) < new Date()) { res.status(410).json({ error: 'Share link has expired' }); return; }
    if (!checkSharePasswordGate(req, res, 'markdownList', req.params.token, md.share_password_hash)) return;

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
      markdownList: { name: md.name, emoji: md.emoji, color: md.color, colorBg: md.color_bg, subtitle: md.subtitle, fullWidth: md.full_width ?? false },
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
    const md = await resolveShareMarkdownList(req.params.token);
    if (!md || !md.share_enabled) { res.status(404).json({ error: 'Not found' }); return; }
    if (md.share_expires_at && new Date(md.share_expires_at) < new Date()) { res.status(410).json({ error: 'Share link has expired' }); return; }
    if (!checkSharePasswordGate(req, res, 'markdownList', req.params.token, md.share_password_hash)) return;

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

// ---------------------------------------------------------------------------
// Public folder share endpoints — a folder published as a read-only navigator
// page listing the shared items inside it. No auth required.
// ---------------------------------------------------------------------------

interface ShareFolderRow {
  id: string; name: string; emoji: string | null; color: string | null;
  share_enabled: boolean; share_password_hash: string | null; share_expires_at: string | null;
  share_include_all: boolean; created_at: string;
  shared_by_name: string | null; shared_by_username: string; shared_by_image: string | null;
}

async function resolveShareFolder(token: string): Promise<ShareFolderRow | null> {
  const result = await dbQuery<ShareFolderRow>(
    `SELECT f.id, f.name, f.emoji, f.color, f.share_enabled, f.share_password_hash,
            f.share_expires_at, f.share_include_all, f.created_at,
            u.full_name AS shared_by_name, u.username AS shared_by_username, u.profile_image AS shared_by_image
     FROM folders f JOIN users u ON f.user_id = u.id
     WHERE f.share_token = $1`,
    [token]
  );
  return result.rows[0] ?? null;
}

// GET /api/share/folder/:token — folder metadata (no contents)
app.get('/api/share/folder/:token', async (req, res) => {
  try {
    const folder = await resolveShareFolder(req.params.token);
    if (!folder || !folder.share_enabled) { res.status(404).json({ error: 'Folder not found' }); return; }
    res.json({
      name: folder.name,
      emoji: folder.emoji,
      color: folder.color,
      ...shareOwnerMeta(folder),
    });
  } catch (err) {
    console.error('share folder info error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/share/folder/:token/content — the navigator's item list. Only items
// whose OWN share link is live (enabled + unexpired) are surfaced, so every
// entry deep-links to a working public page. In "share all" mode every item in
// the folder was cascade-shared when the folder was published; in "only shared"
// mode this naturally reflects whatever the owner has individually shared.
app.get('/api/share/folder/:token/content', async (req, res) => {
  try {
    const folder = await resolveShareFolder(req.params.token);
    if (!folder || !folder.share_enabled) { res.status(404).json({ error: 'Folder not found' }); return; }
    if (folder.share_expires_at && new Date(folder.share_expires_at) < new Date()) { res.status(410).json({ error: 'Share link has expired' }); return; }
    if (!checkSharePasswordGate(req, res, 'folder', req.params.token, folder.share_password_hash)) return;

    const liveShare = `share_enabled = true AND (share_expires_at IS NULL OR share_expires_at > NOW())`;

    const listRes = await dbQuery<{ id: string; name: string; emoji: string | null; color: string | null; color_bg: string | null; share_token: string; total: string; completed: string }>(
      `SELECT l.id, l.name, l.emoji, l.color, l.color_bg, l.share_token,
              COUNT(t.id) AS total,
              COUNT(t.id) FILTER (WHERE t.checked) AS completed
       FROM lists l
       LEFT JOIN tasks t ON t.list_id = l.id AND t.source = 'list'
       WHERE l.folder_id = $1 AND l.${liveShare} AND l.share_token IS NOT NULL
       GROUP BY l.id
       ORDER BY l.position ASC, l.created_at ASC`,
      [folder.id]
    );

    const timelineRes = await dbQuery<{ id: string; name: string; emoji: string | null; color: string | null; color_bg: string | null; share_token: string; total: string; completed: string }>(
      `SELECT t.id, t.name, t.emoji, t.color, t.color_bg, t.share_token,
              COUNT(m.id) AS total,
              COUNT(m.id) FILTER (WHERE m.status = 'done') AS completed
       FROM timelines t
       LEFT JOIN milestones m ON m.timeline_id = t.id
       WHERE t.folder_id = $1 AND t.${liveShare} AND t.share_token IS NOT NULL
       GROUP BY t.id
       ORDER BY t.position ASC, t.created_at ASC`,
      [folder.id]
    );

    const markdownRes = await dbQuery<{ id: string; name: string; emoji: string | null; color: string | null; color_bg: string | null; share_token: string }>(
      `SELECT m.id, m.name, m.emoji, m.color, m.color_bg, m.share_token
       FROM markdown_lists m
       WHERE m.folder_id = $1 AND m.${liveShare} AND m.share_token IS NOT NULL
       ORDER BY m.position ASC, m.created_at ASC`,
      [folder.id]
    );

    const items = [
      ...listRes.rows.map(r => ({
        type: 'list' as const, name: r.name, emoji: r.emoji, color: r.color, colorBg: r.color_bg,
        shareToken: r.share_token, progress: { total: parseInt(r.total, 10), completed: parseInt(r.completed, 10) },
      })),
      ...timelineRes.rows.map(r => ({
        type: 'timeline' as const, name: r.name, emoji: r.emoji, color: r.color, colorBg: r.color_bg,
        shareToken: r.share_token, progress: { total: parseInt(r.total, 10), completed: parseInt(r.completed, 10) },
      })),
      ...markdownRes.rows.map(r => ({
        type: 'markdownList' as const, name: r.name, emoji: r.emoji, color: r.color, colorBg: r.color_bg,
        shareToken: r.share_token, progress: null,
      })),
    ];

    res.json({
      folder: { name: folder.name, emoji: folder.emoji, color: folder.color },
      items,
    });
  } catch (err) {
    console.error('share folder content error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// SSE — real-time sync endpoint.
//
// SECURITY (S4): a browser's EventSource can't set an Authorization header,
// so this used to accept the full, long-lived (30-day) session JWT as a
// `?token=` query parameter — a real secret sitting in the URL, and
// therefore in browser history and this server's own access logs for as
// long as that JWT stayed valid. It now accepts a short-lived, single-use
// `?ticket=` instead (assetTickets.ts, minted via POST /api/auth/asset-ticket
// from an already-authenticated request) — a leaked ticket in a log is
// worthless within a minute and can only ever open ONE SSE stream, nothing
// else. The Authorization header path is unchanged for any non-browser
// caller that CAN set one.
//
// The handler itself lives in sse.ts as handleSseEventsRequest() (extracted
// out of this file) so an integration test can mount and exercise this EXACT
// production code path — including the connectionId threading that makes
// mobile-device revocation actually work — instead of a hand-copied stand-in
// that could silently drift from it. See sse.ts's own header comment on that
// function for why.
app.get('/api/events', handleSseEventsRequest);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// SECURITY/CORRECTNESS (S7): a separate, DB-touching readiness surface — kept
// OUT of /health above on purpose, since /health is polled frequently by
// Docker/orchestrators as a pure liveness check and must stay cheap and
// dependency-free. This one is for a deploy pipeline or admin tooling that
// wants to confirm which versioned migrations have actually landed on THIS
// database, not just that the process is up. No secrets in the response —
// migration ids/descriptions are code, not data — so it's safe unauthenticated,
// same posture as /health itself.
app.get('/health/schema', async (_req, res) => {
  try {
    const version = await getSchemaVersion();
    res.json(version);
  } catch (err) {
    console.error('schema version check error:', err);
    res.status(503).json({ error: 'Schema version unavailable' });
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

import { runAllMigrations } from './migrations';
import { getSchemaVersion } from './versionedMigrations';

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
    // SECURITY/CORRECTNESS (S7): runAllMigrations() wraps the legacy
    // migrations.ts monolith AND the new versioned-migration runner
    // (versionedMigrations.ts) in one advisory lock, so a concurrently
    // starting second process (rolling deploy, restart racing a fresh
    // replica) waits instead of racing DDL statements — see migrations.ts's
    // own header comment on runAllMigrations() for the full rationale.
    await runAllMigrations();
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

  // Notifications: alert task owners + tagged users about overdue deadlines,
  // once per (task, deadline). Hourly is plenty — deadlines have day precision.
  sweepOverdueDeadlines();
  setInterval(sweepOverdueDeadlines, 60 * 60 * 1000);

  // Agent Runtime: expire stale pending proposals (7-day TTL). Hourly is
  // plenty — approvals are a human-timescale action, not a hot path.
  sweepExpiredProposals();
  setInterval(sweepExpiredProposals, 60 * 60 * 1000);

  // Graph Layer: nightly drift check between the legacy hard-link columns and
  // their mirrored entity_links edges, feeding the gated column-drop
  // migration's 7-consecutive-clean-days streak (see graph/verifyMigration.ts
  // and runMigrations()'s gated drop block).
  sweepMigrationVerification();
  setInterval(sweepMigrationVerification, 24 * 60 * 60 * 1000);

  // Delta-sync: prune the outbox daily, and start the realtime dispatcher that
  // fans committed changes out to every affected user's devices.
  pruneSyncLog();
  setInterval(pruneSyncLog, 24 * 60 * 60 * 1000);
  await startSyncDispatcher();

  // Graph Layer: recompute pagerank for any workspace touched since the last
  // sweep (see graph/metrics.ts) — 5-minute cadence, same pattern as the
  // Automation Hub's schedule sweep.
  setInterval(() => { void sweepGraphMetrics(); }, 5 * 60 * 1000);

  // Knowledge Layer: (re-)chunk and embed anything content-save endpoints
  // queued (see knowledge/queue.ts's enqueueEmbedding call sites). A 2-minute
  // cadence keeps freshly-saved content searchable soon without hammering the
  // embedding provider; every step degrades gracefully when pgvector or a
  // provider key isn't configured (see knowledge/embeddingWorker.ts).
  setInterval(() => { void sweepEmbeddingQueue(); }, 2 * 60 * 1000);

  // SECURITY (S4): re-check every OPEN SSE stream against the same
  // revocation state a normal API request already re-checks on every call —
  // see sse.ts's sweepStaleSseConnections(). A 30s cadence bounds how long a
  // password change / forced logout / 2FA toggle can take to actually close
  // an already-open stream, independent of asset-ticket TTLs.
  setInterval(() => { void sweepStaleSseConnections(); }, 30 * 1000);
  setInterval(sweepExpiredAssetTickets, 5 * 60 * 1000);
  setInterval(sweepExpiredShareSessions, 5 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`Solytiq Cloud API listening on port ${PORT}`);
  });
}

start();
