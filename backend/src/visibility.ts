// ---------------------------------------------------------------------------
// Visibility hierarchy — enforces the public/private invariant across the
// Workspace → Folder → List/Timeline chain (in-app `is_public` / `visibility`,
// NOT the anonymous share-link feature).
//
// Rule: a child may only be PUBLIC when every ancestor above it is also public.
//   - A list/timeline public  ⇒ its folder (if any) public AND its workspace public.
//   - A folder public         ⇒ its workspace public.
//
// When a write would break the invariant we return a structured 409
// `visibility_conflict` so the frontend can offer the user a choice:
//   - promote:  making a child public requires private ancestors to go public.
//   - restrict: making a parent private will cascade public descendants private.
// A follow-up request with `cascade: true` commits the cascade in one tx.
// ---------------------------------------------------------------------------

import type { PoolClient } from 'pg';
import { QueryExec } from './workspaceUtil';

export type VisibilityEntity = 'workspace' | 'folder' | 'list' | 'timeline';

export interface ConflictAncestor {
  type: 'workspace' | 'folder';
  id: string;
  name: string;
  /** Whether the current user is allowed to make this ancestor public. */
  canPromote: boolean;
}

export interface ConflictDescendant {
  type: 'folder' | 'list' | 'timeline';
  id: string;
  name: string;
}

export interface VisibilityConflict {
  error: 'visibility_conflict';
  direction: 'promote' | 'restrict';
  entityType: VisibilityEntity;
  entityName: string;
  /** Private ancestors that must become public (promote). */
  ancestors?: ConflictAncestor[];
  /** Public descendants that will become private (restrict). */
  descendants?: ConflictDescendant[];
  /** True when the user is permitted to perform the whole cascade. */
  canResolve: boolean;
  /** Human explanation shown when `canResolve` is false. */
  blockedReason?: string;
}

// ── Promote (child → public): find private ancestors ──────────────────────────

/**
 * Returns the private ancestors of an item that block it from being public.
 * Ordered top-down (workspace first, then folder) to mirror the hierarchy.
 */
export async function getPrivateAncestors(
  exec: QueryExec,
  opts: { workspaceId?: string | null; folderId?: string | null; userId: string; isAdmin: boolean }
): Promise<ConflictAncestor[]> {
  const { workspaceId, folderId, userId, isAdmin } = opts;
  const out: ConflictAncestor[] = [];

  if (workspaceId) {
    const w = await exec(
      `SELECT id, name, visibility, owner_id FROM workspaces WHERE id = $1`,
      [workspaceId]
    );
    const row = w.rows[0] as { id: string; name: string; visibility: string; owner_id: string } | undefined;
    if (row && row.visibility !== 'public') {
      // Only the workspace owner (or an admin) may change workspace visibility.
      out.push({ type: 'workspace', id: row.id, name: row.name, canPromote: isAdmin || row.owner_id === userId });
    }
  }

  if (folderId) {
    const f = await exec(
      `SELECT id, name, is_public, user_id FROM folders WHERE id = $1`,
      [folderId]
    );
    const row = f.rows[0] as { id: string; name: string; is_public: boolean; user_id: string } | undefined;
    if (row && row.is_public !== true) {
      out.push({ type: 'folder', id: row.id, name: row.name, canPromote: isAdmin || row.user_id === userId });
    }
  }

  return out;
}

export function buildPromoteConflict(
  entityType: VisibilityEntity,
  entityName: string,
  ancestors: ConflictAncestor[]
): VisibilityConflict {
  const blocked = ancestors.filter(a => !a.canPromote);
  const canResolve = blocked.length === 0;
  let blockedReason: string | undefined;
  if (!canResolve) {
    const names = blocked.map(a => `"${a.name}"`).join(' and ');
    blockedReason = `Only the owner of ${blocked.length > 1 ? 'these' : 'the'} ${blocked[0].type}${blocked.length > 1 ? 's' : ''} ${names} can make ${blocked.length > 1 ? 'them' : 'it'} public.`;
  }
  return { error: 'visibility_conflict', direction: 'promote', entityType, entityName, ancestors, canResolve, blockedReason };
}

/** Cascade-promote the given private ancestors to public (inside a tx). */
export async function promoteAncestors(client: PoolClient, ancestors: ConflictAncestor[]): Promise<void> {
  for (const a of ancestors) {
    if (a.type === 'workspace') {
      await client.query(`UPDATE workspaces SET visibility = 'public' WHERE id = $1`, [a.id]);
    } else {
      await client.query(`UPDATE folders SET is_public = true WHERE id = $1`, [a.id]);
    }
  }
}

// ── Restrict (parent → private): find public descendants ──────────────────────

/**
 * Returns the public descendants that would be hidden if the given container is
 * made private. For a workspace: public folders, lists and timelines anywhere in
 * it. For a folder: public lists and timelines directly inside it.
 */
export async function getPublicDescendants(
  exec: QueryExec,
  target: { type: 'workspace' | 'folder'; id: string }
): Promise<ConflictDescendant[]> {
  const out: ConflictDescendant[] = [];
  const push = (type: ConflictDescendant['type'], rows: Array<{ id: string; name: string }>) =>
    rows.forEach(r => out.push({ type, id: r.id, name: r.name }));

  if (target.type === 'workspace') {
    const folders = await exec(`SELECT id, name FROM folders WHERE workspace_id = $1 AND is_public = true`, [target.id]);
    push('folder', folders.rows as Array<{ id: string; name: string }>);
    const lists = await exec(`SELECT id, name FROM lists WHERE workspace_id = $1 AND is_public = true`, [target.id]);
    push('list', lists.rows as Array<{ id: string; name: string }>);
    const timelines = await exec(`SELECT id, name FROM timelines WHERE workspace_id = $1 AND is_public = true`, [target.id]);
    push('timeline', timelines.rows as Array<{ id: string; name: string }>);
  } else {
    const lists = await exec(`SELECT id, name FROM lists WHERE folder_id = $1 AND is_public = true`, [target.id]);
    push('list', lists.rows as Array<{ id: string; name: string }>);
    const timelines = await exec(`SELECT id, name FROM timelines WHERE folder_id = $1 AND is_public = true`, [target.id]);
    push('timeline', timelines.rows as Array<{ id: string; name: string }>);
  }
  return out;
}

export function buildRestrictConflict(
  entityType: VisibilityEntity,
  entityName: string,
  descendants: ConflictDescendant[]
): VisibilityConflict {
  // The actor here is always the owner of the container being restricted, so the
  // cascade is always permitted once confirmed.
  return { error: 'visibility_conflict', direction: 'restrict', entityType, entityName, descendants, canResolve: true };
}

/** Cascade-restrict all public descendants of the container to private (in a tx). */
export async function restrictDescendants(
  client: PoolClient,
  target: { type: 'workspace' | 'folder'; id: string }
): Promise<void> {
  if (target.type === 'workspace') {
    await client.query(`UPDATE folders SET is_public = false WHERE workspace_id = $1`, [target.id]);
    await client.query(`UPDATE lists SET is_public = false WHERE workspace_id = $1`, [target.id]);
    await client.query(`UPDATE timelines SET is_public = false WHERE workspace_id = $1`, [target.id]);
  } else {
    await client.query(`UPDATE lists SET is_public = false WHERE folder_id = $1`, [target.id]);
    await client.query(`UPDATE timelines SET is_public = false WHERE folder_id = $1`, [target.id]);
  }
}
