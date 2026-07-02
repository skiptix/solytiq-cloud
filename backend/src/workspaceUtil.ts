// ---------------------------------------------------------------------------
// Workspace utilities — shared helpers for lists / tasks / folders / workspaces.
//
// Goal: make workspace ↔ list ↔ item relationships deterministic and
// "waterproof". Every user is guaranteed a Personal workspace, every write is
// resolved to a workspace the user can actually access, and everything is
// logged to the container with a 📋 prefix so the data flow is traceable.
// ---------------------------------------------------------------------------

import type { QueryResult, QueryResultRow } from 'pg';
import { query } from './db';

// A minimal executor shape satisfied by both the pool-backed `query` helper and
// a transaction `client.query`. Lets the same logic run inside or outside a tx.
export type QueryExec = (
  text: string,
  params?: unknown[]
) => Promise<QueryResult<QueryResultRow>>;

// ---------------------------------------------------------------------------
// Logging — every lists/workspaces/items operation is logged with 📋
// ---------------------------------------------------------------------------

export function wlog(...args: unknown[]): void {
  console.log('📋', ...args);
}

export function wwarn(...args: unknown[]): void {
  console.warn('📋 ⚠️', ...args);
}

export function werr(...args: unknown[]): void {
  console.error('📋 ✗', ...args);
}

// ---------------------------------------------------------------------------
// Personal workspace guarantee
// ---------------------------------------------------------------------------

/**
 * Ensure the given user owns a "Personal" workspace and is a member of it.
 * Idempotent and safe to call on every request. Returns the workspace id.
 *
 * This heals users that were registered/created while the server was already
 * running (the startup seed in runMigrations only covers users that existed at
 * boot time).
 */
export async function ensurePersonalWorkspace(
  exec: QueryExec,
  userId: string
): Promise<string> {
  const existing = await exec(
    `SELECT id FROM workspaces WHERE owner_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [userId]
  );

  if (existing.rows.length > 0) {
    const wsId = (existing.rows[0] as { id: string }).id;
    // Guarantee owner membership for every workspace this user owns. A missing
    // owner row hides the workspace from /api/workspaces, which in turn makes
    // its lists/timelines look like they disappeared even though they were not
    // deleted.
    await ensureOwnedWorkspaceMemberships(exec, userId);
    return wsId;
  }

  const wsId = `ws_${userId.replace(/-/g, '')}`;
  await exec(
    `INSERT INTO workspaces (id, name, emoji, visibility, owner_id)
     VALUES ($1, 'Personal', '🏠', 'private', $2)
     ON CONFLICT (id) DO NOTHING`,
    [wsId, userId]
  );
  await exec(
    `INSERT INTO workspace_members (workspace_id, user_id, role)
     VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`,
    [wsId, userId]
  );
  wlog(`created Personal workspace ${wsId} for user ${userId}`);
  return wsId;
}

/** Ensure every workspace owned by the user also has an owner membership row. */
export async function ensureOwnedWorkspaceMemberships(
  exec: QueryExec,
  userId: string
): Promise<void> {
  await exec(
    `INSERT INTO workspace_members (workspace_id, user_id, role)
     SELECT w.id, w.owner_id, 'owner'
     FROM workspaces w
     WHERE w.owner_id = $1
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'owner'`,
    [userId]
  );
}

// ---------------------------------------------------------------------------
// Access checks & workspace resolution
// ---------------------------------------------------------------------------

/** True if the user is a member of the workspace, or the workspace is public. */
export async function userCanAccessWorkspace(
  userId: string,
  workspaceId: string
): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2
     UNION
     SELECT 1 FROM workspaces WHERE id = $1 AND owner_id = $2
     UNION
     SELECT 1 FROM workspaces WHERE id = $1 AND visibility = 'public'`,
    [workspaceId, userId]
  );
  return r.rows.length > 0;
}

/**
 * Resolve the workspace a new item should belong to.
 *
 * - If the client supplied a workspace the user can access → use it.
 * - If the client supplied an invalid/inaccessible workspace → fall back to the
 *   user's Personal workspace (and log a warning) so the write never fails with
 *   a foreign-key error and the item always has a real home.
 * - If the client supplied nothing → use the user's Personal workspace.
 *
 * This is what makes items "stick": they always land in a workspace the user
 * can actually see on reload, instead of NULL or a dangling id.
 */
export async function resolveWorkspaceForUser(
  userId: string,
  requested?: string | null
): Promise<string> {
  if (requested) {
    if (await userCanAccessWorkspace(userId, requested)) return requested;
    wwarn(
      `user ${userId} requested inaccessible workspace ${requested}; falling back to Personal`
    );
  }
  return ensurePersonalWorkspace(query, userId);
}
