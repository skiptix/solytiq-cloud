// Sprint 04, Phase 1/2 — the app had the exact same "scale up + settle from
// above" popover/dropdown/menu entrance (`@keyframes menuIn` in index.css)
// hand-declared via a raw CSS `animation` string at 38 call sites across 28
// files, differing only in duration and easing. This is the one central
// primitive all of them now render through.
//
// Reduced motion is handled once, here, rather than at each of the 38 call
// sites: the root `AppMotionConfig`'s `MotionConfig reducedMotion="user"`
// automatically drops transform animations (the scale/translateY) for users
// with the OS-level preference set, leaving only the opacity fade — content
// still appears, it just doesn't move.
import { forwardRef } from 'react';
import type { CSSProperties, ReactNode, MouseEventHandler, KeyboardEventHandler } from 'react';
import { motion } from './motion';
import { EASE_SPRING, EASE_SETTLE, EASE_STANDARD } from './motionTokens';

/** Named eases so call sites migrate 1:1 from their old CSS timing-function without guessing at a bezier. */
export type PopInEase = 'standard' | 'spring' | 'settle';

const EASE_MAP: Record<PopInEase, [number, number, number, number]> = {
  standard: EASE_STANDARD,
  spring: EASE_SPRING,
  settle: EASE_SETTLE,
};

export interface PopInProps {
  children: ReactNode;
  /** Matches the original `animation: menuIn <duration>ms ...` duration in ms. */
  duration: number;
  /** Matches the original CSS timing-function: `ease` -> 'standard', `cubic-bezier(0.34,1.56,0.64,1)` -> 'spring', `cubic-bezier(0.22,1,0.36,1)` -> 'settle'. */
  ease?: PopInEase;
  style?: CSSProperties;
  className?: string;
  onClick?: MouseEventHandler<HTMLDivElement>;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  onMouseDown?: MouseEventHandler<HTMLDivElement>;
  onMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: MouseEventHandler<HTMLDivElement>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  id?: string;
  role?: string;
  tabIndex?: number;
}

const PopIn = forwardRef<HTMLDivElement, PopInProps>(function PopIn(
  { children, duration, ease = 'standard', style, ...rest },
  ref
) {
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.88, y: -6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: duration / 1000, ease: EASE_MAP[ease] }}
      style={style}
      {...rest}
    >
      {children}
    </motion.div>
  );
});

export default PopIn;
