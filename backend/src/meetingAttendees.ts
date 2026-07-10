import { query } from './db';

// Shared by routes/meetings.ts and the create_meeting/delete_meeting AI tools
// so invite validation and the attendee table stay in lockstep everywhere a
// meeting can be created.

export const MAX_MEETING_INVITEES = 25;

/** Validate+dedupe a client-supplied invitee list: existing users, excluding the organizer, capped. */
export async function resolveInviteeIds(raw: unknown, organizerId: string): Promise<string[]> {
  if (!Array.isArray(raw)) return [];
  const candidates = [...new Set(raw.filter((x): x is string => typeof x === 'string' && x.length > 0))]
    .filter(id => id !== organizerId)
    .slice(0, MAX_MEETING_INVITEES);
  if (candidates.length === 0) return [];
  const result = await query<{ id: string }>(`SELECT id FROM users WHERE id = ANY($1::uuid[])`, [candidates]);
  return result.rows.map(r => r.id);
}

export async function setMeetingAttendees(meetingId: string, inviteeIds: string[]): Promise<void> {
  await query(`DELETE FROM meeting_attendees WHERE meeting_id = $1`, [meetingId]);
  for (const userId of inviteeIds) {
    await query(
      `INSERT INTO meeting_attendees (meeting_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [meetingId, userId]
    );
  }
}
