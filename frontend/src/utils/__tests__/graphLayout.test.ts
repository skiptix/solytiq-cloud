import { describe, expect, it } from 'vitest';
import { nodeColor, nodeSize, shouldUseSigma, NODE_TYPE_COLOR, SIGMA_THRESHOLD_NODES, radialLayout } from '../graphLayout';
import type { GraphNode } from '../../types';

function makeNode(srn: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    srn, type: 'task', id: srn, title: srn, emoji: null, color: null, deepLink: null,
    degree: 0, pagerank: 0, community: null, status: null, isArchived: false,
    ...overrides,
  };
}

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

describe('radialLayout', () => {
  it('places every node at a unique, deterministic position', () => {
    const nodes = [makeNode('srn:task:1', { pagerank: 0.9 }), makeNode('srn:task:2', { pagerank: 0.5 }), makeNode('srn:task:3', { pagerank: 0.1 })];
    const a = radialLayout(nodes);
    const b = radialLayout(nodes);
    expect(a.size).toBe(3);
    expect(a).toEqual(b); // pure — same input, same output
    const positions = [...a.values()].map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`);
    expect(new Set(positions).size).toBe(3); // no two nodes stacked exactly on top of each other
  });

  it('returns an empty map for no nodes', () => {
    expect(radialLayout([]).size).toBe(0);
  });

  it('ranks higher-pagerank nodes into the inner ring first', () => {
    const many = Array.from({ length: 14 }, (_, i) => makeNode(`srn:task:${i}`, { pagerank: 14 - i }));
    const positions = radialLayout(many);
    const dist = (srn: string) => { const p = positions.get(srn)!; return Math.hypot(p.x, p.y); };
    // Ring size is 12 — the 13th-ranked node (index 12) must be pushed to the second ring, farther out than the top node.
    expect(dist('srn:task:12')).toBeGreaterThan(dist('srn:task:0'));
  });
});
