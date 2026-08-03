import { describe, expect, it } from 'vitest';
import { LABEL_BASE_PX, LABEL_FOCUS_PX, planLabels, type LabelCandidate } from '../graphLabels';

const CAM = { x: 0, y: 0, k: 1 };
const VIEW = { w: 1000, h: 700 };

function candidates(n: number, length = 12): LabelCandidate[] {
  return Array.from({ length: n }, (_, i) => ({ srn: `n${i}`, radius: 10, length }));
}

/** n nodes stacked on one spot — every label but the first must be culled. */
function samePosition(n: number) {
  return new Map(Array.from({ length: n }, (_, i) => [`n${i}`, { x: 0, y: 0 }] as const));
}

describe('planLabels', () => {
  it('returns a placement for every candidate, in order', () => {
    const plan = planLabels(candidates(3), samePosition(3), CAM, VIEW);
    expect(plan.map((p) => p.srn)).toEqual(['n0', 'n1', 'n2']);
  });

  it('culls labels that would overlap, keeping the highest-priority one', () => {
    const plan = planLabels(candidates(5), samePosition(5), CAM, VIEW);
    expect(plan.filter((p) => p.visible).map((p) => p.srn)).toEqual(['n0']);
  });

  it('keeps labels that are far enough apart', () => {
    const positions = new Map([
      ['n0', { x: -300, y: -200 }],
      ['n1', { x: 300, y: 200 }],
    ]);
    const plan = planLabels(candidates(2), positions, CAM, VIEW);
    expect(plan.every((p) => p.visible)).toBe(true);
  });

  it('counter-scales font size and halo so on-screen size is constant at any zoom', () => {
    const positions = new Map([['n0', { x: 0, y: 0 }]]);
    const at = (k: number) => planLabels(candidates(1), positions, { ...CAM, k }, VIEW)[0];
    const zoomedOut = at(0.25);
    const zoomedIn = at(2);
    // World-space size scales as 1/k, which is exactly what keeps the rendered
    // size fixed once the viewport group's scale(k) is applied.
    expect(zoomedOut.fontSize).toBeCloseTo(LABEL_BASE_PX / 0.25);
    expect(zoomedIn.fontSize).toBeCloseTo(LABEL_BASE_PX / 2);
    expect(zoomedOut.strokeWidth / zoomedIn.strokeWidth).toBeCloseTo(2 / 0.25);
  });

  it('shows more labels as you zoom in', () => {
    // A ring of nodes 90 world units apart: illegible mush at k=0.3, roomy at k=1.5.
    const positions = new Map(
      Array.from({ length: 24 }, (_, i) => {
        const a = (i / 24) * Math.PI * 2;
        return [`n${i}`, { x: Math.cos(a) * 340, y: Math.sin(a) * 340 }] as const;
      })
    );
    const visibleAt = (k: number) =>
      planLabels(candidates(24), positions, { ...CAM, k }, VIEW).filter((p) => p.visible).length;
    expect(visibleAt(1.5)).toBeGreaterThan(visibleAt(0.3));
  });

  it('promotes the focused node above every other candidate', () => {
    // n3 is last in priority order but focused, so it must win the contested spot.
    const plan = planLabels(candidates(5), samePosition(5), CAM, VIEW, { focus: 'n3' });
    expect(plan.filter((p) => p.visible).map((p) => p.srn)).toEqual(['n3']);
    expect(plan.find((p) => p.srn === 'n3')!.fontSize).toBeCloseTo(LABEL_FOCUS_PX);
  });

  it('drops labels outside the highlight set entirely, and lets neighbours take the space', () => {
    const positions = samePosition(5);
    const plan = planLabels(candidates(5), positions, CAM, VIEW, {
      focus: 'n4',
      highlight: new Set(['n4']),
    });
    const visible = plan.filter((p) => p.visible).map((p) => p.srn);
    expect(visible).toEqual(['n4']);
    // A dimmed label must not merely fade — it must free its pixels.
    expect(plan.find((p) => p.srn === 'n0')!.visible).toBe(false);
  });

  it('never lets an offscreen node suppress an onscreen label', () => {
    const positions = new Map([
      // n0 is far off to the left; n1 sits in the middle of the viewport.
      ['n0', { x: -100000, y: 0 }],
      ['n1', { x: 0, y: 0 }],
    ]);
    const plan = planLabels(candidates(2), positions, CAM, VIEW);
    expect(plan.find((p) => p.srn === 'n0')!.visible).toBe(false);
    expect(plan.find((p) => p.srn === 'n1')!.visible).toBe(true);
  });

  it('hides a label whose node has no position yet', () => {
    const plan = planLabels(candidates(1), new Map(), CAM, VIEW);
    expect(plan[0].visible).toBe(false);
  });

  it('offsets the label below the dot, scaled by the node radius', () => {
    const positions = new Map([['big', { x: 0, y: 0 }], ['small', { x: 500, y: 0 }]]);
    const plan = planLabels(
      [{ srn: 'big', radius: 30, length: 6 }, { srn: 'small', radius: 8, length: 6 }],
      positions, CAM, VIEW
    );
    expect(plan[0].y).toBeGreaterThan(plan[1].y);
  });
});
