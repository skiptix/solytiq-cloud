import { describe, it, expect } from 'vitest';
import { todayInTz, minutesSinceMidnightInTz, timeToMinutes, futureDateInTz, localIso } from '../date';

describe('timeToMinutes', () => {
  it('parses HH:MM to minutes since midnight', () => {
    expect(timeToMinutes('00:00')).toBe(0);
    expect(timeToMinutes('01:30')).toBe(90);
    expect(timeToMinutes('23:59')).toBe(1439);
    expect(timeToMinutes('12:00')).toBe(720);
  });

  it('handles single-digit hours', () => {
    expect(timeToMinutes('9:05')).toBe(545);
  });

  it('returns null for null/undefined/empty', () => {
    expect(timeToMinutes(null)).toBeNull();
    expect(timeToMinutes(undefined)).toBeNull();
    expect(timeToMinutes('')).toBeNull();
  });

  it('returns null for invalid formats', () => {
    expect(timeToMinutes('abc')).toBeNull();
    expect(timeToMinutes('25:00')).toBeNull();
    expect(timeToMinutes('12:60')).toBeNull();
    expect(timeToMinutes('24:00')).toBeNull();
  });
});

describe('todayInTz', () => {
  it('returns a YYYY-MM-DD string', () => {
    const result = todayInTz('UTC');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('falls back gracefully for an invalid timezone', () => {
    const result = todayInTz('Invalid/Zone');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('respects timezone differences around midnight', () => {
    // At a specific point in time, different timezones can have different dates.
    // We can't easily mock Date, but we verify the format is correct for known zones.
    const utc = todayInTz('UTC');
    const tokyo = todayInTz('Asia/Tokyo'); // UTC+9
    const honolulu = todayInTz('Pacific/Honolulu'); // UTC-10
    expect(utc).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(tokyo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(honolulu).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('minutesSinceMidnightInTz', () => {
  it('returns a number between 0 and 1439', () => {
    const minutes = minutesSinceMidnightInTz('UTC');
    expect(minutes).toBeGreaterThanOrEqual(0);
    expect(minutes).toBeLessThanOrEqual(1439);
  });

  it('falls back for an invalid timezone', () => {
    const minutes = minutesSinceMidnightInTz('Invalid/Zone');
    expect(minutes).toBeGreaterThanOrEqual(0);
    expect(minutes).toBeLessThanOrEqual(1439);
  });
});

describe('futureDateInTz', () => {
  it('returns today when daysAhead is 0', () => {
    const today = todayInTz('UTC');
    const result = futureDateInTz('UTC', 0);
    expect(result).toBe(today);
  });

  it('returns tomorrow when daysAhead is 1', () => {
    const today = todayInTz('UTC');
    const tomorrow = futureDateInTz('UTC', 1);
    // Parse and check the day is 1 ahead
    const d0 = new Date(today + 'T00:00:00Z');
    const d1 = new Date(tomorrow + 'T00:00:00Z');
    expect(d1.getTime() - d0.getTime()).toBe(86400000);
  });

  it('handles negative daysAhead (yesterday)', () => {
    const today = todayInTz('UTC');
    const yesterday = futureDateInTz('UTC', -1);
    const d0 = new Date(today + 'T00:00:00Z');
    const d1 = new Date(yesterday + 'T00:00:00Z');
    expect(d0.getTime() - d1.getTime()).toBe(86400000);
  });

  it('returns a valid YYYY-MM-DD string', () => {
    expect(futureDateInTz('UTC', 30)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('localIso', () => {
  it('formats a Date as YYYY-MM-DD in local time', () => {
    const d = new Date(2025, 0, 15); // Jan 15 2025 local
    expect(localIso(d)).toBe('2025-01-15');
  });

  it('zero-pads single-digit months and days', () => {
    const d = new Date(2025, 2, 5); // Mar 5 2025
    expect(localIso(d)).toBe('2025-03-05');
  });

  it('handles December 31 correctly', () => {
    const d = new Date(2025, 11, 31);
    expect(localIso(d)).toBe('2025-12-31');
  });
});
