// ---------------------------------------------------------------------------
// Central tenant/object access policy (S2 of the security foundation).
//
// The single source of truth for "can userId READ this list/timeline row" —
// extracted from routes/lists.ts's and routes/timelines.ts's own (correct)
// accessCondition, which is the reference implementation this module exists
// to stop being silently re-derived (and re-broken) at every new call site.
//
// THE CENTRAL INVARIANT (see CLAUDE.md's "Two distinct notions of public"):
// an in-app `is_public` flag on a list/timeline is ONLY a grant to workspace
// MEMBERS (or a legacy no-workspace row, or a row inside a workspace that is
// itself public) — never a grant to "any authenticated user of the instance".
// A query that checks `is_public = true` without also checking workspace
// membership exposes every public list/timeline in every OTHER user's private
// workspace to every signed-in user — the exact regression this module closes
// across tasks/attachments/canvas (see objectPolicy.test.ts).
//
// Usage: every query using this condition MUST also join workspaceMembersJoin
// for the SAME alias/userParam, e.g.:
//   `SELECT l.* FROM lists l ${workspaceMembersJoin('l')} WHERE ${objectAccessCondition('l', 'list')}`
// ---------------------------------------------------------------------------

import { itemShareExists, type SharedItemType } from './itemShares';

/** Entity types this policy applies to — both carry `user_id`, `is_public`,
 *  and `workspace_id` columns with identical visibility semantics. */
export type PolicyEntityType = Extract<SharedItemType, 'list' | 'timeline'>;

/**
 * The canonical read-access SQL fragment for a list/timeline row aliased
 * `alias`. Requires a `LEFT JOIN workspace_members wm ON wm.workspace_id =
 * <alias>.workspace_id AND wm.user_id = <userParam>` in the same query (see
 * `workspaceMembersJoin`) — the fragment references `wm.user_id`.
 *
 * Visible when: the caller owns the row, OR the row is `is_public` AND the
 * caller is a member of its workspace (or the row has no workspace, or the
 * workspace itself is public), OR the caller holds an `item_shares` invite
 * to this exact row. `is_public` alone is never sufficient.
 */
export function objectAccessCondition(alias: string, entityType: PolicyEntityType, userParam = '$1'): string {
  return `(
    ${alias}.user_id = ${userParam}
    OR (${alias}.is_public = true AND (
      wm.user_id = ${userParam}
      OR ${alias}.workspace_id IS NULL
      OR EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ${alias}.workspace_id AND w.visibility = 'public')
    ))
    OR ${itemShareExists(alias, entityType, userParam)}
  )`;
}

/** The workspace-membership LEFT JOIN `objectAccessCondition` depends on. */
export function workspaceMembersJoin(alias: string, userParam = '$1'): string {
  return `LEFT JOIN workspace_members wm ON wm.workspace_id = ${alias}.workspace_id AND wm.user_id = ${userParam}`;
}

/**
 * Whether `userId` may READ a specific already-fetched list/timeline row —
 * the in-process equivalent of `objectAccessCondition`, for call sites that
 * already have the row (e.g. an attachment route joining through its parent)
 * and don't want a second round trip just to re-derive the same boolean.
 * `workspaceMemberIds` is the set of workspace ids the caller is a member of
 * (or owns/that are public) — callers that already resolved workspace access
 * elsewhere can pass a precomputed `isWorkspaceAccessible` instead of
 * re-querying `workspace_members` here.
 */
export function isObjectVisible(
  row: { user_id: string; is_public: boolean; workspace_id: string | null },
  userId: string,
  isWorkspaceAccessible: boolean,
  isItemShared: boolean
): boolean {
  if (row.user_id === userId) return true;
  if (row.is_public && (row.workspace_id === null || isWorkspaceAccessible)) return true;
  return isItemShared;
}
