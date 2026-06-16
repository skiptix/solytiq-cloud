/**
 * Shared milestone-progress helpers for the timeline views (authenticated
 * `TimelineScreen` and the public `SharedTimelinePage`).
 *
 * Progress is tracked *hourly* rather than snapping to whole days: a milestone
 * dated today is not counted complete the moment the day starts — it fills
 * gradually across the day and only reaches 100% once the day is over (or its
 * set time-of-day passes, or it's manually marked done). This keeps both the
 * header progress bar and the connecting rail moving throughout the day.
 */
import { timeToMinutes } from './date';

const DAY_MINUTES = 24 * 60;

export interface MilestoneProgressInput {
  status: string;
  date?: string | null;
  time?: string | null;
}

/**
 * Fractional completion (0..1) of a single milestone:
 *  - manually 'done'             → 1
 *  - dated strictly in the past  → 1 (the day is over)
 *  - dated in the future         → 0
 *  - dated today                 → ramps from 0 toward 1 across the day, hitting
 *                                   1 only once its time target passes (the set
 *                                   `time`, or end of day when no time is set).
 */
export function milestoneCompletion(m: MilestoneProgressInput, today: string, nowMinutes: number): number {
  if (m.status === 'done') return 1;
  if (m.date == null) return 0;
  if (m.date < today) return 1;
  if (m.date > today) return 0;
  // Dated today — partial, based on how far through the day we are.
  const target = timeToMinutes(m.time) ?? DAY_MINUTES;
  if (target <= 0) return 1;
  return Math.max(0, Math.min(1, nowMinutes / target));
}

/**
 * The continuous position (in milestone-index units, possibly fractional) that
 * the progress rail should fill to. The rail fills fully past every completed
 * node and then partially into the first not-yet-complete node, so a milestone
 * that's partway through "today" leaves the rail stopped mid-segment.
 * Returns -1 when nothing is reached yet.
 */
export function railFillIndex(completions: number[]): number {
  let fill = -1;
  for (let i = 0; i < completions.length; i++) {
    const c = completions[i];
    if (c >= 1) {
      fill = i;
    } else {
      // Partial fill of the segment leading into node i from the previous node.
      fill = (i - 1) + c;
      break;
    }
  }
  return fill;
}
