// ---------------------------------------------------------------------------
// B2 (Phase 2) — a multer StorageEngine that streams directly into a
// StorageAdapter, instead of multer's own diskStorage (couples every write
// to this process's local disk) or memoryStorage (buffers the WHOLE file in
// process RAM — a real regression against the "no process loads unbounded
// uploads fully into RAM" invariant, since files.ts's own upload limit is
// deliberately uncapped by default — see uploadLimits.ts — bounded only by
// the uploader's storage quota, not a fixed byte ceiling).
//
// GENUINE crash-safety, not just documentation of the intent: `reservePending`
// (caller-supplied — see `files.ts`'s `reservePendingFile`) is called and
// AWAITED here, inside `_handleFile`, BEFORE `adapter.put()` starts
// transferring a single byte. This is the real reservation window — a
// 'pending' `shared_files` row referencing this exact storage key exists in
// the DB the moment the object write begins, not only after it completes.
// If the process crashes mid-write (or between the write finishing and the
// route handler's own finalizing UPDATE committing), the row is still
// there, and `storage/orphanJanitor.ts`'s `sweepExpiredPendingFiles()` finds
// and reclaims it (deletes the row, releasing its quota reservation, and
// best-effort deletes whatever did or didn't get written) once its TTL
// passes — genuinely, for BOTH the local adapter and S3 (the sweep queries
// through the generic `StorageAdapter` interface, not local-disk-specific
// APIs). This closes the gap an earlier pass of this file left open: a
// version of this engine that wrote 'ready' rows directly meant the
// pending/ready machinery existed in the schema and was unit-tested against
// synthetic rows, but no REAL upload ever produced a 'pending' row for the
// janitor to actually exercise — caught in review, fixed here.
//
// `file_size` is intentionally NOT known/reserved at THIS point — HTTP
// multipart's own constraint: a file part's exact size isn't knowable until
// it has been FULLY received (no reliable per-part Content-Length in a
// multipart body), so the reservation row is inserted with a size of 0 and
// the REAL quota check happens atomically at finalization (the route
// handler's UPDATE, still through the same per-user-locked
// `withQuotaReservation` as before — see files.ts). This does NOT reopen
// the concurrent-uploads-over-quota race `withQuotaReservation` exists to
// close: that race was always resolved at the moment a real size becomes
// known and gets atomically checked-and-committed, both before this change
// and after — only WHEN a placeholder row starts existing moved earlier,
// not WHEN the actual quota decision is made. A tighter design that reserves
// against a `Content-Length`-derived size hint upfront is a possible future
// refinement, not required for the crash-safety property this fix closes.
// ---------------------------------------------------------------------------

import crypto from 'crypto';
import path from 'path';
import type { StorageEngine } from 'multer';
import type { StorageAdapter } from './StorageAdapter';

export interface AdapterFile {
  /** The storage key the object was written under — pass this to
   *  `adapter.delete()` for orphan cleanup, or persist it as the DB row's
   *  `file_path` (same column every other upload path already uses). */
  filename: string;
  size: number;
  /** The `shared_files.id` the 'pending' row was reserved under — the route
   *  handler UPDATEs this exact row (pending -> ready) rather than
   *  inserting a fresh one, so the reservation and the finalized row are
   *  the SAME row throughout the upload's lifetime. */
  pendingId: string;
}

export interface PendingReservation {
  id: string;
}

/** Caller-supplied (files.ts) — inserts a genuine 'pending' `shared_files`
 *  row and returns its id. Kept as an injected function (not a direct DB
 *  import here) so this module stays DB-agnostic and unit-testable with a
 *  plain mock, matching this codebase's established QueryExec-injection
 *  convention elsewhere. */
export type ReservePendingFn = (opts: {
  userId: string;
  storageKey: string;
  originalName: string;
  mimeType: string;
}) => Promise<PendingReservation>;

export function createAdapterStorageEngine(adapter: StorageAdapter, reservePending: ReservePendingFn): StorageEngine {
  return {
    _handleFile(req, file, callback) {
      const ext = path.extname(file.originalname);
      const key = `${crypto.randomUUID()}${ext}`;
      const userId = (req as unknown as { userId?: string }).userId;
      if (!userId) {
        // The route this engine is mounted on always runs `authenticate`
        // before multer (see files.ts's router-wide `router.use(authenticate)`
        // ordering) — this is a defensive fail-closed guard, not an
        // expected path, so an unauthenticated call never gets a chance to
        // write ANY object, reserved or not.
        callback(new Error('createAdapterStorageEngine: no authenticated userId on request'));
        return;
      }

      reservePending({ userId, storageKey: key, originalName: file.originalname, mimeType: file.mimetype })
        .then((reservation) => {
          let size = 0;
          file.stream.on('data', (chunk: Buffer) => { size += chunk.length; });
          return adapter.put(key, file.stream, { contentType: file.mimetype }).then(() => {
            // `AdapterFile` (declared above) carries a field — `pendingId`
            // — multer's own `Express.Multer.File` type has no concept of,
            // so this cast is the one deliberate, narrow boundary where a
            // caller-specific field is smuggled through multer's
            // third-party callback shape; `files.ts` reads it back via the
            // SAME `AdapterFile` cast, so the two sides never drift.
            const info: AdapterFile = { filename: key, size, pendingId: reservation.id };
            callback(null, info as unknown as Partial<Express.Multer.File>);
          });
        })
        .catch((err: Error) => callback(err));
    },
    _removeFile(_req, file, callback) {
      adapter.delete((file as unknown as AdapterFile).filename)
        .then(() => callback(null))
        .catch((err: Error) => callback(err));
    },
  };
}
