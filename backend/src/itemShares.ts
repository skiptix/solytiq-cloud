// ---------------------------------------------------------------------------
// Per-item invitations ("Shared with me").
//
// A single `item_shares` table grants a specific user access to ONE list,
// timeline, or markdown list — independent of workspace membership. This is the
// "share just this item" half of the tag/mention prompt, and the standalone
// "Invite people" control on a list/timeline/markdown page.
//
// Access model: an invited user is a FULL COLLABORATOR — they can view AND edit
// the item's content (tasks/milestones/blocks), exactly like the owner, but the
// owner alone manages the item itself (rename/visibility/sharing/delete/invites).
//
// The table is polymorphic (`item_type` + `item_id`), so there's no FK on
// item_id; the item's own delete path calls deleteItemShares() to clean up.
// ---------------------------------------------------------------------------

import { query } from './db';
import type { QueryExec } from './workspaceUtil';

export type SharedItemType = 'list' | 'timeline' | 'markdownList';

/**
 * SQL fragment: "this user has been invited to <alias>". Drop it into a read
 * access-condition, e.g. `${accessCondition} OR ${itemShareExists('l', 'list')}`.
 * `userParam` must reference the same bound user id the surrounding query uses
 * (defaults to `$1`). `alias.id` is the item's id column.
 */
export function itemShareExists(alias: string, type: SharedItemType, userParam = '$1'): string {
  // `type` is a fixed literal from this file — never user input — so inlining it
  // is injection-safe and keeps the parameter list of callers unchanged.
  return `EXISTS (SELECT 1 FROM item_shares s WHERE s.item_type = '${type}' AND s.item_id = ${alias}.id AND s.user_id = ${userParam})`;
}

/** Is this user invited to this specific item? */
export async function isItemSharedWith(type: SharedItemType, itemId: string, userId: string): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM item_shares WHERE item_type = $1 AND item_id = $2 AND user_id = $3`,
    [type, itemId, userId]
  );
  return r.rows.length > 0;
}

/** Grant a user access to an item. Idempotent. Returns true if a NEW row was created. */
export async function addItemShare(type: SharedItemType, itemId: string, userId: string, invitedBy: string): Promise<boolean> {
  const r = await query(
    `INSERT INTO item_shares (item_type, item_id, user_id, invited_by)
     VALUES ($1, $2, $3, $4) ON CONFLICT (item_type, item_id, user_id) DO NOTHING`,
    [type, itemId, userId, invitedBy]
  );
  return (r.rowCount ?? 0) > 0;
}

/** Revoke a user's access to an item. */
export async function removeItemShare(type: SharedItemType, itemId: string, userId: string): Promise<void> {
  await query(`DELETE FROM item_shares WHERE item_type = $1 AND item_id = $2 AND user_id = $3`, [type, itemId, userId]);
}

/** Remove every invite for an item — call from the item's delete path. Accepts
 *  a QueryExec so it can run inside the delete transaction. */
export async function deleteItemShares(
  exec: QueryExec,
  type: SharedItemType,
  itemId: string,
): Promise<void> {
  await exec(`DELETE FROM item_shares WHERE item_type = $1 AND item_id = $2`, [type, itemId]);
}

export interface ItemShareMember {
  userId: string;
  username: string;
  fullName: string | null;
  hasImage: boolean;
  invitedBy: string | null;
  createdAt: string;
}

/** Everyone invited to an item (joined to user profile basics). */
export async function listItemShares(type: SharedItemType, itemId: string): Promise<ItemShareMember[]> {
  const r = await query<{ user_id: string; username: string; full_name: string | null; has_image: boolean; invited_by: string | null; created_at: string }>(
    `SELECT s.user_id, u.username, u.full_name, (u.profile_image IS NOT NULL) AS has_image, s.invited_by, s.created_at
       FROM item_shares s JOIN users u ON u.id = s.user_id
      WHERE s.item_type = $1 AND s.item_id = $2
      ORDER BY s.created_at ASC`,
    [type, itemId]
  );
  return r.rows.map((x) => ({
    userId: x.user_id,
    username: x.username,
    fullName: x.full_name ?? null,
    hasImage: x.has_image,
    invitedBy: x.invited_by ?? null,
    createdAt: x.created_at,
  }));
}
