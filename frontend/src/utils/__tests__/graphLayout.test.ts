import { describe, expect, it } from 'vitest';
import { nodeColor, nodeSize, shouldUseSigma, NODE_TYPE_COLOR, SIGMA_THRESHOLD_NODES, radialLayout, hierarchyLinkDistance } from '../graphLayout';
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

describe('hierarchyLinkDistance', () => {
  const spec = (siblingCount: number, siblingIndex = 0, depth = 1) =>
    hierarchyLinkDistance({ parentRadius: 30, siblingIndex, siblingCount, depth });

  it('leaves a small sibling set compact', () => {
    // Few enough children to fit on the base ring — no need to push them out.
    expect(spec(4)).toBeLessThan(120);
  });

  it('grows the occupied area with the sibling count, so density stays constant', () => {
    // The bug this fixes: a fixed rest length pulled 3 children and 300
    // children onto the same circle, so a big hub collapsed into a knot.
    // The innermost shell stays put by design — it's the outer extent that
    // has to grow, since that's where the extra children go.
    const extent = (count: number) => Math.max(...Array.from({ length: count }, (_, i) => spec(count, i)));
    expect(extent(200)).toBeGreaterThan(extent(60));
    expect(extent(60)).toBeGreaterThan(extent(20));
    expect(extent(20)).toBeGreaterThan(extent(4));
  });

  it('spills past one shell into further-out shells', () => {
    const shells = new Set(Array.from({ length: 100 }, (_, i) => spec(100, i)));
    expect(shells.size).toBeGreaterThan(1);
  });

  it('interleaves shells so the innermost does not saturate first', () => {
    // Consecutive siblings land on different shells.
    expect(spec(100, 0)).not.toBe(spec(100, 1));
  });

  it('gives every sibling of a set the same shell radii regardless of order', () => {
    const distances = Array.from({ length: 40 }, (_, i) => spec(40, i));
    // Every distance repeats across the set — no single child gets a unique
    // orbit, which would read as an accidental outlier.
    expect(new Set(distances).size).toBeLessThan(distances.length);
  });

  it('is stable and finite for degenerate counts', () => {
    for (const count of [0, 1]) {
      const d = spec(count);
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThan(0);
    }
  });

  it('starts the ring outside the parent dot', () => {
    const small = hierarchyLinkDistance({ parentRadius: 8, siblingIndex: 0, siblingCount: 5, depth: 1 });
    const large = hierarchyLinkDistance({ parentRadius: 60, siblingIndex: 0, siblingCount: 5, depth: 1 });
    expect(large - small).toBeCloseTo(52);
  });
});
