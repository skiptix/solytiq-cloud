// ---------------------------------------------------------------------------
// Automation Hub — Code action: user-supplied JavaScript, run inside a real
// isolated-vm V8 isolate (NOT Node's built-in `vm` module, which is a
// well-known WEAK sandbox with documented escape techniques). The isolate
// receives its input as a single JSON string global (`__inputJson`) and
// nothing else — no `require`, `process`, filesystem, or network of any
// kind is ever exposed. A CPU-time timeout catches infinite loops, a memory
// limit catches runaway allocations, and the returned value is round-tripped
// through JSON so only plain, JSON-serializable data can ever leave the
// sandbox (functions/undefined/etc. are silently stripped, matching normal
// JSON.stringify semantics).
// ---------------------------------------------------------------------------

import ivm from 'isolated-vm';
import type { ExpressionScope } from './automationExpressions';

const MEMORY_LIMIT_MB = 32;
const TIMEOUT_MS = 5_000;
export const MAX_CODE_LENGTH = 20_000;

export type RunCodeResult = { ok: true; output: unknown } | { ok: false; error: string };

export async function runSandboxedCode(code: string, scope: ExpressionScope): Promise<RunCodeResult> {
  if (code.length > MAX_CODE_LENGTH) {
    return { ok: false, error: `Code must be under ${MAX_CODE_LENGTH} characters` };
  }

  let isolate: ivm.Isolate | undefined;
  try {
    isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
    const context = await isolate.createContext();
    const inputJson = JSON.stringify(scope) ?? 'null';
    await context.global.set('__inputJson', inputJson);

    // Wrap: `input` is parsed inside the isolate itself (never crosses the
    // boundary as anything but an inert string), and the user's code runs as
    // the body of its own function so a plain `return X;` becomes the result.
    const script = await isolate.compileScript(
      `(function() {\n  const input = JSON.parse(__inputJson);\n  return (function() {\n${code}\n  })();\n})()`
    );
    const raw = await script.run(context, { timeout: TIMEOUT_MS, copy: true });

    let output: unknown;
    try {
      output = raw === undefined ? null : JSON.parse(JSON.stringify(raw));
    } catch {
      return { ok: false, error: 'Code must return a JSON-serializable value' };
    }
    return { ok: true, output };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/script execution timed out/i.test(message)) {
      return { ok: false, error: `Code timed out after ${TIMEOUT_MS}ms` };
    }
    return { ok: false, error: `Code error: ${message}` };
  } finally {
    isolate?.dispose();
  }
}
