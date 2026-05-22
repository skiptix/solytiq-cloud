-- Migration: Add is_public to folders and ensure folder_id in lists

-- Folders table
CREATE TABLE IF NOT EXISTS folders (
  id         VARCHAR(100) PRIMARY KEY,
  user_id    UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       VARCHAR(255) NOT NULL,
  emoji      VARCHAR(10),
  color      VARCHAR(50),
  position   INTEGER      NOT NULL DEFAULT 0,
  collapsed  BOOLEAN      NOT NULL DEFAULT false,
  is_public  BOOLEAN      NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Add is_public to folders if table already existed but without this column
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'folders') THEN
        IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'folders' AND column_name = 'is_public') THEN
            ALTER TABLE folders ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT true;
        END IF;
    END IF;
END $$;

-- Ensure folder_id in lists
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'lists' AND column_name = 'folder_id') THEN
        ALTER TABLE lists ADD COLUMN folder_id VARCHAR(100) REFERENCES folders(id) ON DELETE SET NULL;
    END IF;
END $$;
