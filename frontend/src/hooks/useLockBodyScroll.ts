import { useEffect } from 'react';

/**
 * Locks the page behind a full-screen overlay from scrolling, for as long as
 * the calling component is mounted.
 *
 * Plain `overflow: hidden` on `<body>` is NOT enough on iOS Safari — it's a
 * long-standing WebKit quirk that the body still rubber-bands/scrolls under
 * touch regardless. The reliable fix (used by most production scroll-lock
 * libraries) is to pin the body in place with `position: fixed` at its
 * current scroll offset, then restore both the styles and the scroll
 * position on unmount. This is also what stops the browser's own
 * "scroll the focused input into view" behavior from moving the page when a
 * `position: fixed` overlay's text field is focused on iOS — with nothing
 * left to scroll, there's nothing for it to move.
 */
export function useLockBodyScroll(): void {
  useEffect(() => {
    const { body } = document;
    const scrollY = window.scrollY;
    const prev = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      overflow: body.style.overflow,
    };

    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
    body.style.overflow = 'hidden';

    return () => {
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.left = prev.left;
      body.style.right = prev.right;
      body.style.width = prev.width;
      body.style.overflow = prev.overflow;
      window.scrollTo(0, scrollY);
    };
  }, []);
}
