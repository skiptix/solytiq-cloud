import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import PopIn from './animate-ui/PopIn';

// ── Anchored dropdown (portaled, viewport-positioned) ────────────────────────
// A floating panel pinned under (or above) an anchor element, rendered into
// document.body instead of next to its trigger.
//
// WHY A PORTAL AND NOT `position: absolute`:
// Every modal in this app is a card with `overflow: hidden` whose body scrolls
// (`overflowY: auto`), so an absolutely-positioned dropdown inside one is
// CLIPPED at the modal's edge no matter how high its z-index goes — this is not
// a stacking problem, and raising z-index does not fix it.
//
// WHY NOT JUST `position: fixed` EITHER:
// Those same modal cards are `motion.div`s that animate scale/y, so they carry
// a transform. Per the CSS spec a transformed element becomes the containing
// block for `position: fixed` descendants, which means a fixed child is still
// trapped inside the modal's bounds. (CLAUDE.md calls out the same trap for the
// sidebar.) Portaling to document.body is what actually escapes both.
//
// WHY THE POSITION IS WRITTEN TO THE DOM RATHER THAN HELD IN STATE:
// the panel re-measures on every scroll event so it tracks its input while the
// modal body scrolls. Through React state that is a re-render per scroll event,
// and it would need a setState in an effect body — which this codebase keeps at
// `error` (see useAsyncData / DEPRECATIONS.md). Writing `top`/`left`/`width`
// straight onto the node costs neither. Motion owns only `opacity`/`transform`
// on this element, so these properties never fight the entrance animation.

/** Above every modal layer in the app (ItemSettingsModal 1200, TaskDialog 1500,
 *  the tag/mention share prompt 1600) — a picker must never open behind the
 *  surface that hosts it. */
const Z_ANCHORED_DROPDOWN = 1700;

const VIEWPORT_MARGIN = 8;
const GAP = 4;

interface AnchoredDropdownProps {
  /** The element to pin to — typically the input row or trigger button. */
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  children: ReactNode;
  /** Panel width in px. Omit to match the anchor's own width. */
  width?: number;
  maxHeight?: number;
  /** Receives the panel element so callers can exclude it from outside-click
   *  checks — portaled content is NOT inside the anchor's DOM subtree, so a
   *  `contains(anchor, target)` test would treat clicking the panel as a click
   *  outside and close it before the pick registered. */
  panelRef?: RefObject<HTMLDivElement | null>;
}

export default function AnchoredDropdown({
  anchorRef, open, children, width, maxHeight = 220, panelRef,
}: AnchoredDropdownProps) {
  const innerRef = useRef<HTMLDivElement>(null);

  // Layout effect, not a plain effect: this runs before the browser paints, so
  // the panel is never shown at its unpositioned default for a frame.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current;
      const panel = innerRef.current;
      if (!anchor || !panel) return;
      const r = anchor.getBoundingClientRect();
      const panelWidth = Math.min(width ?? r.width, window.innerWidth - VIEWPORT_MARGIN * 2);

      // Prefer below; flip above only when the space below is genuinely too
      // tight AND there is more room above, so a picker near the bottom of the
      // screen stays usable instead of being squeezed into a couple of rows.
      const below = window.innerHeight - r.bottom - GAP - VIEWPORT_MARGIN;
      const above = r.top - GAP - VIEWPORT_MARGIN;
      const flip = below < Math.min(maxHeight, 120) && above > below;
      const height = Math.min(maxHeight, Math.max(0, flip ? above : below));

      panel.style.top = `${flip ? r.top - GAP - height : r.bottom + GAP}px`;
      // Keep the panel on-screen when the anchor sits near the right edge.
      panel.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(r.left, window.innerWidth - panelWidth - VIEWPORT_MARGIN))}px`;
      panel.style.width = `${panelWidth}px`;
      panel.style.maxHeight = `${height}px`;
      panel.style.visibility = 'visible';
    };

    place();
    // Capture phase: scroll events from the modal's own scrolling body do not
    // bubble to window, so a non-capturing listener would let the panel drift
    // away from its input as the user scrolls the dialog.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, anchorRef, width, maxHeight]);

  if (!open) return null;

  return createPortal(
    <PopIn
      duration={120}
      ref={(node: HTMLDivElement | null) => {
        innerRef.current = node;
        if (panelRef) panelRef.current = node;
      }}
      style={{
        // `visibility: hidden` until the layout effect has placed it — the
        // first render has no rect to measure from yet.
        position: 'fixed', top: 0, left: 0, visibility: 'hidden',
        overflowY: 'auto',
        zIndex: Z_ANCHORED_DROPDOWN,
        background: 'var(--color-white)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
        boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.16)',
        padding: 6,
      }}
    >
      {children}
    </PopIn>,
    document.body,
  );
}
