import { Router, Request, Response } from 'express';
import { query } from '../db';
import { authenticate } from '../middleware';
import { broadcastToUser } from '../sse';
import { werr } from '../workspaceUtil';

const router = Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// Meetings — standalone calendar events that belong to no list/timeline/
// workspace. They are scoped strictly to the owning user (no workspace, no
// sharing). Used by the Calendar page.
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
  created_at: string;
  updated_at: string;
}

function sanitizeMeeting(m: MeetingRow) {
  return {
    id:          m.id,
    title:       m.title,
    description: m.description,
    location:    m.location,
    date:        m.meeting_date,
    startTime:   m.start_time,
    endTime:     m.end_time,
    allDay:      m.all_day,
    color:       m.color,
    createdAt:   m.created_at,
    updatedAt:   m.updated_at,
  };
}

// GET /api/meetings — all of the user's meetings, optionally within a date range.
router.get('/', async (req: Request, res: Response) => {
  try {
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const params: unknown[] = [req.userId];
    let dateFilter = '';
    if (from) { params.push(from); dateFilter += ` AND meeting_date >= $${params.length}`; }
    if (to) { params.push(to); dateFilter += ` AND meeting_date <= $${params.length}`; }

    const result = await query<MeetingRow>(
      `SELECT * FROM meetings
       WHERE user_id = $1 ${dateFilter}
       ORDER BY meeting_date ASC, start_time ASC NULLS FIRST, created_at ASC`,
      params
    );
    res.json({ meetings: result.rows.map(sanitizeMeeting) });
  } catch (err) {
    werr('meetings GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/meetings
router.post('/', async (req: Request, res: Response) => {
  try {
    const { id, title, description, location, date, startTime, endTime, allDay, color } = req.body as {
      id?: string;
      title?: string;
      description?: string;
      location?: string;
      date?: string;
      startTime?: string | null;
      endTime?: string | null;
      allDay?: boolean;
      color?: string;
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

    const result = await query<MeetingRow>(
      `INSERT INTO meetings
         (id, user_id, title, description, location, meeting_date, start_time, end_time, all_day, color)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        meetingId,
        req.userId,
        title.trim(),
        description ?? null,
        location ?? null,
        date,
        isAllDay ? null : (startTime ?? null),
        isAllDay ? null : (endTime ?? null),
        isAllDay,
        color ?? null,
      ]
    );

    res.status(201).json({ meeting: sanitizeMeeting(result.rows[0]) });
    broadcastToUser(req.userId!, 'meetings');
  } catch (err) {
    werr('meetings POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/meetings/:id — full update (the editor sends the complete object).
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { title, description, location, date, startTime, endTime, allDay, color } = req.body as {
      title?: string;
      description?: string | null;
      location?: string | null;
      date?: string;
      startTime?: string | null;
      endTime?: string | null;
      allDay?: boolean;
      color?: string | null;
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

    res.json({ meeting: sanitizeMeeting(result.rows[0]) });
    broadcastToUser(req.userId!, 'meetings');
  } catch (err) {
    werr('meetings PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/meetings/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const result = await query(
      `DELETE FROM meetings WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    res.json({ success: true });
    broadcastToUser(req.userId!, 'meetings');
  } catch (err) {
    werr('meetings DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
