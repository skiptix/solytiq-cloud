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
import type { Transition, TargetAndTransition } from 'motion/react';

// Extends the full native `<div>` attribute surface (data-*, aria-*, role,
// ...) for the same reason MotionButton does — see its own comment on the
// small set of native props Motion's own types override.
type NativePropsMotionOverrides = 'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart' | 'onAnimationEnd' | 'style';
export interface MotionInProps extends Omit<ComponentPropsWithoutRef<'div'>, NativePropsMotionOverrides> {
  children?: ReactNode;
  initial?: TargetAndTransition | boolean;
  animate?: TargetAndTransition;
  exit?: TargetAndTransition;
  transition?: Transition;
  whileHover?: TargetAndTransition;
  whileTap?: TargetAndTransition;
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
