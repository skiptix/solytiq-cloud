import { describe, it, expect } from 'vitest';
import { buildVEvent, buildVTodo, wrapCalendar, parseVEvent, etagFor, ymd } from '../caldav/ical';

describe('caldav ical', () => {
  it('serializes a timed VEVENT', () => {
    const ics = buildVEvent({ uid: 'm1@solytiq', summary: 'Standup', date: '2026-06-17', time: '09:30', endTime: '10:00' });
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('UID:m1@solytiq');
    expect(ics).toContain('SUMMARY:Standup');
    expect(ics).toContain('DTSTART:20260617T093000');
    expect(ics).toContain('DTEND:20260617T100000');
  });

  it('serializes an all-day VEVENT with exclusive end', () => {
    const ics = buildVEvent({ uid: 'm2@solytiq', summary: 'Launch', date: '2026-06-17', allDay: true });
    expect(ics).toContain('DTSTART;VALUE=DATE:20260617');
    expect(ics).toContain('DTEND;VALUE=DATE:20260618');
  });

  it('serializes a VTODO with a due date and priority', () => {
    const ics = buildVTodo({ uid: 't1@solytiq', summary: 'Pay invoice', due: '2026-06-20', priority: 1 });
    expect(ics).toContain('BEGIN:VTODO');
    expect(ics).toContain('DUE;VALUE=DATE:20260620');
    expect(ics).toContain('PRIORITY:1');
    expect(ics).toContain('STATUS:NEEDS-ACTION');
  });

  it('escapes special characters in text', () => {
    const ics = buildVEvent({ uid: 'x@solytiq', summary: 'A, B; C\\nD', date: '2026-01-01' });
    expect(ics).toContain('SUMMARY:A\\, B\\; C');
  });

  it('produces a stable etag for identical input', () => {
    const a = buildVEvent({ uid: 'u@solytiq', summary: 'X', date: '2026-01-01', stamp: '20260101T000000Z' });
    const b = buildVEvent({ uid: 'u@solytiq', summary: 'X', date: '2026-01-01', stamp: '20260101T000000Z' });
    expect(etagFor(wrapCalendar([a]))).toBe(etagFor(wrapCalendar([b])));
  });

  it('parses a timed VEVENT (Apple-style TZID param)', () => {
    const payload = wrapCalendar([[
      'BEGIN:VEVENT',
      'UID:abc-123',
      'SUMMARY:Lunch',
      'LOCATION:Cafe',
      'DTSTART;TZID=Europe/Berlin:20260617T120000',
      'DTEND;TZID=Europe/Berlin:20260617T130000',
      'END:VEVENT',
    ].join('\r\n')]);
    const ev = parseVEvent(payload);
    expect(ev).not.toBeNull();
    expect(ev!.uid).toBe('abc-123');
    expect(ev!.summary).toBe('Lunch');
    expect(ev!.location).toBe('Cafe');
    expect(ev!.date).toBe('2026-06-17');
    expect(ev!.time).toBe('12:00');
    expect(ev!.endTime).toBe('13:00');
    expect(ev!.allDay).toBe(false);
  });

  it('parses an all-day VEVENT', () => {
    const payload = wrapCalendar([[
      'BEGIN:VEVENT', 'UID:d1', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20260617', 'DTEND;VALUE=DATE:20260618', 'END:VEVENT',
    ].join('\r\n')]);
    const ev = parseVEvent(payload)!;
    expect(ev.allDay).toBe(true);
    expect(ev.date).toBe('2026-06-17');
    expect(ev.time).toBeNull();
  });

  it('round-trips a built meeting through the parser', () => {
    const ics = wrapCalendar([buildVEvent({ uid: 'rt@solytiq', summary: 'Review', date: '2026-03-04', time: '14:15', endTime: '15:00', location: 'Room 2' })]);
    const ev = parseVEvent(ics)!;
    expect(ev.date).toBe('2026-03-04');
    expect(ev.time).toBe('14:15');
    expect(ev.endTime).toBe('15:00');
    expect(ev.location).toBe('Room 2');
  });

  it('normalizes Date and string date inputs', () => {
    expect(ymd('2026-06-17T00:00:00.000Z')).toBe('2026-06-17');
    expect(ymd(new Date(2026, 5, 17))).toBe('2026-06-17');
    expect(ymd(null)).toBeNull();
  });
});
