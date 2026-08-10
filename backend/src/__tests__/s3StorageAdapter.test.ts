// ---------------------------------------------------------------------------
// B2 (Phase 2) — S3StorageAdapter + resolveS3Config. Mocked AWS SDK client
// (no live S3/MinIO in this sandbox) — see the Phase 2 handoff for the
// honest scope note on why this is mocked rather than exercised against a
// real S3-compatible server.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';

const sendMock = vi.fn();
const uploadDoneMock = vi.fn();
const uploadCtorArgs: unknown[] = [];

vi.mock('@aws-sdk/client-s3', () => {
  class FakeS3Client {
    send = sendMock;
  }
  class GetObjectCommand { constructor(public input: unknown) {} }
  class HeadObjectCommand { constructor(public input: unknown) {} }
  class DeleteObjectCommand { constructor(public input: unknown) {} }
  return { S3Client: FakeS3Client, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand };
});

vi.mock('@aws-sdk/lib-storage', () => {
  class FakeUpload {
    constructor(args: unknown) {
      uploadCtorArgs.push(args);
    }
    done = uploadDoneMock;
  }
  return { Upload: FakeUpload };
});

import { S3StorageAdapter, resolveS3Config } from '../storage/S3StorageAdapter';

describe('resolveS3Config', () => {
  it('returns null when S3_BUCKET is not set — signals "not configured", never guesses defaults for a bucket', () => {
    expect(resolveS3Config({})).toBeNull();
  });

  it('resolves full config from env vars, with sane defaults for region/prefix/path-style', () => {
    const cfg = resolveS3Config({ S3_BUCKET: 'my-bucket' });
    expect(cfg).toEqual({
      bucket: 'my-bucket',
      region: 'us-east-1',
      endpoint: undefined,
      forcePathStyle: false,
      accessKeyId: undefined,
      secretAccessKey: undefined,
      keyPrefix: '',
    });
  });

  it('honors every override (MinIO-style config)', () => {
    const cfg = resolveS3Config({
      S3_BUCKET: 'uploads',
      S3_REGION: 'eu-west-1',
      S3_ENDPOINT: 'http://minio.internal:9000',
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: 'minioadmin',
      S3_SECRET_ACCESS_KEY: 'minioadmin-secret',
      S3_KEY_PREFIX: 'solytiq/',
    });
    expect(cfg).toEqual({
      bucket: 'uploads',
      region: 'eu-west-1',
      endpoint: 'http://minio.internal:9000',
      forcePathStyle: true,
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin-secret',
      keyPrefix: 'solytiq/',
    });
  });
});

describe('S3StorageAdapter', () => {
  beforeEach(() => {
    sendMock.mockReset();
    uploadDoneMock.mockReset();
    uploadCtorArgs.length = 0;
  });

  const config = { bucket: 'test-bucket', region: 'us-east-1', forcePathStyle: false, keyPrefix: '' };

  it('put() delegates to the lib-storage Upload helper (streaming multipart under the hood) with the bucket/key/body', async () => {
    const adapter = new S3StorageAdapter(config);
    const body = Readable.from([Buffer.from('x')]);
    await adapter.put('some-key', body, { contentType: 'text/plain' });
    expect(uploadDoneMock).toHaveBeenCalledTimes(1);
    const args = uploadCtorArgs[0] as { params: { Bucket: string; Key: string; Body: unknown; ContentType: string } };
    expect(args.params.Bucket).toBe('test-bucket');
    expect(args.params.Key).toBe('some-key');
    expect(args.params.ContentType).toBe('text/plain');
  });

  it('put() applies the configured key prefix', async () => {
    const adapter = new S3StorageAdapter({ ...config, keyPrefix: 'uploads/' });
    await adapter.put('file.txt', Buffer.from('x'));
    const args = uploadCtorArgs[0] as { params: { Key: string } };
    expect(args.params.Key).toBe('uploads/file.txt');
  });

  it('get() returns the SDK response Body stream directly (no buffering)', async () => {
    const fakeBody = Readable.from([Buffer.from('hello')]);
    sendMock.mockResolvedValueOnce({ Body: fakeBody });
    const adapter = new S3StorageAdapter(config);
    const stream = await adapter.get('some-key');
    expect(stream).toBe(fakeBody);
  });

  it('get() throws when the response has no Body', async () => {
    sendMock.mockResolvedValueOnce({ Body: undefined });
    const adapter = new S3StorageAdapter(config);
    await expect(adapter.get('missing')).rejects.toThrow(/not found/);
  });

  it('head() reports exists=true with the object size', async () => {
    sendMock.mockResolvedValueOnce({ ContentLength: 42 });
    const adapter = new S3StorageAdapter(config);
    expect(await adapter.head('k')).toEqual({ exists: true, size: 42 });
  });

  it('head() reports exists=false (not an error) for a NotFound/NoSuchKey response', async () => {
    sendMock.mockRejectedValueOnce(Object.assign(new Error('not found'), { name: 'NotFound' }));
    const adapter = new S3StorageAdapter(config);
    expect(await adapter.head('missing')).toEqual({ exists: false, size: 0 });
  });

  it('head() re-throws any OTHER error (e.g. AccessDenied) rather than misreporting it as "not found"', async () => {
    sendMock.mockRejectedValueOnce(Object.assign(new Error('access denied'), { name: 'AccessDenied' }));
    const adapter = new S3StorageAdapter(config);
    await expect(adapter.head('k')).rejects.toThrow('access denied');
  });

  it('delete() sends a DeleteObjectCommand for the (prefixed) key', async () => {
    sendMock.mockResolvedValueOnce({});
    const adapter = new S3StorageAdapter({ ...config, keyPrefix: 'p/' });
    await adapter.delete('k');
    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0][0] as { input: { Key: string; Bucket: string } };
    expect(cmd.input).toEqual({ Bucket: 'test-bucket', Key: 'p/k' });
  });
});
