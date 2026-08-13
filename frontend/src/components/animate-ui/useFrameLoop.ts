// Sprint 04, Phase 4 — the central layer's per-frame callback primitive.
//
// A handful of surfaces animate by computing values themselves every frame
// rather than by tweening toward a target: the Net's force simulation, the
// block editor's drag autoscroll. Those cannot be expressed as Motion
// animations — Motion moves a value toward a target, while a force sim
// derives positions from mutual forces each tick — but they must not each
// hand-roll a `requestAnimationFrame` loop either, for three reasons:
//
//   1. Every hand-rolled loop is a SECOND rAF competing with Motion's own.
//      Motion batches its whole frame (reads, then writes) through a single
//      scheduler; a rival loop interleaves its DOM writes with Motion's
//      reads and reintroduces exactly the layout thrash Motion avoids.
//      `useAnimationFrame` runs the callback inside that same scheduler.
//   2. Reduced-motion is a policy, and a policy enforced in one place is a
//      policy. Enforced at N call sites it is a convention, and the N+1th
//      site is where it stops being true.
//   3. scripts/check-animations.mjs treats a raw `requestAnimationFrame`
//      outside this directory as a boundary violation, for the same reason
//      it treats a raw `motion/react` import as one.
//
// Callers get `(t, delta)` in milliseconds, exactly as Motion provides it.
import { useEffect, useRef } from 'react';
import { useAnimationFrame, useReducedMotion } from './motion';

export interface FrameLoopOptions {
  /** Stop calling back while false. Defaults to true. */
  running?: boolean;
  /**
   * What "reduce motion" means for this loop.
   *
   * - `'stop'` (default): the loop does not run at all. Correct for purely
   *   decorative motion, where the resting state is the whole content.
   * - `'settle'`: the loop runs, but only for `settleMs` after it starts (or
   *   after `running`/the data flips). Correct for a loop whose motion is
   *   also how the layout is COMPUTED — a force simulation that never ticks
   *   renders every node stacked at the origin, which is not a reduced
   *   experience but a broken one. It reaches its resting layout and stops.
   */
  reducedMotion?: 'stop' | 'settle';
  /** How long a `'settle'` loop keeps running under reduced motion. */
  settleMs?: number;
}

/**
 * Runs `callback` once per animation frame, inside Motion's own frame
 * scheduler, honouring the user's reduced-motion preference.
 *
 * The callback is read from a ref, so a caller may pass a fresh closure every
 * render (the common case — it usually closes over hover/selection state)
 * without restarting anything.
 */
export default function useFrameLoop(
  callback: (t: number, delta: number) => void,
  { running = true, reducedMotion = 'stop', settleMs = 1200 }: FrameLoopOptions = {}
) {
  const cbRef = useRef(callback);
  useEffect(() => { cbRef.current = callback; }, [callback]);

  const reduce = useReducedMotion();
  const startedAt = useRef<number | null>(null);

  // Reset the settle window whenever the loop is (re)started, so a caller
  // that flips `running` off and on gets a fresh window rather than a loop
  // that is already past its budget and therefore silently dead.
  useEffect(() => { startedAt.current = null; }, [running, reduce, reducedMotion]);

  const suspended = !running || (!!reduce && reducedMotion === 'stop');

  useAnimationFrame((t, delta) => {
    if (suspended) return;
    if (reduce && reducedMotion === 'settle') {
      if (startedAt.current === null) startedAt.current = t;
      if (t - startedAt.current > settleMs) return;
    }
    cbRef.current(t, delta);
  });
}
