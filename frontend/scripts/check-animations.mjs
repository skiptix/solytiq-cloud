#!/usr/bin/env node
// Sprint 04, Phase 0 — machine-checkable inventory + policy gate for every
// first-party animation surface (CSS keyframes/transitions, direct Motion
// imports, raw motion.*/AnimatePresence usage, the Web Animations API,
// requestAnimationFrame loops, dynamically-injected <style> blocks, and
// animated SVG properties).
//
// Two jobs in one script:
//   1. Inventory  — always runs, always prints/writes the full findings list
//      (--json writes a machine-readable report to animations-report.json).
//   2. Policy gate — fails (non-zero exit) on any finding outside
//      animation-policy.json's `centralLayer` dirs/files and `allowlist`
//      entries. The allowlist starts empty per the Sprint 04 mandate ("keine
//      fachliche Allowlist-Ausnahmen") — every entry added to it is a
//      disclosed, reviewed exception, never a silent one.
//
// Usage:
//   npm run check:animations          # inventory + gate, human-readable
//   npm run check:animations -- --json   # also writes animations-report.json

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const srcDir = join(root, 'src');
const policyPath = join(__dirname, 'animation-policy.json');
const reportPath = join(root, 'animations-report.json');

const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
const centralLayerDirs = policy.centralLayerDirs.map((d) => join(root, d));
const allowlist = new Set(policy.allowlist ?? []);

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.css']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__']);

/** @type {{file: string, category: string, kind: string, line: number, match: string, central: boolean}[]} */
const findings = [];

function isCentral(absPath) {
  return centralLayerDirs.some((d) => absPath === d || absPath.startsWith(d + '/'));
}

function classify(relPath) {
  const p = relPath.toLowerCase();
  if (p.includes('/animate-ui/')) return 'central';
  if (p.includes('gps')) return 'gps';
  if (p.includes('graph') || p.includes('neuralgraph') || p.includes('sigmagraph') || p.includes('forcesimulation') || p.includes('flowgraph')) return 'graph-svg-canvas-sim';
  if (p.includes('/ai') || p.includes('aiassistant') || p.includes('aichat') || p.includes('aiskill')) return 'ai';
  if (p.includes('dialog') || p.includes('modal') || p.includes('popover') || p.includes('dropdown') || p.includes('tooltip') || p.includes('sheet') || p.includes('panel') || p.includes('overlay') || p.includes('picker')) return 'overlay-focus';
  if (p.includes('sidebar') || p.includes('topbar') || p.includes('commandpalette') || p.includes('contextmenu') || p.includes('notification')) return 'navigation-shell';
  if (p.includes('screens/')) return 'navigation-page';
  if (p.includes('drag')) return 'drag';
  if (p.includes('skeleton') || p.includes('spinner') || p.includes('savestatus') || p.includes('loading') || p.includes('progress')) return 'loading-status';
  if (p.includes('taskitem') || p.includes('card') || p.includes('list') || p.includes('section')) return 'layout';
  return 'hover-press-other';
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (SCAN_EXTENSIONS.has(extname(entry.name))) out.push(abs);
  }
  return out;
}

const files = walk(srcDir);

