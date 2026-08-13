#!/usr/bin/env node
// Sprint 04, Phase 6 — `npm run test:responsive`.
//
// CLAUDE.md's Mobile Responsiveness rules make two promises that nothing was
// checking:
//
//   "Every new component, screen, modal, dialog and popup must work
//    correctly on mobile (>= 390px)"
//   "Wide content must scroll inside its own container — the page body must
//    never scroll horizontally"
//
// A horizontal body scrollbar is the single most common way that second
// promise breaks, it is invisible on a desktop-sized window, and it is
// trivially detectable in a real browser. So this gate loads every route
// reachable without a backend at every breakpoint the rules name and asserts
// the document does not scroll sideways.
//
// It deliberately does NOT screenshot-diff. A pixel baseline for six widths
// across four screens is a large binary artifact that goes stale on any
// intentional design change, and the failure it reports ("something moved")
// needs a human to interpret. "The page scrolls sideways at 320px" needs
// nobody.
//
// The same no-backend scope as run-a11y-tests.mjs applies: screens behind
// <Protected> cannot be reached by an unauthenticated browser and are not
// covered. That gap is stated, not hidden.
//
// Usage: npm run test:responsive  (RESPONSIVE_SKIP_BUILD=1 reuses dist/,
// matching check-bundle.mjs / run-a11y-tests.mjs.)

import { chromium } from 'playwright';
import { execSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const PORT = 4446;
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// The widths CLAUDE.md's rules and the app's own breakpoints actually name.
// 320 is the narrowest phone still in circulation; 390 is the iPhone 15 Pro
// the rules call out by name; 640 is the `@media (max-width: 639px)` boundary
// in index.css, tested from both sides.
const WIDTHS = [
  { w: 320, h: 640, label: '320  (narrowest phone)' },
  { w: 375, h: 667, label: '375  (iPhone SE)' },
  { w: 390, h: 844, label: '390  (iPhone 15 Pro)' },
  { w: 639, h: 800, label: '639  (mobile side of the 640px breakpoint)' },
  { w: 640, h: 800, label: '640  (desktop side of the same breakpoint)' },
  { w: 768, h: 1024, label: '768  (tablet)' },
  { w: 1024, h: 768, label: '1024 (small laptop)' },
  { w: 1440, h: 900, label: '1440 (desktop)' },
];

const PAGES = [
  {
    path: '/login',
    label: 'Login',
    // Same seeding as run-a11y-tests.mjs: without it /login redirects to
    // /setup and this would silently measure the wrong screen.
    seed: { key: 'solytiq_auth', value: JSON.stringify({ state: { adminRegistered: true }, version: 0 }) },
    ready: '#login-username',
  },
  { path: '/setup', label: 'Setup wizard', ready: 'input, button' },
  { path: '/admin-reset', label: 'Admin password reset', ready: 'input, button' },
  { path: '/share/__responsive-probe__', label: 'Public share page', ready: 'body' },
];

if (!process.env.RESPONSIVE_SKIP_BUILD) {
  console.log('[test:responsive] Running production build…');
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
}

const WATCHDOG_MS = 240000;
const watchdog = setTimeout(() => {
  console.error(`[test:responsive] FAIL — watchdog timeout (${WATCHDOG_MS / 1000}s) exceeded, forcing exit.`);
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

// Spawn the local vite binary directly — `npx` adds a process layer whose
// child does not reliably die with it, leaking a server that blocks the next
// run's port. (Same reason as run-a11y-tests.mjs.)
const server = spawn(join(root, 'node_modules/.bin/vite'), ['preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe' });
let serverReady = false;
server.stdout.on('data', (d) => { if (d.toString().includes('Local')) serverReady = true; });
server.stderr.on('data', (d) => process.stderr.write(d));

let exitCode = 0;
let checks = 0;

try {
  for (let i = 0; i < 50 && !serverReady; i++) await sleep(200);
  if (!serverReady) throw new Error('vite preview server did not start within 10s');

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });

  for (const { path, label, seed, ready } of PAGES) {
    console.log(`\n[test:responsive] ${label} (${path})`);

    // One context per touch profile rather than one per width: the mobile UA
    // flags are context-level (index.css's `@supports env(safe-area-inset-*)`
    // rules and the iOS 16px input floor key off them), but the layout itself
    // follows the viewport, which can be resized in place. Eight navigations
    // per page became two.
    for (const mobile of [true, false]) {
      const sizes = WIDTHS.filter((s) => (s.w <= 640) === mobile);
      if (sizes.length === 0) continue;

      const context = await browser.newContext({
        viewport: { width: sizes[0].w, height: sizes[0].h },
        deviceScaleFactor: mobile ? 3 : 1,
        isMobile: mobile,
        hasTouch: mobile,
      });
      // index.html references Google Fonts. In a sandbox without the shell's
      // proxy those requests hang, and every navigation pays for it. Fonts
      // cannot change whether the document scrolls sideways, so drop them.
      await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());

      const page = await context.newPage();
      if (seed) {
        await page.addInitScript(({ key, value }) => {
          try { window.localStorage.setItem(key, value); } catch { /* private mode */ }
        }, seed);
      }
      await page.goto(`http://localhost:${PORT}${path}`, { waitUntil: 'domcontentloaded', timeout: 15000 });

      let rendered = true;
      try {
        await page.waitForSelector(ready, { timeout: 8000 });
      } catch {
        exitCode = 1;
        rendered = false;
        console.log(`  FAIL — "${ready}" never appeared; the route did not render ${label}.`);
      }

      for (const { w, h, label: sizeLabel } of sizes) {
        if (!rendered) break;
        await page.setViewportSize({ width: w, height: h });
        // Let layout settle (reflow, entrance animations) before measuring.
        await sleep(250);

      const report = await page.evaluate(() => {
        const de = document.documentElement;
        // 1px of tolerance: sub-pixel layout rounding can make
        // scrollWidth exceed clientWidth by a fraction with nothing
        // actually clipped or scrollable.
        const overflowBy = Math.max(de.scrollWidth - de.clientWidth, document.body.scrollWidth - de.clientWidth);

        // Name the widest offenders so a failure is actionable rather than
        // "something on this page is too wide".
        const culprits = [];
        if (overflowBy > 1) {
          for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const over = Math.round(r.right - de.clientWidth);
            if (over > 1) {
              culprits.push({
                over,
                tag: el.tagName.toLowerCase(),
                cls: (el.className && typeof el.className === 'string') ? el.className.slice(0, 40) : '',
                text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
              });
            }
          }
          culprits.sort((a, b) => b.over - a.over);
        }
        return { overflowBy, culprits: culprits.slice(0, 4) };
      });

      checks++;
      if (report.overflowBy > 1) {
        exitCode = 1;
        console.log(`  FAIL ${sizeLabel} — document scrolls horizontally by ${report.overflowBy}px.`);
        for (const c of report.culprits) {
          console.log(`         +${c.over}px  <${c.tag}${c.cls ? ` class="${c.cls}"` : ''}> ${c.text ? `"${c.text}"` : ''}`);
        }
      } else {
        console.log(`  PASS ${sizeLabel}`);
      }
      }

      await context.close();
    }
  }

  await browser.close();
} catch (err) {
  exitCode = 1;
  console.error(`[test:responsive] FAIL — unexpected error: ${err.stack || err}`);
} finally {
  server.kill('SIGKILL');
  clearTimeout(watchdog);
}

console.log(`\n[test:responsive] ${exitCode === 0 ? 'PASS' : 'FAIL'} — ${checks} viewport check(s) across ${PAGES.length} page(s).`);
process.exit(exitCode);
