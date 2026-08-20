import { useEffect, useRef, useState } from 'react';

interface UsePullToRefreshOptions {
  onRefresh: () => Promise<void> | void;
  disabled?: boolean;
  /** Pull distance (px) required to trigger a refresh on release. */
  threshold?: number;
}

// How far (px) a touch has to move down before it's treated as a pull
// gesture rather than a tap. Touch events bubble through this container from
// every button inside it (view switcher, Automations, Hide Empty Sections,
// …), so without a dead-zone the ordinary few pixels of finger jitter during
// a tap were enough to call preventDefault() on touchmove — which cancels
// the tap's synthesized click on most mobile browsers instead of letting the
// button handle it.
const DRAG_DEADZONE = 10;

/**
 * Mobile "pull down at the top to refresh" gesture for a scrollable container.
 * Attaches native (non-passive) touch listeners via a ref rather than React's
 * onTouch* props — those are passive by default, so preventDefault() (needed
 * to stop the page's own rubber-band scroll while pulling) would silently
 * fail and log a console warning.
 */
export function usePullToRefresh({ onRefresh, disabled = false, threshold = 64 }: UsePullToRefreshOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // True whenever the indicator is snapping back to 0 on its own (released
  // below threshold, or a refresh just finished) rather than tracking a live
  // touch — the one case that should ease instead of following the finger 1:1.
  const [settling, setSettling] = useState(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startSettling = () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    setSettling(true);
    settleTimer.current = setTimeout(() => setSettling(false), 240);
  };

  useEffect(() => () => { if (settleTimer.current) clearTimeout(settleTimer.current); }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || disabled) return;

    let startY: number | null = null;
    let pulling = false;
    let distance = 0;

    const onTouchStart = (e: TouchEvent) => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
      setSettling(false);
      if (refreshing || el.scrollTop > 0) { startY = null; pulling = false; return; }
      // A touch that starts on a button/link/input is a tap target, not a
      // drag handle — never let it seed a pull gesture, however the finger
      // moves afterward. This is on top of (not instead of) the dead-zone
      // below, which covers the same tap's stray jitter over plain content.
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('button, a, input, textarea, select, [role="button"], [data-no-pull-refresh]')) {
        startY = null; pulling = false; return;
      }
      startY = e.touches[0].clientY;
      pulling = true;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!pulling || startY === null) return;
      if (el.scrollTop > 0) { pulling = false; distance = 0; setPullDistance(0); return; }
      const delta = e.touches[0].clientY - startY;
      if (delta <= DRAG_DEADZONE) {
        // Still inside the tap's normal jitter range — don't touch the
        // indicator and, crucially, don't preventDefault() yet, so a genuine
        // tap's click still fires. Only a downward delta past the dead-zone
        // commits this touch to being a pull gesture.
        if (delta <= 0) { distance = 0; setPullDistance(0); }
        return;
      }
      // Rubber-band damping so the indicator eases rather than tracking 1:1,
      // measured from the dead-zone edge so it doesn't jump the moment the
      // gesture is recognized as a pull.
      distance = Math.min((delta - DRAG_DEADZONE) * 0.5, threshold * 1.6);
      setPullDistance(distance);
      e.preventDefault();
    };

    const onTouchEnd = () => {
      if (!pulling) return;
      pulling = false;
      startY = null;
      if (distance >= threshold) {
        setRefreshing(true);
        setPullDistance(threshold);
        Promise.resolve(onRefresh()).finally(() => {
          startSettling();
          setRefreshing(false);
          setPullDistance(0);
        });
      } else {
        startSettling();
        setPullDistance(0);
      }
      distance = 0;
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, threshold, refreshing]);

  return { containerRef, pullDistance, refreshing, settling, threshold };
}
