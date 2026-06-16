/**
 * Shared timezone-aware date utilities.
 *
 * All "today" comparisons across deadlines and timeline milestones
 * should go through these helpers so the user-chosen timezone is respected.
 */

/**
 * Returns the current date as `YYYY-MM-DD` in the given IANA timezone.
 * Falls back to the system locale if the timezone is invalid.
 */
export function todayInTz(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());

    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    // Fallback: local system date
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  }
}

/**
 * Returns how many minutes have elapsed since midnight (0–1439) in the given
 * IANA timezone. Used to track intra-day "hourly" progress on timelines, where
 * a milestone dated today fills gradually across the day rather than instantly.
 * Falls back to the system locale if the timezone is invalid.
 */
export function minutesSinceMidnightInTz(timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
    // Intl emits "24" for midnight in some engines; normalise to 0.
    const hour = get('hour') % 24;
    return hour * 60 + get('minute');
  } catch {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  }
}

/**
 * Parses an `HH:MM` time string to minutes since midnight, or null if absent/invalid.
 */
export function timeToMinutes(time: string | null | undefined): number | null {
  if (!time) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Returns `YYYY-MM-DD` shifted by `daysAhead` days from today in the given timezone.
 */
export function futureDateInTz(timezone: string, daysAhead: number): string {
  // Move to the correct calendar day in the target timezone by adjusting UTC
  const todayStr = todayInTz(timezone);
  const todayMidnight = new Date(todayStr + 'T00:00:00');
  todayMidnight.setDate(todayMidnight.getDate() + daysAhead);
  return todayMidnight.toISOString().slice(0, 10);
}

/**
 * Convenience: the classic localIso used for deadline comparisons.
 * Returns YYYY-MM-DD for a given Date object in LOCAL time (unchanged behaviour for fallback).
 */
export function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
