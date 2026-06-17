// ---------------------------------------------------------------------------
// CalDAV data layer — turns Solytiq data into calendar collections + resources.
//
// Collections (one per accessible workspace + a writable "Meetings" calendar):
//   ws-<workspaceId>  → milestones (VEVENT, read-only) + tasks (VTODO, read-only)
//   meetings          → standalone meetings (VEVENT, read/write)
//
// Everything is scoped to the authenticated user; access mirrors the in-app
// Calendar page (all accessible workspaces).
// ---------------------------------------------------------------------------

import crypto from 'crypto';
import { query } from '../db';
import { buildVEvent, buildVTodo, wrapCalendar, etagFor, icalStamp, ymd, parseVEvent } from './ical';

export interface CalCollection {
  id: string;                    // 'ws-<id>' | 'meetings'
  kind: 'workspace' | 'meetings';
  name: string;
  color: string;                 // #rrggbb
  components: ('VEVENT' | 'VTODO')[];
  writable: boolean;
}

export interface CalResource {
  name: string;                  // resource filename WITHOUT the .ics suffix
  etag: string;
  ics: string;                   // full VCALENDAR document
}

const WS_COLORS = ['#5e4dbb', '#3b82f6', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6', '#6366f1'];
const MEETINGS_COLOR = '#3b82f6';
const PRIORITY_MAP: Record<string, number> = { High: 1, Medium: 5, Low: 9 };

function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return WS_COLORS[h % WS_COLORS.length];
}

const personalWorkspaceId = (userId: string) => `ws_${userId.replace(/-/g, '')}`;

// ── Collections ────────────────────────────────────────────────────────────
export async function getCollections(userId: string): Promise<CalCollection[]> {
  const ws = await query<{ id: string; name: string }>(
    `SELECT w.id, w.name
     FROM workspaces w
     LEFT JOIN workspace_members wm ON w.id = wm.workspace_id AND wm.user_id = $1
     WHERE wm.user_id = $1 OR w.visibility = 'public'
     ORDER BY w.created_at ASC`,
    [userId]
  );
  const cols: CalCollection[] = ws.rows.map(w => ({
    id: `ws-${w.id}`,
    kind: 'workspace',
    name: w.name,
    color: colorFor(w.id),
    components: ['VEVENT', 'VTODO'],
    writable: false,
  }));
  cols.push({ id: 'meetings', kind: 'meetings', name: 'Meetings', color: MEETINGS_COLOR, components: ['VEVENT'], writable: true });
  return cols;
}

export async function getCollection(userId: string, colId: string): Promise<CalCollection | null> {
  const cols = await getCollections(userId);
  return cols.find(c => c.id === colId) ?? null;
}

// ── Resource builders ────────────────────────────────────────────────────────
function taskResource(t: { id: string; title: string; note: string | null; deadline: string | Date | null; time_val: string | null; priority: string | null; updated_at: string | Date | null }): CalResource {
  const ics = wrapCalendar([buildVTodo({
    uid: `task-${t.id}@solytiq`,
    summary: t.title,
    due: ymd(t.deadline),
    time: t.time_val,
    description: t.note,
    priority: t.priority ? PRIORITY_MAP[t.priority] ?? null : null,
    stamp: icalStamp(t.updated_at),
  })]);
  return { name: `task-${t.id}`, ics, etag: etagFor(ics) };
}

function milestoneResource(m: { id: string; title: string; description: string | null; milestone_date: string | Date | null; time_val: string | null; created_at: string | Date | null }): CalResource {
  const date = ymd(m.milestone_date)!;
  const ics = wrapCalendar([buildVEvent({
    uid: `milestone-${m.id}@solytiq`,
    summary: m.title,
    date,
    time: m.time_val,
    allDay: !m.time_val,
    description: m.description,
    stamp: icalStamp(m.created_at),
  })]);
  return { name: `milestone-${m.id}`, ics, etag: etagFor(ics) };
}

interface MeetingRow {
  id: string; title: string; description: string | null; location: string | null;
  meeting_date: string | Date; start_time: string | null; end_time: string | null;
  all_day: boolean; caldav_uid: string | null; updated_at: string | Date | null;
}

function meetingResource(m: MeetingRow): CalResource {
  const name = m.caldav_uid || `meeting-${m.id}`;
  const ics = wrapCalendar([buildVEvent({
    uid: m.caldav_uid || `meeting-${m.id}@solytiq`,
    summary: m.title,
    date: ymd(m.meeting_date)!,
    time: m.all_day ? null : m.start_time,
    endTime: m.all_day ? null : m.end_time,
    allDay: m.all_day,
    description: m.description,
    location: m.location,
    stamp: icalStamp(m.updated_at),
  })]);
  return { name, ics, etag: etagFor(ics) };
}

