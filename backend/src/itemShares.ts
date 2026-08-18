// ---------------------------------------------------------------------------
// Per-item invitations ("Shared with me").
//
// A single `item_shares` table grants a specific user access to ONE folder,
// list, timeline, or markdown page — independent of workspace membership. This
// is the "share just this item" half of the tag/mention prompt, and the
// standalone "Invite people" control on a folder/list/timeline/markdown page.
//
// Access model: an invited user is a FULL COLLABORATOR — they can view AND edit
// the item's content (tasks/milestones/blocks), exactly like the owner, but the
// owner alone manages the item itself (rename/visibility/sharing/delete/invites).
//
// CASCADE — a share is granted on ONE row but RESOLVED over the containment
// tree, so "share a folder and everything in it comes along" needs no fan-out
// rows and no re-sync when an item moves in or out later:
//
//   folder        → every list / timeline / markdown page whose `folder_id`
//                   points at it (including ones added AFTER the invite)
//   markdown page → its auto-managed Todo mirror list (`todo_list_id`)
//   list          → its sublists, recursively (`lists.parent_task_id` → the
//                   owning task → that task's list)
//
// Grants are therefore always stored where the human clicked "invite" and are
// revoked the same way; moving a board out of a shared folder revokes access to
// it by construction, with no cleanup pass to forget to run.
//
// The table is polymorphic (`item_type` + `item_id`), so there's no FK on
// item_id; the item's own delete path calls deleteItemShares() to clean up.
// ---------------------------------------------------------------------------

import { query } from './db';
import type { QueryExec } from './workspaceUtil';

export type SharedItemType = 'list' | 'timeline' | 'markdownList' | 'folder';

export const SHARED_ITEM_TYPES: readonly SharedItemType[] = ['list', 'timeline', 'markdownList', 'folder'];

/** Narrow an untrusted string (a route param) to a shareable item type. */
export function parseSharedItemType(raw: string): SharedItemType | null {
  return (SHARED_ITEM_TYPES as readonly string[]).includes(raw) ? (raw as SharedItemType) : null;
}

/**
 * SQL fragment: "this user has been invited to <alias>, directly or through a
 * container that was shared with them". Drop it into a read access-condition,
 * e.g. `${accessCondition} OR ${itemShareExists('l', 'list')}`.
 * `userParam` must reference the same bound user id the surrounding query uses
 * (defaults to `$1`).
 *
 * REQUIRED COLUMNS on `alias`: `id` always; `folder_id` for the three non-folder
 * types (present on all three tables); `parent_task_id` additionally for `list`.
 * All callers alias the real table, not a projection — keep it that way.
 *
 * The leading `EXISTS (… WHERE s0.user_id = …)` guard is not redundant: it has
 * no correlation to the outer row, so the planner evaluates it ONCE as an
 * InitPlan. Users with no invitations at all — the overwhelming majority on a
 * typical instance — therefore pay a single index probe for the whole scan
 * instead of a per-row containment walk.
 */
export function itemShareExists(alias: string, type: SharedItemType, userParam = '$1'): string {
  // `type` is a fixed literal from this file — never user input — so inlining it
  // is injection-safe and keeps the parameter list of callers unchanged.
  const anyShare = `EXISTS (SELECT 1 FROM item_shares s0 WHERE s0.user_id = ${userParam})`;

  // A folder is the top of the containment tree — nothing contains it, so a
  // folder share is only ever direct.
  if (type === 'folder') {
    return `(${anyShare} AND EXISTS (
      SELECT 1 FROM item_shares s
       WHERE s.user_id = ${userParam} AND s.item_type = 'folder' AND s.item_id = ${alias}.id
    ))`;
  }

  // Timelines and markdown pages have exactly one container (a folder), so a
  // plain two-way EXISTS covers them. `alias.folder_id` is NULL for a root
  // item, which simply never matches a folder share.
  const directOrFolder = (t: SharedItemType) => `EXISTS (
      SELECT 1 FROM item_shares s
       WHERE s.user_id = ${userParam}
         AND ((s.item_type = '${t}' AND s.item_id = ${alias}.id)
           OR (s.item_type = 'folder'  AND s.item_id = ${alias}.folder_id AND s.include_all))
    )`;
  if (type !== 'list') return `(${anyShare} AND ${directOrFolder(type)})`;

  // Lists are the one type whose containment is unbounded (a sublist of a
  // sublist of …), so their walk lives in a DB function — a correlated
  // `WITH RECURSIVE` is not permitted inside a subquery in PostgreSQL, and one
  // definition beats re-deriving the same recursion at 20+ call sites.
  //
  // The two cheap, non-recursive branches come FIRST and are not merely a
  // shortcut: they mean the recursion runs only for rows that are actually
  // sublists (`parent_task_id IS NOT NULL`). A listing query scans mostly
  // top-level boards, and those now resolve on an index probe — otherwise
  // every collaborator (anyone past the InitPlan guard above) would pay a
  // recursive walk per row on every list query in the app.
  return `(${anyShare} AND (
    ${directOrFolder('list')}
    OR EXISTS (
      SELECT 1 FROM markdown_lists m
       WHERE m.todo_list_id = ${alias}.id
         AND EXISTS (
           SELECT 1 FROM item_shares s2
            WHERE s2.user_id = ${userParam}
              AND ((s2.item_type = 'markdownList' AND s2.item_id = m.id)
                OR (s2.item_type = 'folder'       AND s2.item_id = m.folder_id AND s2.include_all))
         )
    )
    OR (${alias}.parent_task_id IS NOT NULL AND item_share_grants_list(${userParam}::uuid, ${alias}.id))
  ))`;
}

