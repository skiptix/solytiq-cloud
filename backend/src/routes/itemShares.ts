// ---------------------------------------------------------------------------
// /api/item-shares — manage per-item invitations (the "Invite people" control
// on a folder / list / timeline / markdown page, and the "share just this item"
// half of the tag/mention prompt), plus /api/shared-with-me for discovery.
//
//   GET    /api/item-shares/:itemType/:itemId/members         → invited users
//   POST   /api/item-shares/:itemType/:itemId/members {username}
//   DELETE /api/item-shares/:itemType/:itemId/members/:userId
//   GET    /api/shared-with-me                                → items shared with me
//
// Only the item's owner (or an admin) can invite/remove; any user who can see
// the item can read its member list. A new invite notifies the invited user.
//
// Inviting someone to a FOLDER hands them everything inside it — boards,
// timelines and markdown pages alike, including ones added later. The cascade
// is resolved at read/write time from the containment tree rather than
// materialized as per-item rows; see backend/src/itemShares.ts's header.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from 'express';
import { query } from '../db';
import { authenticate } from '../middleware';
import { werr } from '../workspaceUtil';
import { createNotification } from '../notifications';
import {
  addItemShare, removeItemShare, listItemShares, getSharedItemIdsForUser, directShareExists,
  parseSharedItemType, type SharedItemType,
} from '../itemShares';
import { getListForUser, getListsForUserBatch } from './lists';
import { getTimelineForUser, getTimelinesForUserBatch } from './timelines';
import { getMarkdownListForUser } from './markdownLists';
import { getFolderForUser, getFoldersForUserBatch } from './folders';

const router = Router();
// NOTE: this router is mounted at the broad `/api` prefix (see index.ts) so it
// can serve both `/api/item-shares/*` and `/api/shared-with-me`. It therefore
// MUST NOT use a blanket `router.use(authenticate)` — that would run on every
// `/api/*` request that reaches this mount, including the public, intentionally
// unauthenticated `/api/share/*` endpoints registered after it, 401ing every
// anonymous share visitor before the public handler is ever reached. Auth is
// applied per-route instead, so a non-matching path (e.g. `/api/share/folder`)
// falls straight through to the next handler.

const TYPE_TABLE: Record<SharedItemType, string> = {
  list: 'lists',
  timeline: 'timelines',
  markdownList: 'markdown_lists',
  folder: 'folders',
};

interface ItemMeta { ownerId: string; workspaceId: string | null; name: string }

async function getItemMeta(type: SharedItemType, itemId: string): Promise<ItemMeta | null> {
  const table = TYPE_TABLE[type]; // fixed literal from the map — never user input
  const r = await query<{ user_id: string; workspace_id: string | null; name: string }>(
    `SELECT user_id, workspace_id, name FROM ${table} WHERE id = $1`,
    [itemId]
  );
  if (r.rows.length === 0) return null;
  return { ownerId: r.rows[0].user_id, workspaceId: r.rows[0].workspace_id, name: r.rows[0].name };
}

/** Can this user SEE the item at all? Uses the same per-item read boundary the
 *  item's own GET does (owner / workspace-visible / invited). */
async function canViewItem(type: SharedItemType, itemId: string, userId: string): Promise<boolean> {
  if (type === 'list') return (await getListForUser(userId, itemId)) !== null;
  if (type === 'timeline') return (await getTimelineForUser(userId, itemId)) !== null;
  if (type === 'folder') return (await getFolderForUser(userId, itemId)) !== null;
  return (await getMarkdownListForUser(userId, itemId)) !== null;
}

