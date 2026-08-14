#!/usr/bin/env node
// Sprint 04, Phase 7 — the software-composition-analysis gate.
//
// `npm audit --audit-level=high` is almost the right gate, but not quite:
// it cannot tell "a new high-severity dependency vulnerability just landed"
// from "the one known, unfixable, already-mitigated advisory this repo has
// carried since Sprint 01". Used raw, it is permanently red, and a
// permanently red gate is one nobody reads.
//
// So this wrapper runs the audit, then fails on any high/critical finding
// that is NOT in the allowlist below. Each allowlist entry has to name the
// package, the reason it cannot be fixed, and where the mitigation lives —
// an entry with no mitigation is not an exception, it is an unfixed bug.
//
// Two things it deliberately does NOT do:
//   - It does not swallow tool failure. A network error, a malformed
//     response, or a missing lockfile is a FAILURE, never a pass. The
//     sprint brief calls this out specifically: an SCA network error is
//     not green.
//   - It does not allowlist by severity or by package alone. An entry
//     covers one package, and any OTHER advisory against that same package
//     still fails, because "we knew about xlsx's ReDoS" says nothing about
//     a future xlsx RCE.
//
// Usage: node scripts/check-sca.mjs <workspace-dir> [...more dirs]

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';

/**
 * Known, accepted, mitigated advisories.
 *
 * `titles` must match the advisory titles npm reports. Listing them (rather
 * than allowlisting the package outright) is what makes a NEW advisory
 * against the same package fail the gate.
 */
const ALLOWLIST = [
  {
    workspace: 'backend',
    package: 'xlsx',
    titles: [
      'Prototype Pollution in sheetJS',
      'SheetJS Regular Expression Denial of Service (ReDoS)',
    ],
    reason:
      'Both advisories are "No fix available" — SheetJS stopped publishing to ' +
      'npm at 0.18.5, so there is no version to upgrade to. The library cannot ' +
      'be dropped either: spreadsheet text extraction is a real feature (the AI ' +
      'assistant\'s file context and the MCP `read_file` tool).',
    mitigation:
      'backend/src/xlsxSandbox.ts — both the `require("xlsx")` and the parse ' +
      'run inside a worker_threads Worker, so prototype pollution is confined ' +
      'to that worker\'s own V8 heap and cannot reach the main process. A hard ' +
      'wall-clock timeout bounds the ReDoS, and resourceLimits bound memory. ' +
      'xlsx is not required anywhere outside that worker.',
  },
];

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('[check:sca] usage: node scripts/check-sca.mjs <dir> [...dirs]');
  process.exit(2);
}

let exitCode = 0;

for (const dir of dirs) {
  const abs = resolve(dir);
  const name = basename(abs);
  console.log(`\n[check:sca] ${name}`);

  if (!existsSync(join(abs, 'package-lock.json'))) {
    console.log(`  FAIL — no package-lock.json; npm audit has nothing to resolve against.`);
    exitCode = 1;
    continue;
  }

  let report;
  try {
    // `npm audit` exits non-zero when it FINDS something, so a non-zero exit
    // is expected and not itself an error — but stdout must still be valid
    // JSON. Anything else (network failure, registry 5xx, a proxy returning
    // HTML) lands in the catch below and fails the gate.
    let stdout;
    try {
      stdout = execFileSync('npm', ['audit', '--omit=dev', '--json'], {
        cwd: abs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
      });
    } catch (e) {
      // Non-zero exit with usable JSON on stdout is the "found vulnerabilities" path.
      if (!e.stdout) throw e;
      stdout = e.stdout;
    }
    report = JSON.parse(stdout);
  } catch (err) {
    exitCode = 1;
    console.log(`  FAIL — audit did not produce a usable report (this is NOT a pass): ${err.message.split('\n')[0]}`);
    continue;
  }

  if (report.error) {
    exitCode = 1;
    console.log(`  FAIL — audit reported an error (this is NOT a pass): ${report.error.summary ?? JSON.stringify(report.error)}`);
    continue;
  }

  const vulns = Object.entries(report.vulnerabilities ?? {});
  const serious = vulns.filter(([, v]) => v.severity === 'high' || v.severity === 'critical');

  if (serious.length === 0) {
    console.log(`  PASS — 0 high/critical advisories (${vulns.length} total finding(s) at any severity).`);
    continue;
  }

  for (const [pkg, v] of serious) {
    const titles = (v.via ?? []).filter((x) => typeof x === 'object' && x.title).map((x) => x.title);
    const entry = ALLOWLIST.find((a) => a.package === pkg && a.workspace === name);
    const unaccounted = entry ? titles.filter((t) => !entry.titles.includes(t)) : titles;

    if (entry && unaccounted.length === 0) {
      console.log(`  ALLOWED — ${v.severity} in ${pkg}: ${titles.join('; ') || '(no titles reported)'}`);
      console.log(`      why: ${entry.reason}`);
      console.log(`      mitigation: ${entry.mitigation}`);
      continue;
    }

    exitCode = 1;
    if (entry) {
      console.log(`  FAIL — ${v.severity} in ${pkg}: NEW advisory not covered by the allowlist entry:`);
      for (const t of unaccounted) console.log(`      - ${t}`);
      console.log(`      The existing entry covers only: ${entry.titles.join('; ')}`);
    } else {
      console.log(`  FAIL — ${v.severity} in ${pkg}: ${titles.join('; ') || '(no titles reported)'}`);
      console.log(`      fixAvailable: ${JSON.stringify(v.fixAvailable)}`);
    }
  }
}

console.log(`\n[check:sca] ${exitCode === 0 ? 'PASS' : 'FAIL'}`);
process.exit(exitCode);
