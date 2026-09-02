// ---------------------------------------------------------------------------
// The speech waveform — the whole visual surface of voice-only mode.
//
// Reads the live AnalyserNode every frame and writes bar heights STRAIGHT to
// the DOM. There is deliberately no React state in the render loop: a 32-bar
// visualiser at 60fps would otherwise be 3,600 re-renders a second, which is
// the same mistake NeuralGraph's force simulation exists to avoid. The frames
// come from `useFrameLoop`, the central Animate-UI layer's only sanctioned
// per-frame callback, so this shares Motion's scheduler instead of racing it
// with a second requestAnimationFrame.
// ---------------------------------------------------------------------------
import { useMemo, useRef } from 'react';
import useFrameLoop from '../animate-ui/useFrameLoop';

interface Props {
  analyserRef: React.RefObject<AnalyserNode | null>;
  /** Feeds `levelRef` back out so the orb behind the bars can pulse in sync. */
  levelRef?: React.RefObject<number>;
  /** Bars react to audio while true; they settle to the resting line when not. */
  active: boolean;
  bars?: number;
  width?: number;
  height?: number;
  color?: string;
}

/** Bar height as a fraction of `height` when nothing is being said. Not zero:
 *  a flat line reads as "broken", a low line reads as "listening". */
const REST = 0.08;
/** How fast a bar chases its target, per frame at 60fps. Smoothing here rather
 *  than only on the analyser keeps the fall-off graceful without making the
 *  attack feel laggy. */
const ATTACK = 0.55;
const RELEASE = 0.14;

export default function VoiceWaveform({
  analyserRef, levelRef, active,
  bars = 28, width = 240, height = 84,
  color = 'var(--color-white)',
}: Props) {
  const barRefs = useRef<(SVGRectElement | null)[]>([]);
  const heights = useRef<number[]>(Array.from({ length: bars }, () => REST));
  const dataRef = useRef<Uint8Array | null>(null);

  const geometry = useMemo(() => {
    const gap = 4;
    const barWidth = Math.max(2, (width - gap * (bars - 1)) / bars);
    return { gap, barWidth };
  }, [bars, width]);

  useFrameLoop(() => {
    const analyser = analyserRef.current;
    const n = barRefs.current.length;
    if (n === 0) return;

    let sum = 0;
    if (active && analyser) {
      const binCount = analyser.frequencyBinCount;
      if (!dataRef.current || dataRef.current.length !== binCount) {
        dataRef.current = new Uint8Array(binCount);
      }
      const data = dataRef.current;
      // `as never` bridges a lib.dom typing split: some TS DOM versions type
      // this as Uint8Array<ArrayBuffer> and reject the plain alias.
      analyser.getByteFrequencyData(data as never);

      // Speech lives in the low half of the spectrum; sampling the full range
      // would leave most bars permanently flat. Sample logarithmically so the
      // low end — where the energy actually is — gets more of the bars.
      for (let i = 0; i < n; i++) {
        const t = i / Math.max(1, n - 1);
        const lo = Math.floor(Math.pow(t, 1.7) * binCount * 0.62);
        const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / n, 1.7) * binCount * 0.62));
        let peak = 0;
        for (let b = lo; b < hi && b < binCount; b++) peak = Math.max(peak, data[b]);
        const target = REST + (peak / 255) * (1 - REST);
        const prev = heights.current[i] ?? REST;
        heights.current[i] = prev + (target - prev) * (target > prev ? ATTACK : RELEASE);
        sum += heights.current[i];
      }
      if (levelRef) levelRef.current = Math.min(1, (sum / n - REST) / (1 - REST));
    } else {
      // Settle back to the resting line rather than snapping — a hard cut at
      // the end of a turn reads as a glitch.
      for (let i = 0; i < n; i++) {
        const prev = heights.current[i] ?? REST;
        heights.current[i] = prev + (REST - prev) * RELEASE;
      }
      if (levelRef) levelRef.current = 0;
    }

    for (let i = 0; i < n; i++) {
      const el = barRefs.current[i];
      if (!el) continue;
      const h = Math.max(geometry.barWidth, heights.current[i] * height);
      el.setAttribute('y', String((height - h) / 2));
      el.setAttribute('height', String(h));
    }
  }, {
    // 'settle' rather than 'stop': these bars ARE the UI's only indication
    // that the mic is live. A user with reduced motion who sees a permanently
    // flat line has no way to tell a working mic from a dead one — that's a
    // broken interface, not a calmer one. The loop reaches a resting state and
    // stops on its own, which is what 'settle' means.
    reducedMotion: 'settle',
    settleMs: 60_000,
  });

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={active ? 'Listening' : 'Microphone idle'}
      style={{ overflow: 'visible', display: 'block' }}
    >
      {Array.from({ length: bars }, (_, i) => {
        const h = REST * height;
        return (
          <rect
            key={i}
            ref={(el) => { barRefs.current[i] = el; }}
            x={i * (geometry.barWidth + geometry.gap)}
            y={(height - h) / 2}
            width={geometry.barWidth}
            height={h}
            rx={geometry.barWidth / 2}
            fill={color}
          />
        );
      })}
    </svg>
  );
}
