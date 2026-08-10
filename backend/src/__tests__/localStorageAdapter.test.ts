// ---------------------------------------------------------------------------
// B2 (Phase 2) — LocalStorageAdapter. Real filesystem (a temp dir), no DB.
// ---------------------------------------------------------------------------

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalStorageAdapter } from '../storage/LocalStorageAdapter';

describe('LocalStorageAdapter', () => {
  let dir: string;
  let adapter: LocalStorageAdapter;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solytiq-storage-test-'));
    adapter = new LocalStorageAdapter(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the root directory if it does not exist yet', () => {
    const freshDir = path.join(dir, 'nested', 'root');
    expect(fs.existsSync(freshDir)).toBe(false);
    new LocalStorageAdapter(freshDir);
    expect(fs.existsSync(freshDir)).toBe(true);
  });

  it('put() then get() round-trips a Buffer', async () => {
    await adapter.put('a.txt', Buffer.from('hello world'));
    const stream = await adapter.get('a.txt');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('hello world');
  });

  it('put() then get() round-trips a Readable stream (not buffered in memory by the adapter)', async () => {
    const source = Readable.from([Buffer.from('chunk1-'), Buffer.from('chunk2')]);
    await adapter.put('b.txt', source);
    const stream = await adapter.get('b.txt');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('chunk1-chunk2');
  });

  it('head() reports exists=false for a missing key without throwing', async () => {
    const h = await adapter.head('does-not-exist.txt');
    expect(h).toEqual({ exists: false, size: 0 });
  });

  it('head() reports exists=true and the correct size for a written object', async () => {
    await adapter.put('c.txt', Buffer.from('12345'));
    const h = await adapter.head('c.txt');
    expect(h).toEqual({ exists: true, size: 5 });
  });

  it('get() throws for a missing key', async () => {
    await expect(adapter.get('nope.txt')).rejects.toThrow(/not found/);
  });

  it('delete() removes the object', async () => {
    await adapter.put('d.txt', Buffer.from('x'));
    expect((await adapter.head('d.txt')).exists).toBe(true);
    await adapter.delete('d.txt');
    expect((await adapter.head('d.txt')).exists).toBe(false);
  });

  it('delete() is idempotent — deleting an already-gone key does not throw', async () => {
    await expect(adapter.delete('never-existed.txt')).resolves.toBeUndefined();
    await adapter.put('e.txt', Buffer.from('x'));
    await adapter.delete('e.txt');
    await expect(adapter.delete('e.txt')).resolves.toBeUndefined(); // second delete, already gone
  });

  it('put() overwrites an existing key (a retried upload reusing the same reserved key)', async () => {
    await adapter.put('f.txt', Buffer.from('version1'));
    await adapter.put('f.txt', Buffer.from('version2-longer'));
    const stream = await adapter.get('f.txt');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('version2-longer');
  });

  it('SECURITY: a "../../../etc/passwd"-shaped key can never escape the root — path.basename() strips every directory component before any write happens', async () => {
    // basename() collapses this down to the literal filename "passwd" —
    // the write lands harmlessly INSIDE root, never anywhere near the real
    // /etc/passwd. Proves the traversal attempt is neutralized, not merely
    // that some error happens to be thrown.
    await adapter.put('../../../etc/passwd', Buffer.from('x'));
    const h = await adapter.head('passwd');
    expect(h.exists).toBe(true);
    // And the real /etc/passwd (if this test happens to run as a user who
    // could read it) was never touched by this call.
    expect(fs.readdirSync(dir)).toEqual(['passwd']);
  });


  it('a key resolves to a file directly under root regardless of any embedded path segments (basename-only)', async () => {
    // path.basename strips any directory components the "key" might
    // contain — a key is always a server-generated flat filename, never
    // client-controlled, but this proves the defensive basename() call
    // actually collapses an attempted subdirectory reference.
    await adapter.put('sub/dir/file.txt', Buffer.from('flat'));
    const h = await adapter.head('file.txt'); // ends up flat, not nested
    expect(h.exists).toBe(true);
  });
});
