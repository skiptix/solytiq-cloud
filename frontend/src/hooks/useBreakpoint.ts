import { useState, useEffect } from 'react';

export const BP = { mobile: 640, tablet: 1024 } as const;

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

function detect(w: number): Breakpoint {
  if (w < BP.mobile) return 'mobile';
  if (w < BP.tablet) return 'tablet';
  return 'desktop';
}

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(() => detect(window.innerWidth));
  useEffect(() => {
    const mq1 = window.matchMedia(`(max-width: ${BP.mobile - 1}px)`);
    const mq2 = window.matchMedia(`(max-width: ${BP.tablet - 1}px)`);
    const update = () => setBp(detect(window.innerWidth));
    mq1.addEventListener('change', update);
    mq2.addEventListener('change', update);
    return () => {
      mq1.removeEventListener('change', update);
      mq2.removeEventListener('change', update);
    };
  }, []);
  return bp;
}

export function useMobile(): boolean {
  return useBreakpoint() === 'mobile';
}

export function useTabletOrBelow(): boolean {
  return useBreakpoint() !== 'desktop';
}
