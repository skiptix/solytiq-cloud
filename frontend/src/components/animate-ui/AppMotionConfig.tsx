// Sprint 04, Phase 1 — the one place `MotionConfig` is mounted. main.tsx
// wraps the whole app in this exactly once, so `reducedMotion="user"`
// (which follows the OS-level `prefers-reduced-motion` setting) governs
// every Motion-driven animation in the app from a single root. Kept as a
// tiny wrapper component (rather than main.tsx importing `MotionConfig`
// itself) so main.tsx never needs a direct `motion/react` import — see
// motion.ts's central-boundary note.
import type { ReactNode } from 'react';
import { MotionConfig } from './motion';

export default function AppMotionConfig({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
