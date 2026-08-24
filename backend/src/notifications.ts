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
import { sendEmail } from './email/resendClient';
import { buildNotificationEmail } from './email/templates';
import { sendPushForNotification } from './push/send';

export type NotificationType =
  | 'workspace_added'
  | 'item_invite'
  | 'meeting_invite'
  | 'item_tagged'
  | 'mention'
  | 'automation_run'
  | 'deadline_overdue'
  | 'agent_run_complete'
  | 'agent_proposal'
  | 'agent_change'
  | 'meeting_reminder'
  // Collaboration activity on a shared item — see collaborators.ts. These fan
  // out to everyone invited to (or tagged on) the board/page/timeline, which is
  // a much wider audience than the targeted types above, so they are the ones
  // that most need the collapse-by-entity behaviour in push/send.ts.
  | 'item_added'
  | 'milestone_changed'
  | 'page_edited';

// ---------------------------------------------------------------------------
// Email notifications (via Resend) — an additive channel on top of the
// existing in-app feed, not a replacement. Every notification still writes
// its `notifications` row exactly as before; a SUBSET of types also emails
// the recipient, gated on (a) Resend actually being configured/enabled
// (resendClient.ts's own check), (b) that recipient's own per-type
// preference (`users.email_notification_prefs`, sparse override map — same
// "only overrides stored" convention as `keyboard_shortcuts`), and (c) a
// per-type filter for cases where "every notification of this type" would be
// noise rather than signal (see shouldEmailNotification below).
// ---------------------------------------------------------------------------

/** Default email-on-off per type when the recipient has no override. Only
 *  `workspace_added` defaults ON — every other type is opt-in, so a fresh
 *  account's inbox stays quiet until the user explicitly turns more on from
 *  Account Settings → Notifications. */
export const DEFAULT_EMAIL_PREFS: Record<NotificationType, boolean> = {
  workspace_added: true,
  item_invite: false,
  meeting_invite: false,
  item_tagged: false,
  mention: false,
  automation_run: false,
  meeting_reminder: false,
  deadline_overdue: false,
  agent_run_complete: false,
  agent_proposal: false,
  agent_change: false,
  // Activity types are the highest-volume notifications in the app — a busy
  // board can produce dozens a day. Email is the wrong medium for that, so they
  // default OFF here while defaulting ON for push (see DEFAULT_PUSH_PREFS).
  item_added: false,
  milestone_changed: false,
  page_edited: false,
};

/** Per-type extra filter beyond the recipient's on/off preference — e.g. a
 *  successful automation run is exactly the kind of thing the in-app feed is
 *  fine for, but a FAILED one is worth interrupting someone's inbox for. */
export function shouldEmailNotification(type: NotificationType, data: Record<string, unknown> | undefined): boolean {
  if (type === 'automation_run') return (data as { status?: string } | undefined)?.status === 'failed';
  return true;
}

function ctaForNotification(input: CreateNotificationInput): { label: string; path: string } {
  switch (input.entityType) {
    case 'list': return { label: 'Open board', path: input.entityId ? `/list/${input.entityId}` : '/dashboard' };
    case 'timeline': return { label: 'Open timeline', path: input.entityId ? `/timeline/${input.entityId}` : '/dashboard' };
    case 'markdownList': return { label: 'Open page', path: input.entityId ? `/markdown-list/${input.entityId}` : '/dashboard' };
    case 'folder': return { label: 'Open folder', path: input.entityId ? `/folder/${input.entityId}` : '/dashboard' };
    case 'automation': return { label: 'Open automation', path: input.entityId ? `/automations/${input.entityId}` : '/automations' };
    case 'meeting': return { label: 'Open calendar', path: '/calendar?show=meetings' };
    case 'task': return { label: 'Open Solytiq Cloud', path: '/dashboard' };
    default: return { label: 'Open Solytiq Cloud', path: '/dashboard' };
  }
}

interface RecipientRow {
  email: string | null;
  email_notification_prefs: Record<string, boolean> | null;
}

/** Best-effort — never throws, never blocks/undoes the notification write it
 *  follows. A missing/unconfigured Resend setup, a recipient with no email,
 *  or an opted-out preference are all silent no-ops here, not errors. */
async function maybeSendEmail(input: CreateNotificationInput): Promise<void> {
  try {
    if (!shouldEmailNotification(input.type, input.data as Record<string, unknown> | undefined)) return;
    const r = await query<RecipientRow>(
      `SELECT email, email_notification_prefs FROM users WHERE id = $1`,
      [input.userId]
    );
    const recipient = r.rows[0];
    if (!recipient?.email) return;
    const prefs = recipient.email_notification_prefs ?? {};
    const enabled = prefs[input.type] ?? DEFAULT_EMAIL_PREFS[input.type];
    if (!enabled) return;

    const cta = ctaForNotification(input);
    const { subject, html } = buildNotificationEmail({
      heading: input.title,
      bodyText: input.body ?? input.title,
      ctaLabel: cta.label,
      ctaPath: cta.path,
    });
    const result = await sendEmail({ to: recipient.email, subject, html });
    if (!result.ok) nerr('email send failed', input.type, input.userId, result.error);
  } catch (err) {
    nerr('maybeSendEmail failed', input.type, input.userId, err);
  }
}

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
    const inserted = await query(
      // The dedupe uniqueness is a PARTIAL index (WHERE dedupe_key IS NOT NULL),
      // so the ON CONFLICT arbiter MUST repeat that predicate — otherwise
      // Postgres can't infer the partial index and the whole INSERT throws at
      // plan time (for every row, dedupe_key NULL or not). Rows with a NULL
      // dedupe_key simply never conflict and always insert.
      `INSERT INTO notifications
         (id, user_id, type, actor_id, title, body, entity_type, entity_id, workspace_id, data, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
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
    // Only a genuinely NEW row (not a dedupe no-op) should ever email or push
    // — a repeat overdue-deadline sweep hitting the ON CONFLICT DO NOTHING
    // branch must not re-send mail (or re-buzz a phone) every hour just because
    // it re-ran the insert. Push rides this exact hook rather than getting its
    // own call sites, so every present and future NotificationType reaches a
    // device by construction.
    if ((inserted.rowCount ?? 0) > 0) {
      void maybeSendEmail(input);
      void sendPushForNotification({
        userId:        input.userId,
        actorId:       input.actorId ?? null,
        type:          input.type,
        title:         input.title,
        body:          input.body ?? null,
        entityType:    input.entityType ?? null,
        entityId:      input.entityId ?? null,
        workspaceId:   input.workspaceId ?? null,
        data:          input.data,
        notificationId: id,
      });
    }
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
