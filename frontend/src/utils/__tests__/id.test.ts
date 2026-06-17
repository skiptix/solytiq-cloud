import { describe, it, expect } from 'vitest';
import { genId } from '../id';

describe('genId', () => {
  it('returns a string starting with the given prefix', () => {
    const id = genId('timeline');
    expect(id.startsWith('timeline_')).toBe(true);
  });

  it('includes a numeric timestamp portion', () => {
    const id = genId('task');
    const after = id.slice('task_'.length);
    // Should be all digits (timestamp + counter)
    expect(after).toMatch(/^\d+$/);
  });

  it('generates unique IDs on sequential calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(genId('item'));
    }
    expect(ids.size).toBe(100);
  });

  it('works with different prefixes', () => {
    const a = genId('list');
    const b = genId('folder');
    expect(a.startsWith('list_')).toBe(true);
    expect(b.startsWith('folder_')).toBe(true);
  });

  it('counter portion is zero-padded to 3 digits', () => {
    const id = genId('x');
    const numPart = id.slice(2); // 'x_' + digits
    // Last 3 digits are the counter (padded)
    expect(numPart.length).toBeGreaterThanOrEqual(3);
    // The full number part should end with a 3-digit counter
    expect(numPart.slice(-3)).toMatch(/^\d{3}$/);
  });
});
