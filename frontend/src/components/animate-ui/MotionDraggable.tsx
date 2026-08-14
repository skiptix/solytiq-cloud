// Sprint 04, Phase 2/3 — the one shape that blocked Sidebar.tsx and
// TaskItem.tsx from migrating: a list row that is BOTH a native HTML5
// drag source/target (`draggable` + `onDragStart`/`onDragOver`/`onDrop`/…)
// AND wants Motion-driven hover/selection/reorder feedback.
//
// Why this needs its own component rather than just using MotionIn:
// Motion's own prop types declare `onDragStart`/`onDrag`/`onDragEnd` as
// PAN-GESTURE callbacks — `(event, info: PanInfo) => void` — because those
// names are also Motion's drag-gesture API. MotionIn/MotionButton therefore
// `Omit` them outright, so a call site that needs the NATIVE handlers can't
// type-check against them at all.
//
// The important part is that this is only a *types* collision, not a runtime
// one. With Motion's `drag` prop NOT set, Motion's drag gesture is inert and
// these props pass straight through to the DOM as ordinary React event
// handlers — verified empirically, and locked in by
// `src/components/animate-ui/__tests__/motionDraggable.test.tsx`, which fails
// loudly if a future Motion upgrade ever starts intercepting them. Do not
// pass `drag` to this component; that would hand the same prop names back to
// Motion's gesture system and silently break native drag-and-drop.
import { forwardRef } from 'react';
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from 'react';
import { motion } from './motion';
import type { Transition, TargetAndTransition, Variants } from 'motion/react';

// Native <div> surface, keeping the drag handlers as React's own
// DragEventHandler rather than letting Motion's pan-gesture types win.
type NativeDivProps = ComponentPropsWithoutRef<'div'>;
type MotionCollidingProps = 'onAnimationStart' | 'onAnimationEnd' | 'style';

export interface MotionDraggableProps
  extends Omit<NativeDivProps, MotionCollidingProps> {
  children?: ReactNode;
  // Variant NAMES are accepted alongside targets for the same reason MotionIn
  // accepts them: an ancestor driving a descendant's animation, which is the
  // replacement for CSS's `.parent:hover .child`.
  initial?: TargetAndTransition | string | boolean;
  animate?: TargetAndTransition | string;
  exit?: TargetAndTransition | string;
  transition?: Transition;
  whileHover?: TargetAndTransition | string;
  whileTap?: TargetAndTransition | string;
  variants?: Variants;
  layout?: boolean | 'position' | 'size';
  style?: CSSProperties;
}

const MotionDraggable = forwardRef<HTMLDivElement, MotionDraggableProps>(
  function MotionDraggable({ children, ...rest }, ref) {
    return (
      // The cast is the whole point of this file: it is the single, documented
      // place where the native-drag prop types are reconciled with Motion's,
      // instead of every draggable call site carrying its own `as any`.
      <motion.div ref={ref} {...(rest as React.ComponentProps<typeof motion.div>)}>
        {children}
      </motion.div>
    );
  }
);

export default MotionDraggable;
