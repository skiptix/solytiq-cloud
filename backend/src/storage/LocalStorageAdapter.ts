// ---------------------------------------------------------------------------
// B2 (Phase 2) — local-disk StorageAdapter: the dev/test/single-host
// backend, and the default (matches this app's behavior before B2 existed —
// zero-config, zero-risk for anyone not opting into S3).
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import type { StorageAdapter, StorageObjectHead } from './StorageAdapter';

export class LocalStorageAdapter implements StorageAdapter {
  constructor(private readonly rootDir: string) {
    if (!fs.existsSync(this.rootDir)) fs.mkdirSync(this.rootDir, { recursive: true });
  }

  /** Resolves `key` against `rootDir` and verifies the result stays inside
   *  it — the same path-traversal discipline CLAUDE.md's Security Notes
   *  require of every file-serving code path in this app. `key` is always
   *  a server-generated UUID-based filename, never client input, but this
   *  is cheap, unconditional insurance against a future caller that
   *  forgets that invariant. */
  private resolvePath(key: string): string {
    const resolvedRoot = path.resolve(this.rootDir);
    const resolved = path.resolve(resolvedRoot, path.basename(key));
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`refusing to resolve a storage key outside its root: ${key}`);
    }
    return resolved;
  }

  async put(key: string, body: Readable | Buffer): Promise<void> {
    const dest = this.resolvePath(key);
    const source = Buffer.isBuffer(body) ? Readable.from(body) : body;
    // Stream to disk — never buffers the whole object in memory (the
    // invariant this whole abstraction exists to uphold), even when the
    // caller happened to hand us an already-in-memory Buffer (Readable.from
    // still streams it out in chunks rather than one fs.writeFile call).
    await pipeline(source, fs.createWriteStream(dest));
  }

  async get(key: string): Promise<Readable> {
    const p = this.resolvePath(key);
    if (!fs.existsSync(p)) throw new Error(`storage object not found: ${key}`);
    return fs.createReadStream(p);
  }

  async head(key: string): Promise<StorageObjectHead> {
    const p = this.resolvePath(key);
    try {
      const stat = await fs.promises.stat(p);
      return { exists: true, size: stat.size };
    } catch {
      return { exists: false, size: 0 };
    }
  }

  async delete(key: string): Promise<void> {
    const p = this.resolvePath(key);
    try {
      await fs.promises.unlink(p);
    } catch (err) {
      // Idempotent — deleting an already-gone key is not an error (see
      // StorageAdapter's own contract).
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
