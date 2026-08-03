import { describe, expect, it } from 'vitest';
import { ForceSimulation, type SimLink, type SimNodeSpec } from '../forceSimulation';

describe('ForceSimulation', () => {
  it('keeps every node position finite after many ticks', () => {
    const sim = new ForceSimulation(1);
    sim.setData(
      [
        { id: 'root', radius: 20, depth: 0, pinned: { x: 0, y: 0 } },
        { id: 'a', radius: 10, depth: 1 },
        { id: 'b', radius: 10, depth: 1 },
        { id: 'c', radius: 6, depth: 2 },
      ],
      [
        { source: 'root', target: 'a', distance: 80, strength: 0.06 },
        { source: 'root', target: 'b', distance: 80, strength: 0.06 },
        { source: 'a', target: 'c', distance: 60, strength: 0.06 },
      ]
    );
    for (let i = 0; i < 300; i++) sim.tick(1);
    for (const [, p] of sim.positions()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('never moves a pinned node', () => {
    const sim = new ForceSimulation(2);
    sim.setData(
      [{ id: 'root', radius: 20, depth: 0, pinned: { x: 0, y: 0 } }, { id: 'a', radius: 10, depth: 1 }],
      [{ source: 'root', target: 'a', distance: 80, strength: 0.06 }]
    );
    sim.pin('a', 200, 200);
    for (let i = 0; i < 60; i++) sim.tick(1);
    expect(sim.positions().get('a')).toEqual({ x: 200, y: 200 });
  });

  it('unpin releases the node back to the simulation', () => {
    const sim = new ForceSimulation(3);
    sim.setData(
      [{ id: 'root', radius: 20, depth: 0, pinned: { x: 0, y: 0 } }, { id: 'a', radius: 10, depth: 1 }],
      [{ source: 'root', target: 'a', distance: 80, strength: 0.06 }]
    );
    sim.pin('a', 500, 500);
    sim.unpin('a');
    for (let i = 0; i < 30; i++) sim.tick(1);
    const p = sim.positions().get('a')!;
    expect(p.x).not.toBe(500);
  });

  it('preserves live positions across setData calls (no jump on filter change)', () => {
    const sim = new ForceSimulation(4);
    sim.setData(
      [{ id: 'root', radius: 20, depth: 0, pinned: { x: 0, y: 0 } }, { id: 'a', radius: 10, depth: 1 }],
      [{ source: 'root', target: 'a', distance: 80, strength: 0.06 }]
    );
    for (let i = 0; i < 30; i++) sim.tick(1);
    const before = sim.positions().get('a')!;
    sim.setData(
      [{ id: 'root', radius: 20, depth: 0, pinned: { x: 0, y: 0 } }, { id: 'a', radius: 10, depth: 1 }, { id: 'b', radius: 10, depth: 1 }],
      [{ source: 'root', target: 'a', distance: 80, strength: 0.06 }, { source: 'root', target: 'b', distance: 80, strength: 0.06 }]
    );
    const after = sim.positions().get('a')!;
    expect(after).toEqual(before);
  });

  it('does nothing on an empty simulation', () => {
    const sim = new ForceSimulation(5);
    expect(() => sim.tick(1)).not.toThrow();
    expect(sim.positions().size).toBe(0);
  });

  it('cools down to a slow, calm drift instead of moving rapidly forever', () => {
    const sim = new ForceSimulation(6);
    sim.setData(
      [
        { id: 'root', radius: 20, depth: 0, pinned: { x: 0, y: 0 } },
        { id: 'a', radius: 10, depth: 1 }, { id: 'b', radius: 10, depth: 1 },
        { id: 'c', radius: 8, depth: 2 }, { id: 'd', radius: 8, depth: 2 },
      ],
      [
        { source: 'root', target: 'a', distance: 80, strength: 0.14 },
        { source: 'root', target: 'b', distance: 80, strength: 0.14 },
        { source: 'a', target: 'c', distance: 60, strength: 0.14 },
        { source: 'b', target: 'd', distance: 60, strength: 0.14 },
      ]
    );
    // Let the initial "hot" settling burst finish.
    for (let i = 0; i < 250; i++) sim.tick(1);
    // Measure per-tick displacement once settled — should be small.
    const before = new Map([...sim.nodes].map(([id, n]) => [id, { x: n.x, y: n.y }]));
    let maxStep = 0;
    for (let i = 0; i < 60; i++) {
      sim.tick(1);
      for (const [id, n] of sim.nodes) {
        const p = before.get(id)!;
        maxStep = Math.max(maxStep, Math.hypot(n.x - p.x, n.y - p.y));
        before.set(id, { x: n.x, y: n.y });
      }
    }
    expect(maxStep).toBeLessThan(1.5);
  });

  // The Net's readability bug: repulsion used to be fully alpha-scaled while
  // the springs never cooled, so once a layout settled the springs had the
  // only say and every sibling collapsed onto its parent's rest circle —
  // dots overlapping, labels unreadable. Repulsion now has an alpha floor and
  // overlap resolution isn't alpha-scaled at all.
  it('keeps siblings separated once the layout has cooled', () => {
    const sim = new ForceSimulation(7);
    const specs: SimNodeSpec[] = [{ id: 'root', radius: 30, collisionRadius: 46, depth: 0, pinned: { x: 0, y: 0 } }];
    const links: SimLink[] = [];
    for (let i = 0; i < 60; i++) {
      specs.push({ id: `n${i}`, radius: 10, collisionRadius: 26, depth: 1 });
      links.push({ source: 'root', target: `n${i}`, distance: 200, strength: 0.12 });
    }
    sim.setData(specs, links);
    for (let i = 0; i < 600; i++) sim.tick(1);

    const pts = [...sim.positions()].filter(([id]) => id !== 'root').map(([, p]) => p);
    let minGap = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) minGap = Math.min(minGap, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
    }
    // Two 10px dots whose centers are 20px apart are touching. Anything below
    // roughly the sum of the collision radii means the layout re-collapsed.
    expect(minGap).toBeGreaterThan(40);
  });

  it('honors collisionRadius, not just the dot radius', () => {
    const roomy = new ForceSimulation(8);
    const tight = new ForceSimulation(8);
    const build = (collisionRadius: number) => ({
      specs: [
        { id: 'root', radius: 20, collisionRadius: 20, depth: 0, pinned: { x: 0, y: 0 } },
        { id: 'a', radius: 8, collisionRadius, depth: 1 },
        { id: 'b', radius: 8, collisionRadius, depth: 1 },
      ],
      links: [
        { source: 'root', target: 'a', distance: 60, strength: 0.14 },
        { source: 'root', target: 'b', distance: 60, strength: 0.14 },
      ],
    });
    const roomySrc = build(50);
    const tightSrc = build(8);
    roomy.setData(roomySrc.specs, roomySrc.links);
    tight.setData(tightSrc.specs, tightSrc.links);
    for (let i = 0; i < 400; i++) { roomy.tick(1); tight.tick(1); }
    const gap = (sim: ForceSimulation) => {
      const a = sim.positions().get('a')!;
      const b = sim.positions().get('b')!;
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    expect(gap(roomy)).toBeGreaterThan(gap(tight));
  });

  it('fans a large sibling set out on seed rather than heaping it on one spot', () => {
    const sim = new ForceSimulation(9);
    const specs: SimNodeSpec[] = [{ id: 'root', radius: 30, collisionRadius: 30, depth: 0, pinned: { x: 0, y: 0 } }];
    const links: SimLink[] = [];
    for (let i = 0; i < 40; i++) {
      specs.push({ id: `n${i}`, radius: 9, collisionRadius: 24, depth: 1 });
      links.push({ source: 'root', target: `n${i}`, distance: 180, strength: 0.12 });
    }
    sim.setData(specs, links);
    // Before a single tick: the seed alone should already cover the ring.
    const angles = [...sim.positions()].filter(([id]) => id !== 'root').map(([, p]) => Math.atan2(p.y, p.x));
    const quadrants = new Set(angles.map((a) => Math.floor(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 2))));
    expect(quadrants.size).toBe(4);
  });
});
