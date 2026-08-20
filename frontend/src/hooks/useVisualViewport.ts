import { useEffect, useRef, useState } from 'react';

export interface VisualViewportMetrics {
  /** Height (px) of the actually-visible viewport right now. */
  height: number;
  /** Distance (px) from the layout viewport's top edge to the visible area's top edge. */
  top: number;
  /**
   * The largest visual-viewport height observed so far — a stable stand-in
   * for "the keyboard is closed" height. Deliberately NOT `window.innerHeight`:
   * that only holds steady in a regular Safari tab. In an iOS Home Screen
   * (standalone) web app, WebKit resizes the LAYOUT viewport itself right
   * along with the visual one when the keyboard opens, so `innerHeight`
   * shrinks in lockstep and a `visualViewport.height < innerHeight` check
   * never trips — the keyboard reads as "closed" the whole time, and any
   * code branching on that (e.g. dropping home-indicator safe-area padding
   * once the keyboard is up) keeps applying it, leaving a visible gap
   * wedged between the content and the keyboard. Tracking our own running
   * max sidesteps whatever the layout viewport is doing.
   */
  fullHeight: number;
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
    fullHeight: window.innerHeight,
  }));
  const maxHeightRef = useRef(window.innerHeight);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      // A larger reading than anything seen so far means the keyboard is
      // (at most) as closed as it's ever been since mount — fold it into
      // the running baseline. A smaller reading never lowers it: that's
      // the keyboard opening, which is exactly what fullHeight needs to
      // stay stable through.
      if (vv.height > maxHeightRef.current) maxHeightRef.current = vv.height;
      setMetrics({ height: vv.height, top: vv.offsetTop, fullHeight: maxHeightRef.current });
    };
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
