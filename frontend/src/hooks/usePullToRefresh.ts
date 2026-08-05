import { useEffect, useRef, useState } from 'react';

interface UsePullToRefreshOptions {
  onRefresh: () => Promise<void> | void;
  disabled?: boolean;
  /** Pull distance (px) required to trigger a refresh on release. */
  threshold?: number;
}

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

  useEffect(() => {
    const el = containerRef.current;
    if (!el || disabled) return;

    let startY: number | null = null;
    let pulling = false;
    let distance = 0;

    const onTouchStart = (e: TouchEvent) => {
      if (refreshing || el.scrollTop > 0) { startY = null; pulling = false; return; }
      startY = e.touches[0].clientY;
      pulling = true;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!pulling || startY === null) return;
      if (el.scrollTop > 0) { pulling = false; distance = 0; setPullDistance(0); return; }
      const delta = e.touches[0].clientY - startY;
      if (delta <= 0) { distance = 0; setPullDistance(0); return; }
      // Rubber-band damping so the indicator eases rather than tracking 1:1.
      distance = Math.min(delta * 0.5, threshold * 1.6);
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
          setRefreshing(false);
          setPullDistance(0);
        });
      } else {
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

  return { containerRef, pullDistance, refreshing, threshold };
}