/**
 * Is this user invited to this specific item — directly, or via a folder /
 * parent list / owning markdown page that was shared with them?
 *
 * This is the in-process twin of `itemShareExists` and MUST stay equivalent to
 * it: reads go through the SQL fragment, writes through this function, and a
 * user who can open a board but not edit it (or vice versa) is a bug in one of
 * the two. Both resolve the same containment tree, and the `list` case calls
 * the very same DB function.
 */
export async function isItemSharedWith(
  type: SharedItemType,
  itemId: string,
  userId: string,
  exec: QueryExec = query
): Promise<boolean> {
  if (type === 'list') {
    const r = await exec(`SELECT item_share_grants_list($1::uuid, $2) AS granted`, [userId, itemId]);
    return (r.rows[0] as { granted: boolean } | undefined)?.granted === true;
  }
  if (type === 'folder') {
    const r = await exec(
      `SELECT 1 FROM item_shares WHERE item_type = 'folder' AND item_id = $1 AND user_id = $2`,
      [itemId, userId]
    );
    return r.rows.length > 0;
  }
  const table = type === 'timeline' ? 'timelines' : 'markdown_lists';
  const r = await exec(
    `SELECT 1 FROM ${table} x
      WHERE x.id = $1
        AND EXISTS (
          SELECT 1 FROM item_shares s
           WHERE s.user_id = $2
             AND ((s.item_type = $3 AND s.item_id = x.id)
               OR (s.item_type = 'folder' AND s.item_id = x.folder_id AND s.include_all))
        )`,
    [itemId, userId, type]
  );
  return r.rows.length > 0;
}

/**
 * Grant a user access to an item. Idempotent. Returns true if a NEW row was
 * created (i.e. whether this is a first-time invite worth notifying about).
 *
 * `includeAll` is meaningful for FOLDER invites only — see the column comment in
 * migrations.ts. Re-inviting someone who is already a member updates their
 * scope rather than erroring, so the UI can offer "switch this person to
 * folder-only" through the same call and never has to special-case an existing
 * member.
 */
export async function addItemShare(
  type: SharedItemType,
  itemId: string,
  userId: string,
  invitedBy: string,
  includeAll = true
): Promise<boolean> {
  const r = await query(
    `INSERT INTO item_shares (item_type, item_id, user_id, invited_by, include_all)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (item_type, item_id, user_id)
       DO UPDATE SET include_all = EXCLUDED.include_all
       WHERE item_shares.include_all IS DISTINCT FROM EXCLUDED.include_all`,
    [type, itemId, userId, invitedBy, includeAll]
  );
  // A no-op re-invite reports 0 rows; a scope CHANGE reports 1 but is not a new
  // member, so callers must not treat rowCount alone as "newly invited".
  return (r.rowCount ?? 0) > 0;
}

/** Is this user already a member of this exact item (a DIRECT grant)? Lets the
 *  invite route tell a first-time invite from a scope change, since
 *  `addItemShare` reports a row was written for both. */
