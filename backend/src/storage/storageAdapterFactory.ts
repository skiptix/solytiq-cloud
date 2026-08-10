// ---------------------------------------------------------------------------
// B2 (Phase 2) — chooses the active StorageAdapter from configuration.
// `STORAGE_BACKEND` (default `local`) is the ONE switch every upload route
// reads through — see UPLOAD_DIR's own existing convention in files.ts,
// which this reuses for the local adapter's root directory.
// ---------------------------------------------------------------------------

import type { StorageAdapter } from './StorageAdapter';
import { resolveStorageBackend } from './StorageAdapter';
import { LocalStorageAdapter } from './LocalStorageAdapter';
import { S3StorageAdapter, resolveS3Config } from './S3StorageAdapter';

let cached: StorageAdapter | null = null;

/**
 * Builds (once per process, then cached) the StorageAdapter this
 * deployment is configured to use. Throws at first use — not at module
 * import — if `STORAGE_BACKEND=s3` is set without the required S3
 * configuration, since a silent fallback to local disk for a deployment
 * that explicitly asked for S3 would be exactly the kind of unverifiable
 * production assumption this sprint's Stop-Bedingungen forbid papering
 * over.
 */
export function getStorageAdapter(env: NodeJS.ProcessEnv = process.env): StorageAdapter {
  if (cached) return cached;
  const backend = resolveStorageBackend(env);
  if (backend === 's3') {
    const s3Config = resolveS3Config(env);
    if (!s3Config) {
      throw new Error(
        'STORAGE_BACKEND=s3 is set but S3_BUCKET is missing — refusing to silently fall back to local disk. ' +
        'Set S3_BUCKET (and S3_REGION/S3_ENDPOINT/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_FORCE_PATH_STYLE as needed).'
      );
    }
    cached = new S3StorageAdapter(s3Config);
    return cached;
  }
  const rootDir = env.UPLOAD_DIR ?? '/app/uploads';
  cached = new LocalStorageAdapter(rootDir);
  return cached;
}

/** Test-only: clears the cached adapter so a test can reconfigure env vars
 *  and get a fresh instance. */
export function __resetStorageAdapterForTests(): void {
  cached = null;
}
