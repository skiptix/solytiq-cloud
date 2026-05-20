-- Solytiq Cloud - PostgreSQL Initialization Script

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      VARCHAR(50)  UNIQUE NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name     VARCHAR(255),
  is_admin      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lists table
CREATE TABLE IF NOT EXISTS lists (
  id         VARCHAR(100) PRIMARY KEY,
  user_id    UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       VARCHAR(255) NOT NULL,
  emoji      VARCHAR(10),
  color      VARCHAR(20),
  color_bg   VARCHAR(20),
  subtitle   VARCHAR(500),
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sections table
CREATE TABLE IF NOT EXISTS sections (
  id       VARCHAR(100) PRIMARY KEY,
  list_id  VARCHAR(100) NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  label    VARCHAR(255) NOT NULL,
  emoji    VARCHAR(10),
  position INTEGER NOT NULL DEFAULT 0
);

-- Tasks table
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
);

-- Trash table
CREATE TABLE IF NOT EXISTS trash (
  id         SERIAL PRIMARY KEY,
  task_id    BIGINT NOT NULL,
  user_id    UUID   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_data  JSONB  NOT NULL,
  meta       JSONB,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
);

-- Auto-update updated_at on tasks
CREATE OR REPLACE FUNCTION update_tasks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tasks_updated_at_trigger ON tasks;
CREATE TRIGGER tasks_updated_at_trigger
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_tasks_updated_at();
