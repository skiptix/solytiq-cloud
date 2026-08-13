// Sprint 04, Phase 4 — one-shot frame deferral.
//
// This is frame TIMING, not animation: "React has queued a state update that
// will rewrite this textarea's value; put the caret back once the DOM
// actually reflects it." The block editor needs it after a format toggle and
// after picking an @-mention, and it used a bare `requestAnimationFrame` for
// it.
//
// It still belongs in the central layer, for the same reason `useFrameLoop`
// does: this app should have exactly ONE authority on when work happens
// relative to a frame. Motion's scheduler already is that authority for every
// animated write on the page, and `frame.postRender` is its "after this
// frame's DOM writes" slot — precisely the moment a caret restore wants. A
// separate rAF would land in the same frame with no defined ordering against
// those writes.
//
// It is also what lets scripts/check-animations.mjs keep treating a raw
// `requestAnimationFrame` outside this directory as a violation with no
// allowlist exceptions: there is a sanctioned way to say this, so needing to
// say it is not a reason to weaken the gate.
import { frame, cancelFrame } from 'motion/react';

/**
 * Runs `callback` after the next frame's DOM writes have been applied.
 *
 * Returns a cancel function for callers whose component may unmount first —
 * a caret restore against a detached node is harmless, but a longer-lived
 * caller should not have to know that.
 */
export default function nextFrame(callback: () => void): () => void {
  const process = () => callback();
  frame.postRender(process);
  return () => cancelFrame(process);
}
