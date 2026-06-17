// ---------------------------------------------------------------------------
// Minimal iCalendar (RFC 5545) serialization + a small VEVENT parser.
//
// We hand-roll this to avoid a heavy dependency. We only emit/parse the subset
// the Calendar feature needs: VEVENT (milestones, meetings) and VTODO (tasks),
// using floating local date/times (no VTIMEZONE) so the client renders them in
// the user's own timezone — matching how Solytiq stores dates/times.
// ---------------------------------------------------------------------------

import crypto from 'crypto';

/** Normalize a DATE column value (string or Date) to 'YYYY-MM-DD'. */
export function ymd(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

const compactDate = (ymdStr: string) => ymdStr.replace(/-/g, '');           // YYYYMMDD
const compactTime = (hhmm: string) => `${hhmm.replace(/:/g, '')}00`.slice(0, 6); // HHMMSS

function addDays(ymdStr: string, days: number): string {
  const [y, m, d] = ymdStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function addMinutesToTime(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  let total = h * 60 + m + mins;
  total = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function escapeText(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function unescapeText(s: string): string {
  return s
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function dtstamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Convert a DB timestamp (Date or ISO string) to an iCal UTC stamp, or now(). */
export function icalStamp(v: string | Date | null | undefined): string {
  if (!v) return dtstamp();
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return dtstamp();
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Fold a content line at 75 octets (RFC 5545 §3.1) with leading-space continuation. */
function fold(line: string): string {
  if (line.length <= 73) return line;
  const out: string[] = [];
  let rest = line;
  out.push(rest.slice(0, 73));
  rest = rest.slice(73);
  while (rest.length > 72) { out.push(' ' + rest.slice(0, 72)); rest = rest.slice(72); }
  if (rest.length) out.push(' ' + rest);
  return out.join('\r\n');
}

const joinLines = (lines: string[]) => lines.map(fold).join('\r\n');

export interface VEventInput {
  uid: string;
  summary: string;
  date: string;            // YYYY-MM-DD
  time?: string | null;    // HH:MM
  endTime?: string | null; // HH:MM
  allDay?: boolean;
  description?: string | null;
  location?: string | null;
  stamp?: string;          // pre-computed DTSTAMP (keeps ETags stable)
}

export function buildVEvent(p: VEventInput): string {
  const lines = ['BEGIN:VEVENT', `UID:${p.uid}`, `DTSTAMP:${p.stamp ?? dtstamp()}`, `SUMMARY:${escapeText(p.summary)}`];
  if (p.allDay || !p.time) {
    lines.push(`DTSTART;VALUE=DATE:${compactDate(p.date)}`);
    lines.push(`DTEND;VALUE=DATE:${compactDate(addDays(p.date, 1))}`);
  } else {
    lines.push(`DTSTART:${compactDate(p.date)}T${compactTime(p.time)}`);
    const end = p.endTime || addMinutesToTime(p.time, 60);
    lines.push(`DTEND:${compactDate(p.date)}T${compactTime(end)}`);
  }
  if (p.description) lines.push(`DESCRIPTION:${escapeText(p.description)}`);
  if (p.location) lines.push(`LOCATION:${escapeText(p.location)}`);
  lines.push('END:VEVENT');
  return joinLines(lines);
}

export interface VTodoInput {
  uid: string;
  summary: string;
  due?: string | null;     // YYYY-MM-DD
  time?: string | null;    // HH:MM
  description?: string | null;
  priority?: number | null; // 1..9
  stamp?: string;          // pre-computed DTSTAMP (keeps ETags stable)
}

export function buildVTodo(p: VTodoInput): string {
  const lines = ['BEGIN:VTODO', `UID:${p.uid}`, `DTSTAMP:${p.stamp ?? dtstamp()}`, `SUMMARY:${escapeText(p.summary)}`, 'STATUS:NEEDS-ACTION'];
  if (p.due) {
    if (p.time) lines.push(`DUE:${compactDate(p.due)}T${compactTime(p.time)}`);
    else lines.push(`DUE;VALUE=DATE:${compactDate(p.due)}`);
  }
  if (p.priority) lines.push(`PRIORITY:${p.priority}`);
  if (p.description) lines.push(`DESCRIPTION:${escapeText(p.description)}`);
  lines.push('END:VTODO');
  return joinLines(lines);
}

/** Wrap one or more components in a VCALENDAR envelope. */
export function wrapCalendar(components: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Solytiq Cloud//Calendar//EN',
    'CALSCALE:GREGORIAN',
    ...components,
    'END:VCALENDAR',
  ].join('\r\n') + '\r\n';
}

/** Strong ETag derived from the resource content. */
export function etagFor(ics: string): string {
  return `"${crypto.createHash('md5').update(ics).digest('hex')}"`;
}

export interface ParsedEvent {
  uid: string | null;
  summary: string;
  date: string | null;     // YYYY-MM-DD (wall-clock)
  time: string | null;     // HH:MM
  endTime: string | null;  // HH:MM
  allDay: boolean;
  description: string | null;
  location: string | null;
}

function parseDt(raw: { params: string; value: string } | undefined): { date: string | null; time: string | null; allDay: boolean } {
  if (!raw) return { date: null, time: null, allDay: false };
  const allDay = /VALUE=DATE(?!-TIME)/i.test(raw.params) || /^\d{8}$/.test(raw.value.trim());
  const v = raw.value.trim().replace(/Z$/i, '');
  if (v.length < 8) return { date: null, time: null, allDay };
  const date = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  let time: string | null = null;
  const t = v.indexOf('T');
  if (t >= 0 && !allDay) time = `${v.slice(t + 1, t + 3)}:${v.slice(t + 3, t + 5)}`;
  return { date, time, allDay };
}

/** Parse the (first) VEVENT out of an iCalendar payload sent by a client. */
export function parseVEvent(icalText: string): ParsedEvent | null {
  // Unfold continuation lines, then read the VEVENT block.
  const unfolded = icalText.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const props: Record<string, { params: string; value: string }> = {};
  let inEvent = false;
  for (const ln of lines) {
    if (ln === 'BEGIN:VEVENT') { inEvent = true; continue; }
    if (ln === 'END:VEVENT') break;
    if (!inEvent) continue;
    const idx = ln.indexOf(':');
    if (idx < 0) continue;
    const left = ln.slice(0, idx);
    const value = ln.slice(idx + 1);
    const semi = left.indexOf(';');
    const name = (semi < 0 ? left : left.slice(0, semi)).toUpperCase();
    const params = semi < 0 ? '' : left.slice(semi + 1);
    props[name] = { params, value };
  }
  if (!props['DTSTART'] && !props['SUMMARY']) return null;
  const start = parseDt(props['DTSTART']);
  const end = parseDt(props['DTEND']);
  return {
    uid: props['UID']?.value?.trim() ?? null,
    summary: unescapeText(props['SUMMARY']?.value ?? '').trim() || 'Untitled',
    date: start.date,
    time: start.time,
    endTime: end.time,
    allDay: start.allDay,
    description: props['DESCRIPTION'] ? unescapeText(props['DESCRIPTION'].value) : null,
    location: props['LOCATION'] ? unescapeText(props['LOCATION'].value) : null,
  };
}
