// ---------------------------------------------------------------------------
// User notification system — the write side.
//
// A single, general-purpose `notifications` table (per recipient) feeds the
// bell in the TopBar and the Dashboard feed. Every notification is created
// through `createNotification()` / `createNotifications()` here so the rules
// live in one place:
//   • a user is NEVER notified of their own action (recipient === actor is a
//     silent no-op),
//   • an optional `dedupeKey` makes a notification idempotent per recipient
//     (used by the overdue-deadline sweep so a task only ever alerts once),
//   • persistence is best-effort — a notification failing to write must never
//     break the mutation that triggered it, so every path is wrapped/logged.
//
// Realtime: the `notifications` table has an AFTER-INSERT sync_log trigger (see
// runMigrations in index.ts) that emits a `notification` signal scoped to the
// recipient (workspace_id NULL, owner_id = recipient). The frontend treats it
// like any other sync signal — it refetches the unread count / feed. No extra
// SSE plumbing here.
// ---------------------------------------------------------------------------

import { v4 as uuidv4 } from 'uuid';
import { query } from './db';

export type NotificationType =
  | 'workspace_added'
  | 'meeting_invite'
  | 'item_tagged'
  | 'mention'
  | 'automation_run'
  | 'deadline_overdue';

export interface CreateNotificationInput {
  /** Recipient user id. */
  userId: string;
  type: NotificationType;
  /** Who caused it (null for system events like overdue deadlines). */
  actorId?: string | null;
  title: string;
  body?: string | null;
  /** Deep-link target kind: 'task' | 'list' | 'milestone' | 'meeting' | 'workspace' | 'markdownList' | 'automation'. */
  entityType?: string | null;
  entityId?: string | null;
  /** Navigation context — the workspace the target lives in (nullable). */
  workspaceId?: string | null;
  /** Extra structured metadata used by the frontend to build the deep-link. */
  data?: Record<string, unknown>;
  /** When set, the notification is unique per (recipient, dedupeKey) — a repeat is dropped. */
  dedupeKey?: string | null;
}

function nlog(...args: unknown[]): void {
  console.log('🔔', ...args);
}
function nerr(...args: unknown[]): void {
  console.error('🔔 ✗', ...args);
}

/**
 * Create one notification. Never throws — logs and returns on any failure so a
 * caller (always a side-effect of a real mutation) can `void` it safely.
 * Self-notifications (recipient === actor) are silently skipped.
 */
export async function createNotification(input: CreateNotificationInput): Promise<void> {
  try {
    if (!input.userId) return;
    if (input.actorId && input.actorId === input.userId) return; // never notify yourself

    const id = `notif_${uuidv4()}`;
    await query(
      `INSERT INTO notifications
         (id, user_id, type, actor_id, title, body, entity_type, entity_id, workspace_id, data, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
      [
        id,
        input.userId,
        input.type,
        input.actorId ?? null,
        input.title,
        input.body ?? null,
        input.entityType ?? null,
        input.entityId ?? null,
        input.workspaceId ?? null,
        JSON.stringify(input.data ?? {}),
        input.dedupeKey ?? null,
      ]
    );
  } catch (err) {
    nerr('createNotification failed', input.type, input.userId, err);
  }
}

/**
 * Fan one notification out to many recipients (e.g. every newly-invited meeting
 * attendee). De-dupes the recipient list and skips the actor. Fully
 * best-effort — a single failed insert can't abort the others.
 */
export async function createNotifications(
  userIds: Iterable<string>,
  input: Omit<CreateNotificationInput, 'userId'>
): Promise<void> {
  const seen = new Set<string>();
  for (const userId of userIds) {
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    await createNotification({ ...input, userId });
  }
  if (seen.size > 0) nlog(`queued ${seen.size} ${input.type} notification(s)`);
}

// ---------------------------------------------------------------------------
// Overdue-deadline sweep — a periodic pass (registered in index.ts's start(),
// same pattern as the AI-file-purge / schedule-automation crons). For every
// open task whose deadline is in the past, notify its creator AND everyone
// tagged on it, EXACTLY ONCE per (task, deadline): the dedupe_key carries the
// deadline, so moving a task's due date into the future and back re-arms a
// fresh alert, while a steady overdue task never re-notifies on later sweeps.
// ---------------------------------------------------------------------------

interface OverdueRow {
  id: string;
  title: string;
  user_id: string;
  workspace_id: string | null;
  list_id: string | null;
  source: string;
  deadline: string;
  tagged: string[];
}

export async function sweepOverdueDeadlines(): Promise<void> {
  try {
    const overdue = await query<OverdueRow>(
      `SELECT t.id::text AS id, t.title, t.user_id, t.workspace_id, t.list_id, t.source,
              t.deadline::text AS deadline,
              COALESCE((SELECT array_agg(tt.user_id::text) FROM task_tags tt WHERE tt.task_id = t.id), '{}') AS tagged
         FROM tasks t
        WHERE t.checked = false AND t.deadline IS NOT NULL AND t.deadline < CURRENT_DATE
        ORDER BY t.deadline ASC
        LIMIT 2000`
    );
    for (const row of overdue.rows) {
      const recipients = new Set<string>([row.user_id, ...(row.tagged ?? [])]);
      const dedupeKey = `overdue:${row.id}:${row.deadline}`;
      for (const userId of recipients) {
        await createNotification({
          userId,
          type: 'deadline_overdue',
          actorId: null,
          title: 'Task overdue',
          body: `"${row.title}" was due ${row.deadline}`,
          entityType: 'task',
          entityId: row.id,
          workspaceId: row.workspace_id,
          data: { listId: row.list_id, source: row.source, deadline: row.deadline, taskTitle: row.title },
          dedupeKey,
        });
      }
    }
    if (overdue.rows.length > 0) nlog(`overdue sweep processed ${overdue.rows.length} task(s)`);
  } catch (err) {
    nerr('sweepOverdueDeadlines error', err);
  }
}
