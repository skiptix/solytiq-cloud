// ---------------------------------------------------------------------------
// /api/item-shares — manage per-item invitations (the "Invite people" control
// on a list / timeline / markdown page, and the "share just this item" half of
// the tag/mention prompt), plus /api/shared-with-me for discovery.
//
//   GET    /api/item-shares/:itemType/:itemId/members         → invited users
//   POST   /api/item-shares/:itemType/:itemId/members {username}
//   DELETE /api/item-shares/:itemType/:itemId/members/:userId
//   GET    /api/shared-with-me                                → items shared with me
//
// Only the item's owner (or an admin) can invite/remove; any user who can see
// the item can read its member list. A new invite notifies the invited user.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from 'express';
import { query } from '../db';
import { authenticate } from '../middleware';
import { werr } from '../workspaceUtil';
import { createNotification } from '../notifications';
import { addItemShare, removeItemShare, listItemShares, type SharedItemType } from '../itemShares';
import { getListForUser } from './lists';
import { getTimelineForUser } from './timelines';
import { getMarkdownListForUser } from './markdownLists';

const router = Router();
router.use(authenticate);

const TYPE_TABLE: Record<SharedItemType, string> = {
  list: 'lists',
  timeline: 'timelines',
  markdownList: 'markdown_lists',
};

function parseType(raw: string): SharedItemType | null {
  return raw === 'list' || raw === 'timeline' || raw === 'markdownList' ? raw : null;
}

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
  return (await getMarkdownListForUser(userId, itemId)) !== null;
}

// GET /api/item-shares/:itemType/:itemId/members
router.get('/item-shares/:itemType/:itemId/members', async (req: Request, res: Response) => {
  try {
    const type = parseType(req.params.itemType);
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
router.post('/item-shares/:itemType/:itemId/members', async (req: Request, res: Response) => {
  try {
    const type = parseType(req.params.itemType);
    if (!type) { res.status(400).json({ error: 'Invalid item type' }); return; }
    const { itemId } = req.params;
    const { username } = req.body as { username?: string };
    if (!username || !username.trim()) { res.status(400).json({ error: 'username is required' }); return; }

    const meta = await getItemMeta(type, itemId);
    if (!meta) { res.status(404).json({ error: 'Item not found' }); return; }
    // Only the owner (or an admin) may invite.
    if (meta.ownerId !== req.userId && !req.user?.isAdmin) {
      res.status(403).json({ error: 'Only the owner can invite people to this item' });
      return;
    }

    const userRes = await query<{ id: string; username: string }>(
      'SELECT id, username FROM users WHERE username = $1', [username.trim()]
    );
    if (userRes.rows.length === 0) { res.status(404).json({ error: 'User not found' }); return; }
    const invitee = userRes.rows[0];
    if (invitee.id === meta.ownerId) { res.status(400).json({ error: 'The owner already has access' }); return; }

    const created = await addItemShare(type, itemId, invitee.id, req.userId!);
    if (created) {
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
router.delete('/item-shares/:itemType/:itemId/members/:userId', async (req: Request, res: Response) => {
  try {
    const type = parseType(req.params.itemType);
    if (!type) { res.status(400).json({ error: 'Invalid item type' }); return; }
    const { itemId, userId } = req.params;
    const meta = await getItemMeta(type, itemId);
    if (!meta) { res.status(404).json({ error: 'Item not found' }); return; }
    // Owner/admin can remove anyone; an invited user can remove themselves.
    if (meta.ownerId !== req.userId && !req.user?.isAdmin && userId !== req.userId) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }
    await removeItemShare(type, itemId, userId);
    res.json({ members: await listItemShares(type, itemId) });
  } catch (err) {
    werr('item-shares DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/shared-with-me — every list/timeline/markdown list this user has been
// INVITED to (they aren't the owner), fully hydrated so the client can render
// them exactly like their own items, independent of the active workspace.
router.get('/shared-with-me', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const shares = await query<{ item_type: string; item_id: string }>(
      `SELECT item_type, item_id FROM item_shares WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );

    const lists: unknown[] = [];
    const timelines: unknown[] = [];
    const markdownLists: unknown[] = [];
    for (const s of shares.rows) {
      if (s.item_type === 'list') {
        const l = await getListForUser(userId, s.item_id);
        if (l) lists.push(l);
      } else if (s.item_type === 'timeline') {
        const t = await getTimelineForUser(userId, s.item_id);
        if (t) timelines.push(t);
      } else if (s.item_type === 'markdownList') {
        const m = await getMarkdownListForUser(userId, s.item_id);
        if (m) markdownLists.push(m);
      }
    }
    res.json({ lists, timelines, markdownLists });
  } catch (err) {
    werr('shared-with-me GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
