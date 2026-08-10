#!/usr/bin/env node
// Sprint 03, Phase 2 — "Nicht interaktiven Bundle-Check ergänzen; initialer
// App-Chunk höchstens 250 kB gzip." Runs a real production build, then
// measures exactly what a fresh page load actually downloads eagerly: the
// `<script type="module">` and `<link rel="stylesheet">` tags Vite wrote
// into dist/index.html. Anything only reachable through a dynamic import()
// (every lazy-loaded route screen / heavy modal, see src/App.tsx) is a
// separate chunk that never gets referenced from index.html, so it is
// correctly excluded here without needing to special-case filenames.
//
// Usage: npm run check:bundle  (add BUNDLE_SKIP_BUILD=1 to reuse an
// already-built dist/, e.g. right after `npm run build` in the same CI step).

import { execSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const distDir = join(root, 'dist');
const indexHtmlPath = join(distDir, 'index.html');

const JS_BUDGET_BYTES = 250 * 1000; // 250 kB, decimal (matches how the spec/Vite's own build output report gzip sizes)

if (!process.env.BUNDLE_SKIP_BUILD) {
  console.log('[check:bundle] Running production build…');
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
}

let html;
try {
  html = readFileSync(indexHtmlPath, 'utf8');
} catch {
  console.error(`[check:bundle] FAIL — could not read ${indexHtmlPath}. Run "npm run build" first, or drop BUNDLE_SKIP_BUILD.`);
  process.exit(1);
}

const scriptSrcs = [...html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)].map((m) => m[1]);
const stylesheetHrefs = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1]);

if (scriptSrcs.length === 0) {
  console.error('[check:bundle] FAIL — no eager <script type="module"> entry found in dist/index.html. This script assumes Vite\'s standard single-entry output; if the build config changed how the entry is emitted, update this check rather than skipping it.');
  process.exit(1);
}

function gzipSizeOf(assetUrlPath) {
  const filePath = join(distDir, assetUrlPath.replace(/^\//, ''));
  const raw = readFileSync(filePath);
  return { raw: raw.length, gzip: gzipSync(raw, { level: 9 }).length, filePath };
}

let totalJsGzip = 0;
let totalJsRaw = 0;
console.log('\n[check:bundle] Eager entry chunks (referenced directly from dist/index.html):');
for (const src of scriptSrcs) {
  const { raw, gzip } = gzipSizeOf(src);
  totalJsGzip += gzip;
  totalJsRaw += raw;
  console.log(`  JS  ${src}  ${(raw / 1000).toFixed(1)} kB raw / ${(gzip / 1000).toFixed(1)} kB gzip`);
}

let totalCssGzip = 0;
for (const href of stylesheetHrefs) {
  const { raw, gzip } = gzipSizeOf(href);
  totalCssGzip += gzip;
  console.log(`  CSS ${href}  ${(raw / 1000).toFixed(1)} kB raw / ${(gzip / 1000).toFixed(1)} kB gzip`);
}

// Informational: list the largest lazy chunks too, so a regression in "what
// got left eager vs. lazy" is visible even though only the eager total gates
// the check.
try {
  const { readdirSync } = await import('node:fs');
  const assetsDir = join(distDir, 'assets');
  const jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
  const eagerBasenames = new Set(scriptSrcs.map((s) => s.split('/').pop()));
  const lazyFiles = jsFiles
    .filter((f) => !eagerBasenames.has(f))
    .map((f) => {
      const p = join(assetsDir, f);
      const raw = statSync(p).size;
      return { f, raw };
    })
    .sort((a, b) => b.raw - a.raw)
    .slice(0, 8);
  if (lazyFiles.length) {
    console.log('\n[check:bundle] Largest lazy (dynamically-imported) chunks — informational, not counted against the budget:');
    for (const { f, raw } of lazyFiles) console.log(`  ${f}  ${(raw / 1000).toFixed(1)} kB raw`);
  }
} catch {
  // purely informational — never fail the gate over this listing
}

const gzipKb = totalJsGzip / 1000;
const budgetKb = JS_BUDGET_BYTES / 1000;
console.log(`\n[check:bundle] Eager JS total: ${gzipKb.toFixed(1)} kB gzip (budget: ${budgetKb.toFixed(0)} kB gzip). CSS (informational, not gated): ${(totalCssGzip / 1000).toFixed(1)} kB gzip.`);

if (totalJsGzip > JS_BUDGET_BYTES) {
  console.error(`[check:bundle] FAIL — eager JS is ${gzipKb.toFixed(1)} kB gzip, over the ${budgetKb.toFixed(0)} kB gzip budget by ${(gzipKb - budgetKb).toFixed(1)} kB.`);
  process.exit(1);
}

console.log(`[check:bundle] PASS — ${gzipKb.toFixed(1)} kB gzip ≤ ${budgetKb.toFixed(0)} kB gzip budget.`);
