// Route/feature error boundary with retry (Sprint 03, Phase 2 — "Route- und
// Feature-Error-Boundaries mit Retry"). Error boundaries must be class
// components (React has no hook equivalent to componentDidCatch/
// getDerivedStateFromError) — this is the one class component in the
// codebase for exactly that reason.
//
// Wraps both `<Routes>` blocks in App.tsx (see call sites) — every screen
// rendered inside is `React.lazy()`-loaded (Sprint 03, Phase 2), so a
// render-time exception here is overwhelmingly a failed dynamic `import()`
// chunk fetch (a flaky network blip on first navigation to a page).
//
// Sprint 03 independent-review finding, fixed here: Retry previously just
// did `this.setState({ error: null })`, which re-renders this subtree but
// does NOT actually retry anything for a lazy-chunk failure. `React.lazy(()
// => import(...))` caches its resolved/rejected status on the `lazy()`
// object itself (e.g. App.tsx's module-scope `const CalendarScreen =
// lazy(() => import('./screens/CalendarScreen'))`), not on the component
// tree — a live Playwright test (real network interception, aborting only
// the FIRST request for a chunk) confirmed that clicking the old Retry
// button made zero new network requests and instantly re-showed the exact
// same cached rejection. Unmounting/remounting via a changed `key` cannot
// fix this either, since it's still the same `lazy()` object reference
// being rendered — there is no supported way to reset one specific lazy
// object's cache from outside React's internals. A full page reload is the
// simple, genuinely correct fix (the same "ChunkLoadError" recovery pattern
// many production apps use) rather than a more surgical per-lazy-factory
// rebuild, which would add real complexity for a failure this rare.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import Icon from './Icon';

interface Props {
  children: ReactNode;
  /** Short, human label for what failed, e.g. "This page" or "Graph view" — used in the retry message. */
  label?: string;
}

interface State {
  error: Error | null;
}

export default class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Best-effort console diagnostics only — no telemetry pipeline exists in
    // this app to report to (see CLAUDE.md's AI/telemetry conventions),
    // matching the "best-effort, never breaks the flow" convention used
    // throughout the backend's own notification code.
    console.error(`[RouteErrorBoundary] ${this.props.label ?? 'A screen'} crashed:`, error, info.componentStack);
  }

  private retry = () => {
    // A real, full reload — NOT a local setState — is required to actually
    // clear a failed React.lazy() import()'s cached rejection. See the
    // header comment for why an in-place remount cannot do this.
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          minHeight: 240,
          width: '100%',
          padding: 32,
          textAlign: 'center',
        }}
      >
        <Icon name="error_outline" size={32} color="var(--color-error)" />
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)' }}>
          {this.props.label ?? 'This page'} couldn't load
        </div>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', maxWidth: 360 }}>
          Something went wrong while loading it — often a temporary network hiccup. Reloading the page usually fixes it.
        </div>
        <button
          onClick={this.retry}
          style={{
            fontFamily: 'var(--font-heading)',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--color-white)',
            background: 'var(--color-primary)',
            border: 'none',
            borderRadius: 8,
            padding: '10px 20px',
            cursor: 'pointer',
            marginTop: 4,
          }}
        >
          Reload page
        </button>
      </div>
    );
  }
}
