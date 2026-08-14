import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Sprint 04, Phase 7.1 — a warning, not an error, and deliberately so.
      //
      // This rule (from the React Compiler rule set) fires on any synchronous
      // setState in an effect body. It caught five genuine "you might not need
      // an effect" cases in this codebase, all now fixed by deriving at render
      // or keying a component — see the Phase 7.1 commits.
      //
      // What remains is one shape, repeated across ~24 files, that the rule
      // reads as a violation and is not:
      //
      //   useEffect(() => {
      //     if (!id) { setData([]); return; }   // clear the PREVIOUS id's data
      //     setLoading(true);                   // drives the spinner
      //     fetchThing(id).then(r => setData(r));
      //   }, [id]);
      //
      // Both flagged statements are load-bearing. Drop the reset and the
      // previous entity's data stays on screen while the new request is in
      // flight; move it into the async continuation and you get the same
      // flash. Neither is derivable — the value comes from the network.
      //
      // Downgrading rather than disabling keeps every finding visible in
      // `npm run lint`, so a future genuine case is still reported; the CI
      // gate runs `eslint --quiet`, which fails on errors only.
      //
      // The principled fix is a shared `useAsyncData` hook that owns the
      // loading flag and cancellation (today ~24 sites hand-roll that with
      // three different spellings: `cancelled`, `alive`, `reqId.current`).
      // That is a real refactor of the app's data-loading path, out of scope
      // for an animation sprint, and tracked in DEPRECATIONS.md.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
])
