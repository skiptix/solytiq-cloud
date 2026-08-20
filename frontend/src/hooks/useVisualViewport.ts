import { useEffect, useState } from 'react';

export interface VisualViewportMetrics {
  /** Height (px) of the actually-visible viewport right now. */
  height: number;
  /** Distance (px) from the layout viewport's top edge to the visible area's top edge. */
  top: number;
}

/**
 * Tracks `window.visualViewport` so a full-screen overlay can size itself to
 * what's ACTUALLY visible, not the full layout viewport.
 *
 * iOS Safari's on-screen keyboard shrinks the visual viewport without
 * shrinking the layout viewport that `100dvh`/`position:fixed; inset:0` size
 * against — a fixed-bottom element keeps the same box it always had, now
 * with its lower portion rendered underneath the keyboard. This is Apple's
 * own documented behavior and the `visualViewport` API is WebKit's own
 * prescribed fix (see the WebKit blog's "Visual Viewport API" post) — there
 * is no CSS-only way to track the keyboard's height across the iOS Safari
 * versions actually in the field. Falls back to `window.innerHeight`/no
 * offset on browsers without the API (older WebViews, some desktop
 * browsers), which reproduces the plain `inset:0` behavior those already had.
 */
export function useVisualViewport(): VisualViewportMetrics {
  const [metrics, setMetrics] = useState<VisualViewportMetrics>(() => ({
    height: window.innerHeight,
    top: 0,
  }));

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => setMetrics({ height: vv.height, top: vv.offsetTop });
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return metrics;
}
