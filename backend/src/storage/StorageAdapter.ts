// ---------------------------------------------------------------------------
// B2 (Phase 2) — the storage abstraction boundary.
//
// Before this, every upload route (files.ts, taskAttachments.ts,
// milestoneAttachments.ts, gps.ts) called `fs`/multer's disk storage
// directly — upload bytes were permanently coupled to whichever single
// process happened to receive the request, an inherent obstacle to running
// more than one stateless API replica (a file uploaded to replica A is
// invisible to replica B unless both share a network filesystem mount).
//
// `StorageAdapter` is intentionally NARROW — four operations, all
// stream-based (never buffers a whole object in memory; see the "no
// process loads unbounded uploads fully into RAM" invariant): `put` (write
// a stream under a key), `get` (read a stream back), `head` (existence +
// size, for orphan-cleanup and validation), `delete`. `LocalStorageAdapter`
// (dev/tests, matches today's behavior 1:1) and `S3StorageAdapter`
// (production-capable, S3-compatible — AWS, MinIO, R2, …) both implement
// exactly this surface; nothing above this boundary (routes, quota logic)
// ever needs to know which one is active.
//
// Existing public URLs are UNCHANGED: `/api/share/:token/download` still
// serves through the SAME route, which now asks the configured adapter for
// a stream instead of calling `fs.createReadStream` directly — no client-
// visible contract change, no S3 credentials or internal object keys are
// ever exposed to a caller.
// ---------------------------------------------------------------------------

import type { Readable } from 'stream';

export interface StorageObjectHead {
  exists: boolean;
  size: number;
}

export interface StorageAdapter {
  /** Writes `body` (a stream OR a Buffer — both accepted since some
   *  producers, like a controlled-size in-memory multer buffer, already
   *  have the whole object in hand) under `key`. Must be safe to call again
   *  with the same key (overwrite), since a retried upload after a
   *  transient failure reuses the same reserved key. */
  put(key: string, body: Readable | Buffer, opts?: { contentType?: string }): Promise<void>;
  /** Returns a readable stream for `key`. Throws if the object doesn't
   *  exist — callers that need existence-without-reading should use
   *  `head()` instead. */
  get(key: string): Promise<Readable>;
  /** Existence + size, without transferring the object body. */
  head(key: string): Promise<StorageObjectHead>;
  /** Idempotent — deleting a key that doesn't exist is not an error (an
   *  orphan-cleanup sweep may race a completed upload's own cleanup). */
  delete(key: string): Promise<void>;
}

export type StorageBackend = 'local' | 's3';

export function resolveStorageBackend(env: NodeJS.ProcessEnv = process.env): StorageBackend {
  const raw = (env.STORAGE_BACKEND ?? 'local').trim().toLowerCase();
  return raw === 's3' ? 's3' : 'local';
}