export async function directShareExists(type: SharedItemType, itemId: string, userId: string): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM item_shares WHERE item_type = $1 AND item_id = $2 AND user_id = $3`,
    [type, itemId, userId]
  );
  return r.rows.length > 0;
}

/** Revoke a user's access to an item. Returns true if a row was actually removed.
 *  Only ever removes the DIRECT grant on this item — an inherited one is revoked
 *  where it was granted (on the folder / parent list), which is also the only
 *  place it is visible as a member row. */
export async function removeItemShare(type: SharedItemType, itemId: string, userId: string): Promise<boolean> {
  const r = await query(`DELETE FROM item_shares WHERE item_type = $1 AND item_id = $2 AND user_id = $3`, [type, itemId, userId]);
  return (r.rowCount ?? 0) > 0;
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
  /**
   * Where this person's access comes from. `direct` = invited to this exact
   * item and removable here; `inherited` = it came from a container (the folder
   * the item sits in, an ancestor board, or the markdown page this is the Todo
   * mirror of), shown read-only so the roster explains itself rather than
   * offering a Remove button that would silently do nothing.
   */
  via: 'direct' | 'inherited';
  /** For `via: 'inherited'`, the container that granted access. */
  viaName?: string;
  viaType?: SharedItemType;
  /** FOLDER invites only: does this person also get everything inside the
   *  folder, or just the folder itself? */
  includeAll?: boolean;
}

/**
 * The containers whose share rows also grant access to `itemId` — i.e. every
 * place a person listed on this item might actually have been invited. For a
 * list this is the full ancestry (parent boards, each one's folder, and the
 * markdown page this is a Todo mirror of, plus that page's folder); for the
 * other types it is simply the folder it sits in.
 *
 * Deliberately mirrors what `itemShareExists` RESOLVES. If the two ever
 * disagree, the People tab starts lying about who can edit something — which is
 * worse than showing nothing, because it reads as authoritative.
 */
const CONTAINERS_CTE = `
  WITH RECURSIVE anc(list_id, folder_id, parent_task_id, lvl) AS (
    SELECT l.id, l.folder_id, l.parent_task_id, 0 FROM lists l WHERE l.id = $1
    UNION ALL
    SELECT pl.id, pl.folder_id, pl.parent_task_id, anc.lvl + 1
      FROM anc
      JOIN tasks pt ON pt.id = anc.parent_task_id
      JOIN lists pl ON pl.id = pt.list_id
     WHERE anc.lvl < 16
  ),
  containers(item_type, item_id, name) AS (
    -- Ancestor boards (lvl > 0 skips the item itself; a direct share on it is
    -- already reported as 'direct').
    SELECT 'list', al.id, al.name FROM anc JOIN lists al ON al.id = anc.list_id WHERE anc.lvl > 0
    UNION
    SELECT 'folder', f.id, f.name FROM anc JOIN folders f ON f.id = anc.folder_id
    UNION
    SELECT 'markdownList', m.id, m.name FROM anc JOIN markdown_lists m ON m.todo_list_id = anc.list_id
    UNION
    SELECT 'folder', mf.id, mf.name
      FROM anc JOIN markdown_lists m ON m.todo_list_id = anc.list_id
      JOIN folders mf ON mf.id = m.folder_id
  )`;

/** A container only confers access when it actually cascades — a folder invite
 *  scoped to "just the folder" grants nothing to the items inside it. */
const CONTAINER_CASCADES = `(c.item_type <> 'folder' OR s.include_all)`;

/** Everyone invited to an item (joined to user profile basics), including the
 *  people who reach it through a container that was shared with them. */
export async function listItemShares(type: SharedItemType, itemId: string): Promise<ItemShareMember[]> {
  const direct = await query<{ user_id: string; username: string; full_name: string | null; has_image: boolean; invited_by: string | null; created_at: string; include_all: boolean }>(
    `SELECT s.user_id, u.username, u.full_name, (u.profile_image IS NOT NULL) AS has_image, s.invited_by, s.created_at, s.include_all
       FROM item_shares s JOIN users u ON u.id = s.user_id
      WHERE s.item_type = $1 AND s.item_id = $2
      ORDER BY s.created_at ASC`,
    [type, itemId]
  );
  const members: ItemShareMember[] = direct.rows.map((x) => ({
    userId: x.user_id,
    username: x.username,
    fullName: x.full_name ?? null,
    hasImage: x.has_image,
    invitedBy: x.invited_by ?? null,
    createdAt: x.created_at,
    via: 'direct',
    includeAll: x.include_all,
  }));

  // Nothing contains a folder, so its roster is exactly its direct invitees.
  if (type === 'folder') return members;

  const selectInherited = `SELECT s.user_id, u.username, u.full_name, (u.profile_image IS NOT NULL) AS has_image,
            s.invited_by, s.created_at, c.name AS via_name, c.item_type AS via_type
       FROM containers c
       JOIN item_shares s ON s.item_type = c.item_type AND s.item_id = c.item_id
       JOIN users u ON u.id = s.user_id
      WHERE ${CONTAINER_CASCADES}
      ORDER BY s.created_at ASC`;

  const inherited = type === 'list'
    ? await query<{ user_id: string; username: string; full_name: string | null; has_image: boolean; invited_by: string | null; created_at: string; via_name: string; via_type: string }>(
        `${CONTAINERS_CTE} ${selectInherited}`, [itemId]
      )
    : await query<{ user_id: string; username: string; full_name: string | null; has_image: boolean; invited_by: string | null; created_at: string; via_name: string; via_type: string }>(
        `WITH containers(item_type, item_id, name) AS (
           SELECT 'folder', f.id, f.name
             FROM ${type === 'timeline' ? 'timelines' : 'markdown_lists'} x
             JOIN folders f ON f.id = x.folder_id
            WHERE x.id = $1
         ) ${selectInherited}`, [itemId]
      );

  // De-duped, direct first: someone invited both ways stays removable here.
  const seen = new Set(members.map((m) => m.userId));
  for (const x of inherited.rows) {
    if (seen.has(x.user_id)) continue;
    seen.add(x.user_id);
    members.push({
      userId: x.user_id,
      username: x.username,
      fullName: x.full_name ?? null,
      hasImage: x.has_image,
      invitedBy: x.invited_by ?? null,
      createdAt: x.created_at,
      via: 'inherited',
      viaName: x.via_name,
      viaType: x.via_type as SharedItemType,
    });
  }
  return members;
}

/** Every item id this user reaches through an invitation, grouped by type.
 *  Folder shares are expanded to the folder's own contents so "Shared with me"
 *  lists them without the caller re-deriving the cascade. Sublists and a
 *  markdown page's Todo mirror are deliberately NOT expanded here — they are
 *  reachable (see `itemShareExists`) but are nested UNDER something already in
 *  this result, and would render as bogus top-level rows in the sidebar. */
export async function getSharedItemIdsForUser(userId: string): Promise<{
  folders: string[];
  lists: string[];
  timelines: string[];
  markdownLists: string[];
}> {
  const rows = await query<{ item_type: string; item_id: string; include_all: boolean }>(
    `SELECT item_type, item_id, include_all FROM item_shares WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  const out = { folders: [] as string[], lists: [] as string[], timelines: [] as string[], markdownLists: [] as string[] };
  // A folder invite scoped to "just the folder" still lists the folder — it is
  // a real grant and the person should see it — but contributes no contents.
  const cascadingFolders: string[] = [];
  for (const r of rows.rows) {
    if (r.item_type === 'folder') {
      out.folders.push(r.item_id);
      if (r.include_all) cascadingFolders.push(r.item_id);
    }
    else if (r.item_type === 'list') out.lists.push(r.item_id);
    else if (r.item_type === 'timeline') out.timelines.push(r.item_id);
    else if (r.item_type === 'markdownList') out.markdownLists.push(r.item_id);
  }
  if (cascadingFolders.length === 0) return out;

  const contents = await query<{ kind: string; id: string }>(
    `SELECT 'list' AS kind, id FROM lists          WHERE folder_id = ANY($1::varchar[])
     UNION ALL
     SELECT 'timeline',      id FROM timelines     WHERE folder_id = ANY($1::varchar[])
     UNION ALL
     SELECT 'markdownList',  id FROM markdown_lists WHERE folder_id = ANY($1::varchar[])`,
    [cascadingFolders]
  );
  const push = (arr: string[], id: string) => { if (!arr.includes(id)) arr.push(id); };
  for (const c of contents.rows) {
    if (c.kind === 'list') push(out.lists, c.id);
    else if (c.kind === 'timeline') push(out.timelines, c.id);
    else push(out.markdownLists, c.id);
  }
  return out;
}
