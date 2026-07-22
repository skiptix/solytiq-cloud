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

/**
 * Resolve a set of mentioned usernames to real user ids that are BOTH members
 * of the given workspace AND not the actor. A null workspace (personal/global
 * items) has no other members, so nothing resolves — the safe default.
 */
export async function resolveMentionUserIds(
  workspaceId: string | null,
  usernames: Set<string>,
  actorId: string
): Promise<string[]> {
  if (!workspaceId || usernames.size === 0) return [];
  const lower = [...usernames];
  const rows = await query<{ id: string }>(
    `SELECT u.id
       FROM users u
       JOIN workspace_members wm ON wm.user_id = u.id
      WHERE wm.workspace_id = $1
        AND LOWER(u.username) = ANY($2::text[])
        AND u.id <> $3`,
    [workspaceId, lower, actorId]
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
}): Promise<void> {
  try {
    const before = extractMentionUsernames(opts.beforeText);
    const after = extractMentionUsernames(opts.afterText);
    const added = new Set([...after].filter((u) => !before.has(u)));
    if (added.size === 0) return;

    const userIds = await resolveMentionUserIds(opts.workspaceId, added, opts.actorId);
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
