// ---------------------------------------------------------------------------
// Database schema migrations — extracted verbatim from index.ts so it can be
// imported (and its exported runMigrations() called) by integration tests
// against a disposable test database, without pulling in index.ts's HTTP
// server, cron sweeps, and sync dispatcher startup side effects.
//
// See CLAUDE.md's "Key Architectural Decisions" — migrations in code, not
// files: additive ALTER TABLE ... IF NOT EXISTS guards, idempotent re-run on
// every startup. index.ts's start() still calls this exact function; this
// module has NO behavior of its own beyond housing it.
// ---------------------------------------------------------------------------

import { pool, query as dbQuery } from './db';
import { backfillHardLinks } from './graph/backfill';
import { setPgvectorAvailable } from './knowledge/state';
import { backfillSectionMemory } from './quickAdd/backfill';
import { SYNC_CHANNEL } from './syncLog';
import { encryptTotpSecret, isEncryptedTotpSecret } from './totpCrypto';
import { runVersionedMigrations, VERSIONED_MIGRATIONS } from './versionedMigrations';

export async function runMigrations() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
  // FRESH-INSTALL FIX: this used to be created much further down (right
  // before entity_index's trigram index), but four gin_trgm_ops indexes are
  // created before that point was ever reached — the very first one
  // (knowledge_entries_term_trgm) crashed runMigrations() outright on a truly
  // fresh Postgres with a "operator class gin_trgm_ops does not exist"
  // error, since the extension providing it didn't exist yet. Idempotent
  // (IF NOT EXISTS) and a no-op on every already-migrated database, so
  // moving it earlier is purely additive — see objectPolicy.integration.test.ts,
  // whose beforeAll runMigrations() against a genuinely empty database is
  // what surfaced this.
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);

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

  // Audit trail for the Timeline view's per-task change markers/changelog
  // button — one row per tracked-field change (title/note/deadline/priority/
  // badge/section). Must come after `tasks` — it has a FK to tasks(id).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_change_log (
      id          BIGSERIAL PRIMARY KEY,
      task_id     BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      list_id     VARCHAR(100) NOT NULL,
      field       VARCHAR(20) NOT NULL,
      old_value   TEXT,
      new_value   TEXT,
      actor_type  VARCHAR(20) NOT NULL CHECK (actor_type IN ('user', 'automation')),
      actor_id    VARCHAR(100),
      actor_name  VARCHAR(255),
      changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS task_change_log_task_idx ON task_change_log (task_id, changed_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS task_change_log_list_idx ON task_change_log (list_id, changed_at DESC)`);

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
  // SECURITY (S3): totp_secret is now encrypted at rest (totpCrypto.ts) — the
  // encrypted-and-prefixed form is longer than a raw base32 secret ever was;
  // widen the column defensively so it can never truncate a stored value.
  await pool.query(`ALTER TABLE users ALTER COLUMN totp_secret TYPE VARCHAR(255)`);
  // Heal any pre-existing PLAINTEXT totp_secret rows (from before encryption
  // existed) in place, in the SAME transaction as their re-read so a crash
  // mid-loop can't leave a row double-encrypted or lost. Idempotent: an
  // already-`enc:v1:`-prefixed row is skipped by the WHERE clause, so a
  // second run touches zero rows.
  {
    const plaintextRows = await pool.query<{ id: string; totp_secret: string }>(
      `SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL AND totp_secret NOT LIKE 'enc:v1:%'`
    );
    for (const row of plaintextRows.rows) {
      if (isEncryptedTotpSecret(row.totp_secret)) continue; // belt-and-suspenders
      await pool.query(`UPDATE users SET totp_secret = $1 WHERE id = $2`, [encryptTotpSecret(row.totp_secret), row.id]);
    }
    if (plaintextRows.rows.length > 0) {
      console.log(`📋 migration: encrypted ${plaintextRows.rows.length} legacy plaintext totp_secret row(s) at rest`);
    }
  }

  // Feature flags
  await pool.query(`
    INSERT INTO app_settings (key, value) VALUES ('two_fa_feature_enabled', 'true')
    ON CONFLICT (key) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO app_settings (key, value) VALUES ('mcp_enabled', 'true')
    ON CONFLICT (key) DO NOTHING
  `);

  // Email notifications (Resend) — off by default until an admin configures
  // an API key + sender address from Settings → Email. The key itself is
  // never seeded here; its absence IS "not configured" (see resendClient.ts).
  await pool.query(`
    INSERT INTO app_settings (key, value) VALUES ('resend_enabled', 'false')
    ON CONFLICT (key) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO app_settings (key, value) VALUES ('resend_from_email', '')
    ON CONFLICT (key) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO app_settings (key, value) VALUES ('resend_from_name', 'Solytiq Cloud')
    ON CONFLICT (key) DO NOTHING
  `);

  // Per-user email-notification preferences (sparse overrides only — same
  // convention as keyboard_shortcuts; a type absent here falls back to
  // notifications.ts's DEFAULT_EMAIL_PREFS) and this user's own lead time for
  // meeting-reminder emails (0 = off). 30 minutes is a reasonable default —
  // long enough to still act on, short enough to stay relevant.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notification_prefs JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS meeting_reminder_lead_minutes INTEGER NOT NULL DEFAULT 30`);

  // User Invitations — admin invites a new user by email; only a SHA-256 hash
  // of the raw one-time link token is ever stored (same convention as
  // api_tokens/admin_api_keys — see userInvitations.ts). A row is "pending"
  // (still usable) exactly when accepted_at/revoked_at are both NULL and
  // expires_at is in the future; every other state (used, revoked, expired,
  // or simply a token that never existed) is deliberately indistinguishable
  // to an unauthenticated caller — see routes/auth.ts's invitation endpoints.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_invitations (
      id           VARCHAR(100) PRIMARY KEY,
      email        VARCHAR(255) NOT NULL,
      token_hash   TEXT NOT NULL UNIQUE,
      is_admin     BOOLEAN NOT NULL DEFAULT false,
      invited_by   UUID REFERENCES users(id) ON DELETE SET NULL,
      accepted_by  UUID REFERENCES users(id) ON DELETE SET NULL,
      accepted_at  TIMESTAMPTZ,
      revoked_at   TIMESTAMPTZ,
      expires_at   TIMESTAMPTZ NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_invitations_token_hash ON user_invitations(token_hash)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_invitations_email ON user_invitations(lower(email))`);

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

  // Folder public share link — a folder can be published as a read-only
  // "navigator" page at /share/folder/:token that lists the shared items
  // inside it. Same opaque-token / optional-password / optional-expiry shape
  // as list/timeline/markdown shares. `share_include_all` is the dialog choice:
  // true  = "share every item in the folder" (sharing cascades to each item),
  // false = "only items already shared individually" appear in the navigator.
  await pool.query(`ALTER TABLE folders ADD COLUMN IF NOT EXISTS share_token VARCHAR(64)`);
  await pool.query(`ALTER TABLE folders ADD COLUMN IF NOT EXISTS share_enabled BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE folders ADD COLUMN IF NOT EXISTS share_password_hash VARCHAR(255)`);
  await pool.query(`ALTER TABLE folders ADD COLUMN IF NOT EXISTS share_expires_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE folders ADD COLUMN IF NOT EXISTS share_include_all BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`CREATE INDEX IF NOT EXISTS folders_share_token_idx ON folders(share_token) WHERE share_token IS NOT NULL`);

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

  // iOS "Add to Home Screen" installs. Unlike mobile_connections, this isn't a
  // separate login flow — it's the same web session running in standalone
  // display mode. The frontend detects that (see utils/homescreen.ts) and
  // pings /api/auth/homescreen-connections/ping with a client-generated,
  // locally-persisted `install_id` so repeat opens from one Home Screen icon
  // update a single row instead of creating a new one every launch.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS homescreen_connections (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      install_id   VARCHAR(100) NOT NULL,
      device_name  VARCHAR(255) NOT NULL DEFAULT 'Home Screen App',
      os_version   VARCHAR(255),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, install_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS homescreen_connections_user_idx ON homescreen_connections(user_id)`);

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
      color       VARCHAR(50),
      color_bg    VARCHAR(50),
      is_shared   BOOLEAN NOT NULL DEFAULT FALSE,
      structure   JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Widen the color columns on instances that created this table with the old
  // VARCHAR(20) size. Those were sized for hex codes (`#5e4dbb`); colors are
  // now stored as CSS custom-property references (`var(--color-primary)`, and
  // up to `var(--color-accent-purple-light)` at 32 chars), so an insert of
  // anything but the shortest token failed with "value too long for type
  // character varying(20)" — i.e. creating/saving a template was broken.
  // Every other color column in the schema is already VARCHAR(50); these two
  // were missed when hex codes were replaced by tokens.
  await pool.query(`ALTER TABLE templates ALTER COLUMN color TYPE VARCHAR(50)`);
  await pool.query(`ALTER TABLE templates ALTER COLUMN color_bg TYPE VARCHAR(50)`);
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

  // Owner entity — which single Board/Page/Timeline an automation's editor is
  // reached from (Settings-level sidebar access was removed in favor of a
  // per-item entry point). Purely a UI/discovery anchor: workspace_id stays
  // the authoritative scope for every IDOR guard and execution check in
  // automationGraph.ts/automationTypes.ts/automationEngine.ts, none of which
  // this touches — an action that moves a task/list to another list or
  // workspace keeps working exactly as before. Nullable because a pre-existing
  // automation (from before this column existed) has no natural single owner
  // to backfill for a `schedule` trigger with no list scope — it keeps running,
  // it's just not reachable from any one Board/Page/Timeline's button anymore.
  await pool.query(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS owner_entity_type VARCHAR(20)`);
  await pool.query(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS owner_entity_id VARCHAR(100)`);
  await pool.query(`
    UPDATE automations
       SET owner_entity_type = 'list', owner_entity_id = trigger_scope->>'listId'
     WHERE owner_entity_type IS NULL AND trigger_scope->>'listId' IS NOT NULL
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS automations_owner_entity_idx ON automations (owner_entity_type, owner_entity_id)`);

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

  // ── Markdown Pages ───────────────────────────────────────────────────────
  // A block-based document type ("Markdown Page"): headings, paragraphs,
  // bulleted/numbered list items, quotes, dividers, images, links and todo
  // items authored via `/` slash commands — parallel to `lists`/`timelines`,
  // not a mode of List. `content` is a versioned JSONB block array (see
  // MarkdownListContent in frontend/src/types.ts). `todo_list_id` points at
  // an auto-managed regular `lists` row that mirrors every `/todo` block as
  // a real task — created lazily on the first todo block and kept in sync on
  // every content save (see routes/markdownLists.ts) — so the Todo summary
  // can be browsed/checked off like any other Board and folded out
  // under the Markdown Page in the Sidebar.
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
  // optional expiry). No `share_subpages` — markdown pages have no nesting.
  await pool.query(`ALTER TABLE markdown_lists ADD COLUMN IF NOT EXISTS share_token VARCHAR(64)`);
  await pool.query(`ALTER TABLE markdown_lists ADD COLUMN IF NOT EXISTS share_enabled BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE markdown_lists ADD COLUMN IF NOT EXISTS share_password_hash VARCHAR(255)`);
  await pool.query(`ALTER TABLE markdown_lists ADD COLUMN IF NOT EXISTS share_expires_at TIMESTAMPTZ`);
  await pool.query(`CREATE INDEX IF NOT EXISTS markdown_lists_share_token_idx ON markdown_lists(share_token) WHERE share_token IS NOT NULL`);

  // Per-page layout preference: when true, the in-app editor stretches its
  // content (sections/columns) to fill the whole app width instead of the
  // default centered reading column — toggled from the Appearance tab of the
  // "More settings…" dialog. See frontend/src/screens/MarkdownListScreen.tsx.
  await pool.query(`ALTER TABLE markdown_lists ADD COLUMN IF NOT EXISTS full_width BOOLEAN NOT NULL DEFAULT false`);

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

  // Generalize the image store's owner so the SAME block editor can be embedded
  // by something other than a Markdown Page (Knowledge Base entries, below).
  // Purely additive: `markdown_list_id` keeps its FK for every pre-existing row
  // and for Markdown Pages going forward — it just stops being mandatory, and
  // (owner_type, owner_id) becomes the polymorphic key the shared code reads.
  await pool.query(`ALTER TABLE markdown_list_images ADD COLUMN IF NOT EXISTS owner_type VARCHAR(24) NOT NULL DEFAULT 'markdownList'`);
  await pool.query(`ALTER TABLE markdown_list_images ADD COLUMN IF NOT EXISTS owner_id   VARCHAR(100)`);
  await pool.query(`UPDATE markdown_list_images SET owner_id = markdown_list_id WHERE owner_id IS NULL AND markdown_list_id IS NOT NULL`);
  await pool.query(`ALTER TABLE markdown_list_images ALTER COLUMN markdown_list_id DROP NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS markdown_list_images_owner_idx ON markdown_list_images(owner_type, owner_id)`);

  // ── Knowledge Base ───────────────────────────────────────────────────────────
  // A per-workspace, human-curated dictionary of the terms/concepts/people/
  // systems that workspace actually talks about — the authoritative counterpart
  // to the Knowledge LAYER (backend/src/knowledge/), which is fuzzy retrieval
  // over content written for other reasons. Rendered as a net (see
  // frontend/src/screens/KnowledgeScreen.tsx) and served to Sol/the Agent
  // Runtime/MCP as a deterministic term lookup rather than a ranked guess.
  //
  // `workspace_id UNIQUE` is what enforces "exactly one Knowledge Base per
  // workspace" — a DB constraint, not an application check that a second code
  // path could forget.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_bases (
      id           VARCHAR(100) PRIMARY KEY,
      workspace_id VARCHAR(100) NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name         VARCHAR(200) NOT NULL DEFAULT 'Knowledge',
      emoji        VARCHAR(10),
      color        VARCHAR(50),
      description  TEXT,
      version      INTEGER NOT NULL DEFAULT 1,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // An entry's body is the SAME block shape a Markdown Page uses
  // ({version:1, blocks:[]}), so the extracted BlockEditor and the existing
  // buildMarkdownBlockFromSpec validator serve both — todo-block reconciliation
  // is the one deliberate exception (a definition is not a task list).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_entries (
      id           VARCHAR(100) PRIMARY KEY,
      kb_id        VARCHAR(100) NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      term         VARCHAR(200) NOT NULL,
      aliases      TEXT[] NOT NULL DEFAULT '{}',
      entry_type   VARCHAR(24) NOT NULL DEFAULT 'concept',
      summary      VARCHAR(1000),
      content      JSONB NOT NULL DEFAULT '{"version":1,"blocks":[]}'::jsonb,
      properties   JSONB NOT NULL DEFAULT '{}'::jsonb,
      emoji        VARCHAR(10),
      color        VARCHAR(50),
      position     INTEGER NOT NULL DEFAULT 0,
      origin       VARCHAR(16) NOT NULL DEFAULT 'manual',
      version      INTEGER NOT NULL DEFAULT 1,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Case-insensitive term uniqueness per KB — "Q3 Rollout" and "q3 rollout"
  // must resolve to one entry, or the dictionary stops being deterministic.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS knowledge_entries_term_uniq ON knowledge_entries (kb_id, lower(term))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS knowledge_entries_kb_idx      ON knowledge_entries (kb_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS knowledge_entries_aliases_idx ON knowledge_entries USING gin (aliases)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS knowledge_entries_term_trgm   ON knowledge_entries USING gin (term gin_trgm_ops)`);

  // Suggest-only extraction: a scan proposes candidate terms, a human accepts
  // them. Nothing here is ever visible to the AI as knowledge until accepted —
  // an unreviewed suggestion is not a definition.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_suggestions (
      id           VARCHAR(100) PRIMARY KEY,
      kb_id        VARCHAR(100) NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      term         VARCHAR(200) NOT NULL,
      summary      VARCHAR(1000),
      entry_type   VARCHAR(24) NOT NULL DEFAULT 'concept',
      evidence     JSONB NOT NULL DEFAULT '[]'::jsonb,
      status       VARCHAR(16) NOT NULL DEFAULT 'pending',
      decided_by   UUID REFERENCES users(id) ON DELETE SET NULL,
      decided_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // One live suggestion per term per KB — re-running a scan converges instead
  // of stacking duplicates (same ON CONFLICT DO NOTHING convergence the graph
  // backfill relies on).
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS knowledge_suggestions_term_uniq ON knowledge_suggestions (kb_id, lower(term))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS knowledge_suggestions_status_idx ON knowledge_suggestions (kb_id, status)`);

  // ── AI Skills ─────────────────────────────────────────────────────────────
  // Admin-curated, instance-wide context bundles that personalize/extend Sol,
  // the Agent Runtime, and MCP clients — a SKILL.md body (markdown
  // instructions) plus optional bundled reference files, uploaded as a raw
  // .md file or a .zip (see aiSkills/bundle.ts for the zip-slip/zip-bomb
  // guards on extraction). Progressive disclosure: every ENABLED skill's
  // name+description rides in every chat's system prompt (cheap); the full
  // content/files are pulled via the read_skill/read_skill_file AI tools only
  // when a task actually matches one — mirrors how Claude's own Skill system
  // works. Reference files only — nothing here is ever executed, so this
  // stays out of the one narrow code-execution surface the app already has
  // (the Automation Hub's isolated-vm sandbox).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_skills (
      id           VARCHAR(100) PRIMARY KEY,
      name         VARCHAR(200) NOT NULL,
      slug         VARCHAR(120) NOT NULL UNIQUE,
      description  VARCHAR(500) NOT NULL DEFAULT '',
      content      TEXT NOT NULL DEFAULT '',
      enabled      BOOLEAN NOT NULL DEFAULT TRUE,
      source       VARCHAR(16) NOT NULL DEFAULT 'manual',
      origin       VARCHAR(16) NOT NULL DEFAULT 'manual',
      created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
      version      INTEGER NOT NULL DEFAULT 1,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ai_skills_enabled_idx ON ai_skills (enabled)`);
  // Widen description — real SKILL.md frontmatter (mirroring Claude's own skill
  // format) routinely runs 800-1200+ chars enumerating trigger conditions; the
  // original 500-char cap rejected legitimate uploads with a raw DB error.
  await pool.query(`ALTER TABLE ai_skills ALTER COLUMN description TYPE VARCHAR(2000)`);

  // A skill's supporting reference files (e.g. a bundled checklist or style
  // guide alongside SKILL.md), text-only — see bundle.ts's extraction allow-list.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_skill_files (
      id           VARCHAR(100) PRIMARY KEY,
      skill_id     VARCHAR(100) NOT NULL REFERENCES ai_skills(id) ON DELETE CASCADE,
      file_path    VARCHAR(500) NOT NULL,
      content      TEXT NOT NULL DEFAULT '',
      size_bytes   INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ai_skill_files_path_uniq ON ai_skill_files (skill_id, file_path)`);

  // ── User Notification System ─────────────────────────────────────────────────
  // A single general-purpose per-recipient notification feed (bell in the
  // TopBar + Dashboard feed). Written only through backend/src/notifications.ts
  // (createNotification), read/managed via routes/notifications.ts. `dedupe_key`
  // (optional) makes a notification idempotent per recipient — the overdue
  // deadline sweep uses it to alert exactly once per task. An AFTER-INSERT
  // sync_log trigger (below) pushes a `notification` signal to the recipient so
  // the bell updates live over the existing SSE pipeline.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id           VARCHAR(100) PRIMARY KEY,
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type         VARCHAR(50) NOT NULL,
      actor_id     UUID REFERENCES users(id) ON DELETE SET NULL,
      title        TEXT NOT NULL,
      body         TEXT,
      entity_type  VARCHAR(50),
      entity_id    VARCHAR(100),
      workspace_id VARCHAR(100),
      data         JSONB NOT NULL DEFAULT '{}'::jsonb,
      dedupe_key   VARCHAR(200),
      read_at      TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications (user_id) WHERE read_at IS NULL`);
  // Partial-unique dedupe: ON CONFLICT (user_id, dedupe_key) DO NOTHING relies
  // on this. NULL dedupe_key rows never collide (multiple NULLs are allowed).
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_idx ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL`);

  // Additional users tagged onto an item (task). The item's creator is the
  // implicit owner (shown in the dialog's Tag row, never stored here); this
  // table holds only the EXTRA tagged users. FK to tasks(id) so a deleted task
  // cleans up its tags automatically.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_tags (
      task_id    BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id    UUID   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tagged_by  UUID   REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (task_id, user_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS task_tags_user_idx ON task_tags (user_id)`);

  // Per-item invitations ("Shared with me") — grants one user full-collaborator
  // access to a single folder/list/timeline/markdown page, independent of
  // workspace membership. Polymorphic (item_type + item_id), so no FK on
  // item_id; the item's delete path removes its shares via deleteItemShares().
  await pool.query(`
    CREATE TABLE IF NOT EXISTS item_shares (
      item_type   VARCHAR(20) NOT NULL,
      item_id     VARCHAR(100) NOT NULL,
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invited_by  UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (item_type, item_id, user_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS item_shares_user_idx ON item_shares (user_id, item_type)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS item_shares_item_idx ON item_shares (item_type, item_id)`);
  // Folder invites only: does this person get the folder's CONTENTS too, or
  // just the folder itself? Mirrors `folders.share_include_all`, which already
  // draws exactly this distinction for the public share link, so the two
  // sharing mechanisms stay conceptually the same shape. Defaults to true —
  // handing over the contents is the point of sharing a folder, and it is the
  // behaviour every existing row was created under.
  // MUST be added before item_share_grants_list() below: a LANGUAGE sql body is
  // validated at CREATE time, and that body reads this column.
  await pool.query(`ALTER TABLE item_shares ADD COLUMN IF NOT EXISTS include_all BOOLEAN NOT NULL DEFAULT true`);
  // Resolving a folder cascade means matching a share against an item's
  // `folder_id`; without these the check degrades to a seq scan on every
  // access-condition evaluation.
  await pool.query(`CREATE INDEX IF NOT EXISTS lists_folder_idx          ON lists          (folder_id) WHERE folder_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS timelines_folder_idx      ON timelines      (folder_id) WHERE folder_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS markdown_lists_folder_idx ON markdown_lists (folder_id) WHERE folder_id IS NOT NULL`);

  // The list half of the item-share cascade (see backend/src/itemShares.ts's
  // header for the full containment model). A list is reachable when the
  // caller was invited to it, to the folder it sits in, to the markdown page
  // whose auto-managed Todo mirror it is, or to ANY of its ancestor lists —
  // sublists nest arbitrarily deep, so this walks up `parent_task_id` → the
  // owning task → that task's list until it runs out of parents.
  //
  // It lives in the database rather than in `itemShareExists`'s generated SQL
  // because PostgreSQL does not allow a `WITH RECURSIVE` inside a subquery to
  // reference the outer row, and because a single definition is what keeps the
  // 20+ access-condition call sites from each re-deriving the recursion. STABLE
  // (not VOLATILE) so the planner may cache it within a statement.
  //
  // The depth cap is a cycle guard, not a product limit: `lists.parent_task_id`
  // is application-maintained, and a corrupted cycle must fail closed with a
  // bounded query rather than spin.
  await pool.query(`
    CREATE OR REPLACE FUNCTION item_share_grants_list(p_user UUID, p_list_id VARCHAR)
    RETURNS BOOLEAN
    LANGUAGE sql STABLE AS $fn$
      WITH RECURSIVE anc(list_id, folder_id, parent_task_id, lvl) AS (
        SELECT l.id, l.folder_id, l.parent_task_id, 0
          FROM lists l
         WHERE l.id = p_list_id
        UNION ALL
        SELECT pl.id, pl.folder_id, pl.parent_task_id, anc.lvl + 1
          FROM anc
          JOIN tasks pt ON pt.id = anc.parent_task_id
          JOIN lists pl ON pl.id = pt.list_id
         WHERE anc.lvl < 16
      )
      SELECT EXISTS (
        SELECT 1 FROM anc
         WHERE EXISTS (
                 SELECT 1 FROM item_shares s
                  WHERE s.user_id = p_user
                    AND ((s.item_type = 'list'   AND s.item_id = anc.list_id)
                      OR (s.item_type = 'folder' AND s.item_id = anc.folder_id AND s.include_all))
               )
            OR EXISTS (
                 SELECT 1 FROM markdown_lists m
                  JOIN item_shares s2
                    ON s2.user_id = p_user
                   AND ((s2.item_type = 'markdownList' AND s2.item_id = m.id)
                     OR (s2.item_type = 'folder'       AND s2.item_id = m.folder_id AND s2.include_all))
                  WHERE m.todo_list_id = anc.list_id
               )
      );
    $fn$
  `);

  // Supports the hourly overdue-deadline sweep's `WHERE checked = false AND deadline < CURRENT_DATE`.
  await pool.query(`CREATE INDEX IF NOT EXISTS tasks_open_deadline_idx ON tasks (deadline) WHERE checked = false AND deadline IS NOT NULL`);

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
  // Notifications are user-global (workspace_id NULL, owner_id = recipient) so
  // the delta endpoint's `(workspace_id IS NULL AND owner_id = reader)` filter
  // delivers a `notification` signal to exactly the recipient's own devices.
  await pool.query(`
    CREATE OR REPLACE FUNCTION trg_synclog_notifications() RETURNS trigger AS $$
    BEGIN
      IF (TG_OP = 'DELETE') THEN PERFORM sync_emit('notification', OLD.id, 'delete', NULL, OLD.user_id); RETURN OLD; END IF;
      PERFORM sync_emit('notification', NEW.id, 'upsert', NULL, NEW.user_id); RETURN NEW;
    END; $$ LANGUAGE plpgsql
  `);

  // The Knowledge Base emits ONE signal entity for both the base and its
  // entries — a KB is small (tens-to-hundreds of entries) and the screen loads
  // it as a single graph payload anyway, so splitting into two signals would
  // buy a second refetch path for no benefit. Entries have no workspace of
  // their own, so the trigger resolves it through the parent base, exactly like
  // trg_synclog_sections resolves through its parent list.
  await pool.query(`
    CREATE OR REPLACE FUNCTION trg_synclog_knowledge_bases() RETURNS trigger AS $$
    BEGIN
      IF (TG_OP = 'DELETE') THEN PERFORM sync_emit('knowledgeBase', OLD.id, 'delete', OLD.workspace_id, OLD.user_id); RETURN OLD; END IF;
      PERFORM sync_emit('knowledgeBase', NEW.id, 'upsert', NEW.workspace_id, NEW.user_id); RETURN NEW;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION trg_synclog_knowledge_entries() RETURNS trigger AS $$
    DECLARE v_kb text; v_ws text; v_owner uuid;
    BEGIN
      IF (TG_OP = 'DELETE') THEN v_kb := OLD.kb_id; ELSE v_kb := NEW.kb_id; END IF;
      SELECT workspace_id, user_id INTO v_ws, v_owner FROM knowledge_bases WHERE id = v_kb;
      IF v_owner IS NOT NULL THEN PERFORM sync_emit('knowledgeBase', v_kb, 'upsert', v_ws, v_owner); END IF;
      IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
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
    ['notifications', 'notifications'],
    ['knowledge_bases', 'knowledge_bases'], ['knowledge_entries', 'knowledge_entries'],
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

  // Per-list layout preference — the Board screen's List/Kanban/Timeline tab switcher.
  // Persisted (not just local UI state) so it's the same on every device.
  await pool.query(`ALTER TABLE lists ADD COLUMN IF NOT EXISTS view_mode VARCHAR(20) NOT NULL DEFAULT 'list'`);

  // Independent override for which layout the *public share page* renders —
  // lets an owner share a Kanban/Timeline view of a list they're currently
  // browsing as a plain List (or vice versa). NULL falls back to the list's
  // own `view_mode` at read time (see resolveListViewMode in the share routes).
  await pool.query(`ALTER TABLE lists ADD COLUMN IF NOT EXISTS share_view_mode VARCHAR(20)`);

  // Tracks exactly when a task was checked, independent of updated_at (which
  // also moves on unrelated edits made after completion) — the Timeline view's
  // bars need a stable, accurate completion point. Back-fill existing checked
  // tasks with their best-known approximation once, idempotently.
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
  await pool.query(`UPDATE tasks SET completed_at = updated_at WHERE checked = true AND completed_at IS NULL`);

  // ── Graph Layer: entity_index (canonical node registry) ────────────────────
  // See CLAUDE.md's "Graph Layer" section. `entity_index` is a denormalized,
  // trigger-maintained registry of every linkable entity across 10 source
  // tables, keyed by (entity_type, entity_id) — entity_id is always the id AS
  // A STRING (tasks.id is BIGINT; everything else is already VARCHAR), which
  // is what lets entity_links carry a real composite FK despite the
  // ID-type heterogeneity. Read ONLY through backend/src/graph/entityIndex.ts
  // (scoped via graph/visibility.ts) — never query it directly from a route.
  // (pg_trgm itself is created much earlier now, right after pgcrypto — see
  // the fresh-install ordering fix noted there.)

  // meetings/shared_files/gps_files previously had no workspace_id — they hung
  // off user_id alone. A graph node needs a workspace to decide visibility, so
  // add it here (nullable, `SET NULL` — matching every other content table's
  // FK behavior, NOT the workspace-delete cascade) and heal existing rows into
  // their owner's Personal workspace, same pattern as the lists/folders/tasks
  // heal above.
  await pool.query(`ALTER TABLE meetings     ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(100) REFERENCES workspaces(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE shared_files ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(100) REFERENCES workspaces(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE gps_files    ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(100) REFERENCES workspaces(id) ON DELETE SET NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS meetings_workspace_idx     ON meetings(workspace_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS shared_files_workspace_idx ON shared_files(workspace_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS gps_files_workspace_idx    ON gps_files(workspace_id)`);
  await pool.query(`
    UPDATE meetings m SET workspace_id = (SELECT w.id FROM workspaces w WHERE w.owner_id = m.user_id ORDER BY w.created_at ASC LIMIT 1)
    WHERE m.workspace_id IS NULL
  `);
  await pool.query(`
    UPDATE shared_files f SET workspace_id = (SELECT w.id FROM workspaces w WHERE w.owner_id = f.user_id ORDER BY w.created_at ASC LIMIT 1)
    WHERE f.workspace_id IS NULL
  `);
  await pool.query(`
    UPDATE gps_files g SET workspace_id = (SELECT w.id FROM workspaces w WHERE w.owner_id = g.user_id ORDER BY w.created_at ASC LIMIT 1)
    WHERE g.workspace_id IS NULL
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS entity_index (
      entity_type   VARCHAR(24)  NOT NULL,
      entity_id     VARCHAR(100) NOT NULL,
      workspace_id  VARCHAR(100) REFERENCES workspaces(id) ON DELETE SET NULL,
      owner_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title         VARCHAR(1000) NOT NULL DEFAULT '',
      emoji         VARCHAR(10),
      color         VARCHAR(50),
      subtitle      VARCHAR(500),
      status        VARCHAR(24),
      is_archived   BOOLEAN NOT NULL DEFAULT false,
      is_trashed    BOOLEAN NOT NULL DEFAULT false,
      deep_link     VARCHAR(500),
      entity_created_at TIMESTAMPTZ,
      entity_updated_at TIMESTAMPTZ,
      indexed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (entity_type, entity_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_entity_index_ws    ON entity_index (workspace_id) WHERE is_trashed = false`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_entity_index_owner ON entity_index (owner_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_entity_index_type  ON entity_index (entity_type, workspace_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_entity_index_title ON entity_index USING gin (title gin_trgm_ops)`);

  // Generic per-row sync function, bound to 8 of the 10 source tables via a
  // trigger argument (`sync_entity_index('task')` etc.) — each CASE branch
  // only ever runs for the table it was bound to, so referencing a column
  // another table doesn't have (e.g. NEW.checked when NEW is a `folders` row)
  // is never actually evaluated. `sections` and `milestones` need their own
  // variants below because their workspace/owner must be resolved via a join
  // to their parent list/timeline — they have no such columns of their own.
  await pool.query(`
    CREATE OR REPLACE FUNCTION sync_entity_index() RETURNS TRIGGER AS $$
    DECLARE
      v_type       VARCHAR(24) := TG_ARGV[0];
      v_id         VARCHAR(100);
      v_title      VARCHAR(1000);
      v_ws         VARCHAR(100);
      v_owner      UUID;
      v_status     VARCHAR(24);
      v_deep_link  VARCHAR(500);
      v_archived   BOOLEAN := false;
    BEGIN
      IF (TG_OP = 'DELETE') THEN
        DELETE FROM entity_index WHERE entity_type = v_type AND entity_id = OLD.id::text;
        RETURN OLD;
      END IF;

      v_id := NEW.id::text;

      CASE v_type
        WHEN 'task' THEN
          v_title := NEW.title; v_ws := NEW.workspace_id; v_owner := NEW.user_id;
          v_status := CASE WHEN NEW.checked THEN 'done' ELSE 'open' END;
        WHEN 'list' THEN
          v_title := NEW.name; v_ws := NEW.workspace_id; v_owner := NEW.user_id;
          v_deep_link := '/list/' || v_id; v_archived := NEW.is_archived;
        WHEN 'markdownList' THEN
          v_title := NEW.name; v_ws := NEW.workspace_id; v_owner := NEW.user_id;
          v_deep_link := '/markdown-list/' || v_id;
        WHEN 'timeline' THEN
          v_title := NEW.name; v_ws := NEW.workspace_id; v_owner := NEW.user_id;
          v_deep_link := '/timeline/' || v_id;
        WHEN 'meeting' THEN
          v_title := NEW.title; v_ws := NEW.workspace_id; v_owner := NEW.user_id;
        WHEN 'folder' THEN
          v_title := NEW.name; v_ws := NEW.workspace_id; v_owner := NEW.user_id;
          v_deep_link := '/folder/' || v_id;
        WHEN 'file' THEN
          v_title := COALESCE(NEW.title, NEW.original_name); v_ws := NEW.workspace_id; v_owner := NEW.user_id;
        WHEN 'gpsFile' THEN
          v_title := NEW.original_name; v_ws := NEW.workspace_id; v_owner := NEW.user_id;
          v_deep_link := '/gps/' || v_id || '/edit';
        WHEN 'knowledgeBase' THEN
          v_title := NEW.name; v_ws := NEW.workspace_id; v_owner := NEW.user_id;
          v_deep_link := '/knowledge';
        ELSE
          RETURN NEW;
      END CASE;

      INSERT INTO entity_index (entity_type, entity_id, workspace_id, owner_id, title, status,
                                deep_link, is_archived, entity_created_at, entity_updated_at, indexed_at)
      VALUES (v_type, v_id, v_ws, v_owner, COALESCE(v_title, ''), v_status, v_deep_link, v_archived,
              NEW.created_at, NOW(), NOW())
      ON CONFLICT (entity_type, entity_id) DO UPDATE
        SET workspace_id = EXCLUDED.workspace_id,
            owner_id     = EXCLUDED.owner_id,
            title        = EXCLUDED.title,
            status       = EXCLUDED.status,
            deep_link    = EXCLUDED.deep_link,
            is_archived  = EXCLUDED.is_archived,
            entity_updated_at = NOW(),
            indexed_at   = NOW();
      RETURN NEW;
    END; $$ LANGUAGE plpgsql
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION sync_entity_index_section() RETURNS TRIGGER AS $$
    DECLARE v_ws VARCHAR(100); v_owner UUID;
    BEGIN
      IF (TG_OP = 'DELETE') THEN
        DELETE FROM entity_index WHERE entity_type = 'section' AND entity_id = OLD.id;
        RETURN OLD;
      END IF;
      SELECT l.workspace_id, l.user_id INTO v_ws, v_owner FROM lists l WHERE l.id = NEW.list_id;
      IF v_owner IS NULL THEN RETURN NEW; END IF;
      INSERT INTO entity_index (entity_type, entity_id, workspace_id, owner_id, title, entity_updated_at, indexed_at)
      VALUES ('section', NEW.id, v_ws, v_owner, COALESCE(NEW.label, ''), NOW(), NOW())
      ON CONFLICT (entity_type, entity_id) DO UPDATE
        SET workspace_id = EXCLUDED.workspace_id, owner_id = EXCLUDED.owner_id, title = EXCLUDED.title,
            entity_updated_at = NOW(), indexed_at = NOW();
      RETURN NEW;
    END; $$ LANGUAGE plpgsql
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION sync_entity_index_milestone() RETURNS TRIGGER AS $$
    DECLARE v_ws VARCHAR(100); v_owner UUID;
    BEGIN
      IF (TG_OP = 'DELETE') THEN
        DELETE FROM entity_index WHERE entity_type = 'milestone' AND entity_id = OLD.id;
        RETURN OLD;
      END IF;
      SELECT t.workspace_id, t.user_id INTO v_ws, v_owner FROM timelines t WHERE t.id = NEW.timeline_id;
      IF v_owner IS NULL THEN RETURN NEW; END IF;
      INSERT INTO entity_index (entity_type, entity_id, workspace_id, owner_id, title, status, deep_link,
                                entity_created_at, entity_updated_at, indexed_at)
      VALUES ('milestone', NEW.id, v_ws, v_owner, COALESCE(NEW.title, ''), NEW.status,
              '/timeline/' || NEW.timeline_id, NEW.created_at, NOW(), NOW())
      ON CONFLICT (entity_type, entity_id) DO UPDATE
        SET workspace_id = EXCLUDED.workspace_id, owner_id = EXCLUDED.owner_id, title = EXCLUDED.title,
            status = EXCLUDED.status, deep_link = EXCLUDED.deep_link, entity_updated_at = NOW(), indexed_at = NOW();
      RETURN NEW;
    END; $$ LANGUAGE plpgsql
  `);

  // A Knowledge Base entry, like sections/milestones, carries no workspace of
  // its own — it inherits the one its parent Knowledge Base is pinned to. The
  // indexed title is the TERM (that's what a lookup resolves against) and the
  // subtitle is the one-line summary, so entity search and the Net tooltip both
  // show a usable definition without loading the entry body.
  await pool.query(`
    CREATE OR REPLACE FUNCTION sync_entity_index_knowledge_entry() RETURNS TRIGGER AS $$
    DECLARE v_ws VARCHAR(100); v_owner UUID;
    BEGIN
      IF (TG_OP = 'DELETE') THEN
        DELETE FROM entity_index WHERE entity_type = 'knowledgeEntry' AND entity_id = OLD.id;
        RETURN OLD;
      END IF;
      SELECT kb.workspace_id, kb.user_id INTO v_ws, v_owner FROM knowledge_bases kb WHERE kb.id = NEW.kb_id;
      IF v_owner IS NULL THEN RETURN NEW; END IF;
      INSERT INTO entity_index (entity_type, entity_id, workspace_id, owner_id, title, emoji, color, subtitle,
                                deep_link, entity_created_at, entity_updated_at, indexed_at)
      VALUES ('knowledgeEntry', NEW.id, v_ws, v_owner, COALESCE(NEW.term, ''), NEW.emoji, NEW.color, NEW.summary,
              '/knowledge?entry=' || NEW.id, NEW.created_at, NOW(), NOW())
      ON CONFLICT (entity_type, entity_id) DO UPDATE
        SET workspace_id = EXCLUDED.workspace_id, owner_id = EXCLUDED.owner_id, title = EXCLUDED.title,
            emoji = EXCLUDED.emoji, color = EXCLUDED.color, subtitle = EXCLUDED.subtitle,
            deep_link = EXCLUDED.deep_link, entity_updated_at = NOW(), indexed_at = NOW();
      RETURN NEW;
    END; $$ LANGUAGE plpgsql
  `);

  {
    const directEntityIndexTriggers: Array<[string, string]> = [
      ['tasks', 'task'], ['lists', 'list'], ['markdown_lists', 'markdownList'],
      ['timelines', 'timeline'], ['meetings', 'meeting'], ['folders', 'folder'],
      ['shared_files', 'file'], ['gps_files', 'gpsFile'], ['knowledge_bases', 'knowledgeBase'],
    ];
    for (const [table, type] of directEntityIndexTriggers) {
      await pool.query(`DROP TRIGGER IF EXISTS entity_index_${table} ON ${table}`);
      await pool.query(
        `CREATE TRIGGER entity_index_${table} AFTER INSERT OR UPDATE OR DELETE ON ${table}
         FOR EACH ROW EXECUTE FUNCTION sync_entity_index('${type}')`
      );
    }
    await pool.query(`DROP TRIGGER IF EXISTS entity_index_sections ON sections`);
    await pool.query(`
      CREATE TRIGGER entity_index_sections AFTER INSERT OR UPDATE OR DELETE ON sections
        FOR EACH ROW EXECUTE FUNCTION sync_entity_index_section()
    `);
    await pool.query(`DROP TRIGGER IF EXISTS entity_index_milestones ON milestones`);
    await pool.query(`
      CREATE TRIGGER entity_index_milestones AFTER INSERT OR UPDATE OR DELETE ON milestones
        FOR EACH ROW EXECUTE FUNCTION sync_entity_index_milestone()
    `);
    await pool.query(`DROP TRIGGER IF EXISTS entity_index_knowledge_entries ON knowledge_entries`);
    await pool.query(`
      CREATE TRIGGER entity_index_knowledge_entries AFTER INSERT OR UPDATE OR DELETE ON knowledge_entries
        FOR EACH ROW EXECUTE FUNCTION sync_entity_index_knowledge_entry()
    `);
  }

  // One-time backfill of every pre-existing row, guarded by an app_settings
  // marker so it doesn't rescan all 10 tables on every restart (the triggers
  // above cover everything going forward).
  {
    const marker = await pool.query(`SELECT 1 FROM app_settings WHERE key = 'entity_index_backfilled_v1'`);
    if (marker.rows.length === 0) {
      await pool.query(`
        INSERT INTO entity_index (entity_type, entity_id, workspace_id, owner_id, title, status, entity_created_at, entity_updated_at, indexed_at)
        SELECT 'task', id::text, workspace_id, user_id, title, CASE WHEN checked THEN 'done' ELSE 'open' END, created_at, NOW(), NOW() FROM tasks
        ON CONFLICT (entity_type, entity_id) DO NOTHING
      `);
      await pool.query(`
        INSERT INTO entity_index (entity_type, entity_id, workspace_id, owner_id, title, emoji, color, subtitle, is_archived, deep_link, entity_created_at, entity_updated_at, indexed_at)
        SELECT 'list', id, workspace_id, user_id, name, emoji, color, subtitle, is_archived, '/list/' || id, created_at, NOW(), NOW() FROM lists
        ON CONFLICT (entity_type, entity_id) DO NOTHING
      `);
      await pool.query(`
        INSERT INTO entity_index (entity_type, entity_id, workspace_id, owner_id, title, emoji, color, subtitle, deep_link, entity_created_at, entity_updated_at, indexed_at)
        SELECT 'markdownList', id, workspace_id, user_id, name, emoji, color, subtitle, '/markdown-list/' || id, created_at, NOW(), NOW() FROM markdown_lists
        ON CONFLICT (entity_type, entity_id) DO NOTHING
      `);
      await pool.query(`
        INSERT INTO entity_index (entity_type, entity_id, workspace_id, owner_id, title, emoji, color, subtitle, deep_link, entity_created_at, entity_updated_at, indexed_at)
        SELECT 'timeline', id, workspace_id, user_id, name, emoji, color, subtitle, '/timeline/' || id, created_at, NOW(), NOW() FROM timelines
        ON CONFLICT (entity_type, entity_id) DO NOTHING
      `);
      await pool.query(`
        INSERT INTO entity_index (entity_type, entity_id, workspace_id, owner_id, title, color, entity_created_at, entity_updated_at, indexed_at)
        SELECT 'meeting', id, workspace_id, user_id, title, color, created_at, NOW(), NOW() FROM meetings
        ON CONFLICT (entity_type, entity_id) DO NOTHING
      `);
      await pool.query(`
        INSERT INTO entity_index (entity_type, entity_id, workspace_id, owner_id, title, emoji, color, deep_link, entity_created_at, entity_updated_at, indexed_at)
        SELECT 'folder', id, workspace_id, user_id, name, emoji, color, '/folder/' || id, created_at, NOW(), NOW() FROM folders
        ON CONFLICT (entity_type, entity_id) DO NOTHING
      `);
      await pool.query(`
        INSERT INTO entity_index (entity_type, entity_id, workspace_id, owner_id, title, entity_created_at, entity_updated_at, indexed_at)
        SELECT 'file', id, workspace_id, user_id, COALESCE(title, original_name), created_at, NOW(), NOW() FROM shared_files
        ON CONFLICT (entity_type, entity_id) DO NOTHING
      `);
      await pool.query(`
        INSERT INTO entity_index (entity_type, entity_id, workspace_id, owner_id, title, deep_link, entity_created_at, entity_updated_at, indexed_at)
        SELECT 'gpsFile', id, workspace_id, user_id, original_name, '/gps/' || id || '/edit', created_at, NOW(), NOW() FROM gps_files
        ON CONFLICT (entity_type, entity_id) DO NOTHING
      `);
      await pool.query(`
        INSERT INTO entity_index (entity_type, entity_id, workspace_id, owner_id, title, status, deep_link, entity_created_at, entity_updated_at, indexed_at)
        SELECT 'milestone', ms.id, tl.workspace_id, tl.user_id, ms.title, ms.status, '/timeline/' || tl.id, ms.created_at, NOW(), NOW()
          FROM milestones ms JOIN timelines tl ON tl.id = ms.timeline_id
        ON CONFLICT (entity_type, entity_id) DO NOTHING
      `);
      await pool.query(`
        INSERT INTO entity_index (entity_type, entity_id, workspace_id, owner_id, title, entity_updated_at, indexed_at)
        SELECT 'section', s.id, l.workspace_id, l.user_id, s.label, NOW(), NOW()
          FROM sections s JOIN lists l ON l.id = s.list_id
        ON CONFLICT (entity_type, entity_id) DO NOTHING
      `);
      await pool.query(`INSERT INTO app_settings (key, value) VALUES ('entity_index_backfilled_v1', 'true') ON CONFLICT (key) DO NOTHING`);
      console.log('📋 migration: entity_index backfilled from all 10 source tables');
    }
  }

  // ── Graph Layer: entity_links (edges) + workspace_link_types ───────────────
  // See CLAUDE.md's "Graph Layer" section. Query ONLY through
  // backend/src/graph/links.ts — never directly from a route.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workspace_link_types (
      id            VARCHAR(100) PRIMARY KEY,
      workspace_id  VARCHAR(100) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      key           VARCHAR(40)  NOT NULL,
      label         VARCHAR(80)  NOT NULL,
      inverse_key   VARCHAR(40)  NOT NULL,
      inverse_label VARCHAR(80)  NOT NULL,
      is_symmetric  BOOLEAN NOT NULL DEFAULT false,
      color         VARCHAR(50),
      edge_style    VARCHAR(12) NOT NULL DEFAULT 'solid' CHECK (edge_style IN ('solid','dashed','dotted')),
      allowed_src   TEXT[] NOT NULL DEFAULT '{}',
      allowed_dst   TEXT[] NOT NULL DEFAULT '{}',
      created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (workspace_id, key)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS entity_links (
      id            VARCHAR(100) PRIMARY KEY,
      workspace_id  VARCHAR(100) REFERENCES workspaces(id) ON DELETE SET NULL,
      src_type      VARCHAR(24)  NOT NULL,
      src_id        VARCHAR(100) NOT NULL,
      dst_type      VARCHAR(24)  NOT NULL,
      dst_id        VARCHAR(100) NOT NULL,
      link_type     VARCHAR(40)  NOT NULL,
      origin        VARCHAR(16)  NOT NULL DEFAULT 'manual'
                      CHECK (origin IN ('manual','inline','system','automation','agent')),
      source_block_id VARCHAR(100),
      props         JSONB NOT NULL DEFAULT '{}'::jsonb,
      weight        REAL  NOT NULL DEFAULT 1.0,
      is_cross_workspace BOOLEAN NOT NULL DEFAULT false,
      created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_link_src FOREIGN KEY (src_type, src_id) REFERENCES entity_index (entity_type, entity_id) ON DELETE CASCADE,
      CONSTRAINT fk_link_dst FOREIGN KEY (dst_type, dst_id) REFERENCES entity_index (entity_type, entity_id) ON DELETE CASCADE,
      CONSTRAINT chk_no_self_loop CHECK (NOT (src_type = dst_type AND src_id = dst_id))
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_links
      ON entity_links (src_type, src_id, dst_type, dst_id, link_type, COALESCE(source_block_id, ''))
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_links_src    ON entity_links (src_type, src_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_links_dst    ON entity_links (dst_type, dst_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_links_ws     ON entity_links (workspace_id, link_type)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_links_origin ON entity_links (origin) WHERE origin = 'inline'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_links_props  ON entity_links USING gin (props)`);

  // Symmetric-type canonical ordering (so A↔B never stores as two rows) +
  // `is_cross_workspace` — both computed server-side on every write so the
  // application layer (graph/links.ts) never has to get this right itself.
  await pool.query(`
    CREATE OR REPLACE FUNCTION enforce_symmetric_order() RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.link_type = 'relates_to' OR EXISTS (
        SELECT 1 FROM workspace_link_types wlt WHERE wlt.key = NEW.link_type AND wlt.is_symmetric = true
      ) THEN
        IF (NEW.src_type, NEW.src_id) > (NEW.dst_type, NEW.dst_id) THEN
          SELECT NEW.dst_type, NEW.dst_id, NEW.src_type, NEW.src_id
            INTO NEW.src_type, NEW.src_id, NEW.dst_type, NEW.dst_id;
        END IF;
      END IF;
      NEW.is_cross_workspace := (
        SELECT COUNT(DISTINCT workspace_id) > 1 FROM entity_index
         WHERE (entity_type, entity_id) IN ((NEW.src_type, NEW.src_id), (NEW.dst_type, NEW.dst_id))
      );
      RETURN NEW;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`DROP TRIGGER IF EXISTS trg_links_normalize ON entity_links`);
  await pool.query(`
    CREATE TRIGGER trg_links_normalize BEFORE INSERT OR UPDATE ON entity_links
      FOR EACH ROW EXECUTE FUNCTION enforce_symmetric_order()
  `);

  // sync_log wiring — a 'link' signal (see routes/sync.ts SIGNAL_ENTITIES and
  // syncLog.ts's SyncEntity union) so a future graph UI can refetch on edge
  // changes. Guarded on created_by IS NOT NULL: system-origin backfill rows
  // may have no attributable actor, and sync_log.owner_id is NOT NULL.
  await pool.query(`
    CREATE OR REPLACE FUNCTION trg_synclog_entity_links() RETURNS trigger AS $$
    DECLARE v_owner uuid; v_ws text; v_id text; v_op text;
    BEGIN
      IF (TG_OP = 'DELETE') THEN v_owner := OLD.created_by; v_ws := OLD.workspace_id; v_id := OLD.id; v_op := 'delete';
      ELSE v_owner := NEW.created_by; v_ws := NEW.workspace_id; v_id := NEW.id; v_op := 'upsert'; END IF;
      IF v_owner IS NOT NULL THEN PERFORM sync_emit('link', v_id, v_op, v_ws, v_owner); END IF;
      IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`DROP TRIGGER IF EXISTS synclog_entity_links ON entity_links`);
  await pool.query(`
    CREATE TRIGGER synclog_entity_links AFTER INSERT OR UPDATE OR DELETE ON entity_links
      FOR EACH ROW EXECUTE FUNCTION trg_synclog_entity_links()
  `);

  // Backfill the 5 pre-existing hard-link mechanisms as real entity_links rows
  // (`origin = 'system'`) — Phase R1 of the rolling refactor. Idempotent
  // (ON CONFLICT DO NOTHING against uq_entity_links), so this runs on every
  // startup and converges to zero new rows after the first. Must run after
  // entity_index is fully populated (both endpoints of every backfilled edge
  // need an entity_index row already, or the composite FK rejects the insert).
  await backfillHardLinks(dbQuery);

  // ── Graph Layer: entity_graph_metrics (degree/pagerank/community) ──────────
  // degree_in/degree_out are maintained incrementally by a trigger on every
  // entity_links write (cheap, exact). pagerank is a debounced batch job — see
  // graph/metrics.ts — so it starts at 0 until the first sweep.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entity_graph_metrics (
      entity_type   VARCHAR(24)  NOT NULL,
      entity_id     VARCHAR(100) NOT NULL,
      workspace_id  VARCHAR(100),
      degree_in     INTEGER NOT NULL DEFAULT 0,
      degree_out    INTEGER NOT NULL DEFAULT 0,
      pagerank      REAL    NOT NULL DEFAULT 0,
      community_id  INTEGER,
      computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (entity_type, entity_id),
      CONSTRAINT fk_metrics_entity FOREIGN KEY (entity_type, entity_id)
        REFERENCES entity_index (entity_type, entity_id) ON DELETE CASCADE
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_metrics_ws_rank ON entity_graph_metrics (workspace_id, pagerank DESC)`);

  await pool.query(`
    CREATE OR REPLACE FUNCTION update_link_degree() RETURNS TRIGGER AS $$
    BEGIN
      IF (TG_OP = 'INSERT') THEN
        INSERT INTO entity_graph_metrics (entity_type, entity_id, workspace_id, degree_out)
        VALUES (NEW.src_type, NEW.src_id, NEW.workspace_id, 1)
        ON CONFLICT (entity_type, entity_id) DO UPDATE SET degree_out = entity_graph_metrics.degree_out + 1;
        INSERT INTO entity_graph_metrics (entity_type, entity_id, workspace_id, degree_in)
        VALUES (NEW.dst_type, NEW.dst_id, NEW.workspace_id, 1)
        ON CONFLICT (entity_type, entity_id) DO UPDATE SET degree_in = entity_graph_metrics.degree_in + 1;
        RETURN NEW;
      ELSIF (TG_OP = 'DELETE') THEN
        UPDATE entity_graph_metrics SET degree_out = GREATEST(degree_out - 1, 0) WHERE entity_type = OLD.src_type AND entity_id = OLD.src_id;
        UPDATE entity_graph_metrics SET degree_in = GREATEST(degree_in - 1, 0) WHERE entity_type = OLD.dst_type AND entity_id = OLD.dst_id;
        RETURN OLD;
      END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`DROP TRIGGER IF EXISTS trg_link_degree ON entity_links`);
  await pool.query(`
    CREATE TRIGGER trg_link_degree AFTER INSERT OR DELETE ON entity_links
      FOR EACH ROW EXECUTE FUNCTION update_link_degree()
  `);

  // ── Graph Layer: canvases (curated, editable graph layouts) ────────────────
  // `layout` stores ONLY positions/groups/free-text notes — the edges are
  // always real entity_links rows created via POST /api/links when the user
  // drags a connection, never a drawn-only line. See CLAUDE.md's Graph Layer
  // section and routes/canvases.ts.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS graph_canvases (
      id           VARCHAR(100) PRIMARY KEY,
      workspace_id VARCHAR(100) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name         VARCHAR(255) NOT NULL,
      emoji        VARCHAR(10),
      layout       JSONB NOT NULL DEFAULT '{"version":1,"nodes":[],"groups":[],"notes":[]}'::jsonb,
      is_public    BOOLEAN NOT NULL DEFAULT false,
      version      INTEGER NOT NULL DEFAULT 1,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_graph_canvases_ws ON graph_canvases(workspace_id)`);
  await pool.query(`DROP TRIGGER IF EXISTS bump_version_graph_canvases ON graph_canvases`);
  await pool.query(`
    CREATE TRIGGER bump_version_graph_canvases BEFORE UPDATE ON graph_canvases
      FOR EACH ROW EXECUTE FUNCTION bump_version()
  `);

  // ── Graph Layer Phase R2: ongoing dual-write for the 5 legacy hard-links ───
  // WP-2's backfill only covers rows that existed at migration time. From here
  // on, every hard-link column write must ALSO keep entity_links current. The
  // design doc puts this in ~13 scattered app-code call sites (routes/lists.ts,
  // routes/tasks.ts, templateUtil.ts, automationEngine.ts, …) — deliberately
  // NOT followed here. A DB trigger on the underlying table catches every
  // writer at once (routes, templateUtil.ts, automationEngine.ts all write the
  // same columns), which structurally eliminates the "missed call site"
  // divergence risk the doc itself flags as the top risk of this phase (R2 in
  // its risk table) rather than merely mitigating it with more tests.
  // Trigger names are prefixed `trg_hardlink_` so they always sort AFTER the
  // `entity_index_*` triggers on the same table (Postgres fires same-event
  // triggers in name order) — the entity's own entity_index row must exist
  // before these triggers reference it.
  await pool.query(`
    CREATE OR REPLACE FUNCTION sync_hardlink_task() RETURNS TRIGGER AS $$
    DECLARE v_task_id text := NEW.id::text;
    BEGIN
      DELETE FROM entity_links
       WHERE origin = 'system' AND link_type IN ('child_of','links_to')
         AND ((dst_type='task' AND dst_id=v_task_id) OR (src_type='task' AND src_id=v_task_id))
         AND NOT (
           NEW.linked_list_id IS NOT NULL AND (
             (NEW.linked_list_type='sublist' AND link_type='child_of' AND src_type='list' AND src_id=NEW.linked_list_id AND dst_type='task' AND dst_id=v_task_id)
             OR (NEW.linked_list_type='link' AND link_type='links_to' AND src_type='task' AND src_id=v_task_id AND dst_type='list' AND dst_id=NEW.linked_list_id)
           )
         );

      IF NEW.linked_list_id IS NOT NULL AND EXISTS (SELECT 1 FROM entity_index e WHERE e.entity_type='list' AND e.entity_id=NEW.linked_list_id) THEN
        IF NEW.linked_list_type = 'sublist' THEN
          INSERT INTO entity_links (id, workspace_id, src_type, src_id, dst_type, dst_id, link_type, origin, created_by, created_at)
          VALUES ('lnk_' || gen_random_uuid(), NEW.workspace_id, 'list', NEW.linked_list_id, 'task', v_task_id, 'child_of', 'system', NEW.user_id, NOW())
          ON CONFLICT (src_type, src_id, dst_type, dst_id, link_type, COALESCE(source_block_id, '')) DO NOTHING;
        ELSIF NEW.linked_list_type = 'link' THEN
          INSERT INTO entity_links (id, workspace_id, src_type, src_id, dst_type, dst_id, link_type, origin, created_by, created_at)
          VALUES ('lnk_' || gen_random_uuid(), NEW.workspace_id, 'task', v_task_id, 'list', NEW.linked_list_id, 'links_to', 'system', NEW.user_id, NOW())
          ON CONFLICT (src_type, src_id, dst_type, dst_id, link_type, COALESCE(source_block_id, '')) DO NOTHING;
        END IF;
      END IF;

      -- Structural part_of: a list-task belongs to its containing list.
      DELETE FROM entity_links
       WHERE origin='system' AND link_type='part_of' AND src_type='task' AND src_id=v_task_id
         AND NOT (NEW.source='list' AND NEW.list_id IS NOT NULL AND dst_type='list' AND dst_id=NEW.list_id);
      IF NEW.source = 'list' AND NEW.list_id IS NOT NULL AND EXISTS (SELECT 1 FROM entity_index e WHERE e.entity_type='list' AND e.entity_id=NEW.list_id) THEN
        INSERT INTO entity_links (id, workspace_id, src_type, src_id, dst_type, dst_id, link_type, origin, created_at)
        VALUES ('lnk_' || gen_random_uuid(), NEW.workspace_id, 'task', v_task_id, 'list', NEW.list_id, 'part_of', 'system', NOW())
        ON CONFLICT (src_type, src_id, dst_type, dst_id, link_type, COALESCE(source_block_id, '')) DO NOTHING;
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`DROP TRIGGER IF EXISTS trg_hardlink_task ON tasks`);
  await pool.query(`
    CREATE TRIGGER trg_hardlink_task AFTER INSERT OR UPDATE ON tasks
      FOR EACH ROW EXECUTE FUNCTION sync_hardlink_task()
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION sync_hardlink_list() RETURNS TRIGGER AS $$
    DECLARE v_list_id text := NEW.id;
    BEGIN
      DELETE FROM entity_links
       WHERE origin='system' AND link_type='child_of' AND src_type='list' AND src_id=v_list_id
         AND NOT (NEW.parent_task_id IS NOT NULL AND dst_type='task' AND dst_id = NEW.parent_task_id::text);
      IF NEW.parent_task_id IS NOT NULL AND EXISTS (SELECT 1 FROM entity_index e WHERE e.entity_type='task' AND e.entity_id=NEW.parent_task_id::text) THEN
        INSERT INTO entity_links (id, workspace_id, src_type, src_id, dst_type, dst_id, link_type, origin, created_by, created_at)
        VALUES ('lnk_' || gen_random_uuid(), NEW.workspace_id, 'list', v_list_id, 'task', NEW.parent_task_id::text, 'child_of', 'system', NEW.user_id, NOW())
        ON CONFLICT (src_type, src_id, dst_type, dst_id, link_type, COALESCE(source_block_id, '')) DO NOTHING;
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`DROP TRIGGER IF EXISTS trg_hardlink_list ON lists`);
  await pool.query(`
    CREATE TRIGGER trg_hardlink_list AFTER INSERT OR UPDATE ON lists
      FOR EACH ROW EXECUTE FUNCTION sync_hardlink_list()
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION sync_hardlink_markdown() RETURNS TRIGGER AS $$
    DECLARE v_id text := NEW.id;
    BEGIN
      DELETE FROM entity_links
       WHERE origin='system' AND link_type='tracks' AND src_type='markdownList' AND src_id=v_id
         AND NOT (NEW.todo_list_id IS NOT NULL AND dst_type='list' AND dst_id=NEW.todo_list_id);
      IF NEW.todo_list_id IS NOT NULL AND EXISTS (SELECT 1 FROM entity_index e WHERE e.entity_type='list' AND e.entity_id=NEW.todo_list_id) THEN
        INSERT INTO entity_links (id, workspace_id, src_type, src_id, dst_type, dst_id, link_type, origin, created_by, created_at)
        VALUES ('lnk_' || gen_random_uuid(), NEW.workspace_id, 'markdownList', v_id, 'list', NEW.todo_list_id, 'tracks', 'system', NEW.user_id, NOW())
        ON CONFLICT (src_type, src_id, dst_type, dst_id, link_type, COALESCE(source_block_id, '')) DO NOTHING;
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`DROP TRIGGER IF EXISTS trg_hardlink_markdown ON markdown_lists`);
  await pool.query(`
    CREATE TRIGGER trg_hardlink_markdown AFTER INSERT OR UPDATE ON markdown_lists
      FOR EACH ROW EXECUTE FUNCTION sync_hardlink_markdown()
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION sync_hardlink_milestone() RETURNS TRIGGER AS $$
    BEGIN
      INSERT INTO entity_links (id, workspace_id, src_type, src_id, dst_type, dst_id, link_type, origin, created_at)
      SELECT 'lnk_' || gen_random_uuid(), tl.workspace_id, 'milestone', NEW.id, 'timeline', NEW.timeline_id, 'part_of', 'system', NOW()
        FROM timelines tl WHERE tl.id = NEW.timeline_id
      ON CONFLICT (src_type, src_id, dst_type, dst_id, link_type, COALESCE(source_block_id, '')) DO NOTHING;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`DROP TRIGGER IF EXISTS trg_hardlink_milestone ON milestones`);
  await pool.query(`
    CREATE TRIGGER trg_hardlink_milestone AFTER INSERT ON milestones
      FOR EACH ROW EXECUTE FUNCTION sync_hardlink_milestone()
  `);

  // ── R2b: entity_attachments merge ───────────────────────────────────────
  // Both attachment tables keep their existing columns/routes unchanged (they
  // remain the source of truth — see CLAUDE.md); entity_attachments is an
  // ADDITIONAL trigger-synced union that lets a future UI/AI-tool query
  // attachments on any entity type in one place, not just tasks/milestones.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entity_attachments (
      id              VARCHAR(100) PRIMARY KEY,
      entity_type     VARCHAR(24)  NOT NULL,
      entity_id       VARCHAR(100) NOT NULL,
      user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      attachment_type VARCHAR(20) NOT NULL DEFAULT 'upload' CHECK (attachment_type IN ('upload','linked')),
      original_name   VARCHAR(500),
      mime_type       VARCHAR(100) NOT NULL DEFAULT 'application/octet-stream',
      file_size       BIGINT NOT NULL DEFAULT 0,
      file_path       VARCHAR(500),
      shared_file_id  VARCHAR(100) REFERENCES shared_files(id) ON DELETE CASCADE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_att_entity FOREIGN KEY (entity_type, entity_id)
        REFERENCES entity_index (entity_type, entity_id) ON DELETE CASCADE
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_entity_attachments_entity ON entity_attachments (entity_type, entity_id)`);

  await pool.query(`
    INSERT INTO entity_attachments (id, entity_type, entity_id, user_id, attachment_type, original_name, mime_type, file_size, file_path, shared_file_id, created_at)
    SELECT id, 'task', task_id::text, user_id, attachment_type, original_name, mime_type, file_size, file_path, shared_file_id, created_at
      FROM task_attachments
      WHERE EXISTS (SELECT 1 FROM entity_index e WHERE e.entity_type='task' AND e.entity_id = task_attachments.task_id::text)
    ON CONFLICT (id) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO entity_attachments (id, entity_type, entity_id, user_id, attachment_type, original_name, mime_type, file_size, file_path, shared_file_id, created_at)
    SELECT id, 'milestone', milestone_id, user_id, attachment_type, original_name, mime_type, file_size, file_path, shared_file_id, created_at
      FROM milestone_attachments
      WHERE EXISTS (SELECT 1 FROM entity_index e WHERE e.entity_type='milestone' AND e.entity_id = milestone_attachments.milestone_id)
    ON CONFLICT (id) DO NOTHING
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION sync_hardlink_task_attachment() RETURNS TRIGGER AS $$
    BEGIN
      IF (TG_OP = 'DELETE') THEN
        DELETE FROM entity_links WHERE origin='system' AND link_type='attached_to' AND src_type='file' AND src_id=OLD.shared_file_id AND dst_type='task' AND dst_id=OLD.task_id::text;
        DELETE FROM entity_attachments WHERE id = OLD.id;
        RETURN OLD;
      END IF;
      IF NEW.shared_file_id IS NOT NULL AND EXISTS (SELECT 1 FROM entity_index e WHERE e.entity_type='file' AND e.entity_id=NEW.shared_file_id) THEN
        INSERT INTO entity_links (id, workspace_id, src_type, src_id, dst_type, dst_id, link_type, origin, created_by, created_at)
        SELECT 'lnk_' || gen_random_uuid(), t.workspace_id, 'file', NEW.shared_file_id, 'task', NEW.task_id::text, 'attached_to', 'system', NEW.user_id, NOW()
          FROM tasks t WHERE t.id = NEW.task_id
        ON CONFLICT (src_type, src_id, dst_type, dst_id, link_type, COALESCE(source_block_id, '')) DO NOTHING;
      END IF;
      INSERT INTO entity_attachments (id, entity_type, entity_id, user_id, attachment_type, original_name, mime_type, file_size, file_path, shared_file_id, created_at)
      VALUES (NEW.id, 'task', NEW.task_id::text, NEW.user_id, NEW.attachment_type, NEW.original_name, NEW.mime_type, NEW.file_size, NEW.file_path, NEW.shared_file_id, NEW.created_at)
      ON CONFLICT (id) DO NOTHING;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`DROP TRIGGER IF EXISTS trg_hardlink_task_attachment ON task_attachments`);
  await pool.query(`
    CREATE TRIGGER trg_hardlink_task_attachment AFTER INSERT OR DELETE ON task_attachments
      FOR EACH ROW EXECUTE FUNCTION sync_hardlink_task_attachment()
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION sync_hardlink_milestone_attachment() RETURNS TRIGGER AS $$
    BEGIN
      IF (TG_OP = 'DELETE') THEN
        DELETE FROM entity_links WHERE origin='system' AND link_type='attached_to' AND src_type='file' AND src_id=OLD.shared_file_id AND dst_type='milestone' AND dst_id=OLD.milestone_id;
        DELETE FROM entity_attachments WHERE id = OLD.id;
        RETURN OLD;
      END IF;
      IF NEW.shared_file_id IS NOT NULL AND EXISTS (SELECT 1 FROM entity_index e WHERE e.entity_type='file' AND e.entity_id=NEW.shared_file_id) THEN
        INSERT INTO entity_links (id, workspace_id, src_type, src_id, dst_type, dst_id, link_type, origin, created_by, created_at)
        SELECT 'lnk_' || gen_random_uuid(), tl.workspace_id, 'file', NEW.shared_file_id, 'milestone', NEW.milestone_id, 'attached_to', 'system', NEW.user_id, NOW()
          FROM milestones ms JOIN timelines tl ON tl.id = ms.timeline_id WHERE ms.id = NEW.milestone_id
        ON CONFLICT (src_type, src_id, dst_type, dst_id, link_type, COALESCE(source_block_id, '')) DO NOTHING;
      END IF;
      INSERT INTO entity_attachments (id, entity_type, entity_id, user_id, attachment_type, original_name, mime_type, file_size, file_path, shared_file_id, created_at)
      VALUES (NEW.id, 'milestone', NEW.milestone_id, NEW.user_id, NEW.attachment_type, NEW.original_name, NEW.mime_type, NEW.file_size, NEW.file_path, NEW.shared_file_id, NEW.created_at)
      ON CONFLICT (id) DO NOTHING;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql
  `);
  await pool.query(`DROP TRIGGER IF EXISTS trg_hardlink_milestone_attachment ON milestone_attachments`);
  await pool.query(`
    CREATE TRIGGER trg_hardlink_milestone_attachment AFTER INSERT OR DELETE ON milestone_attachments
      FOR EACH ROW EXECUTE FUNCTION sync_hardlink_milestone_attachment()
  `);

  // ── Knowledge Layer: entity_chunks + embedding_queue ────────────────────
  // pgvector is optional: `CREATE EXTENSION vector` only succeeds on a
  // pgvector/pgvector:pg16 image (see docker-compose.yml); a plain postgres:16
  // image doesn't ship it. Attempt it, and if it fails, degrade gracefully —
  // entity_chunks.embedding is only added (and only ever read/written) when
  // the extension is actually present; every knowledge/ module checks
  // isPgvectorAvailable() first (see knowledge/state.ts). Search still works
  // lexical-only (pg_trgm) without pgvector; embeddings just never populate.
  let pgvectorReady = false;
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "vector"`);
    pgvectorReady = true;
  } catch (err) {
    console.warn('⚠️  pgvector extension unavailable — Knowledge Layer will run lexical-only (trigram) search. Use the pgvector/pgvector:pg16 Postgres image to enable semantic search.', (err as Error).message);
  }
  setPgvectorAvailable(pgvectorReady);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS entity_chunks (
      id            VARCHAR(100) PRIMARY KEY,
      entity_type   VARCHAR(24)  NOT NULL,
      entity_id     VARCHAR(100) NOT NULL,
      workspace_id  VARCHAR(100),
      chunk_index   INTEGER NOT NULL,
      content       TEXT NOT NULL,
      content_hash  VARCHAR(64) NOT NULL,
      token_count   INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_chunks_entity FOREIGN KEY (entity_type, entity_id)
        REFERENCES entity_index (entity_type, entity_id) ON DELETE CASCADE,
      UNIQUE (entity_type, entity_id, chunk_index)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_entity_chunks_entity ON entity_chunks (entity_type, entity_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_entity_chunks_ws ON entity_chunks (workspace_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_entity_chunks_trgm ON entity_chunks USING gin (content gin_trgm_ops)`);
  if (pgvectorReady) {
    // Fixed at 1536 dims (see knowledge/state.ts's EMBEDDING_DIMENSIONS) —
    // matches OpenAI's text-embedding-3-small and most comparable small
    // models. Switching embedding dimensionality requires a new column and a
    // full re-embed, not a live migration.
    await pool.query(`ALTER TABLE entity_chunks ADD COLUMN IF NOT EXISTS embedding vector(1536)`);
    // IVFFlat needs training data to be useful and errors on an empty table
    // for some pgvector versions when lists > row count; HNSW has no such
    // restriction and builds incrementally, so it's the safer default for a
    // table that starts empty on every fresh install.
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_entity_chunks_embedding ON entity_chunks USING hnsw (embedding vector_cosine_ops)`).catch((err) => {
      console.warn('⚠️  Could not create HNSW index on entity_chunks.embedding (non-fatal — vector search will be slower):', (err as Error).message);
    });
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS embedding_queue (
      id            VARCHAR(100) PRIMARY KEY,
      entity_type   VARCHAR(24)  NOT NULL,
      entity_id     VARCHAR(100) NOT NULL,
      workspace_id  VARCHAR(100),
      status        VARCHAR(20) NOT NULL DEFAULT 'pending',
      attempts      INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (entity_type, entity_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_embedding_queue_status ON embedding_queue (status, updated_at)`);

  // ── Agent Runtime ─────────────────────────────────────────────────────
  // Per-workspace autonomy: agent_mode gates whether the agent runs at all
  // ('off') and how much a run can do without a human ('suggest' always
  // proposes, 'assisted' auto-runs only policy.autoApproveTools, 'autonomous'
  // auto-runs everything the policy allows). See agent/policy.ts.
  await pool.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS agent_mode VARCHAR(20) NOT NULL DEFAULT 'off'`);
  await pool.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS agent_policy JSONB NOT NULL DEFAULT '{}'`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id                 VARCHAR(100) PRIMARY KEY,
      workspace_id       VARCHAR(100) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      trigger_type       VARCHAR(40) NOT NULL,
      trigger_context    JSONB NOT NULL DEFAULT '{}',
      goal               TEXT NOT NULL,
      mode               VARCHAR(20) NOT NULL,
      status             VARCHAR(20) NOT NULL DEFAULT 'running',
      steps              JSONB NOT NULL DEFAULT '[]',
      tokens_prompt      INTEGER NOT NULL DEFAULT 0,
      tokens_completion  INTEGER NOT NULL DEFAULT 0,
      model              VARCHAR(100),
      error              TEXT,
      started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at        TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace ON agent_runs (workspace_id, started_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_runs_user ON agent_runs (user_id, started_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_proposals (
      id            VARCHAR(100) PRIMARY KEY,
      run_id        VARCHAR(100) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      workspace_id  VARCHAR(100) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      tool_name     VARCHAR(100) NOT NULL,
      tool_args     JSONB NOT NULL DEFAULT '{}',
      rationale     TEXT,
      preview       JSONB,
      status        VARCHAR(20) NOT NULL DEFAULT 'pending',
      decided_by    UUID REFERENCES users(id) ON DELETE SET NULL,
      decided_at    TIMESTAMPTZ,
      expires_at    TIMESTAMPTZ NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_proposals_ws_status ON agent_proposals (workspace_id, status)`);

  // Curated revert support (agent/inverse.ts) — one row per tracked mutation a
  // run made. before_state is null for a create (nothing existed before).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_mutations (
      id            VARCHAR(100) PRIMARY KEY,
      run_id        VARCHAR(100) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      workspace_id  VARCHAR(100) NOT NULL,
      tool_name     VARCHAR(100) NOT NULL,
      entity_type   VARCHAR(24),
      entity_id     VARCHAR(100),
      before_state  JSONB,
      reverted      BOOLEAN NOT NULL DEFAULT false,
      revert_error  TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_mutations_run ON agent_mutations (run_id)`);

  // ── Graph Layer: rolling-refactor R3/R4 (gated legacy-column drop) ──────
  // TWO independent flags must both be 'true' before a single column is
  // touched:
  //   - graph_migration_verified: written ONLY by graph/verifyMigration.ts's
  //     nightly sweep, after 7 CONSECUTIVE clean days of zero drift between
  //     the legacy hard-link columns and their mirrored entity_links edges.
  //   - graph_links_v2: the READ-SWITCH flag — set only once every
  //     application read/write path that currently touches these columns
  //     directly (routes/lists.ts, aiTools.ts, templateUtil.ts, etc.) has
  //     been migrated to go through entity_links instead. That rollout is
  //     substantial and is NOT part of this change — see DEPRECATIONS.md.
  //     This flag is never set anywhere in this codebase (yet), so this
  //     entire block is provably dead code today, by construction, not by
  //     convention — exactly the point of a two-key gate for an irreversible
  //     operation.
  //
  // Why both are required, not just the drift streak: the trg_hardlink_*
  // triggers below read NEW.linked_list_id/NEW.parent_task_id/NEW.todo_list_id
  // directly — dropping those columns while the triggers still reference them
  // would break every INSERT/UPDATE on tasks/lists/markdown_lists the moment
  // it fires. So a real drop must ALSO retire the triggers whose only purpose
  // was dual-writing FROM these columns — which only makes sense once nothing
  // in the app writes to the columns anymore (graph_links_v2), not just once
  // the dual-write has been verified to run correctly so far.
  //
  // Scope is deliberately narrower than "5 mechanisms" even then: only the 4
  // columns that are pure reference redundancy (fully reconstructable from
  // entity_links) are covered. task_attachments/milestone_attachments are
  // real DATA tables (file path/size/mime metadata), not reference columns —
  // dropping a data table is a materially different risk class and gets its
  // own dedicated, separately-reviewed migration, never bundled into this gate.
  //
  // ONE MORE THING THIS BLOCK MUST DO BEFORE IT EVER RUNS FOR REAL:
  // `item_share_grants_list()` (created earlier in this file) resolves the
  // per-item-share cascade by reading `lists.parent_task_id` and
  // `markdown_lists.todo_list_id`. PostgreSQL does not record function bodies
  // as column dependencies, so these DROPs would succeed and leave that
  // function — and therefore EVERY list access-condition in the app — failing
  // at runtime, and the next startup unable to re-create it. Rewriting it
  // against entity_links (`child_of` / `tracks` edges) belongs in the same
  // change that opens this gate, not after it.
  const [migrationVerifiedRes, linksV2Res] = await Promise.all([
    pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'graph_migration_verified'`),
    pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'graph_links_v2'`),
  ]);
  if (migrationVerifiedRes.rows[0]?.value === 'true' && linksV2Res.rows[0]?.value === 'true') {
    console.log('🔗 🗑️  graph_migration_verified + graph_links_v2 are both true — retiring the dual-write triggers and dropping the now-redundant legacy hard-link columns...');
    await pool.query(`DROP TRIGGER IF EXISTS trg_hardlink_task ON tasks`);
    await pool.query(`DROP FUNCTION IF EXISTS sync_hardlink_task()`);
    await pool.query(`DROP TRIGGER IF EXISTS trg_hardlink_list ON lists`);
    await pool.query(`DROP FUNCTION IF EXISTS sync_hardlink_list()`);
    await pool.query(`DROP TRIGGER IF EXISTS trg_hardlink_markdown ON markdown_lists`);
    await pool.query(`DROP FUNCTION IF EXISTS sync_hardlink_markdown()`);
    await pool.query(`ALTER TABLE tasks DROP COLUMN IF EXISTS linked_list_id`);
    await pool.query(`ALTER TABLE tasks DROP COLUMN IF EXISTS linked_list_type`);
    await pool.query(`ALTER TABLE lists DROP COLUMN IF EXISTS parent_task_id`);
    await pool.query(`ALTER TABLE markdown_lists DROP COLUMN IF EXISTS todo_list_id`);
    console.log('🔗 🗑️  Legacy hard-link columns and their sync triggers are gone. entity_links (origin=\'system\') is now the sole source of truth for these relationships.');
  }

  // Per-user "last visited screen" — a new tab (or reload) restores this
  // path instead of always landing on the dashboard. Set from AppLayout on
  // every route change (routes/auth.ts's `PUT /last-route`); read back at
  // login/session-verify time via sanitizeUser().
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_route VARCHAR(500)`);

  // Sol's long-term memory: small, durable facts about a user (preferences,
  // standing context) that ride in every chat's system prompt — the "stop
  // asking me every time" layer, scoped per-user rather than the instance-wide
  // AI Skills. Deliberately NOT a dump of chat history — that stays out of the
  // system prompt entirely and is reachable only via the search_chat_history
  // tool, on demand, so an old conversation never inflates every future call.
  // Entry-count/length caps live in aiMemory.ts, not here.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_user_memory (
      id         VARCHAR(100) PRIMARY KEY,
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content    TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ai_user_memory_user_idx ON ai_user_memory (user_id, created_at ASC)`);

  // Trigram index backing search_chat_history's on-demand lookups over past
  // sessions — pg_trgm is already enabled above (Knowledge Layer migration).
  await pool.query(`CREATE INDEX IF NOT EXISTS ai_chats_content_trgm ON ai_chats USING gin (content gin_trgm_ops)`);

  // ── Quick Add: staging tray + placement memory ──────────────────────────
  // Per-board opt-in. Off by default: a board with no history predicts
  // nothing useful, and an always-on input bar would change every existing
  // board's layout without being asked.
  await pool.query(`ALTER TABLE lists ADD COLUMN IF NOT EXISTS quick_add_enabled BOOLEAN NOT NULL DEFAULT false`);
  // The board's Knowledge Base bubble (quickAdd/kbBubble.ts). SET NULL rather
  // than CASCADE: deleting the bubble from the Knowledge Base must not delete
  // the board it describes.
  await pool.query(`ALTER TABLE lists ADD COLUMN IF NOT EXISTS quick_add_kb_entry_id VARCHAR(100) REFERENCES knowledge_entries(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE lists ADD COLUMN IF NOT EXISTS quick_add_memory_dirty BOOLEAN NOT NULL DEFAULT false`);
  // Declutters a busy board's List/Kanban/Timeline views once Quick Add has
  // been filing items into sections for a while. Defaults to true (per the
  // feature's own request) rather than false like every other Quick Add
  // column — an existing board turning Quick Add on for the first time should
  // start decluttered, not need a second opt-in click to get there.
  await pool.query(`ALTER TABLE lists ADD COLUMN IF NOT EXISTS quick_add_hide_empty_sections BOOLEAN NOT NULL DEFAULT true`);

  // Append-only placement history. Deliberately NOT read by the predictor —
  // see quickAdd/memory.ts's header for why the projection below is a separate
  // table rather than a "latest row" query over this one. Section ids are
  // stored WITHOUT a foreign key, alongside a label snapshot, so history stays
  // readable after a section is renamed or deleted.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS section_placement_events (
      id                 BIGSERIAL PRIMARY KEY,
      list_id            VARCHAR(100) NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      task_id            VARCHAR(40) NOT NULL,
      title              TEXT NOT NULL,
      title_key          TEXT NOT NULL,
      from_section_id    VARCHAR(100),
      from_section_label TEXT,
      to_section_id      VARCHAR(100),
      to_section_label   TEXT,
      event_type         VARCHAR(16) NOT NULL,
      actor_type         VARCHAR(16) NOT NULL,
      actor_id           VARCHAR(100),
      occurred_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS section_placement_events_list_idx ON section_placement_events (list_id, occurred_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS section_placement_events_key_idx ON section_placement_events (list_id, title_key)`);

  // The projection the predictor reads: exactly one row per (board, item
  // title), holding that item's LAST section and nothing else. "Only the last
  // placement may drive a suggestion" is enforced HERE, by the primary key —
  // an UPSERT overwrites the previous section rather than appending — not by a
  // WHERE clause a future query could omit.
  //
  // last_section_id CASCADEs: a memory pointing at a deleted section can only
  // ever produce a suggestion that cannot be acted on. The event history keeps
  // the deleted section's label either way.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS section_memory (
      list_id         VARCHAR(100) NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      title_key       TEXT NOT NULL,
      title           TEXT NOT NULL,
      last_section_id VARCHAR(100) NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
      occurrences     INTEGER NOT NULL DEFAULT 1,
      last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (list_id, title_key)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS section_memory_list_idx ON section_memory (list_id, last_seen_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS section_memory_section_idx ON section_memory (last_section_id)`);
  // Backs both fuzzy channels in quickAdd/predict.ts — similarity() and
  // word_similarity() over the NORMALIZED key, so matching never depends on
  // how a title happened to be capitalized or punctuated.
  await pool.query(`CREATE INDEX IF NOT EXISTS section_memory_key_trgm ON section_memory USING gin (title_key gin_trgm_ops)`);
  if (pgvectorReady) {
    await pool.query(`ALTER TABLE section_memory ADD COLUMN IF NOT EXISTS embedding vector(1536)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS section_memory_embedding_idx ON section_memory USING hnsw (embedding vector_cosine_ops)`).catch((err) => {
      console.warn('⚠️  Could not create HNSW index on section_memory.embedding (non-fatal — semantic Quick Add matching will be slower):', (err as Error).message);
    });
  }

  // Seed the projection from where every existing item currently sits, so a
  // board that enables Quick Add predicts from day one instead of starting
  // blank. Runs in TypeScript rather than SQL specifically so it reuses the
  // REAL titleKey() — a hand-written SQL equivalent would be a second
  // normalization implementation that has to agree with the first forever, and
  // the day they disagree every backfilled row silently stops matching.
  await backfillSectionMemory(pool).catch((err) => {
    console.warn('⚠️  Quick Add memory backfill skipped (non-fatal — memory fills in as items are placed):', (err as Error).message);
  });

  console.log('Database migrations applied.');
}

// ---------------------------------------------------------------------------
// S7 — concurrency-safe boot orchestration.
//
// SECURITY/CORRECTNESS: `runMigrations()` above is many independent
// `pool.query()` calls, each individually idempotent (IF NOT EXISTS), but
// NOT wrapped in one transaction — nothing previously stopped two backend
// processes starting concurrently (a rolling deploy, a container restart
// racing a fresh replica) from running it AT THE SAME TIME. Two connections
// racing `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` on the same table can
// contend for the same DDL lock or, in rarer cases, deadlock — idempotency
// guarantees the END STATE converges, not that concurrent execution is free
// of transient errors along the way. `runAllMigrations()` is what index.ts's
// start() actually calls: it wraps the ENTIRE legacy run plus the new
// versioned-migration runner (versionedMigrations.ts) in a single
// session-level Postgres advisory lock, so a second process starting
// concurrently simply WAITS for the first to finish (typically well under a
// second once already-migrated) rather than racing it.
//
// runMigrations() itself is left completely unwrapped and is still exported
// standalone — every existing integration test calls it directly against a
// single-process test database, where the race this lock defends against
// cannot occur, so adding lock overhead there would be pure cost with no
// benefit. Only the real startup path needs it.
// ---------------------------------------------------------------------------

export async function runAllMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    // A fixed, well-known lock key — collision with a per-user key elsewhere
    // in this codebase (e.g. storageQuota.ts's per-user quota lock, itself
    // `hashtext('storage_quota:' + userId)`) is astronomically unlikely and,
    // even in that case, only costs a little extra serialization for the
    // unlucky party — advisory locks are safe under contention by design,
    // never a correctness risk. Session-level (not `_xact_`) because this
    // lock must span the ENTIRE multi-statement migration run, not one
    // transaction.
    await client.query(`SELECT pg_advisory_lock(hashtext('solytiq_cloud:schema_migrations'))`);
    await runMigrations();
    await runVersionedMigrations(VERSIONED_MIGRATIONS);
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('solytiq_cloud:schema_migrations'))`).catch(() => {
      // Best-effort — if the connection itself is already broken, Postgres
      // releases every session-level advisory lock automatically when the
      // session ends, so a failed explicit unlock here can't leak the lock.
    });
    client.release();
  }
}
