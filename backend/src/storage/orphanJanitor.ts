// ---------------------------------------------------------------------------
// B2 (Phase 2) — orphan/pending cleanup.
//
// Two independent sweeps:
//
//   1. `sweepExpiredPendingFiles` — a `shared_files` row that never made it
//      from `pending` to `ready` (the uploading process crashed between
//      reserving the row/quota and finishing the object write) is deleted
//      once its `pending_expires_at` passes, releasing its quota
//      reservation, and any partially-written object is best-effort
//      deleted too. Plain DELETEs are already safe under concurrent
//      janitors here — no claim/lease needed, since deletion IS the
//      terminal action (see the module-level note in jobLease.ts on why
//      lease semantics matter for RESUMABLE work but not a one-shot purge).
//
//   2. `sweepOrphanLocalFiles` — LOCAL-ADAPTER-ONLY, best-effort: lists
//      every file actually present under `UPLOAD_DIR` and deletes any that
//      no live row (across all four tables that reference a file on disk —
//      shared_files, task_attachments, milestone_attachments, gps_files)
//      still points to. A true disk-vs-DB reconciliation, catching orphans
//      from code paths this sprint did NOT convert to the pending/ready
//      flow (bundle uploads, task/milestone attachments, GPS uploads — see
//      the Phase 2 handoff's honest scope note). Deliberately NOT
//      implemented for the S3 backend in this pass — a full bucket LIST
//      reconciliation is a heavier, separate operation; the pending-row
//      sweep above is backend-agnostic and covers the primary new-upload
//      path regardless of which adapter is active.
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import { query } from '../db';
import type { QueryExec } from '../workspaceUtil';
import type { StorageAdapter } from './StorageAdapter';

export interface JanitorResult {
  reclaimedPendingRows: number;
}

export async function sweepExpiredPendingFiles(adapter: StorageAdapter, exec: QueryExec = query): Promise<JanitorResult> {
  const rows = await exec(
    `DELETE FROM shared_files
     WHERE object_status = 'pending' AND pending_expires_at IS NOT NULL AND pending_expires_at < NOW()
     RETURNING id, file_path`
  );
  for (const row of rows.rows as Array<{ id: string; file_path: string }>) {
    try {
      await adapter.delete(row.file_path);
    } catch {
      // Best-effort — the object may never have finished writing at all,
      // which is exactly the case this sweep exists to clean up after.
    }
  }
  return { reclaimedPendingRows: rows.rows.length };
}

export interface LocalOrphanSweepResult {
  scanned: number;
  deleted: number;
  deletedFiles: string[];
}

/**
 * Best-effort local-disk reconciliation — see module header. Never throws;
 * a single file's stat/delete failure is logged and skipped rather than
 * aborting the whole sweep.
 */
export async function sweepOrphanLocalFiles(uploadDir: string, exec: QueryExec = query): Promise<LocalOrphanSweepResult> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(uploadDir);
  } catch {
    return { scanned: 0, deleted: 0, deletedFiles: [] };
  }

  const [sharedFiles, taskAttachments, milestoneAttachments, gpsFiles] = await Promise.all([
    exec(`SELECT file_path FROM shared_files WHERE file_path IS NOT NULL`),
    exec(`SELECT file_path FROM task_attachments WHERE file_path IS NOT NULL`),
    exec(`SELECT file_path FROM milestone_attachments WHERE file_path IS NOT NULL`),
    exec(`SELECT file_path FROM gps_files WHERE file_path IS NOT NULL`),
  ]);
  const referenced = new Set<string>();
  for (const r of [sharedFiles, taskAttachments, milestoneAttachments, gpsFiles]) {
    for (const row of r.rows as Array<{ file_path: string }>) {
      referenced.add(path.basename(row.file_path));
    }
  }

  const deletedFiles: string[] = [];
  for (const entry of entries) {
    if (referenced.has(entry)) continue;
    const full = path.join(uploadDir, entry);
    try {
      const stat = await fs.promises.stat(full);
      if (!stat.isFile()) continue;
      await fs.promises.unlink(full);
      deletedFiles.push(entry);
    } catch {
      // Skip — a concurrent legitimate write racing this scan, or a
      // permissions issue, should never abort the rest of the sweep.
    }
  }

  return { scanned: entries.length, deleted: deletedFiles.length, deletedFiles };
}
