// ---------------------------------------------------------------------------
// Item activity notifications — "everyone marked on or added to this board /
// page / timeline hears about changes to it".
//
// The targeted notification types (mention, item_tagged, item_invite) each name
// exactly one recipient the actor picked. This module covers the other half:
// activity that nobody addressed to anyone in particular, but that the people
// working on that item should still learn about — an item appearing on a shared
// board, a milestone moving, a page being edited.
//
// WHO COUNTS AS A COLLABORATOR
//   • the item's OWNER — always, even on a workspace-public item they never
//     explicitly invited anyone to,
//   • everyone INVITED to it (`item_shares`), directly or through a container
//     that was shared with them — resolved by listItemShares(), so a person who
//     reaches a board through a shared folder is included exactly as the People
//     tab shows them,
//   • everyone TAGGED on an item inside it (`task_tags`) — "marked" in the
//     user's words. For a markdown page that means its auto-managed Todo mirror,
//     which is where a page's tasks actually live.
//
// Deliberately NOT every workspace member: a workspace can have dozens of people
// who have never opened this board, and turning routine edits into a
// workspace-wide broadcast is how a notification feed becomes something people
// stop reading. Membership already grants VISIBILITY; being invited or tagged is
// what expresses involvement.
//
// Everything here is best-effort and never throws into the mutation that called
// it, the same contract mentions.ts and graph/inlineLinks.ts hold.
// ---------------------------------------------------------------------------

import { listItemShares, type SharedItemType } from './itemShares';
import { createNotification, type NotificationType } from './notifications';
import { query } from './db';

/** The item types that carry collaborative activity. A folder has no content of
 *  its own to change, so it is not one of them — activity on the things INSIDE
 *  a folder notifies through those items (and a folder invitee is picked up as
 *  an inherited member of each). */
export type CollaborativeItemType = Extract<SharedItemType, 'list' | 'timeline' | 'markdownList'>;

export interface ItemAudience {
  /** Everyone to notify, including the actor — callers pass this straight to
   *  createNotification, whose own actor===recipient guard drops them. */
  userIds: string[];
  ownerId: string | null;
  workspaceId: string | null;
  name: string;
}

const TABLES: Record<CollaborativeItemType, string> = {
  list: 'lists',
  timeline: 'timelines',
  markdownList: 'markdown_lists',
};

/**
 * Resolve the people involved with one item.
 *
 * Returns an empty audience (rather than throwing) for an item that no longer
 * exists — an activity notification is a side effect of a mutation that has
 * already committed, so there is nothing useful to fail into.
 */
export async function resolveItemAudience(
  type: CollaborativeItemType,
  itemId: string
): Promise<ItemAudience> {
  const empty: ItemAudience = { userIds: [], ownerId: null, workspaceId: null, name: '' };
  try {
    const row = await query<{ user_id: string; workspace_id: string | null; name: string; todo_list_id: string | null }>(
      `SELECT user_id, workspace_id, name${type === 'markdownList' ? ', todo_list_id' : ', NULL AS todo_list_id'}
         FROM ${TABLES[type]} WHERE id = $1`,
      [itemId]
    );
    const item = row.rows[0];
    if (!item) return empty;

    const recipients = new Set<string>();
    if (item.user_id) recipients.add(item.user_id);

    // Invited collaborators — direct and container-inherited alike.
    for (const member of await listItemShares(type, itemId)) recipients.add(member.userId);

    // Tagged users. For a page this is its Todo mirror list; a timeline has no
    // tag surface at all, so it contributes nobody here.
    const taggedListId = type === 'list' ? itemId : type === 'markdownList' ? item.todo_list_id : null;
    if (taggedListId) {
      const tagged = await query<{ user_id: string }>(
        `SELECT DISTINCT tt.user_id
           FROM task_tags tt JOIN tasks t ON t.id = tt.task_id
          WHERE t.list_id = $1`,
        [taggedListId]
      );
      for (const t of tagged.rows) recipients.add(t.user_id);
    }

    return {
      userIds: [...recipients],
      ownerId: item.user_id ?? null,
      workspaceId: item.workspace_id ?? null,
      name: item.name ?? '',
    };
  } catch (err) {
    console.error('🔔 ✗ resolveItemAudience failed', type, itemId, err);
    return empty;
  }
}

