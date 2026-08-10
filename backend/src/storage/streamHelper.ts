// ---------------------------------------------------------------------------
// B2 (Phase 2) — shared "serve one storage object over HTTP" helper.
//
// Before this, every download/preview route called `res.sendFile(filePath)`
// directly — an Express convenience method that only ever works against a
// LOCAL filesystem path, hard-coding every read path to the local adapter
// regardless of `STORAGE_BACKEND`. This streams through whichever adapter
// is actually configured (see storageAdapterFactory.ts) via `stream.pipe`,
// so switching to S3 works for reads exactly as it does for writes — and
// never buffers the whole object into process memory first (the "no
// process loads unbounded uploads fully into RAM" invariant applies to
// downloads too, not just uploads).
// ---------------------------------------------------------------------------

import type { Response } from 'express';
import type { StorageAdapter } from './StorageAdapter';

/**
 * Streams `key` from `adapter` to `res`, having already set whatever
 * headers the caller wants (Content-Disposition, Content-Type, etc.) —
 * this function only handles the body transfer and the not-found case.
 * Returns `true` if the object was found and streaming started, `false` if
 * the caller should respond 404 itself (this function does NOT write a 404
 * response body, since different call sites want different 404 shapes —
 * JSON vs plain).
 */
export async function streamStorageObject(adapter: StorageAdapter, key: string, res: Response): Promise<boolean> {
  const head = await adapter.head(key);
  if (!head.exists) return false;
  const stream = await adapter.get(key);
  await new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    res.on('finish', resolve);
    res.on('close', resolve);
    stream.pipe(res);
  });
  return true;
}
