// Sprint 04, Phase 2 — the app had the exact same "bordered-circle spin"
// loading indicator hand-rolled 44 times across 24 files (a raw CSS
// `@keyframes spin` div, differing only in size/thickness/color/duration),
// none of them respecting `prefers-reduced-motion`. This is the one central
// primitive all of them now render through.
import { motion, useReducedMotion } from './motion';

export interface SpinnerProps {
  /** Diameter in px. */
  size: number;
  /** Ring thickness in px. */
  thickness?: number;
  /** Color of the ring's resting track. */
  trackColor?: string;
  /** Color of the rotating leading edge (pass 'transparent' for a spinning-gap look). */
  indicatorColor?: string;
  /** Full-rotation duration in ms — mirrors the 600/700ms values already used across the app. */
  durationMs?: number;
  display?: 'block' | 'inline-block';
  flexShrink?: number;
  className?: string;
  'aria-hidden'?: boolean;
}

export default function Spinner({
  size,
  thickness = 2,
  trackColor = 'var(--color-border)',
  indicatorColor = 'var(--color-primary)',
  durationMs = 700,
  display = 'block',
  flexShrink,
  className,
  'aria-hidden': ariaHidden,
}: SpinnerProps) {
  const prefersReducedMotion = useReducedMotion();
  return (
    <motion.div
      aria-hidden={ariaHidden}
      className={className}
      style={{
        display,
        width: size,
        height: size,
        flexShrink,
        borderRadius: '50%',
        border: `${thickness}px solid ${trackColor}`,
        // Under reduced motion, swap to a static, visibly-dimmed ring rather
        // than freezing mid-spin (which could read as a rendering glitch
        // rather than a loading state) — same design decision already
        // established for RouteFallback.css's own reduced-motion override.
        borderTopColor: prefersReducedMotion ? trackColor : indicatorColor,
        opacity: prefersReducedMotion ? 0.6 : 1,
      }}
      animate={prefersReducedMotion ? { rotate: 0 } : { rotate: 360 }}
      transition={prefersReducedMotion ? { duration: 0 } : { repeat: Infinity, ease: 'linear', duration: durationMs / 1000 }}
    />
  );
}
