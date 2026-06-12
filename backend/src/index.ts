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
import gpsRouter from './routes/gps';
import { comparePassword } from './auth';
import { query as dbQuery } from './db';
import { addSseClient, removeSseClient } from './sse';
import { verifyToken } from './auth';

const app = express();
const PORT = parseInt(process.env.PORT ?? '3001', 10);

app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

const frontendUrl = process.env.FRONTEND_URL;

app.use(cors({
  origin: frontendUrl ?? '*',
  credentials: Boolean(frontendUrl),
}));

app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(express.json({ limit: '4mb' }));

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
app.use('/api/admin/nuke', setupLimiter);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use('/api/auth',       authRouter);
app.use('/api/tasks',      tasksRouter);
app.use('/api/lists',      listsRouter);
app.use('/api/trash',      trashRouter);
app.use('/api/admin',      adminRouter);
app.use('/api/folders',    foldersRouter);
app.use('/api/files',      filesRouter);
app.use('/api/ai',         aiRouter);
app.use('/api/workspaces', workspacesRouter);
app.use('/api/gps',        gpsRouter);

// Public share endpoints — no auth required
interface ShareFileRow { id: string; original_name: string; title: string | null; mime_type: string; file_size: number; file_path: string; is_public: boolean; password_hash: string | null; expires_at: string | null; created_at: string; shared_by_name: string | null; shared_by_username: string; shared_by_image: string | null; }

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
    const filePath = path.join(path.resolve(UPLOAD_DIR), file.file_path);
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
