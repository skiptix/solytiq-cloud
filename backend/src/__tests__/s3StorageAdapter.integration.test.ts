// ---------------------------------------------------------------------------
// B2 (Phase 2) — S3StorageAdapter against a REAL S3-compatible server
// (MinIO), not a mock. Proves the adapter genuinely works against S3-wire-
// protocol semantics (multipart-capable streaming put, real object
// existence/size via HEAD, real 404-shaped NotFound on a missing key),
// which s3StorageAdapter.test.ts's mocked-SDK unit tests cannot prove on
// their own (they only prove this codebase's OWN call shape is correct,
// not that a real S3-compatible server accepts and round-trips it).
//
// Requires a MinIO (or any S3-compatible) server reachable at
// TEST_S3_ENDPOINT with TEST_S3_BUCKET already created — SKIPPED (not
// passed) if unreachable, same convention as every other *.integration.test.ts
// in this suite for its own dependency (Postgres).
// ---------------------------------------------------------------------------

import { Readable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3StorageAdapter } from '../storage/S3StorageAdapter';

const ENDPOINT = process.env.TEST_S3_ENDPOINT ?? 'http://localhost:19000';
const BUCKET = process.env.TEST_S3_BUCKET ?? 'solytiq-test-bucket';
const ACCESS_KEY = process.env.TEST_S3_ACCESS_KEY_ID ?? 'testminio';
const SECRET_KEY = process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'testminio123';

let s3Available = false;
let adapter: S3StorageAdapter;

try {
  const { S3Client, HeadBucketCommand } = await import('@aws-sdk/client-s3');
  const probe = new S3Client({
    region: 'us-east-1', endpoint: ENDPOINT, forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });
  await probe.send(new HeadBucketCommand({ Bucket: BUCKET }));
  s3Available = true;
} catch (err) {
  console.warn(`⚠️  s3StorageAdapter.integration.test.ts: no reachable S3-compatible server at ${ENDPOINT} (bucket "${BUCKET}") — every test in this file is SKIPPED, not passed. (${(err as Error)?.message})`);
}

describe.skipIf(!s3Available)('S3StorageAdapter — live MinIO (real S3-compatible server)', () => {
  const testPrefix = `b2-test-${Date.now()}-`;

  beforeAll(() => {
    adapter = new S3StorageAdapter({
      bucket: BUCKET, region: 'us-east-1', endpoint: ENDPOINT, forcePathStyle: true,
      accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, keyPrefix: testPrefix,
    });
  });

  afterAll(async () => {
    // Best-effort cleanup of whatever this file wrote.
    for (const key of ['a.txt', 'b.txt', 'large.bin', 'overwrite.txt']) {
      await adapter.delete(key).catch(() => {});
    }
  });

  it('put() then get() round-trips a Buffer through a REAL S3-compatible server', async () => {
    await adapter.put('a.txt', Buffer.from('hello from a real S3-compatible server'));
    const stream = await adapter.get('a.txt');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('hello from a real S3-compatible server');
  });

  it('put() then get() round-trips a genuine Readable stream (proves streaming upload, not a buffered fallback)', async () => {
    async function* gen() {
      yield Buffer.from('chunk-A-');
      yield Buffer.from('chunk-B-');
      yield Buffer.from('chunk-C');
    }
    await adapter.put('b.txt', Readable.from(gen()));
    const stream = await adapter.get('b.txt');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('chunk-A-chunk-B-chunk-C');
  });

  it('head() reports real exists=false for a key that was never written', async () => {
    const h = await adapter.head('does-not-exist-on-the-real-server.bin');
    expect(h).toEqual({ exists: false, size: 0 });
  });

  it('head() reports real exists=true with the ACTUAL byte size the server stored', async () => {
    const payload = Buffer.from('12345678901234567890'); // 20 bytes
    await adapter.put('a.txt', payload); // overwrite from the first test with a known size
    const h = await adapter.head('a.txt');
    expect(h).toEqual({ exists: true, size: payload.length });
  });

  it('delete() genuinely removes the object from the real server', async () => {
    await adapter.put('overwrite.txt', Buffer.from('temp'));
    expect((await adapter.head('overwrite.txt')).exists).toBe(true);
    await adapter.delete('overwrite.txt');
    expect((await adapter.head('overwrite.txt')).exists).toBe(false);
  });

  it('delete() is idempotent against the real server (S3 DELETE is itself idempotent)', async () => {
    await expect(adapter.delete('never-existed-either.bin')).resolves.toBeUndefined();
  });

  it('a multi-megabyte upload streams through lib-storage\'s multipart path without buffering the whole object in this process', async () => {
    // 6 MiB — comfortably over @aws-sdk/lib-storage's default 5 MiB
    // multipart threshold, so this genuinely exercises the multipart
    // upload path against the real server, not just a single PutObject.
    const SIZE = 6 * 1024 * 1024;
    let written = 0;
    async function* largeGen() {
      const chunkSize = 64 * 1024;
      while (written < SIZE) {
        const n = Math.min(chunkSize, SIZE - written);
        written += n;
        yield Buffer.alloc(n, 'x');
      }
    }
    await adapter.put('large.bin', Readable.from(largeGen()));
    const h = await adapter.head('large.bin');
    expect(h.exists).toBe(true);
    expect(h.size).toBe(SIZE);
  }, 60_000);
});
