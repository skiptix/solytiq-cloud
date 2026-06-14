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
 * Returns `YYYY-MM-DD` shifted by `daysAhead` days from today in the given timezone.
 */
export function futureDateInTz(timezone: string, daysAhead: number): string {
  const base = new Date();
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
