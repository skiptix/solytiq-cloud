import { Router, Request, Response } from 'express';
import { query } from '../db';
import { authenticate } from '../middleware';
import { broadcastToUser } from '../sse';
import { werr } from '../workspaceUtil';
import { parseRecurrenceRule, computeRecurrenceDates } from '../recurrence';
import { resolveInviteeIds, setMeetingAttendees } from '../meetingAttendees';

const router = Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// Meetings — standalone calendar events that belong to no list/timeline/
// workspace. They are owned by one user (meetings.user_id), who may invite
// any other instance user via meeting_attendees — an invited meeting appears
// on the invitee's calendar too, read-only: only the organizer can
// edit/delete/re-invite, and an invitee can remove just their own row via
// POST /:id/leave without affecting anyone else. Used by the Calendar page.
// ---------------------------------------------------------------------------

interface MeetingRow {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  location: string | null;
  meeting_date: string;
  start_time: string | null;
  end_time: string | null;
  all_day: boolean;
  color: string | null;
  recurrence_id: string | null;
  created_at: string;
  updated_at: string;
  attendee_ids?: (string | null)[] | null;
}

function sanitizeMeeting(m: MeetingRow, viewerId: string) {
  return {
    id:            m.id,
    title:         m.title,
    description:   m.description,
    location:      m.location,
    date:          m.meeting_date,
    startTime:     m.start_time,
    endTime:       m.end_time,
    allDay:        m.all_day,
    color:         m.color,
    recurrenceId:  m.recurrence_id,
    organizerId:   m.user_id,
    isOwner:       m.user_id === viewerId,
    attendeeIds:   (m.attendee_ids ?? []).filter((x): x is string => !!x),
    createdAt:     m.created_at,
    updatedAt:     m.updated_at,
  };
}

