import { describe, expect, it } from 'vitest';
import { nodeColor, nodeSize, shouldUseSigma, NODE_TYPE_COLOR, SIGMA_THRESHOLD_NODES } from '../graphLayout';

describe('nodeColor', () => {
  it('maps every entity type to a design-token color', () => {
    for (const type of Object.keys(NODE_TYPE_COLOR) as Array<keyof typeof NODE_TYPE_COLOR>) {
      expect(nodeColor(type)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('a done task is success-green, not the default task gray', () => {
    expect(nodeColor('task', 'done')).toBe('#10b981');
    expect(nodeColor('task', 'open')).not.toBe('#10b981');
  });
});

describe('nodeSize', () => {
  it('grows with degree via the 4 + sqrt(degree)*3 formula', () => {
    expect(nodeSize(0)).toBe(4);
    expect(nodeSize(1)).toBeCloseTo(7, 1);
    expect(nodeSize(4)).toBeCloseTo(10, 1);
  });

  it('is capped at 24px so a hub node never dominates the canvas', () => {
    expect(nodeSize(10000)).toBe(24);
  });

  it('never goes negative for a malformed/negative degree', () => {
    expect(nodeSize(-5)).toBe(4);
  });
});

describe('shouldUseSigma', () => {
  it('stays on React Flow at or below the threshold', () => {
    expect(shouldUseSigma(SIGMA_THRESHOLD_NODES)).toBe(false);
    expect(shouldUseSigma(0)).toBe(false);
  });

  it('switches to Sigma above the threshold', () => {
    expect(shouldUseSigma(SIGMA_THRESHOLD_NODES + 1)).toBe(true);
  });
});
