// Central Animate-UI motion boundary — Sprint 04, Phase 1.
//
// This is the one first-party module (alongside the vendored
// animate-ui/primitives/** and animate-ui/components/** trees) permitted to
// import the raw `motion/react` runtime. Every feature/screen/hook/store
// that needs `motion.div`, `AnimatePresence`, drag controls, or Motion's
// types re-exports from here instead of importing 'motion/react' directly —
// see CLAUDE.md's Animate-UI invariant ("Nur die zentrale Animate-UI-Schicht
// darf rohe Motion-Primitives importieren") and
// scripts/check-animations.mjs's `centralLayerDirs` policy gate, which
// enforces this at CI time. A future swap of the underlying motion runtime
// (or a version bump with a breaking export change) touches this one file
// instead of the ~20 call sites that consume it.
export { motion, AnimatePresence, useDragControls, MotionConfig } from 'motion/react';
export type { PanInfo, Variants } from 'motion/react';
