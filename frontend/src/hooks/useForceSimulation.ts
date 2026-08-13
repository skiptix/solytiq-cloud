import { useEffect, useRef } from 'react';
import { ForceSimulation, type SimNodeSpec, type SimLink } from '../utils/forceSimulation';
import useFrameLoop from '../components/animate-ui/useFrameLoop';

/**
 * Owns a persistent ForceSimulation instance across renders and ticks it once
 * per frame, calling `onTick` with the live position map.
 *
 * The frame loop itself belongs to the central Animate-UI layer
 * (`useFrameLoop`) rather than being a `requestAnimationFrame` of its own:
 * that keeps this tick inside Motion's frame scheduler instead of racing it,
 * and puts the reduced-motion decision somewhere it can be made once. Note
 * the `'settle'` mode — a force simulation is not decoration, it is how node
 * positions are COMPUTED, so a user who prefers reduced motion still needs
 * the sim to run long enough to reach a layout. It just stops drifting once
 * it gets there, instead of breathing indefinitely.
 *
 * `onTick` is read from a ref inside useFrameLoop, so the loop never restarts
 * when the caller's callback identity changes (e.g. from a hover-state
 * closure) — only `running` starts and stops it.
 */
export default function useForceSimulation(
  nodeSpecs: SimNodeSpec[],
  links: SimLink[],
  onTick: (positions: Map<string, { x: number; y: number }>) => void,
  running: boolean
) {
  const simRef = useRef<ForceSimulation>(new ForceSimulation());

  useEffect(() => {
    simRef.current.setData(nodeSpecs, links);
  }, [nodeSpecs, links]);

  useFrameLoop(
    () => {
      simRef.current.tick(1);
      onTick(simRef.current.positions());
    },
    { running, reducedMotion: 'settle' }
  );

  return simRef;
}
