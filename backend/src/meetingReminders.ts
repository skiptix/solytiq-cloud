// ---------------------------------------------------------------------------
// Meeting reminder sweep — a periodic pass (registered in index.ts's start(),
// same shape as notifications.ts's sweepOverdueDeadlines) that notifies a
// meeting's organizer AND every invited attendee shortly before it starts,
// each on THEIR OWN configured lead time (users.meeting_reminder_lead_minutes;
// 0 = reminders off for that user). Runs every 5 minutes; a per-(meeting,
// recipient) dedupeKey means it doesn't matter that a meeting sits inside the
// lead window across several consecutive sweeps — it still only ever
// notifies once per occurrence. Recurring meetings are unaffected: each
// occurrence is its own `meetings` row (see CLAUDE.md's `recurrence_id`
// note), so each gets its own reminder.
//
// V1 scope, deliberate: only TODAY's timed (non-all-day) meetings are
// considered — a lead time can never exceed "the rest of today" here, so a
// reminder window spanning midnight (e.g. a 30-min-lead reminder for a
// 00:10 meeting) is simply not caught. Acceptable for a first cut; documented
// rather than silently wrong.
// ---------------------------------------------------------------------------

import { query } from './db';
import { createNotification } from './notifications';

interface UpcomingMeetingRow {
  id: string;
  title: string;
  workspace_id: string | null;
  recipient_id: string;
  lead_minutes: number;
  minutes_until: string; // numeric comes back as a string from pg
}

export async function sweepMeetingReminders(): Promise<void> {
  try {
    const rows = await query<UpcomingMeetingRow>(
      `SELECT m.id, m.title, m.workspace_id, u.id AS recipient_id,
              u.meeting_reminder_lead_minutes AS lead_minutes,
              EXTRACT(EPOCH FROM ((m.meeting_date + m.start_time::time) - NOW())) / 60 AS minutes_until
         FROM meetings m
         JOIN LATERAL (
           SELECT m.user_id AS id
           UNION
           SELECT ma.user_id FROM meeting_attendees ma WHERE ma.meeting_id = m.id
         ) recipients ON true
         JOIN users u ON u.id = recipients.id
        WHERE m.all_day = false
          AND m.start_time IS NOT NULL
          AND m.start_time ~ '^[0-2][0-9]:[0-5][0-9]$'
          AND m.meeting_date = CURRENT_DATE
          AND u.meeting_reminder_lead_minutes > 0`
    );

    let sent = 0;
    for (const row of rows.rows) {
      const minutesUntil = parseFloat(row.minutes_until);
      if (!Number.isFinite(minutesUntil)) continue;
      // Not yet inside this recipient's lead window, or already started.
      if (minutesUntil < 0 || minutesUntil > row.lead_minutes) continue;

      await createNotification({
        userId: row.recipient_id,
        type: 'meeting_reminder',
        actorId: null,
        title: `"${row.title}" starts soon`,
        body: `Starting in about ${Math.max(0, Math.round(minutesUntil))} minute(s).`,
        entityType: 'meeting',
        entityId: row.id,
        workspaceId: row.workspace_id,
        data: { meetingTitle: row.title },
        dedupeKey: `meeting-reminder:${row.id}:${row.recipient_id}`,
      });
      sent++;
    }
    if (sent > 0) console.log(`🔔 meeting reminder sweep sent ${sent} reminder(s)`);
  } catch (err) {
    console.error('🔔 ✗ sweepMeetingReminders error', err);
  }
}
