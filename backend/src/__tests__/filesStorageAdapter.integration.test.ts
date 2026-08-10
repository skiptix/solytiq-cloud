// ---------------------------------------------------------------------------
// B2 (Phase 2) — live-Postgres + real local-disk proof that:
//   1. `POST /api/files` genuinely streams through the StorageAdapter (not
//      the raw fs calls it used to) end-to-end: upload -> DB row -> preview
//      stream -> delete actually removes the object.
//   2. Parallel uploads racing the SAME user's quota can NEVER collectively
//      exceed it (withQuotaReservation's existing guarantee, now proven
//      through the real, currently-wired route rather than in isolation).
//   3. The storage janitor (`sweepExpiredPendingFiles`) reclaims an
//      orphaned 'pending' row (crash-before-ready simulation) — deletes
//      both the row (releasing its quota reservation) and its object.
//
// Same live-DB convention as the rest of this suite — SKIPPED (not passed)
// if no database is reachable.
// ---------------------------------------------------------------------------

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.PGHOST     = process.env.TEST_PGHOST     ?? 'localhost';
process.env.PGPORT     = process.env.TEST_PGPORT     ?? '5432';
process.env.PGDATABASE = process.env.TEST_PGDATABASE ?? 'solytiq_test';
process.env.PGUSER     = process.env.TEST_PGUSER     ?? 'solytiq_test';
process.env.PGPASSWORD = process.env.TEST_PGPASSWORD ?? 'solytiq_test_pw';

const testUploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solytiq-files-integration-'));
process.env.UPLOAD_DIR = testUploadDir;
process.env.STORAGE_BACKEND = 'local';

let dbAvailable = false;
let pool: typeof import('../db').pool;