export interface NotifyItemActivityInput {
  itemType: CollaborativeItemType;
  itemId: string;
  /** Who made the change. Null for a system/automation actor — those still
   *  notify, they just have no name to attribute the change to. */
  actorId: string | null;
  type: NotificationType;
  /** Reads as a predicate after the actor's name, matching how the in-app feed
   *  row renders (`<b>Niels</b> added an item to "Roadmap"`). */
  title: string;
  body?: string | null;
  data?: Record<string, unknown>;
  /**
   * Coalescing window in seconds, or 0 for none.
   *
   * Page edits and milestone tweaks arrive in bursts — a person editing a
   * document produces a save every few seconds, and one notification per save
   * would make the feature unusable rather than useful. A non-zero window
   * derives a dedupeKey bucketed to it, so a burst from one actor on one item
   * produces exactly ONE notification per recipient per window. An ADD is
   * genuinely discrete and passes 0, since dropping items 2..n would hide real
   * events; the device-side collapse in push/send.ts is what keeps a bulk paste
   * from buzzing repeatedly.
   */
  coalesceSeconds?: number;
  /** Distinguishes bursts that should NOT merge with each other inside the same
   *  window (e.g. two different milestones on one timeline). */
  coalesceScope?: string;
}

/**
 * Notify every collaborator on an item about something that happened to it.
 *
 * The entity/deep-link target is always the ITEM, not the thing inside it, so a
 * tap lands on the board/page/timeline the person actually collaborates on.
 */
export async function notifyItemActivity(input: NotifyItemActivityInput): Promise<void> {
  try {
    const audience = await resolveItemAudience(input.itemType, input.itemId);
    if (audience.userIds.length === 0) return;

    const dedupeKey = buildCoalesceKey(input);
    for (const userId of audience.userIds) {
      await createNotification({
        userId,
        type: input.type,
        actorId: input.actorId,
        title: input.title,
        body: input.body ?? null,
        entityType: input.itemType,
        entityId: input.itemId,
        workspaceId: audience.workspaceId,
        data: { ...(input.data ?? {}), itemName: audience.name },
        dedupeKey,
      });
    }
  } catch (err) {
    console.error('🔔 ✗ notifyItemActivity failed', input.itemType, input.itemId, err);
  }
}

/** The bucketed dedupe key, or null when the caller wants every event through.
 *  Exported for unit tests — the bucketing is the whole reason a burst of edits
 *  produces one notification instead of forty, so it is worth pinning. */
export function buildCoalesceKey(
  input: Pick<NotifyItemActivityInput, 'type' | 'itemId' | 'actorId' | 'coalesceSeconds' | 'coalesceScope'>,
  now: number = Date.now()
): string | null {
  const window = input.coalesceSeconds ?? 0;
  if (window <= 0) return null;
  const bucket = Math.floor(now / (window * 1000));
  return `${input.type}:${input.itemId}:${input.coalesceScope ?? ''}:${input.actorId ?? 'system'}:${bucket}`;
}

/** A burst of edits from one person on one document collapses to a single
 *  notification per quarter hour — long enough to cover a real editing session,
 *  short enough that a change made an hour later still surfaces. */
export const PAGE_EDIT_COALESCE_SECONDS = 15 * 60;

/** Milestone edits coalesce per MILESTONE (see coalesceScope) on a shorter
 *  window: dragging a date around is a burst, but editing a second milestone
 *  five minutes later is genuinely a second event. */
export const MILESTONE_COALESCE_SECONDS = 5 * 60;
