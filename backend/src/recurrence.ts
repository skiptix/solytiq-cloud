// Recurrence expansion for meetings — a series is materialized as independent
// `meetings` rows sharing one `recurrence_id` (the id of the first occurrence)
// at creation time, rather than stored as a live RRULE. Keeps every consumer
// (Calendar UI, AI tools, CalDAV read) working against plain rows with no
// special-casing.

export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface RecurrenceRule {
  freq: RecurrenceFreq;
  interval: number; // e.g. freq=weekly interval=2 → every 2 weeks
  count: number;    // total occurrences including the first
}

export const RECURRENCE_MAX_COUNT = 104;
export const RECURRENCE_MAX_INTERVAL = 365;

const FREQS: RecurrenceFreq[] = ['daily', 'weekly', 'monthly', 'yearly'];

/** Validate + clamp an untrusted repeat payload from a client. Returns null if not a usable rule. */
export function parseRecurrenceRule(input: unknown): RecurrenceRule | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const freq = o.freq;
  if (typeof freq !== 'string' || !FREQS.includes(freq as RecurrenceFreq)) return null;
  const interval = o.interval == null ? 1 : Math.floor(Number(o.interval));
  const count = Math.floor(Number(o.count));
  if (!Number.isFinite(interval) || interval < 1) return null;
  if (!Number.isFinite(count) || count < 2) return null;
  return {
    freq: freq as RecurrenceFreq,
    interval: Math.min(interval, RECURRENCE_MAX_INTERVAL),
    count: Math.min(count, RECURRENCE_MAX_COUNT),
  };
}

/** Expand a rule starting at `startDateIso` (YYYY-MM-DD) into a list of YYYY-MM-DD dates, first entry === startDateIso. */
export function computeRecurrenceDates(startDateIso: string, rule: RecurrenceRule): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(startDateIso);
  if (!m) return [startDateIso];
  const [, yStr, moStr, dStr] = m;
  const y = Number(yStr), mo = Number(moStr) - 1, d = Number(dStr);
  const dates: string[] = [];
  for (let i = 0; i < rule.count; i++) {
    const dt = new Date(Date.UTC(y, mo, d));
    const step = rule.interval * i;
    if (rule.freq === 'daily') dt.setUTCDate(dt.getUTCDate() + step);
    else if (rule.freq === 'weekly') dt.setUTCDate(dt.getUTCDate() + step * 7);
    else if (rule.freq === 'monthly') dt.setUTCMonth(dt.getUTCMonth() + step);
    else if (rule.freq === 'yearly') dt.setUTCFullYear(dt.getUTCFullYear() + step);
    dates.push(dt.toISOString().slice(0, 10));
  }
  return dates;
}
