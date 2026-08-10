// ---------------------------------------------------------------------------
// S6 — central upload-size configuration.
//
// Before this, every upload endpoint's multer `limits.fileSize` was a
// hardcoded magic number duplicated inline in its own route file (200MB in
// taskAttachments.ts, a separately-typed 200MB in milestoneAttachments.ts,
// 50MB in gps.ts, 15MB in markdownLists.ts, 25MB in ai.ts, and files.ts with
// no per-file cap at all) — nothing tied them together, so a future change to
// one was easy to forget to apply consistently, and an operator had no way
// to tune any of them without editing code. This module is the single
// source of truth: one named constant per upload surface, each overridable
// via an env var with the SAME default the code already shipped (a pure
// refactor — no behavior changes for anyone who doesn't set the new vars).
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;

function envBytes(name: string, defaultBytes: number): number {
  const raw = process.env[name];
  if (!raw) return defaultBytes;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultBytes;
}

/** files.ts (Files screen) — deliberately uncapped per-file; bounded only by
 *  the uploader's remaining storage quota (storageQuota.ts), same as today. */
export const FILE_UPLOAD_MAX_BYTES = envBytes('FILE_UPLOAD_MAX_BYTES', Number.POSITIVE_INFINITY);

/** taskAttachments.ts direct upload. */
export const TASK_ATTACHMENT_MAX_BYTES = envBytes('TASK_ATTACHMENT_MAX_BYTES', 200 * MB);

/** milestoneAttachments.ts direct upload. */
export const MILESTONE_ATTACHMENT_MAX_BYTES = envBytes('MILESTONE_ATTACHMENT_MAX_BYTES', 200 * MB);

/** gps.ts GPX/FIT upload. */
export const GPS_UPLOAD_MAX_BYTES = envBytes('GPS_UPLOAD_MAX_BYTES', 50 * MB);

/** markdownLists.ts inline `/image` block upload (shared with Knowledge Base
 *  entries via the same polymorphic owner_type/owner_id table) — deliberately
 *  NOT counted against the user's overall storage quota, see
 *  storageQuota.ts's own header comment for the reasoning; this per-file cap
 *  is its only bound. */
export const MARKDOWN_IMAGE_MAX_BYTES = envBytes('MARKDOWN_IMAGE_MAX_BYTES', 15 * MB);

/** ai.ts AI-chat file upload — memoryStorage, never written to disk (see
 *  storageQuota.ts), so this bounds request memory, not disk quota. */
export const AI_FILE_UPLOAD_MAX_BYTES = envBytes('AI_FILE_UPLOAD_MAX_BYTES', 25 * MB);
