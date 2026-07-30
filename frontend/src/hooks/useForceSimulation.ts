import { useEffect, useRef } from 'react';
import { ForceSimulation, type SimNodeSpec, type SimLink } from '../utils/forceSimulation';

/**
 * Owns a persistent ForceSimulation instance across renders and drives it
 * with requestAnimationFrame, calling `onTick` every frame with the live
 * position map. `onTick` is read from a ref so the RAF loop never needs to
 * restart when the caller's callback identity changes (e.g. from a
 * hover-state closure) — only a change to `running` starts/stops the loop.
 */
export default function useForceSimulation(
  nodeSpecs: SimNodeSpec[],
  links: SimLink[],
  onTick: (positions: Map<string, { x: number; y: number }>) => void,
  running: boolean
) {
  const simRef = useRef<ForceSimulation>(new ForceSimulation());
  const onTickRef = useRef(onTick);
  useEffect(() => { onTickRef.current = onTick; }, [onTick]);

  useEffect(() => {
    simRef.current.setData(nodeSpecs, links);
  }, [nodeSpecs, links]);

  useEffect(() => {
    if (!running) return;
    let frame = 0;
    let stopped = false;

    const loop = () => {
      if (stopped) return;
      simRef.current.tick(1);
      onTickRef.current(simRef.current.positions());
      frame = requestAnimationFrame(loop);
    };

    const handleVisibility = () => {
      if (document.hidden) { cancelAnimationFrame(frame); }
      else if (!stopped) { frame = requestAnimationFrame(loop); }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    frame = requestAnimationFrame(loop);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [running]);

  return simRef;
}
