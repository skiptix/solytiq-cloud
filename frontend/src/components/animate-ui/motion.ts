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
export { motion, AnimatePresence, useDragControls, useReducedMotion, MotionConfig, useAnimationFrame, animate } from 'motion/react';
// `TargetAndTransition`/`Transition` are re-exported for the same reason as the
// runtime values: a component that takes a Motion target as a PROP (e.g.
// SlashCommandInput's `inputAnimate`, where the host owns the animated state)
// still must not reach into 'motion/react' itself — the policy gate treats a
// type-only import from there as a boundary violation just like a value one,
// deliberately, since a type import is exactly how the boundary erodes first.
export type { PanInfo, Variants, TargetAndTransition, Transition } from 'motion/react';
