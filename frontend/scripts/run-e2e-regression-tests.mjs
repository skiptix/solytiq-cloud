#!/usr/bin/env node
// Sprint 03 independent-review fix regression test — `npm run test:e2e`.
//
// Proves, with a real browser (Playwright + Chromium) and real network
// interception, that RouteErrorBoundary's "Retry" button genuinely recovers
// from a failed lazy-chunk `import()` — NOT just that the error UI
// disappears. This is the exact defect an independent live-browser review
// found: the previous `retry = () => this.setState({ error: null })` made
// zero new network requests on click and instantly re-showed the same
// cached rejection, because `React.lazy()` caches a chunk's
// resolved/rejected status on the `lazy()` object itself, which a local
// re-render or even a `key`-based remount cannot reset.
//
// Runs against the real production build's real `/setup` route — reachable
// with NO backend/auth (a failed `apiCheckSetupRequired()` call falls back
// to rendering SetupWizard regardless, see App.tsx), so this is a genuine,
// CI-runnable regression test, not a synthetic reproduction in an isolated
// harness.
//
// Usage: npm run test:e2e  (add E2E_SKIP_BUILD=1 to reuse an already-built
// dist/, matching check-bundle.mjs / run-a11y-tests.mjs's convention).

import { chromium } from 'playwright';
import { execSync, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const PORT = 4503;
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

if (!process.env.E2E_SKIP_BUILD) {
  console.log('[test:e2e] Running production build…');
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
}

// Confirm the SetupWizard chunk actually exists before trying to intercept
// it by pattern — if Vite's chunking strategy ever changes so this screen
// stops being its own lazy chunk, this test should fail loudly and
// specifically rather than silently passing on a route match that never
// matches.
const assetsDir = join(root, 'dist/assets');
const setupChunk = readdirSync(assetsDir).find((f) => /^SetupWizard-.*\.js$/.test(f));
if (!setupChunk) {
  console.error('[test:e2e] FAIL — no SetupWizard-*.js chunk found in dist/assets. Did App.tsx stop lazy-loading SetupWizard?');
  process.exit(1);
}

const watchdog = setTimeout(() => {
  console.error('[test:e2e] FAIL — watchdog timeout (60s) exceeded, forcing exit.');
  process.exit(1);
}, 60000);
watchdog.unref();

const server = spawn(join(root, 'node_modules/.bin/vite'), ['preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe' });
let serverReady = false;
server.stdout.on('data', (d) => { if (d.toString().includes('Local')) serverReady = true; });
server.stderr.on('data', (d) => process.stderr.write(d));

const results = {};
function record(name, pass, detail) {
  results[name] = { pass, detail };
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ': ' + detail : ''}`);
}

let exitCode = 0;
try {
  for (let i = 0; i < 50 && !serverReady; i++) await sleep(200);
  if (!serverReady) throw new Error('vite preview server did not start within 10s');

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  const context = await browser.newContext();
  const page = await context.newPage();

  let chunkRequestCount = 0;
  let abortedOnce = false;
  await page.route('**/assets/SetupWizard-*.js', async (route) => {
    chunkRequestCount++;
    if (!abortedOnce) {
      abortedOnce = true;
      await route.abort('failed');
    } else {
      await route.continue();
    }
  });

  await page.goto(`http://localhost:${PORT}/setup`, { waitUntil: 'domcontentloaded', timeout: 15000 });

  const boundaryShown = await page.waitForSelector('[role="alert"]', { timeout: 8000 }).then(() => true).catch(() => false);
  record('RouteErrorBoundary appears after a simulated flaky chunk-fetch failure', boundaryShown);

  if (boundaryShown) {
    const requestsBeforeRetry = chunkRequestCount;
    const navigationPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null);
    await page.getByRole('button', { name: /reload/i }).click();
    await navigationPromise;

    const setupRendered = await page
      .waitForSelector("text=/set up your admin account|Welcome/i", { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    record('after clicking Retry, the real SetupWizard screen actually renders (not just the error UI clearing)', setupRendered);
    record('Retry made a genuine new network request for the chunk (not a no-op local re-render)', chunkRequestCount > requestsBeforeRetry, `before=${requestsBeforeRetry}, after=${chunkRequestCount}`);
  } else {
    exitCode = 1;
  }

  await context.close();
  await browser.close();
} catch (err) {
  console.error('[test:e2e] FAIL — unexpected error:', err);
  exitCode = 1;
} finally {
  server.kill();
}

const failed = Object.entries(results).filter(([, r]) => !r.pass);
if (failed.length) exitCode = 1;
console.log(`\n${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed`);
console.log(exitCode === 0 ? '[test:e2e] PASS' : '[test:e2e] FAIL');
process.exit(exitCode);
