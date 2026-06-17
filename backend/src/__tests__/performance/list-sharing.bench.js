const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// Mock out the query implementation to simulate db time
async function mockQuery(queryStr, params) {
  // Simulate 10ms per query as a network/DB latency baseline
  return new Promise(resolve => setTimeout(resolve, 5));
}

async function runBenchmark(numDescendants) {
  const ids = Array.from({ length: numDescendants }, () => uuidv4());
  const passwordHash = 'fake-hash';
  const expiresAt = new Date().toISOString();

  // Baseline (N+1)
  const startBaseline = performance.now();
  for (const id of ids) {
    await mockQuery(
      `UPDATE lists SET share_enabled = true WHERE id = $1`,
      [id, crypto.randomBytes(24).toString('hex'), passwordHash, expiresAt]
    );
  }
  const endBaseline = performance.now();

  // Optimized (using ANY array parameter)
  // To avoid minting N tokens in JS, we can just use SQL directly if we want,
  // or generate the tokens and pass them via UNNEST, but the prompt says:
  // "Can be replaced with a single parameterized query utilizing ANY array passing which is already used a few lines below (e.g. L415)."
  // Wait, if we use `WHERE id = ANY($1::varchar[])`, how do we mint a *unique* token for each if it's missing?
  // `share_token = COALESCE(share_token, md5(random()::text || clock_timestamp()::text))`
  // This correctly mints a unique token for each missing one within the query.
  const startOptimized = performance.now();
  await mockQuery(
    `UPDATE lists SET share_enabled = true WHERE id = ANY($1::varchar[])`,
    [ids, passwordHash, expiresAt]
  );
  const endOptimized = performance.now();

  const baselineMs = endBaseline - startBaseline;
  const optimizedMs = endOptimized - startOptimized;
  const improvement = baselineMs / optimizedMs;

  console.log(`--- ${numDescendants} descendants ---`);
  console.log(`Baseline (N+1 queries): ${baselineMs.toFixed(2)}ms`);
  console.log(`Optimized (1 query): ${optimizedMs.toFixed(2)}ms`);
  console.log(`Speedup: ${improvement.toFixed(2)}x`);
  console.log("");
}

async function main() {
  await runBenchmark(10);
  await runBenchmark(50);
  await runBenchmark(100);
}

main();
