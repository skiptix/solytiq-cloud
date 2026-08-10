import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { MotionConfig } from 'motion/react'
import './index.css'
// Additive Tailwind entry for the vendored Animate UI primitive family — see
// that file's header comment. Does not replace or modify index.css.
import './components/animate-ui/tailwind.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Sprint 03 Animate-UI-Kompatibilitäts-Spike requirement: set exactly
        once, at the app root, so every Motion-driven animation (existing
        first-party ones and the new Animate UI primitives alike) degrades to
        near-instant transitions for a user with `prefers-reduced-motion:
        reduce` set at the OS/browser level. Verified in the pilot gate with
        Playwright: settle time for a spring entrance drops from ~430ms to
        ~20ms under this setting, with normal motion unaffected. */}
    <MotionConfig reducedMotion="user">
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </MotionConfig>
  </StrictMode>,
)
