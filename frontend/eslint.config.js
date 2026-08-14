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
      // An ERROR, and the codebase is at zero.
      //
      // This rule (from the React Compiler rule set) fires on any synchronous
      // setState in an effect body. It arrived reporting ~40 findings across
      // ~24 files, nearly all of them one shape:
      //
      //   useEffect(() => {
      //     if (!id) { setData([]); return; }   // clear the PREVIOUS id's data
      //     setLoading(true);                   // drives the spinner
      //     fetchThing(id).then(r => setData(r));
      //   }, [id]);
      //
      // Both flagged statements are load-bearing — drop the reset and the
      // previous entity's data stays on screen while the new request is in
      // flight — which is why the rule could not simply be obeyed at each call
      // site. The answer was not to obey it there but to stop writing that
      // shape: `hooks/useAsyncData.ts` stores the key the data was fetched FOR
      // and derives both `data` and `loading` at render, so neither is ever
      // set from an effect. Every data-loading site now goes through it.
      //
      // What is left is seven effects that are NOT data loads: a DOM
      // measurement, two that seed editable form buffers, two that consume a
      // one-shot navigation signal, one drag/drop handoff, and one that starts
      // a side effect on entering a state. Each carries its own line-scoped
      // disable directive next to a NOTE giving the specific reason. Plus the
      // five public share pages, which are password-
      // gated state machines rather than loads and disable the rule for the
      // one effect that runs the machine.
      //
      // Keeping this at 'error' is the point: the ~40 findings are gone, so
      // the next one to appear is a real "you might not need an effect" and
      // should stop the build. If a new site genuinely needs an exception,
      // add a disable WITH a reason — do not downgrade this rule again.
      'react-hooks/set-state-in-effect': 'error',
    },
  },
])
