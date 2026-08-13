import type { Variants } from './motion';

/** Spring-overshoot curve — mirrors the app's `modalIn`/`aiWindowIn`/`menuIn` CSS keyframes. */
export const EASE_SPRING: [number, number, number, number] = [0.34, 1.56, 0.64, 1];
/** Ease-out settle curve — mirrors the app's `backdropIn`/`sectionFadeUp`/`aiSheetIn` CSS keyframes. */
export const EASE_SETTLE: [number, number, number, number] = [0.22, 1, 0.36, 1];
/** The CSS `ease` keyword's own curve, spelled out as a bezier — mirrors every `menuIn ...ms ease` CSS call site so migrating off the keyframe changes zero timing/physics. */
export const EASE_STANDARD: [number, number, number, number] = [0.25, 0.1, 0.25, 1];
/** Cubic ease-out (`1 - (1-p)^3`), spelled as its exact bezier — mirrors the hand-rolled camera/scroll tweens migrated off bespoke rAF loops. */
export const EASE_OUT_CUBIC: [number, number, number, number] = [0.33, 1, 0.68, 1];

/** Durations in seconds (Motion's convention), consolidating the scattered ms values found across the CSS. */
export const DURATION = {
  fast: 0.16,
  base: 0.2,
  modal: 0.22,
  spring: 0.28,
};

/** Full-screen dim/blur behind a modal or panel. Mirrors `backdropIn`/`backdropOut`. */
export const backdropVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: DURATION.base, ease: EASE_SETTLE } },
  exit: { opacity: 0, transition: { duration: DURATION.fast, ease: EASE_SETTLE } },
};

/** Centered modal card. Mirrors `modalIn` (enter) / `settingsModalOut` (exit). */
export const modalVariants: Variants = {
  initial: { opacity: 0, scale: 0.94, y: 0 },
  animate: { opacity: 1, scale: 1, y: 0, transition: { duration: DURATION.modal, ease: EASE_SPRING } },
  exit: { opacity: 0, scale: 0.97, y: 14, transition: { duration: DURATION.fast, ease: EASE_SETTLE } },
};

/** Mobile bottom sheet. Mirrors `aiSheetIn`. */
export const sheetVariants: Variants = {
  initial: { y: '100%' },
  animate: { y: 0, transition: { duration: DURATION.spring, ease: EASE_SETTLE } },
  exit: { y: '100%', transition: { duration: DURATION.base, ease: EASE_SETTLE } },
};

/** Right-docked slide-in panel (inspectors, notification tray). Mirrors `aiPanelIn`. */
export const panelVariantsRight: Variants = {
  initial: { opacity: 0, x: '100%' },
  animate: { opacity: 1, x: 0, transition: { duration: DURATION.modal, ease: EASE_SETTLE } },
  exit: { opacity: 0, x: '100%', transition: { duration: DURATION.base, ease: EASE_SETTLE } },
};

/** Sol's desktop chat window, anchored bottom-right. Mirrors `aiWindowIn`. Pair with `style={{ transformOrigin: 'bottom right' }}`. */
export const desktopWindowVariants: Variants = {
  initial: { opacity: 0, scale: 0.92, y: 16 },
  animate: { opacity: 1, scale: 1, y: 0, transition: { duration: DURATION.spring, ease: EASE_SPRING } },
  exit: { opacity: 0, scale: 0.92, y: 16, transition: { duration: DURATION.base, ease: EASE_SETTLE } },
};

/** Small inline pop — confirm-delete rows, mode-toggle content swaps. */
export const popVariants: Variants = {
  initial: { opacity: 0, scale: 0.94 },
  animate: { opacity: 1, scale: 1, transition: { duration: DURATION.base, ease: EASE_SETTLE } },
  exit: { opacity: 0, scale: 0.94, transition: { duration: DURATION.fast, ease: EASE_SETTLE } },
};

/** Cross-fade for tab/step content swaps (pair with `AnimatePresence mode="wait"`, keyed by the active tab/step). Mirrors `sectionFadeUp`. */
export const crossFadeVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: DURATION.base, ease: EASE_SETTLE } },
  exit: { opacity: 0, y: -8, transition: { duration: DURATION.fast, ease: EASE_SETTLE } },
};

/** A list row that can enter/leave a reorderable list. Pair with `layout` on the wrapping element. */
export const listItemVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: DURATION.base, ease: EASE_SETTLE } },
  exit: { opacity: 0, x: -14, transition: { duration: DURATION.fast, ease: EASE_SETTLE } },
};

/** Spring used for `layout` position tweens (drag-reorder, add/remove reflow). */
export const LAYOUT_TRANSITION = { duration: DURATION.spring, ease: EASE_SETTLE };

/** Thresholds for the mobile chat sheet's swipe-to-dismiss gesture. */
export const SWIPE_DISMISS_DISTANCE = 120;
export const SWIPE_DISMISS_VELOCITY = 500;