// ── Enumerate a collection's resources ───────────────────────────────────────
export async function getResources(userId: string, colId: string): Promise<CalResource[]> {
  if (colId === 'meetings') {
    const r = await query<MeetingRow>(`SELECT * FROM meetings WHERE user_id = $1 ORDER BY meeting_date ASC`, [userId]);
    return r.rows.map(meetingResource);
  }
  if (!colId.startsWith('ws-')) return [];
  const wsId = colId.slice(3);
  const personal = personalWorkspaceId(userId);
  const bucket = (ws: string | null) => ws || personal;

  const [tasks, milestones] = await Promise.all([
    query<{ id: string; title: string; note: string | null; deadline: string | Date | null; time_val: string | null; priority: string | null; updated_at: string | Date | null; ws: string | null }>(
      `SELECT t.id, t.title, t.note, t.deadline, t.time_val, t.priority, t.updated_at,
              COALESCE(t.workspace_id, l.workspace_id) AS ws
       FROM tasks t LEFT JOIN lists l ON t.list_id = l.id
       WHERE ((t.user_id = $1 AND t.source = 'dash')
          OR (t.source = 'list' AND (l.user_id = $1 OR l.is_public = true)))
         AND t.checked = false`,
      [userId]
    ),
    query<{ id: string; title: string; description: string | null; milestone_date: string | Date | null; time_val: string | null; created_at: string | Date | null; ws: string | null }>(
      `SELECT m.id, m.title, m.description, m.milestone_date, m.time_val, m.created_at, t.workspace_id AS ws
       FROM milestones m JOIN timelines t ON m.timeline_id = t.id
       LEFT JOIN workspace_members wm ON wm.workspace_id = t.workspace_id AND wm.user_id = $1
       WHERE (t.user_id = $1 OR (t.is_public = true AND (
                wm.user_id = $1 OR t.workspace_id IS NULL
                OR EXISTS (SELECT 1 FROM workspaces w WHERE w.id = t.workspace_id AND w.visibility = 'public'))))
         AND m.milestone_date IS NOT NULL AND m.status <> 'done'`,
      [userId]
    ),
  ]);

  const out: CalResource[] = [];
  for (const t of tasks.rows) if (bucket(t.ws) === wsId) out.push(taskResource(t));
  for (const m of milestones.rows) if (bucket(m.ws) === wsId) out.push(milestoneResource(m));
  return out;
}

export async function getResource(userId: string, colId: string, name: string): Promise<CalResource | null> {
  const all = await getResources(userId, colId);
  return all.find(r => r.name === name) ?? null;
}

/** Collection tag — changes whenever any resource in the collection changes. */
export async function getCtag(userId: string, colId: string): Promise<string> {
  const res = await getResources(userId, colId);
  const sig = res.map(r => `${r.name}:${r.etag}`).sort().join('|');
  return crypto.createHash('md5').update(sig).digest('hex');
}

// ── Meeting writes (the Meetings collection is read/write) ────────────────────
async function findMeetingByResource(userId: string, name: string): Promise<{ id: string } | null> {
  let r = await query<{ id: string }>(`SELECT id FROM meetings WHERE user_id = $1 AND caldav_uid = $2`, [userId, name]);
  if (r.rows[0]) return r.rows[0];
  if (name.startsWith('meeting-')) {
    const id = name.slice('meeting-'.length);
    r = await query<{ id: string }>(`SELECT id FROM meetings WHERE user_id = $1 AND id = $2`, [userId, id]);
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

export interface UpsertResult { etag: string; created: boolean }

export async function upsertMeetingFromICal(userId: string, name: string, icalText: string): Promise<UpsertResult | null> {
  const ev = parseVEvent(icalText);
  if (!ev || !ev.date) return null;

  const existing = await findMeetingByResource(userId, name);
  const fields = {
    title: ev.summary,
    description: ev.description,
    location: ev.location,
    date: ev.date,
    allDay: ev.allDay,
    startTime: ev.allDay ? null : ev.time,
    endTime: ev.allDay ? null : ev.endTime,
  };

  if (existing) {
    const r = await query<MeetingRow>(
      `UPDATE meetings SET title=$1, description=$2, location=$3, meeting_date=$4,
              start_time=$5, end_time=$6, all_day=$7, updated_at=NOW()
       WHERE id=$8 AND user_id=$9 RETURNING *`,
      [fields.title, fields.description, fields.location, fields.date, fields.startTime, fields.endTime, fields.allDay, existing.id, userId]
    );
    return { etag: meetingResource(r.rows[0]).etag, created: false };
  }

  const id = `mt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const r = await query<MeetingRow>(
    `INSERT INTO meetings (id, user_id, title, description, location, meeting_date, start_time, end_time, all_day, caldav_uid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [id, userId, fields.title, fields.description, fields.location, fields.date, fields.startTime, fields.endTime, fields.allDay, name]
  );
  return { etag: meetingResource(r.rows[0]).etag, created: true };
}

export async function deleteMeetingByResource(userId: string, name: string): Promise<boolean> {
  const existing = await findMeetingByResource(userId, name);
  if (!existing) return false;
  const r = await query(`DELETE FROM meetings WHERE id = $1 AND user_id = $2`, [existing.id, userId]);
  return (r.rowCount ?? 0) > 0;
}