// Each pattern is mutually exclusive by construction (no two patterns below
// can match the same substring), so no post-hoc de-dupe is needed — an
// earlier version of this script had `css-animation-prop`/`inline-animation-prop`
// (and the transition/keyframes equivalents) matching the *same* property
// declaration from two different regexes, double-counting every hit. Fixed
// by collapsing each CSS-syntax family (which appears identically in both
// .css files and inline `style={{}}` object literals — the property name
// and colon look the same either way) into one pattern.
const PATTERNS = [
  { kind: 'keyframes-def', re: /@keyframes\s+[\w-]+/g, category: (rel) => classify(rel) },
  { kind: 'animation-prop', re: /(?<![\w-])animation(?:Name|-name)?\s*:/g, category: (rel) => classify(rel) },
  { kind: 'transition-prop', re: /(?<![\w-])transition(?:Property|Duration|TimingFunction|Delay|-property|-duration|-timing-function|-delay)?\s*:/g, category: (rel) => classify(rel) },
  { kind: 'motion-import', re: /from\s+['"](motion\/react|framer-motion)['"]/g, category: () => 'central-boundary' },
  { kind: 'motion-jsx-usage', re: /<motion\.\w+|\bAnimatePresence\b/g, category: (rel) => classify(rel) },
  { kind: 'web-animations-api', re: /\.animate\(\s*\[/g, category: (rel) => classify(rel) },
  { kind: 'raf-loop', re: /\brequestAnimationFrame\s*\(/g, category: (rel) => classify(rel) },
  { kind: 'dynamic-style-block', re: /<style[>\s]|styleSheet\.insertRule|\.insertRule\(/g, category: (rel) => classify(rel) },
  { kind: 'animated-svg-attr', re: /<animate(Transform|Motion)?[\s>]|stroke-dashoffset|strokeDashoffset/g, category: (rel) => classify(rel) },
];

for (const abs of files) {
  const rel = relative(root, abs).replace(/\\/g, '/');
  const central = isCentral(abs);
  const content = readFileSync(abs, 'utf8');
  const lines = content.split('\n');
  for (const { kind, re, category } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content))) {
      const upto = content.slice(0, m.index);
      const line = upto.split('\n').length;
      findings.push({
        file: rel,
        category: central ? 'central' : category(rel),
        kind,
        line,
        match: m[0].trim(),
        central,
      });
    }
  }
}

// De-dupe identical (file, kind, line) hits from overlapping patterns
// (e.g. css-animation-prop vs inline-animation-prop on the same literal).
const seen = new Set();
const deduped = findings.filter((f) => {
  const key = `${f.file}:${f.line}:${f.kind}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

// `motion-jsx-usage` (<motion.*>/AnimatePresence JSX) is the COMPLIANT
// end-state once a file's underlying import is routed through the central
// motion.ts barrel (enforced separately by `motion-import`, which gates
// hard) — so it's inventoried but not itself a violation kind. Gating it
// too would fail every legitimate user of the central layer's `motion.div`,
// which defeats the point of having a central layer at all.
const INFO_ONLY_KINDS = new Set(['motion-jsx-usage']);

const nonCentral = deduped.filter((f) => !f.central);
const violations = nonCentral.filter((f) => !INFO_ONLY_KINDS.has(f.kind) && !allowlist.has(`${f.file}`) && !allowlist.has(`${f.file}:${f.kind}`));

// Summary
const byKind = {};
const byCategory = {};
for (const f of nonCentral) {
  byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
}
const filesWithFindings = new Set(nonCentral.map((f) => f.file));

console.log('[check:animations] First-party animation inventory (non-central-layer findings)\n');
console.log(`  Total findings:        ${nonCentral.length}`);
console.log(`  Files with findings:   ${filesWithFindings.size}`);
console.log('\n  By kind:');
for (const [k, c] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(24)} ${c}`);
console.log('\n  By category:');
for (const [k, c] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(24)} ${c}`);

if (process.argv.includes('--json')) {
  writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), total: nonCentral.length, filesWithFindings: filesWithFindings.size, byKind, byCategory, findings: nonCentral }, null, 2));
  console.log(`\n[check:animations] Wrote ${relative(root, reportPath)}`);
}

if (violations.length > 0) {
  console.log(`\n[check:animations] FAIL — ${violations.length} finding(s) outside the central Animate-UI layer and not in the allowlist.`);
  if (policy.strict) {
    console.log('  (strict mode: every finding above is a violation — the allowlist is empty by design)');
  }
  process.exit(1);
}

console.log('\n[check:animations] PASS — no findings outside the central Animate-UI layer / allowlist.');
