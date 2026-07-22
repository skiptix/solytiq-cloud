// ---------------------------------------------------------------------------
// @-mention parsing + notification.
//
// Mentions are authored as plain `@username` tokens inside a note or a markdown
// block's text — no UUIDs are ever embedded in user-visible text, so the raw
// content stays clean and renders normally. On save, we extract the mentioned
// usernames, resolve them ONLY against the item's workspace members (the
// members-only access model: you can only mention someone who can already see
// the item), diff against what was mentioned before, and notify the newly
// added ones. Diffing against the prior text is what keeps a re-save from
// re-notifying the same people.
//
// The resolver is a pure lookup — a mention token can only ever match an
// existing workspace member's username or fail; it can never inject SQL or
// reach a user outside the workspace.
// ---------------------------------------------------------------------------

import { query } from './db';
import { createNotification, NotificationType } from './notifications';

// Usernames in this app are word-ish (letters/digits/underscore, plus . and -).
// We capture a conservative token and match it case-insensitively against real
// members, so trailing punctuation simply fails to resolve rather than
// mis-resolving.
const MENTION_RE = /(?:^|[^\w@])@([A-Za-z0-9_.-]{1,50})/g;

/** Extract the distinct, lower-cased usernames mentioned in a blob of text. */
export function extractMentionUsernames(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(text)) !== null) {
    // Trim trailing dots/dashes that are more likely punctuation than username.
    const raw = m[1].replace(/[.\-]+$/, '');
    if (raw) out.add(raw.toLowerCase());
  }
  return out;
}

export interface MentionShareScope {
  itemType: 'list' | 'timeline' | 'markdownList';
  itemId: string;
}

/**
 * Resolve a set of mentioned usernames to real user ids that are not the actor
 * and can actually see the item — i.e. they are a member of the item's
 * workspace OR they've been invited to the specific item (item_shares). A note
 * in a personal (no-workspace) item can still mention someone it's been shared
 * with. Nothing resolves when there's neither a workspace nor a share scope.
 */
export async function resolveMentionUserIds(
  workspaceId: string | null,
  usernames: Set<string>,
  actorId: string,
  shareItem?: MentionShareScope | null
): Promise<string[]> {
  if (usernames.size === 0 || (!workspaceId && !shareItem)) return [];
  const lower = [...usernames];
  const rows = await query<{ id: string }>(
    `SELECT u.id
       FROM users u
      WHERE LOWER(u.username) = ANY($1::text[])
        AND u.id <> $2
        AND (
          ($3::text IS NOT NULL AND EXISTS (
            SELECT 1 FROM workspace_members wm WHERE wm.user_id = u.id AND wm.workspace_id = $3
          ))
          OR ($4::text IS NOT NULL AND $5::text IS NOT NULL AND EXISTS (
            SELECT 1 FROM item_shares s WHERE s.user_id = u.id AND s.item_type = $4 AND s.item_id = $5
          ))
        )`,
    [lower, actorId, workspaceId, shareItem?.itemType ?? null, shareItem?.itemId ?? null]
  );
  return rows.rows.map((r) => r.id);
}

/**
 * Compute who is NEWLY mentioned (present in `after`, absent from `before`) and
 * notify each. Best-effort; never throws into the mutation that called it.
 */
export async function notifyNewMentions(opts: {
  beforeText: string | null | undefined;
  afterText: string | null | undefined;
  workspaceId: string | null;
  actorId: string;
  title: string;
  body?: string | null;
  entityType: string;
  entityId: string;
  data?: Record<string, unknown>;
  type?: NotificationType;
  /** The item whose invitees (item_shares) may also be mentioned, beyond workspace members. */
  shareItem?: MentionShareScope | null;
}): Promise<void> {
  try {
    const before = extractMentionUsernames(opts.beforeText);
    const after = extractMentionUsernames(opts.afterText);
    const added = new Set([...after].filter((u) => !before.has(u)));
    if (added.size === 0) return;

    const userIds = await resolveMentionUserIds(opts.workspaceId, added, opts.actorId, opts.shareItem);
    for (const userId of userIds) {
      await createNotification({
        userId,
        type: opts.type ?? 'mention',
        actorId: opts.actorId,
        title: opts.title,
        body: opts.body ?? null,
        entityType: opts.entityType,
        entityId: opts.entityId,
        workspaceId: opts.workspaceId,
        data: opts.data,
      });
    }
  } catch (err) {
    console.error('🔔 ✗ notifyNewMentions failed', opts.entityType, opts.entityId, err);
  }
}
