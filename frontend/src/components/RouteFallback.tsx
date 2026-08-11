// Shared Suspense fallback for lazily-loaded route screens and heavy modals
// (Sprint 03, Phase 2 — "leere Gates durch zugängliche, visuell stabile
// Zustände ersetzen"). Every route in App.tsx used to fall back to `null`
// while its chunk downloaded (or, for the app-install gates, while
// `installedApps` loaded) — a blank screen with zero feedback is
// indistinguishable from a crash and fails a screen-reader user completely
// (nothing is announced). This component:
//   - is announced to assistive tech via `role="status"` + `aria-live="polite"`
//     (visually-hidden text, not just a spinning icon)
//   - has a fixed, known size so it never causes layout shift when swapped
//     for the real screen
//   - Sprint 04: renders through the central Spinner primitive (was a plain
//     CSS `@keyframes spin` animation) — same reduced-motion behavior
//     (static, dimmed ring instead of a spinning one), now Motion-driven.
import Spinner from '@/components/animate-ui/Spinner';

export default function RouteFallback({ label = 'Loading…' }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 240,
        width: '100%',
      }}
    >
      <Spinner size={32} thickness={3} durationMs={700} aria-hidden />
      <span
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {label}
      </span>
    </div>
  );
}
