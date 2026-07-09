import { describe, expect, it } from 'vitest';
import { computeRecurrenceDates, parseRecurrenceRule } from '../recurrence';

describe('parseRecurrenceRule', () => {
  it('rejects missing or malformed input', () => {
    expect(parseRecurrenceRule(undefined)).toBeNull();
    expect(parseRecurrenceRule(null)).toBeNull();
    expect(parseRecurrenceRule({})).toBeNull();
    expect(parseRecurrenceRule({ freq: 'weekly' })).toBeNull(); // missing count
    expect(parseRecurrenceRule({ freq: 'nonsense', count: 5 })).toBeNull();
    expect(parseRecurrenceRule({ freq: 'weekly', count: 1 })).toBeNull(); // count < 2
  });

  it('defaults interval to 1 when omitted and clamps out-of-range values', () => {
    expect(parseRecurrenceRule({ freq: 'daily', interval: 0, count: 5 })).toBeNull();
    expect(parseRecurrenceRule({ freq: 'weekly', count: 500 })).toEqual({ freq: 'weekly', interval: 1, count: 104 });
    expect(parseRecurrenceRule({ freq: 'daily', interval: 999, count: 3 })).toEqual({ freq: 'daily', interval: 365, count: 3 });
  });
});

describe('computeRecurrenceDates', () => {
  it('expands daily/weekly/monthly/yearly presets from the start date', () => {
    expect(computeRecurrenceDates('2026-01-01', { freq: 'daily', interval: 3, count: 3 }))
      .toEqual(['2026-01-01', '2026-01-04', '2026-01-07']);
    expect(computeRecurrenceDates('2026-01-01', { freq: 'weekly', interval: 2, count: 3 }))
      .toEqual(['2026-01-01', '2026-01-15', '2026-01-29']);
    expect(computeRecurrenceDates('2026-01-31', { freq: 'monthly', interval: 1, count: 2 }))
      .toEqual(['2026-01-31', '2026-03-03']); // Feb has no 31st — JS Date rolls over
    expect(computeRecurrenceDates('2026-01-01', { freq: 'yearly', interval: 1, count: 2 }))
      .toEqual(['2026-01-01', '2027-01-01']);
  });

  it('always includes the start date as the first occurrence', () => {
    const dates = computeRecurrenceDates('2026-07-09', { freq: 'monthly', interval: 3, count: 4 });
    expect(dates[0]).toBe('2026-07-09');
    expect(dates).toHaveLength(4);
  });
});