// GET /api/meetings — the user's own meetings plus any they're invited to,
// optionally within a date range.
router.get('/', async (req: Request, res: Response) => {
  try {
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const params: unknown[] = [req.userId];
    let dateFilter = '';
    if (from) { params.push(from); dateFilter += ` AND m.meeting_date >= $${params.length}`; }
    if (to) { params.push(to); dateFilter += ` AND m.meeting_date <= $${params.length}`; }

    const result = await query<MeetingRow>(
      `SELECT m.*, att.attendee_ids
       FROM meetings m
       LEFT JOIN LATERAL (
         SELECT array_agg(user_id) AS attendee_ids FROM meeting_attendees WHERE meeting_id = m.id
       ) att ON true
       WHERE (m.user_id = $1 OR EXISTS (SELECT 1 FROM meeting_attendees ma WHERE ma.meeting_id = m.id AND ma.user_id = $1))
       ${dateFilter}
       ORDER BY m.meeting_date ASC, m.start_time ASC NULLS FIRST, m.created_at ASC`,
      params
    );
    res.json({ meetings: result.rows.map(m => sanitizeMeeting(m, req.userId!)) });
  } catch (err) {
    werr('meetings GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/meetings
router.post('/', async (req: Request, res: Response) => {
  try {
    const { id, title, description, location, date, startTime, endTime, allDay, color, repeat, inviteeIds } = req.body as {
      id?: string;
      title?: string;
      description?: string;
      location?: string;
      date?: string;
      startTime?: string | null;
      endTime?: string | null;
      allDay?: boolean;
      color?: string;
      repeat?: unknown;
      inviteeIds?: unknown;
    };

    if (!title || !title.trim()) {
      res.status(400).json({ error: 'title is required' });
      return;
    }
    if (!date) {
      res.status(400).json({ error: 'date is required' });
      return;
    }

    const meetingId = id ?? `mt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const isAllDay = allDay === true;
    const rule = parseRecurrenceRule(repeat);
    const dates = rule ? computeRecurrenceDates(date, rule) : [date];
    const invitees = await resolveInviteeIds(inviteeIds, req.userId!);

    const rows: MeetingRow[] = [];
    for (let i = 0; i < dates.length; i++) {
      const occurrenceId = i === 0 ? meetingId : `mt_${Date.now()}_${Math.floor(Math.random() * 1e6)}_${i}`;
      const result = await query<MeetingRow>(
        `INSERT INTO meetings
           (id, user_id, title, description, location, meeting_date, start_time, end_time, all_day, color, recurrence_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          occurrenceId,
          req.userId,
          title.trim(),
          description ?? null,
          location ?? null,
          dates[i],
          isAllDay ? null : (startTime ?? null),
          isAllDay ? null : (endTime ?? null),
          isAllDay,
          color ?? null,
          dates.length > 1 ? meetingId : null,
        ]
      );
      if (invitees.length > 0) await setMeetingAttendees(occurrenceId, invitees);
      rows.push({ ...result.rows[0], attendee_ids: invitees });
    }

    res.status(201).json({
      meeting: sanitizeMeeting(rows[0], req.userId!),
      meetings: rows.map(r => sanitizeMeeting(r, req.userId!)),
    });
    broadcastToUser(req.userId!, 'meetings');
    for (const userId of invitees) broadcastToUser(userId, 'meetings');
  } catch (err) {
    werr('meetings POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/meetings/:id — full update (the editor sends the complete object).
// Owner-only. `inviteeIds`, when present, replaces the attendee list.
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { title, description, location, date, startTime, endTime, allDay, color, inviteeIds } = req.body as {
      title?: string;
      description?: string | null;
      location?: string | null;
      date?: string;
      startTime?: string | null;
      endTime?: string | null;
      allDay?: boolean;
      color?: string | null;
      inviteeIds?: unknown;
    };

    const isAllDay = allDay === true;

    const result = await query<MeetingRow>(
      `UPDATE meetings
       SET title       = COALESCE($1, title),
           description = $2,
           location    = $3,
           meeting_date = COALESCE($4, meeting_date),
           start_time  = $5,
           end_time    = $6,
           all_day     = COALESCE($7, all_day),
           color       = $8,
           updated_at  = NOW()
       WHERE id = $9 AND user_id = $10
       RETURNING *`,
      [
        title?.trim() ?? null,
        description ?? null,
        location ?? null,
        date ?? null,
        isAllDay ? null : (startTime ?? null),
        isAllDay ? null : (endTime ?? null),
        allDay ?? null,
        color ?? null,
        req.params.id,
        req.userId,
      ]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const previousAttendees = await query<{ user_id: string }>(
      `SELECT user_id FROM meeting_attendees WHERE meeting_id = $1`,
      [req.params.id]
    );
    const before = new Set(previousAttendees.rows.map(r => r.user_id));

    let attendeeIds = [...before];
    if (inviteeIds !== undefined) {
      attendeeIds = await resolveInviteeIds(inviteeIds, req.userId!);
      await setMeetingAttendees(req.params.id, attendeeIds);
    }

    res.json({ meeting: sanitizeMeeting({ ...result.rows[0], attendee_ids: attendeeIds }, req.userId!) });
    broadcastToUser(req.userId!, 'meetings');
    const notify = new Set([...before, ...attendeeIds]);
    for (const userId of notify) broadcastToUser(userId, 'meetings');
  } catch (err) {
    werr('meetings PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/meetings/:id — pass ?series=1 to delete every occurrence in the
// same recurring series (falls back to just this one if it isn't recurring).
// Owner-only.
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const deleteSeries = req.query.series === '1' || req.query.series === 'true';
    const affected = deleteSeries
      ? await query<{ id: string }>(
          `SELECT id FROM meetings
           WHERE user_id = $2 AND (
             id = $1
             OR recurrence_id = (SELECT recurrence_id FROM meetings WHERE id = $1 AND user_id = $2)
           )`,
          [req.params.id, req.userId]
        )
      : await query<{ id: string }>(`SELECT id FROM meetings WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);

    if (affected.rows.length === 0) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    const meetingIds = affected.rows.map(r => r.id);
    const attendees = await query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM meeting_attendees WHERE meeting_id = ANY($1::text[])`,
      [meetingIds]
    );

    const result = await query(`DELETE FROM meetings WHERE id = ANY($1::text[])`, [meetingIds]);

    res.json({ success: true, deletedCount: result.rowCount });
    broadcastToUser(req.userId!, 'meetings');
    for (const row of attendees.rows) broadcastToUser(row.user_id, 'meetings');
  } catch (err) {
    werr('meetings DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/meetings/:id/leave — an invitee removes themselves from a meeting
// they don't own. No-op (still 200) if they weren't invited in the first place.
router.post('/:id/leave', async (req: Request, res: Response) => {
  try {
    const meeting = await query<{ user_id: string }>(`SELECT user_id FROM meetings WHERE id = $1`, [req.params.id]);
    if (meeting.rows.length === 0) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    if (meeting.rows[0].user_id === req.userId) {
      res.status(400).json({ error: "The organizer can't leave their own meeting — delete it instead" });
      return;
    }
    await query(`DELETE FROM meeting_attendees WHERE meeting_id = $1 AND user_id = $2`, [req.params.id, req.userId]);
    res.json({ success: true });
    broadcastToUser(req.userId!, 'meetings');
  } catch (err) {
    werr('meetings leave error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
