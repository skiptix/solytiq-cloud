// ---------------------------------------------------------------------------
// S6 — XLSX parsing isolation.
//
// SECURITY: `xlsx` (SheetJS) has two KNOWN, currently unpatched advisories
// with "No fix available" (GHSA-4r6h-8v6p-xvw6 prototype pollution,
// GHSA-5pgg-2g8v-p4x9 ReDoS) — confirmed via `npm audit`. This app cannot
// avoid the library (spreadsheet text-extraction for the AI assistant and
// the MCP `read_file` tool is a real, documented feature), so instead of
// running `XLSX.read()`/`sheet_to_csv()` directly against an untrusted
// buffer in the main process, this module runs BOTH the `require('xlsx')`
// AND the actual parse call inside a dedicated `worker_threads` Worker:
//   - Prototype pollution stays CONTAINED — a Worker has its own isolated
//     V8 heap/global object, so a crafted file that pollutes
//     `Object.prototype` inside the worker cannot reach the main process's
//     objects at all. This is a real isolation boundary, not just
//     defense-in-depth theater.
//   - ReDoS is bounded by a hard wall-clock timeout that force-terminates
//     the worker — a hung regex blocks only that one worker thread, never
//     the main event loop (which keeps serving every other request), and
//     the request that triggered it fails cleanly instead of hanging.
//   - A `resourceLimits` memory cap bounds worst-case allocation from a
//     maliciously huge/dense spreadsheet — the worker OOMs and exits
//     instead of pressuring the main process's memory.
//
// `xlsx` is deliberately NOT `require()`d anywhere outside the eval'd
// worker source string below (fileText.ts no longer imports it directly).
// ---------------------------------------------------------------------------

import { Worker } from 'worker_threads';

const XLSX_WORKER_TIMEOUT_MS = 10_000;
const XLSX_WORKER_MAX_OLD_GEN_MB = 256;
const XLSX_WORKER_MAX_YOUNG_GEN_MB = 32;

// Inline source (not a separate compiled/dist file) so this works identically
// under `ts-node-dev` (dev) and `node dist/index.js` (prod) with no path
// resolution to get wrong between the two — only `require('xlsx')` needs to
// resolve, which Node does via the normal node_modules lookup regardless of
// how the eval'd code itself was loaded.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
try {
  const XLSX = require('xlsx');
  const buffer = Buffer.from(workerData.buffer);
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheets = workbook.SheetNames.map((name) => {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
    return 'Sheet: ' + name + '\\n' + csv;
  }).join('\\n\\n');
  parentPort.postMessage({ ok: true, sheets });
} catch (err) {
  parentPort.postMessage({ ok: false, error: (err && err.message) ? err.message : String(err) });
}
`;

interface WorkerResult {
  ok: boolean;
  sheets?: string;
  error?: string;
}

/**
 * Parse an XLSX/XLS buffer into a per-sheet CSV dump, entirely inside a
 * sandboxed worker thread. Rejects (never hangs forever) on a parse error,
 * a worker crash, or the timeout — callers should catch and degrade, same
 * as every other extractor in fileText.ts.
 */
export function parseXlsxInWorker(buffer: Buffer, timeoutMs: number = XLSX_WORKER_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    // Copy exactly this buffer's bytes into a fresh ArrayBuffer — `buffer.buffer`
    // may be a larger, shared, pooled allocation (Node batches small Buffers),
    // so slicing to [byteOffset, byteOffset+byteLength) avoids leaking
    // unrelated pooled memory into the worker.
    const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { buffer: bytes },
        resourceLimits: {
          maxOldGenerationSizeMb: XLSX_WORKER_MAX_OLD_GEN_MB,
          maxYoungGenerationSizeMb: XLSX_WORKER_MAX_YOUNG_GEN_MB,
        },
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      worker.terminate().catch(() => { /* already gone */ });
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error('XLSX parsing timed out')));
    }, timeoutMs);

    worker.once('message', (msg: WorkerResult) => {
      finish(() => {
        if (msg.ok) resolve(msg.sheets ?? '');
        else reject(new Error(msg.error ?? 'XLSX parsing failed'));
      });
    });

    worker.once('error', (err) => {
      finish(() => reject(err));
    });

    worker.once('exit', (code) => {
      // A clean exit after 'message' already settled the promise — ignore.
      if (settled) return;
      finish(() => reject(new Error(`XLSX worker exited unexpectedly with code ${code}`)));
    });
  });
}
