// Sprint 04, Phase 2 (shell/route batch) — the app had a single route-change
// entrance (`@keyframes pageIn` in index.css) hand-declared via a raw CSS
// `animation` string on the `.page-transition` wrapper in App.tsx (remounted
// per-route via `key={location.pathname}`). This is the one primitive that
// call site now renders through, mirroring `ModalIn`/`PopIn`'s shape.
//
// Reduced motion is handled once, centrally: the root `AppMotionConfig`'s
// `MotionConfig reducedMotion="user"` drops the translateY transform for
// users with the OS-level preference set, leaving only the opacity fade.
//
// Note for future readers: this wrapper's `animate` state leaves a
// persistent (non-`none`) inline `transform` on the DOM node after the
// entrance finishes, exactly like the CSS `animation-fill-mode: both` it
// replaces did — so it still establishes a containing block for
// `position: fixed` descendants. Every modal rendered from inside a routed
// screen must still render via `createPortal` (see CLAUDE.md's Mobile
// Responsiveness rules and the `.page-transition` comments in
// TaskDialog.tsx/AttachmentPreview.tsx/CalendarScreen.tsx) — this migration
// does not change that contract.
import { forwardRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { motion } from './motion';
import { EASE_SETTLE } from './motionTokens';

export interface PageInProps {
  children: ReactNode;
  /** Matches the original `animation: pageIn <duration>ms ...` duration in ms. */
  duration: number;
  style?: CSSProperties;
  className?: string;
  id?: string;
  tabIndex?: number;
}

// Renders a `<main>`, not a `<div>` — the sole call site (App.tsx's routed
// content) is the page's `<main id="main-content">` landmark the skip link
// targets, so this can't be genericized to `motion.div` the way
// ModalIn/PopIn are without losing that landmark for screen readers.
const PageIn = forwardRef<HTMLElement, PageInProps>(function PageIn(
  { children, duration, style, ...rest },
  ref
) {
  return (
    <motion.main
      ref={ref}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: duration / 1000, ease: EASE_SETTLE }}
      style={style}
      {...rest}
    >
      {children}
    </motion.main>
  );
});

export default PageIn;