try {
  const dbMod = await import('../db');
  pool = dbMod.pool;
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch (err) {
  console.warn(`⚠️  filesStorageAdapter.integration.test.ts: no reachable Postgres — every test in this file is SKIPPED, not passed. (${(err as Error)?.message})`);
}

describe.skipIf(!dbAvailable)('B2 — files.ts upload route through the StorageAdapter (live Postgres + real local disk)', () => {
  let server: http.Server;
  let baseUrl: string;
  const userId = 'b2000000-0000-4000-8000-0000000000e1';
  let token: string;

  beforeAll(async () => {
    const { runAllMigrations } = await import('../migrations');
    await runAllMigrations();

    const express = (await import('express')).default;
    const filesRouter = (await import('../routes/files')).default;
    const { generateToken, hashPassword } = await import('../auth');

    await pool.query(`DELETE FROM shared_files WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool.query(`INSERT INTO installed_apps (app_id) VALUES ('files') ON CONFLICT DO NOTHING`);
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('storage_quota_per_user', '500000') ON CONFLICT (key) DO UPDATE SET value = '500000'`); // 500KB quota, small enough to test overflow cheaply

    const pw = await hashPassword('irrelevant-for-this-test-x');
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, full_name, is_admin) VALUES ($1, 'b2_files_user', 'b2-files@test.local', $2, 'Files', false)`,
      [userId, pw]
    );
    token = generateToken(userId, 0);

    const app = express();
    app.use('/api/files', filesRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM shared_files WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('storage_quota_per_user', '${15 * 1024 * 1024 * 1024}') ON CONFLICT (key) DO UPDATE SET value = '${15 * 1024 * 1024 * 1024}'`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(testUploadDir, { recursive: true, force: true });
    // NOTE: `pool` (from ../db) is a single module-level singleton SHARED
    // with the second describe block below — do not `pool.end()` it here,
    // only after the final describe block's tests have run (see its own
    // afterAll), or the janitor block's beforeAll fails with "Cannot use a
    // pool after calling end on the pool".
  });

  function uploadFile(content: Buffer, filename = 'test.txt') {
    // Hand-rolled multipart body — no extra dependency needed for a single-field upload.
    const boundary = '----solytiqTestBoundary' + Math.random().toString(16).slice(2);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return fetch(`${baseUrl}/api/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
  }

  it('uploads a file end-to-end: the object is genuinely written to the configured StorageAdapter (real local disk, not a stub)', async () => {
    const content = Buffer.from('hello from the B2 storage adapter integration test');
    const res = await uploadFile(content);
    expect(res.status).toBe(201);
    const body = await res.json() as { file: { id: string } };

    const row = await pool.query<{ file_path: string; object_status: string; file_size: string }>(
      `SELECT file_path, object_status, file_size FROM shared_files WHERE id = $1`, [body.file.id]
    );
    expect(row.rows[0].object_status).toBe('ready');
    expect(parseInt(row.rows[0].file_size, 10)).toBe(content.length);

    // The object genuinely exists on disk under the configured UPLOAD_DIR —
    // proves the adapter (not a mock) actually wrote it there.
    const onDisk = fs.readFileSync(path.join(testUploadDir, row.rows[0].file_path));
    expect(onDisk.equals(content)).toBe(true);
  });

  it('preview streams the SAME bytes back through the adapter (round-trip proof, not just existence)', async () => {
    const content = Buffer.from('preview round-trip content 12345');
    const uploadRes = await uploadFile(content, 'preview.txt');
    const uploaded = await uploadRes.json() as { file: { id: string } };

    const previewRes = await fetch(`${baseUrl}/api/files/${uploaded.file.id}/preview`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(previewRes.status).toBe(200);
    const streamed = Buffer.from(await previewRes.arrayBuffer());
    expect(streamed.equals(content)).toBe(true);
  });

  it('delete genuinely removes the object from disk, not just the DB row', async () => {
    const content = Buffer.from('to be deleted');
    const uploadRes = await uploadFile(content, 'delete-me.txt');
    const uploaded = await uploadRes.json() as { file: { id: string } };
    const row = await pool.query<{ file_path: string }>(`SELECT file_path FROM shared_files WHERE id = $1`, [uploaded.file.id]);
    const diskPath = path.join(testUploadDir, row.rows[0].file_path);
    expect(fs.existsSync(diskPath)).toBe(true);

    const deleteRes = await fetch(`${baseUrl}/api/files/${uploaded.file.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    expect(deleteRes.status).toBe(200);
    expect(fs.existsSync(diskPath)).toBe(false);
  });

  it('a single upload exceeding the (500KB) quota is rejected with 413, and the just-written object is cleaned up (no orphan)', async () => {
    const bigContent = Buffer.alloc(600_000, 'x'); // over the 500KB test quota
    const res = await uploadFile(bigContent, 'toobig.txt');
    expect(res.status).toBe(413);
    // No orphaned file left on disk from the rejected upload.
    const entries = fs.readdirSync(testUploadDir);
    // Every remaining file on disk must correspond to a REAL 'ready' row —
    // none should be the just-rejected 600KB payload (a leaked orphan would
    // show up as an extra 600000-byte file with no DB row).
    for (const entry of entries) {
      const stat = fs.statSync(path.join(testUploadDir, entry));
      expect(stat.size).not.toBe(600_000);
    }
  });

  it('PARALLEL uploads racing the same quota never collectively exceed it — the atomic withQuotaReservation guarantee, proven through the real route', async () => {
    // Reset to a clean, small, precisely-known quota window for this test.
    await pool.query(`DELETE FROM shared_files WHERE user_id = $1`, [userId]);
    await pool.query(`UPDATE app_settings SET value = '100000' WHERE key = 'storage_quota_per_user'`); // 100KB

    const chunk = Buffer.alloc(40_000, 'y'); // 3 concurrent x 40KB = 120KB > 100KB quota
    const [r1, r2, r3] = await Promise.all([
      uploadFile(chunk, 'p1.txt'),
      uploadFile(chunk, 'p2.txt'),
      uploadFile(chunk, 'p3.txt'),
    ]);
    const statuses = [r1.status, r2.status, r3.status].sort();
    // Exactly 2 succeed (80KB total, under 100KB) and 1 is rejected — never
    // all 3 (which would silently blow the quota by 20KB).
    expect(statuses).toEqual([201, 201, 413]);

    const used = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(file_size), 0) AS total FROM shared_files WHERE user_id = $1`, [userId]
    );
    expect(parseInt(used.rows[0].total, 10)).toBeLessThanOrEqual(100_000);

    await pool.query(`UPDATE app_settings SET value = '500000' WHERE key = 'storage_quota_per_user'`);
  });

  // -------------------------------------------------------------------------
  // GENUINE crash-mid-upload simulation against the REAL route — not a
  // synthetic row inserted directly via SQL. Reviewed finding: an earlier
  // pass of this file's "crash recovery" coverage only proved the janitor
  // could clean up a 'pending' row that was never actually produced by any
  // real code path (POST /api/files always committed 'ready' directly, so
  // 'pending' was dead code end-to-end). Fixed at the design level
  // (multerStorageEngine.ts now reserves a 'pending' row BEFORE any bytes
  // transfer — see its header comment) — this test proves that fix through
  // the real HTTP route, by GENUINELY severing the connection mid-upload
  // (Node's raw `http` client, not `fetch` — gives byte-level control over
  // when the socket dies) and confirming a real 'pending' row exists
  // afterward, referencing a real (partially-written) object, which the
  // janitor then genuinely reclaims — the actual crash-safety story, not a
  // stand-in for it.
  // -------------------------------------------------------------------------
  it('a REAL mid-upload connection drop leaves a genuine, janitor-cleanable "pending" row — not a synthetic one', async () => {
    await pool.query(`DELETE FROM shared_files WHERE user_id = $1`, [userId]);
    const before = await pool.query(`SELECT id FROM shared_files WHERE user_id = $1`, [userId]);
    expect(before.rows.length).toBe(0);

    const boundary = '----solytiqCrashTestBoundary' + Math.random().toString(16).slice(2);
    const port = Number(new URL(baseUrl).port);

    // Send the multipart preamble + the file part's own headers + a FIRST
    // chunk of real body bytes (enough for busboy to dispatch the file part
    // to createAdapterStorageEngine's `_handleFile`, which reserves the
    // 'pending' row BEFORE this data even arrives) — then DESTROY the
    // socket without ever sending the closing boundary. No Content-Length
    // is set (chunked transfer), so the server has no way to know the body
    // was supposed to continue — indistinguishable, from the server's
    // perspective, from the client process crashing mid-transfer.
    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/files',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Transfer-Encoding': 'chunked',
        },
      });
      req.on('error', () => resolve()); // destroying our own socket surfaces here — expected, not a test failure
      req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="crash-test.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      req.write(Buffer.alloc(20_000, 'z')); // a real chunk of file bytes — genuinely reaches the server and the storage adapter
      // Give the server a moment to actually receive and start processing
      // this chunk (reserve the row, start the adapter write) before we
      // sever the connection — a 0-byte-transferred abort would prove
      // nothing about the reservation-before-write ordering.
      setTimeout(() => {
        req.destroy(new Error('simulated crash — connection dropped mid-upload'));
        resolve();
      }, 150);
    });

    // Give the server a moment to notice the dropped connection and let
    // any in-flight adapter.put() settle (reject) before we inspect state.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const pendingRows = await pool.query<{ id: string; object_status: string; file_path: string }>(
      `SELECT id, object_status, file_path FROM shared_files WHERE user_id = $1`, [userId]
    );
    expect(pendingRows.rows.length).toBe(1); // the reservation genuinely happened, through the real route
    expect(pendingRows.rows[0].object_status).toBe('pending');
    const storageKey = pendingRows.rows[0].file_path; // the exact key createAdapterStorageEngine generated for this upload

    // The partially-written object should have genuinely landed on disk —
    // proof the reservation truly happened BEFORE (not instead of) the
    // object write; a bug that skipped the object write entirely would
    // pass the row-existence check above just as easily.
    const partialPath = path.join(testUploadDir, storageKey);
    expect(fs.existsSync(partialPath)).toBe(true);

    // The janitor genuinely reclaims it — same real sweep a production
    // worker process runs on its own timer.
    const { sweepExpiredPendingFiles } = await import('../storage/orphanJanitor');
    const { LocalStorageAdapter } = await import('../storage/LocalStorageAdapter');
    const adapter = new LocalStorageAdapter(testUploadDir);
    // The row's TTL is 1 hour out (PENDING_UPLOAD_TTL_MS in files.ts) — not
    // expired yet, so a sweep RIGHT NOW correctly leaves it alone (proves
    // the janitor doesn't reclaim in-flight-looking work prematurely).
    const tooEarly = await sweepExpiredPendingFiles(adapter);
    expect(tooEarly.reclaimedPendingRows).toBe(0);
    const stillThere = await pool.query(`SELECT id FROM shared_files WHERE user_id = $1`, [userId]);
    expect(stillThere.rows.length).toBe(1);
    expect(fs.existsSync(partialPath)).toBe(true); // untouched by the too-early sweep

    // Now simulate the TTL having genuinely passed, and sweep again —
    // this is the real reclaim path a worker's cron eventually exercises.
    await pool.query(`UPDATE shared_files SET pending_expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1`, [userId]);
    const reclaimed = await sweepExpiredPendingFiles(adapter);
    expect(reclaimed.reclaimedPendingRows).toBe(1);
    const afterSweep = await pool.query(`SELECT id FROM shared_files WHERE user_id = $1`, [userId]);
    expect(afterSweep.rows.length).toBe(0); // row reclaimed, quota reservation released

    // The partially-written object itself is also gone — no disk orphan
    // left behind despite the connection never completing normally, for
    // BOTH the local adapter (checked directly here) and — since the
    // janitor's delete call goes through the generic `StorageAdapter`
    // interface, not a local-disk-specific API — S3 as well.
    expect(fs.existsSync(partialPath)).toBe(false);
  }, 15_000);
});

describe.skipIf(!dbAvailable)('B2 — storage janitor reclaims an orphaned pending row (simulated crash)', () => {
  const userId = 'b2000000-0000-4000-8000-0000000000e2';

  beforeAll(async () => {
    const { runAllMigrations } = await import('../migrations');
    await runAllMigrations();
    const { hashPassword } = await import('../auth');
    await pool.query(`DELETE FROM shared_files WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    const pw = await hashPassword('irrelevant-for-this-test-x');
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, full_name, is_admin) VALUES ($1, 'b2_janitor_user', 'b2-janitor@test.local', $2, 'Janitor', false)`,
      [userId, pw]
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM shared_files WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool.end();
  });

  it('a "pending" row past its TTL (simulating a crash before the object ever finished writing) is deleted by the janitor, freeing its quota reservation', async () => {
    const { sweepExpiredPendingFiles } = await import('../storage/orphanJanitor');
    const { LocalStorageAdapter } = await import('../storage/LocalStorageAdapter');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solytiq-janitor-test-'));
    const adapter = new LocalStorageAdapter(dir);

    const pendingId = 'sf_test_pending_crash';
    await pool.query(
      `INSERT INTO shared_files (id, user_id, original_name, file_size, file_path, share_token, object_status, pending_expires_at)
       VALUES ($1, $2, 'crashed-upload.bin', 12345, 'never-actually-written.bin', 'tok_test', 'pending', NOW() - INTERVAL '1 minute')`,
      [pendingId, userId]
    );
    const before = await pool.query(`SELECT id FROM shared_files WHERE id = $1`, [pendingId]);
    expect(before.rows.length).toBe(1);

    const result = await sweepExpiredPendingFiles(adapter);
    expect(result.reclaimedPendingRows).toBeGreaterThanOrEqual(1);

    const after = await pool.query(`SELECT id FROM shared_files WHERE id = $1`, [pendingId]);
    expect(after.rows.length).toBe(0); // reclaimed — quota reservation released

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a "pending" row NOT yet past its TTL is left alone (still legitimately in-flight)', async () => {
    const { sweepExpiredPendingFiles } = await import('../storage/orphanJanitor');
    const { LocalStorageAdapter } = await import('../storage/LocalStorageAdapter');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solytiq-janitor-test-2-'));
    const adapter = new LocalStorageAdapter(dir);

    const pendingId = 'sf_test_pending_active';
    await pool.query(
      `INSERT INTO shared_files (id, user_id, original_name, file_size, file_path, share_token, object_status, pending_expires_at)
       VALUES ($1, $2, 'still-uploading.bin', 999, 'still-uploading.bin', 'tok_test2', 'pending', NOW() + INTERVAL '10 minutes')`,
      [pendingId, userId]
    );

    await sweepExpiredPendingFiles(adapter);

    const after = await pool.query(`SELECT id FROM shared_files WHERE id = $1`, [pendingId]);
    expect(after.rows.length).toBe(1); // NOT reclaimed — still within its TTL

    await pool.query(`DELETE FROM shared_files WHERE id = $1`, [pendingId]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a "ready" row (a normal, finished upload) is never touched by the janitor regardless of age', async () => {
    const { sweepExpiredPendingFiles } = await import('../storage/orphanJanitor');
    const { LocalStorageAdapter } = await import('../storage/LocalStorageAdapter');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solytiq-janitor-test-3-'));
    const adapter = new LocalStorageAdapter(dir);

    const readyId = 'sf_test_ready_old';
    await pool.query(
      `INSERT INTO shared_files (id, user_id, original_name, file_size, file_path, share_token, object_status, created_at)
       VALUES ($1, $2, 'normal-file.bin', 100, 'normal-file.bin', 'tok_test3', 'ready', NOW() - INTERVAL '1 year')`,
      [readyId, userId]
    );

    await sweepExpiredPendingFiles(adapter);

    const after = await pool.query(`SELECT id FROM shared_files WHERE id = $1`, [readyId]);
    expect(after.rows.length).toBe(1); // untouched

    await pool.query(`DELETE FROM shared_files WHERE id = $1`, [readyId]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
