// Sprint 04, Phase 2+ — a large tail of the remaining first-party CSS
// `@keyframes` (fileDropPanelIn, fileDropIconFloat, filesBtnPulse, aiPulse,
// savedPop, cardIn, ...) are each bespoke, one-or-two-call-site shapes with
// their own scale/translate/origin deltas — unlike `modalIn`/`menuIn`/
// `pageIn`, which repeated the exact same shape at 10+ call sites and so
// earned a dedicated named primitive (ModalIn/PopIn/PageIn).
//
// Hand-rolling a dozens more single-use named components would just move
// the same three lines of motion.div boilerplate into dozens of files
// without adding any real abstraction. Instead, MotionIn is a thin, typed
// pass-through onto the central `motion.div` — call sites supply their own
// exact `initial`/`animate`/`transition`/`exit` (and optional `whileHover`/
// `whileTap` for hover/press feedback), copied 1:1 from the keyframe being
// replaced, so migrating a site never means guessing at shared physics.
// This still satisfies the "only the central layer imports raw motion"
// invariant — every consumer imports MotionIn, never `motion/react`.
import { forwardRef } from 'react';
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from 'react';
import { motion } from './motion';
import type { Transition, TargetAndTransition, Variants } from 'motion/react';

// Extends the full native `<div>` attribute surface (data-*, aria-*, role,
// ...) for the same reason MotionButton does — see its own comment on the
// small set of native props Motion's own types override.
type NativePropsMotionOverrides = 'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart' | 'onAnimationEnd' | 'style';
export interface MotionInProps extends Omit<ComponentPropsWithoutRef<'div'>, NativePropsMotionOverrides> {
  children?: ReactNode;
  // Each state also accepts a variant NAME. That is what lets an ancestor drive
  // a descendant's animation — the replacement for CSS's `.parent:hover .child`,
  // which Motion has no selector-based equivalent for: the parent declares
  // `whileHover="hover"` and the child picks the label up through `variants`.
  // (First needed by CalendarScreen's day cell revealing its add button.)
  initial?: TargetAndTransition | string | boolean;
  animate?: TargetAndTransition | string;
  exit?: TargetAndTransition | string;
  transition?: Transition;
  whileHover?: TargetAndTransition | string;
  whileTap?: TargetAndTransition | string;
  variants?: Variants;
  style?: CSSProperties;
}

const MotionIn = forwardRef<HTMLDivElement, MotionInProps>(function MotionIn(
  { children, ...rest },
  ref
) {
  return (
    <motion.div ref={ref} {...rest}>
      {children}
    </motion.div>
  );
});

export default MotionIn;
