import { describe, expect, it } from 'vitest';
import { ForceSimulation } from '../forceSimulation';

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
});
