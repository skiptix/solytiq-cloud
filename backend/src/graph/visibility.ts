// ---------------------------------------------------------------------------
// Graph-layer visibility — the single read boundary every entity_index /
// entity_links query must go through.
//
// An entity is visible to a user when they own it, are a member of its
// workspace, its workspace is public, or they were individually invited to it
// via item_shares (the existing "Shared with me" mechanism — see
// backend/src/itemShares.ts). This mirrors the in-app read boundary used by
// buildListsForUser/getListForUser et al. so the graph layer never shows more
// than the app itself would.
//
// Per the graph-layer design doc's security model: no route may query
// entity_links directly without joining through this boundary, and it applies
// identically to entity_index reads.
// ---------------------------------------------------------------------------

import type { QueryExec } from '../workspaceUtil';
import { query } from '../db';
import { isItemSharedWith } from '../itemShares';

/** SQL fragment: "<alias> (an entity_index row) is visible to $<userParamIndex>". */
export function visibleCondition(alias: string, userParamIndex: number): string {
  const p = `$${userParamIndex}`;
  return `(
    ${alias}.is_trashed = false
    AND (
         ${alias}.owner_id = ${p}
      OR EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = ${alias}.workspace_id AND wm.user_id = ${p})
      OR EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ${alias}.workspace_id AND w.visibility = 'public')
      OR EXISTS (SELECT 1 FROM item_shares s WHERE s.user_id = ${p} AND s.item_type = ${alias}.entity_type AND s.item_id = ${alias}.entity_id)
      OR (
        -- Inherited through a shared CONTAINER (see backend/src/itemShares.ts).
        -- This must mirror what canWriteEntity() grants below: a sublist of a
        -- board in a shared folder that is writable but invisible would 404 on
        -- read and never appear in the Net, entity search, or knowledge search.
        -- The leading guard has no correlation to the outer row, so the planner
        -- runs it once as an InitPlan and a user holding no invites at all
        -- never pays for the lookups below.
        EXISTS (SELECT 1 FROM item_shares sg WHERE sg.user_id = ${p})
        AND (
          (${alias}.entity_type = 'list' AND item_share_grants_list(${p}::uuid, ${alias}.entity_id))
          OR (${alias}.entity_type IN ('timeline', 'markdownList') AND EXISTS (
            SELECT 1 FROM item_shares sf
             WHERE sf.user_id = ${p} AND sf.item_type = 'folder'
               AND sf.item_id = (CASE ${alias}.entity_type
                    WHEN 'timeline'     THEN (SELECT t.folder_id FROM timelines t      WHERE t.id = ${alias}.entity_id)
                    WHEN 'markdownList' THEN (SELECT m.folder_id FROM markdown_lists m WHERE m.id = ${alias}.entity_id)
                  END)
          ))
        )
      )
    )
  )`;
}

/** Is this single entity visible to the user? Existence-safe (false for both "gone" and "not visible"). */
export async function isEntityVisible(
  exec: QueryExec,
  userId: string,
  entityType: string,
  entityId: string
): Promise<boolean> {
  const r = await exec(
    `SELECT 1 FROM entity_index e WHERE e.entity_type = $1 AND e.entity_id = $2 AND ${visibleCondition('e', 3)}`,
    [entityType, entityId, userId]
  );
  return r.rows.length > 0;
}

/**
 * Can this user WRITE to the entity — i.e. create/edit/delete a link FROM it?
 * Ownership (or admin) is always sufficient. For the three item-shareable
 * types (list/timeline/markdownList) a full-collaborator invite also counts,
 * matching the "Shared with me" content-write model in CLAUDE.md. Other entity
 * types (task/milestone/section/meeting/file/gpsFile) are single-owner in this
 * version — no per-item collaborator model exists for them yet.
 *
 * The two Knowledge Base types are the deliberate exception: a workspace has
 * exactly ONE Knowledge Base and it is a shared artifact of that workspace, not
 * of whoever happened to click "add". `entity_index.owner_id` for a KB entry is
 * the base's creator, so restricting writes to the owner would leave every
 * other member unable to author the very thing the feature exists for — so any
 * member of the KB's workspace may write it.
 */
export async function canWriteEntity(
  userId: string,
  isAdmin: boolean,
  entityType: string,
  entityId: string,
  exec: QueryExec = query
): Promise<boolean> {
  if (isAdmin) return true;
  const r = await exec(
    `SELECT owner_id, workspace_id FROM entity_index WHERE entity_type = $1 AND entity_id = $2 AND is_trashed = false`,
    [entityType, entityId]
  );
  const row = r.rows[0] as { owner_id: string; workspace_id: string | null } | undefined;
  if (!row) return false;
  if (row.owner_id === userId) return true;
  if (entityType === 'knowledgeBase' || entityType === 'knowledgeEntry') {
    if (!row.workspace_id) return false;
    const member = await exec(
      `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [row.workspace_id, userId]
    );
    return member.rows.length > 0;
  }
  if (entityType === 'list' || entityType === 'timeline' || entityType === 'markdownList') {
    // Delegates so the graph layer resolves the SAME containment cascade the
    // app's own write checks do (a board inside a shared folder, a sublist of a
    // shared board) instead of matching only the exact row someone was invited
    // to — see backend/src/itemShares.ts.
    return isItemSharedWith(entityType, entityId, userId, exec);
  }
  return false;
}
