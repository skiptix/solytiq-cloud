// Sprint 04, Phase 3 — the app had the exact same "scale up from center"
// modal-card entrance (`@keyframes modalIn` in index.css) hand-declared via
// a raw CSS `animation` string, always with the same spring easing
// (cubic-bezier(0.34,1.56,0.64,1)) and only the duration varying (180-280ms)
// across call sites. This is the one central primitive all of them now
// render through — mirrors `PopIn`'s shape/conventions exactly, just with
// modalIn's own transform (scale only, no translateY).
//
// Reduced motion is handled once, centrally: the root `AppMotionConfig`'s
// `MotionConfig reducedMotion="user"` drops the scale animation for users
// with the OS-level preference set, leaving only the opacity fade.
import { forwardRef } from 'react';
import type { CSSProperties, ReactNode, MouseEventHandler } from 'react';
import { motion } from './motion';
import { EASE_SPRING } from './motionTokens';

export interface ModalInProps {
  children: ReactNode;
  /** Matches the original `animation: modalIn <duration>ms ...` duration in ms. */
  duration: number;
  style?: CSSProperties;
  className?: string;
  onClick?: MouseEventHandler<HTMLDivElement>;
  onMouseDown?: MouseEventHandler<HTMLDivElement>;
  id?: string;
  role?: string;
}

const ModalIn = forwardRef<HTMLDivElement, ModalInProps>(function ModalIn(
  { children, duration, style, ...rest },
  ref
) {
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: duration / 1000, ease: EASE_SPRING }}
      style={style}
      {...rest}
    >
      {children}
    </motion.div>
  );
});

export default ModalIn;
