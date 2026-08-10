// ---------------------------------------------------------------------------
// B2 (Phase 2) — S3-compatible StorageAdapter (production): works against
// real AWS S3 as well as any S3-compatible endpoint (MinIO, Cloudflare R2,
// Backblaze B2, …) via `S3_ENDPOINT` + `S3_FORCE_PATH_STYLE`.
//
// Streaming both directions — `put` uses `@aws-sdk/lib-storage`'s `Upload`
// helper (multipart under the hood for large objects, single PutObject for
// small ones, entirely stream-based) and `get` returns the SDK's own
// Readable body stream directly. Neither buffers a whole object into
// process memory.
// ---------------------------------------------------------------------------

import type { Readable } from 'stream';
import { S3Client, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, type S3ClientConfig } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { StorageAdapter, StorageObjectHead } from './StorageAdapter';

export interface S3StorageConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Optional key prefix (e.g. `uploads/`) — lets one bucket be shared
   *  across environments/instances without collision. */
  keyPrefix: string;
}

function envBool(env: NodeJS.ProcessEnv, name: string, def: boolean): boolean {
  const raw = env[name];
  if (raw === undefined) return def;
  return raw === 'true' || raw === '1';
}

/**
 * Resolves S3 configuration from environment variables. Returns `null`
 * (rather than throwing) when required settings are missing — the CALLER
 * decides whether that's fatal (see storageAdapterFactory.ts: choosing
 * `STORAGE_BACKEND=s3` without a bucket configured is a startup-time
 * configuration error, surfaced clearly rather than silently falling back,
 * per this sprint's own Stop-Bedingungen on unverifiable production
 * assumptions).
 */
export function resolveS3Config(env: NodeJS.ProcessEnv = process.env): S3StorageConfig | null {
  const bucket = env.S3_BUCKET?.trim();
  if (!bucket) return null;
  return {
    bucket,
    region: env.S3_REGION?.trim() || 'us-east-1',
    endpoint: env.S3_ENDPOINT?.trim() || undefined,
    forcePathStyle: envBool(env, 'S3_FORCE_PATH_STYLE', false),
    accessKeyId: env.S3_ACCESS_KEY_ID?.trim() || undefined,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY?.trim() || undefined,
    keyPrefix: env.S3_KEY_PREFIX?.trim() ?? '',
  };
}

export class S3StorageAdapter implements StorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly keyPrefix: string;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.keyPrefix = config.keyPrefix;
    const clientConfig: S3ClientConfig = {
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
    };
    if (config.accessKeyId && config.secretAccessKey) {
      clientConfig.credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };
    }
    this.client = new S3Client(clientConfig);
  }

  private fullKey(key: string): string {
    return this.keyPrefix ? `${this.keyPrefix}${key}` : key;
  }

  async put(key: string, body: Readable | Buffer, opts?: { contentType?: string }): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: this.fullKey(key),
        Body: body,
        ContentType: opts?.contentType,
      },
    });
    await upload.done();
  }

  async get(key: string): Promise<Readable> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }));
    if (!result.Body) throw new Error(`storage object not found: ${key}`);
    return result.Body as Readable;
  }

  async head(key: string): Promise<StorageObjectHead> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }));
      return { exists: true, size: result.ContentLength ?? 0 };
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'NotFound' || name === 'NoSuchKey') return { exists: false, size: 0 };
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    // S3's DeleteObject is already idempotent (no error for a missing key)
    // — matches StorageAdapter's contract with no extra handling needed.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }));
  }
}
