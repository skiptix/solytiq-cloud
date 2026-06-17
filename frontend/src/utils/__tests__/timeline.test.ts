import { describe, it, expect } from 'vitest';
import { milestoneCompletion, railFillIndex } from '../timeline';

describe('milestoneCompletion', () => {
  const today = '2025-06-15';

  it('returns 1 for a milestone marked done regardless of date', () => {
    expect(milestoneCompletion({ status: 'done', date: '2099-01-01' }, today, 0)).toBe(1);
    expect(milestoneCompletion({ status: 'done', date: null }, today, 720)).toBe(1);
  });

  it('returns 0 when there is no date', () => {
    expect(milestoneCompletion({ status: 'upcoming', date: null }, today, 720)).toBe(0);
  });

  it('returns 1 for a past date', () => {
    expect(milestoneCompletion({ status: 'upcoming', date: '2025-06-14' }, today, 0)).toBe(1);
    expect(milestoneCompletion({ status: 'in-progress', date: '2020-01-01' }, today, 720)).toBe(1);
  });

  it('returns 0 for a future date', () => {
    expect(milestoneCompletion({ status: 'upcoming', date: '2025-06-16' }, today, 720)).toBe(0);
    expect(milestoneCompletion({ status: 'in-progress', date: '2099-12-31' }, today, 0)).toBe(0);
  });

  it('returns partial progress for today based on elapsed time (no set time)', () => {
    // No time set → target is end of day (1440 minutes)
    // At noon (720 min): 720 / 1440 = 0.5
    expect(milestoneCompletion({ status: 'upcoming', date: today }, today, 720)).toBe(0.5);
    // At 6am (360 min): 360 / 1440 = 0.25
    expect(milestoneCompletion({ status: 'upcoming', date: today }, today, 360)).toBe(0.25);
    // At midnight start: 0 / 1440 = 0
    expect(milestoneCompletion({ status: 'upcoming', date: today }, today, 0)).toBe(0);
  });

  it('returns partial progress relative to a set time target', () => {
    // Time set to 12:00 (720 minutes target)
    // At 360 min: 360/720 = 0.5
    expect(milestoneCompletion({ status: 'upcoming', date: today, time: '12:00' }, today, 360)).toBe(0.5);
    // Past the target time → clamped to 1
    expect(milestoneCompletion({ status: 'upcoming', date: today, time: '12:00' }, today, 800)).toBe(1);
  });

  it('returns 1 when time target is 00:00 (target ≤ 0)', () => {
    expect(milestoneCompletion({ status: 'upcoming', date: today, time: '00:00' }, today, 0)).toBe(1);
  });
});

describe('railFillIndex', () => {
  it('returns -1 for an empty array', () => {
    expect(railFillIndex([])).toBe(-1);
  });

  it('returns -1 when nothing is completed', () => {
    expect(railFillIndex([0, 0, 0])).toBe(-1);
  });

  it('returns the index of the last fully-completed milestone', () => {
    expect(railFillIndex([1, 1, 0])).toBe(1);
    expect(railFillIndex([1, 1, 1])).toBe(2);
  });

  it('fills partially into the first incomplete milestone', () => {
    // [done, half, not-started]
    const fill = railFillIndex([1, 0.5, 0]);
    // Should be 0 (last done index) + 0.5 = 0.5
    expect(fill).toBeCloseTo(0.5, 5);
  });

  it('handles a leading partial with no prior done items', () => {
    // First milestone partially done: fill = (0 - 1) + 0.3 = -0.7
    const fill = railFillIndex([0.3, 0, 0]);
    expect(fill).toBeCloseTo(-0.7, 5);
  });

  it('handles all done', () => {
    expect(railFillIndex([1, 1, 1, 1])).toBe(3);
  });
});