// GET /api/item-shares/:itemType/:itemId/members
router.get('/item-shares/:itemType/:itemId/members', authenticate, async (req: Request, res: Response) => {
  try {
    const type = parseSharedItemType(req.params.itemType);
    if (!type) { res.status(400).json({ error: 'Invalid item type' }); return; }
    const { itemId } = req.params;
    const meta = await getItemMeta(type, itemId);
    if (!meta) { res.status(404).json({ error: 'Item not found' }); return; }
    if (!(await canViewItem(type, itemId, req.userId!)) && !req.user?.isAdmin) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    res.json({ ownerId: meta.ownerId, members: await listItemShares(type, itemId) });
  } catch (err) {
    werr('item-shares GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/item-shares/:itemType/:itemId/members  { username }
router.post('/item-shares/:itemType/:itemId/members', authenticate, async (req: Request, res: Response) => {
  try {
    const type = parseSharedItemType(req.params.itemType);
    if (!type) { res.status(400).json({ error: 'Invalid item type' }); return; }
    const { itemId } = req.params;
    const { username, includeAll } = req.body as { username?: string; includeAll?: boolean };
    if (!username || !username.trim()) { res.status(400).json({ error: 'username is required' }); return; }
    // Folder invites carry a scope: everything inside, or the folder alone.
    // Meaningless for the other types, so it is not read for them.
    const scopeIncludeAll = type === 'folder' ? includeAll !== false : true;

    const meta = await getItemMeta(type, itemId);
    if (!meta) { res.status(404).json({ error: 'Item not found' }); return; }
    // Only the owner (or an admin) may invite.
    if (meta.ownerId !== req.userId && !req.user?.isAdmin) {
      res.status(403).json({ error: 'Only the owner can invite people to this item' });
      return;
    }

    const userRes = await query<{ id: string; username: string }>(
      'SELECT id, username FROM users WHERE LOWER(username) = LOWER($1)', [username.trim()]
    );
    if (userRes.rows.length === 0) { res.status(404).json({ error: 'User not found' }); return; }
    const invitee = userRes.rows[0];
    if (invitee.id === meta.ownerId) { res.status(400).json({ error: 'The owner already has access' }); return; }

    // Distinguish a first-time invite from a scope change on an existing
    // member: both write a row, but only the former is news to the invitee.
    const alreadyMember = await directShareExists(type, itemId, invitee.id);
    await addItemShare(type, itemId, invitee.id, req.userId!, scopeIncludeAll);
    if (!alreadyMember) {
      await createNotification({
        userId: invitee.id,
        type: 'item_invite',
        actorId: req.userId!,
        title: `invited you to "${meta.name}"`,
        body: null,
        entityType: type,
        entityId: itemId,
        workspaceId: meta.workspaceId,
        data: { itemName: meta.name, itemType: type },
      });
    }
    res.status(201).json({ members: await listItemShares(type, itemId) });
  } catch (err) {
    werr('item-shares POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/item-shares/:itemType/:itemId/members/:userId
router.delete('/item-shares/:itemType/:itemId/members/:userId', authenticate, async (req: Request, res: Response) => {
  try {
    const type = parseSharedItemType(req.params.itemType);
    if (!type) { res.status(400).json({ error: 'Invalid item type' }); return; }
    const { itemId, userId } = req.params;
    const meta = await getItemMeta(type, itemId);
    if (!meta) { res.status(404).json({ error: 'Item not found' }); return; }
    const privileged = meta.ownerId === req.userId || req.user?.isAdmin === true;
    // Owner/admin can remove anyone; anyone else may only remove THEIR OWN share.
    if (!privileged && userId !== req.userId) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }
    const removed = await removeItemShare(type, itemId, userId);
    // A non-privileged caller who wasn't actually a member gets nothing back —
    // otherwise a self-removal "probe" would leak the roster of any item.
    if (!privileged && !removed) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }
    res.json({ members: privileged ? await listItemShares(type, itemId) : [] });
  } catch (err) {
    werr('item-shares DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/shared-with-me — every folder/list/timeline/markdown page this user
// has been INVITED to (they aren't the owner), fully hydrated so the client can
// render them exactly like their own items, independent of the active workspace.
//
// A folder invite contributes the folder itself AND everything currently inside
// it, so the sidebar can group the contents under their folder without knowing
// the cascade rules. Deeper containment (sublists, a page's Todo mirror) is
// intentionally left out: those are reachable, but they render nested under an
// item that is already in this payload, never as a top-level row.
router.get('/shared-with-me', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const ids = await getSharedItemIdsForUser(userId);

    // Hydrate through each type's BATCH per-user builder — a second,
    // independent access check, in one query per type. One folder invite can
    // expand to every board in that folder, and this endpoint re-fires on
    // focus, on an invite notification, and ~300ms after any mutation, so the
    // per-id variants would mean hundreds of round trips on a routine refresh.
    // An id the caller can no longer see is simply absent from the returned Map
    // — deleted, moved out of the shared folder, or the invite revoked.
    const [folders, lists, timelines, markdownLists] = await Promise.all([
      getFoldersForUserBatch(userId, ids.folders),
      getListsForUserBatch(userId, ids.lists),
      getTimelinesForUserBatch(userId, ids.timelines),
      // Markdown pages have no batch builder (their detail payload is a single
      // JSONB document, so there is no N+1 join fan-out to collapse).
      Promise.all(ids.markdownLists.map((id) => getMarkdownListForUser(userId, id))),
    ]);
    // Preserve the order getSharedItemIdsForUser returned (most recent invite
    // first, then folder contents) rather than the Map's insertion order.
    const ordered = <T>(idList: string[], map: Map<string, T>): T[] =>
      idList.map((id) => map.get(id)).filter((x): x is T => x !== undefined);
    res.json({
      folders: ordered(ids.folders, folders),
      lists: ordered(ids.lists, lists),
      timelines: ordered(ids.timelines, timelines),
      markdownLists: markdownLists.filter(Boolean),
    });
  } catch (err) {
    werr('shared-with-me GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
