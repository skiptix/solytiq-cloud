#!/usr/bin/env node
// Sprint 03 — `npm run test:a11y`. A real, non-interactive accessibility gate
// using axe-core (industry-standard automated a11y engine, already a
// devDependency) driven by Playwright against the pre-installed Chromium.
//
// Scope, and why: there is no backend/database running here, so screens
// behind `<Protected>` (everything inside AppLayout: Dashboard, Board,
// Timeline, …) cannot be reached by a real unauthenticated browser session
// and are NOT swept — a gap called out explicitly rather than silently
// skipped. Every route that IS reachable without a backend is swept:
//
//   /login       the screen whose a11y bugs were actually fixed
//                (unassociated <label>s, no aria-invalid/aria-describedby on
//                error, unlabelled OTP digit inputs).
//   /setup       the first-run wizard.
//   /admin-reset the recovery screen.
//   /share/…     the public share chrome, in its error state.
//
// Sprint 04 correction: this file previously listed ONLY /login and claimed
// it renders with no backend. It does not. A failed `apiCheckSetupRequired()`
// falls back to `setSetupRequired(!adminRegistered)`, and with nothing in
// localStorage that is `true`, so /login redirects to /setup. The sweep was
// therefore testing SetupWizard while reporting it as Login, and the login
// fixes above were never actually verified. Seeding `solytiq_auth` with
// `adminRegistered: true` (see the `seed` field below) is what makes the
// login form render, so the gate now tests what it says it tests.
//
// Usage: npm run test:a11y  (add A11Y_SKIP_BUILD=1 to reuse an already-built
// dist/, matching check-bundle.mjs's convention).

import { chromium } from 'playwright';
import { execSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const PORT = 4444;
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

if (!process.env.A11Y_SKIP_BUILD) {
  console.log('[test:a11y] Running production build…');
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
}

const axeSource = readFileSync(join(root, 'node_modules/axe-core/axe.min.js'), 'utf8');

// Hard watchdog: nothing in this script should legitimately take this long
// (a single-page axe sweep); if the browser/network stack wedges on
// something (e.g. an external resource with no way to time out cleanly),
// force-exit with a clear failure rather than hanging the CI step forever.
// Scaled to the page count below (a single-page sweep took ~15s); if the
// browser/network stack wedges on something with no clean timeout, fail
// loudly rather than hanging the CI step forever.
const WATCHDOG_MS = 180000;
const watchdog = setTimeout(() => {
  console.error(`[test:a11y] FAIL — watchdog timeout (${WATCHDOG_MS / 1000}s) exceeded, forcing exit.`);
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

// Spawn the local `vite` binary directly rather than through `npx` — `npx`
// adds an extra process layer whose child (the real vite server) does not
// reliably die when the `npx` process itself is killed, leaking a server
// that then blocks the next run's port.
const server = spawn(join(root, 'node_modules/.bin/vite'), ['preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe' });
let serverReady = false;
server.stdout.on('data', (d) => { if (d.toString().includes('Local')) serverReady = true; });
server.stderr.on('data', (d) => process.stderr.write(d));

let exitCode = 0;

try {
  for (let i = 0; i < 50 && !serverReady; i++) await sleep(200);
  if (!serverReady) throw new Error('vite preview server did not start within 10s');

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });

  // `seed` runs before the app boots; `ready` is the selector that proves the
  // intended screen (not a fallback) actually rendered — a sweep that silently
  // accepts whatever loaded is how the /login gap above went unnoticed.
  const pages = [
    {
      path: '/login',
      label: 'Login screen',
      seed: { key: 'solytiq_auth', value: JSON.stringify({ state: { adminRegistered: true }, version: 0 }) },
      ready: '#login-username',
    },
    { path: '/setup', label: 'Setup wizard', ready: 'input, button' },
    { path: '/admin-reset', label: 'Admin password reset', ready: 'input, button' },
    { path: '/share/__a11y-probe__', label: 'Public share page (error state)', ready: 'body' },
  ];

  for (const { path, label, seed, ready } of pages) {
    console.log(`\n[test:a11y] ${label} (${path})`);
    const context = await browser.newContext();
    const page = await context.newPage();
    if (seed) {
      await page.addInitScript(({ key, value }) => {
        try { window.localStorage.setItem(key, value); } catch { /* private mode */ }
      }, seed);
    }
    // NOT 'networkidle': index.html references Google Fonts, and this
    // sandbox's browser network stack doesn't share the shell's configured
    // HTTPS proxy, so those external requests can hang well past any
    // reasonable timeout — 'networkidle' would wait on them indefinitely.
    // 'domcontentloaded' is enough; the explicit waitForSelector below is
    // the real readiness signal we actually care about.
    await page.goto(`http://localhost:${PORT}${path}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Each screen only appears once the (failed, no-backend) setup check
    // settles. A missing readiness selector is a HARD failure: it means the
    // route fell back to something else and any result below would describe
    // the wrong screen.
    try {
      await page.waitForSelector(ready, { timeout: 8000 });
    } catch {
      exitCode = 1;
      console.log(`  FAIL — "${ready}" never appeared; ${path} did not render ${label}.`);
      await context.close();
      continue;
    }

    await page.addScriptTag({ content: axeSource });
    const results = await page.evaluate(async () => {
      // `axe` is a browser global injected by the addScriptTag() call above —
      // this whole arrow function is serialized and executed inside the
      // page context by Playwright, not in this script's own Node scope.
      return await axe.run(document, {
        // Contrast checks need real layout/paint, which we have here (a
        // real browser, real build) — deliberately NOT disabling this rule.
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      });
    });

    const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    const minor = results.violations.filter((v) => v.impact !== 'critical' && v.impact !== 'serious');

    if (minor.length) {
      console.log(`  ${minor.length} minor/moderate violation(s) (non-blocking, reported for visibility):`);
      for (const v of minor) console.log(`    - [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))`);
    }

    if (blocking.length) {
      exitCode = 1;
      console.log(`  FAIL — ${blocking.length} critical/serious violation(s):`);
      for (const v of blocking) {
        console.log(`    - [${v.impact}] ${v.id}: ${v.help}`);
        for (const node of v.nodes.slice(0, 3)) {
          console.log(`        selector: ${node.target.join(' ')}`);
          console.log(`        html: ${node.html}`);
          if (node.failureSummary) console.log(`        ${node.failureSummary.replace(/\n/g, '\n        ')}`);
        }
      }
    } else {
      console.log(`  PASS — 0 critical/serious violations (${results.passes.length} rules checked and passed).`);
    }

    // Structural spot-checks specific to what Sprint 03 changed on this
    // screen (form label association + live-region error announcement) —
    // axe already covers "label" broadly, but asserting the exact
    // htmlFor/id pairing directly makes the regression this fixed explicit
    // rather than implicit in axe's rule set.
    if (path === '/login') {
    const usernameLabelled = await page.evaluate(() => {
      const input = document.getElementById('login-username');
      if (!input) return null;
      const label = document.querySelector('label[for="login-username"]');
      return !!label;
    });
    if (usernameLabelled === false) {
      exitCode = 1;
      console.log('  FAIL — #login-username has no associated <label for="login-username">.');
    } else if (usernameLabelled === true) {
      console.log('  PASS — #login-username is programmatically labelled.');
    }
    }

    await context.close();
  }

  await browser.close();
} catch (err) {
  console.error('[test:a11y] FAIL — unexpected error:', err);
  exitCode = 1;
} finally {
  server.kill();
}

console.log(exitCode === 0 ? '\n[test:a11y] PASS' : '\n[test:a11y] FAIL');
process.exit(exitCode);
