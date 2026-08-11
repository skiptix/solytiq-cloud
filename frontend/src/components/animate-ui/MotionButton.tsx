// Sprint 04, Phase 2+ — the single most common first-party CSS-transition
// shape in the whole app: an icon `<button>` with a `transition: 'all Nms'`
// (or a specific-property list) paired with imperative `onMouseEnter`/
// `onMouseLeave` handlers that mutate `e.currentTarget.style.*` directly to
// swap background/border/color on hover, then restore it on mouse-leave.
// This is `motion.button`'s `whileHover`/`whileTap` built for exactly this
// case — declarative target styles, Motion owns the enter/leave tween, no
// imperative DOM mutation or manual "restore the previous value" logic.
//
// Sibling of MotionIn (which renders `motion.div`) — kept as its own
// component rather than an `as` prop so call sites migrating a real
// `<button>` keep native button semantics (keyboard focus/activation)
// instead of silently downgrading to a non-focusable div, the same
// consideration PageIn's `motion.main` vs `motion.div` choice documents.
import { forwardRef } from 'react';
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from 'react';
import { motion } from './motion';
import type { Transition, TargetAndTransition } from 'motion/react';

// Extends the full native `<button>` attribute surface (data-*, aria-*,
// disabled, type, ...) rather than enumerating props by hand, so a call
// site migrating an arbitrary existing button never hits a missing-prop
// type error. Omits the handful of native props Motion's own types
// override with an incompatible (gesture/animation-lifecycle) signature —
// none of these are used for the imperative-hover pattern being replaced.
type NativePropsMotionOverrides = 'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart' | 'onAnimationEnd' | 'style';
export interface MotionButtonProps extends Omit<ComponentPropsWithoutRef<'button'>, NativePropsMotionOverrides> {
  children?: ReactNode;
  /** Entrance state, for buttons that also play a mount animation (e.g. a staggered menu item). */
  initial?: TargetAndTransition | boolean;
  /** Persistent state-driven target (mirrors the old conditional inline `style`). */
  animate?: TargetAndTransition;
  /** Hover-only target, layered on top of `animate`. `undefined` disables hover feedback (e.g. while a state like `fileDragActive` should suppress it). */
  whileHover?: TargetAndTransition;
  whileTap?: TargetAndTransition;
  transition?: Transition;
  style?: CSSProperties;
}

const MotionButton = forwardRef<HTMLButtonElement, MotionButtonProps>(function MotionButton(
  { children, ...rest },
  ref
) {
  return (
    <motion.button ref={ref} {...rest}>
      {children}
    </motion.button>
  );
});

export default MotionButton;
