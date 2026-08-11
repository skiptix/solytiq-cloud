import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  // tailwindcss() only feeds the small `@import 'tailwindcss/theme.css'` +
  // `@import 'tailwindcss/utilities.css'` stylesheet used by the vendored
  // Animate UI primitives (see src/components/animate-ui/tailwind.css) — the
  // rest of the app's styling is untouched inline styles / index.css, per
  // CLAUDE.md's "Luminous List" design system. No Tailwind preflight/reset is
  // imported anywhere, so this plugin cannot change any existing element's
  // appearance; it only makes `@tailwind`-authored utility classes resolvable
  // for the small set of files that opt into them.
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
