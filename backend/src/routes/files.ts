import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { query } from '../db';
import { authenticate } from '../middleware';
import { requireAppInstalled } from '../appsRegistry';
import { hashPassword } from '../auth';
import { broadcastToUser } from '../sse';
import { getUserQuota as getUserQuotaShared, withQuotaReservation } from '../storageQuota';
import { FILE_UPLOAD_MAX_BYTES } from '../uploadLimits';
import { getStorageAdapter } from '../storage/storageAdapterFactory';
import { createAdapterStorageEngine } from '../storage/multerStorageEngine';
import { streamStorageObject } from '../storage/streamHelper';
import { decodeCreatedAtCursor, encodeCreatedAtCursor, paginateRows, parsePageLimit, type CreatedAtCursor } from '../pagination';

export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/app/uploads';

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

// No per-file size limit by default — a single upload is bounded only by the
// uploading user's remaining storage quota (checked below), not an arbitrary
// file cap. See uploadLimits.ts — an operator can still set FILE_UPLOAD_MAX_BYTES.
const upload = multer({ storage, limits: { fileSize: FILE_UPLOAD_MAX_BYTES } });

// B2 (Phase 2): the single-file upload route below streams through the
// configured StorageAdapter (local or S3) instead of always writing
// straight to this process's local disk — see multerStorageEngine.ts's own
// header for why this is a streaming engine, not multer's memoryStorage()
// (which would buffer the whole file in RAM, a real regression against the
// "no unbounded upload in memory" invariant). `/bundle` below still uses
// the disk-only `upload` instance above — not yet migrated in this pass,
// see the Phase 2 handoff for the honest scope note.
// (`adapterUpload` itself is constructed further below, once
// `reservePendingFile` — its genuine pending-row-reservation callback — is
// defined; see that section's own header comment for the full design.)

const router = Router();

interface FileRow {
  id: string;
  user_id: string;
  original_name: string;
  title: string | null;
  note: string | null;
  mime_type: string;
  file_size: number;
  file_path: string;
  is_public: boolean;
  password_hash: string | null;
  expires_at: string | null;
  share_token: string;
  created_at: string;
  bundle_id: string | null;
  bundle_name: string | null;
  bundle_count?: number;
}


function getBaseUrl(req: Request): string {
  const proto = req.headers['x-forwarded-proto'] ?? req.protocol;
  const host  = req.headers['x-forwarded-host'] ?? req.get('host');
  return `${proto}://${host}`;
}

function sanitizeFile(f: FileRow, baseUrl: string) {
  return {
    id:          f.id,
    userId:      f.user_id,
    name:        f.original_name,
    title:       f.title ?? null,
    note:        f.note ?? null,
    mimeType:    f.mime_type,
    size:        Number(f.file_size),
    isPublic:    f.is_public,
    hasPassword: f.password_hash !== null,
    expiresAt:   f.expires_at ?? null,
    shareToken:  f.share_token,
    shareUrl:    `${baseUrl}/share/${f.share_token}`,
    createdAt:   f.created_at,
    bundleId:    f.bundle_id ?? null,
    bundleName:  f.bundle_name ?? null,
    bundleCount: Number(f.bundle_count ?? 1),
  };
}

// SECURITY (S6): quota reads/checks now live in storageQuota.ts, shared with
// every other upload endpoint (taskAttachments.ts, milestoneAttachments.ts,
// gps.ts) so the SAME race-safe reservation logic backs all of them, not a
// second hand-rolled copy per file. getUserQuota is re-exported under its
// original local name purely so GET /storage below didn't need to change.
const getUserQuota = getUserQuotaShared;

// ── Authenticated routes ──────────────────────────────────────────
router.use(authenticate);
router.use(requireAppInstalled('files'));

// GET /api/files/storage
router.get('/storage', async (req: Request, res: Response) => {
  try {
    const isAdmin = (req as Request & { user?: { isAdmin: boolean } }).user?.isAdmin ?? false;
    const usageRes = await query<{ used: string }>(
      'SELECT COALESCE(SUM(file_size), 0) AS used FROM shared_files WHERE user_id = $1',
      [req.userId]
    );
    const used = parseInt(usageRes.rows[0].used, 10);
    if (isAdmin) {
      res.json({ used, quota: null, isAdmin: true });
      return;
    }
    const quota = await getUserQuota();
    res.json({ used, quota, isAdmin: false });
  } catch (err) {
    console.error('files/storage error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// B5 (Phase 2) — keyset-paginated variant of the classic GET /api/files
// query below. "Dateien" (Files) is one of the entities the Phase 2 spec
// explicitly names for pagination. Same `pagination.ts` primitive used for
// tasks, but with `CreatedAtCursor` (no `position` column on `shared_files`
// — files are only ever listed newest-first, never manually reordered) and
// a DESCENDING keyset comparison (`<` instead of `>` — the next page needs
// rows STRICTLY OLDER than the cursor's boundary row, since we're walking
// backwards through time). The bundle-collapsing CTE (one row per
// bundle_id/id group, via ROW_NUMBER()) is unchanged — the keyset predicate
// applies to the CTE's already-collapsed output, so a bundle is still
// treated as exactly one paginated "row" regardless of how many files it
// contains.
async function getFilesPageForUser(
  userId: string,
  opts: { cursor: CreatedAtCursor | null; limit: number }
): Promise<{ rows: FileRow[]; nextCursor: string | null }> {
  const params: unknown[] = [userId];
  let cursorClause = '';
  if (opts.cursor) {
    params.push(opts.cursor.createdAt, opts.cursor.id);
    const n = params.length;
    // `EXTRACT(EPOCH FROM created_at)::double precision` on both sides —
    // NOT the raw `timestamptz` column — for the exact same reason
    // routes/tasks.ts's buildTasksPageForUser does: comparing against a
    // JS-Date-derived value truncates below millisecond precision and can
    // re-include the cursor's own boundary row on the next page; Postgres's
    // `numeric` return type from bare EXTRACT() also comes back from `pg`
    // as a STRING unless explicitly cast to `double precision` — see
    // pagination.ts's `KeysetCursor.createdAt` doc comment for the full
    // story (a real bug caught by this suite's own integration tests
    // before it shipped).
    cursorClause = `AND (EXTRACT(EPOCH FROM created_at)::double precision, id) < ($${n - 1}::double precision, $${n})`;
  }
  params.push(opts.limit + 1);
  const limitParamIndex = params.length;

  const result = await query<FileRow & { created_at_epoch: number }>(
    `WITH grouped AS (
       SELECT sf.*,
              COUNT(*) OVER (PARTITION BY COALESCE(bundle_id, id)) AS bundle_count,
              SUM(file_size) OVER (PARTITION BY COALESCE(bundle_id, id)) AS bundle_size,
              ROW_NUMBER() OVER (PARTITION BY COALESCE(bundle_id, id) ORDER BY created_at DESC) AS rn
       FROM shared_files sf
       WHERE user_id = $1
     )
     SELECT id, user_id, original_name, title, note, mime_type, bundle_size AS file_size, file_path, is_public, password_hash, expires_at, share_token, created_at, bundle_id, bundle_name, bundle_count,
            EXTRACT(EPOCH FROM created_at)::double precision AS created_at_epoch
     FROM grouped
     WHERE rn = 1
     ${cursorClause}
     ORDER BY created_at DESC, id DESC
     LIMIT $${limitParamIndex}`,
    params
  );

  const { page, nextCursor } = paginateRows(
    result.rows,
    opts.limit,
    (row) => ({ createdAt: row.created_at_epoch, id: row.id }),
    encodeCreatedAtCursor
  );
  return { rows: page, nextCursor };
}

// GET /api/files
// Backward-compatible: with no `cursor`/`limit` query param, behaves exactly
// as before (the full, unbounded set in one `{ files }` response) — every
// existing caller keeps working unmodified. Passing either param opts into
// the paginated shape (`{ files, nextCursor }`) instead — additive, not a
// breaking change, mirroring GET /api/tasks's own convention.
router.get('/', async (req: Request, res: Response) => {
  try {
    const base = getBaseUrl(req);
    const wantsPage = req.query.cursor !== undefined || req.query.limit !== undefined;
    if (wantsPage) {
      const cursor = decodeCreatedAtCursor(req.query.cursor);
      const limit = parsePageLimit(req.query.limit);
      const { rows, nextCursor } = await getFilesPageForUser(req.userId!, { cursor, limit });
      res.json({ files: rows.map(f => sanitizeFile(f, base)), nextCursor });
      return;
    }
    const result = await query<FileRow>(
      `WITH grouped AS (
         SELECT sf.*,
                COUNT(*) OVER (PARTITION BY COALESCE(bundle_id, id)) AS bundle_count,
                SUM(file_size) OVER (PARTITION BY COALESCE(bundle_id, id)) AS bundle_size,
                ROW_NUMBER() OVER (PARTITION BY COALESCE(bundle_id, id) ORDER BY created_at DESC) AS rn
         FROM shared_files sf
         WHERE user_id = $1
       )
       SELECT id, user_id, original_name, title, note, mime_type, bundle_size AS file_size, file_path, is_public, password_hash, expires_at, share_token, created_at, bundle_id, bundle_name, bundle_count
       FROM grouped
       WHERE rn = 1
       ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json({ files: result.rows.map(f => sanitizeFile(f, base)) });
  } catch (err) {
    console.error('files GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// POST /api/files/bundle  (multipart/form-data)
router.post('/bundle', upload.array('files', 50), async (req: Request, res: Response) => {
  const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
  try {
    if (uploaded.length === 0) {
      res.status(400).json({ error: 'No files provided' });
      return;
    }

    const { isPublic, password, expiresAt, title } = req.body as { isPublic?: string; password?: string; expiresAt?: string; title?: string };
    const totalSize = uploaded.reduce((sum, file) => sum + file.size, 0);
    const isAdmin = (req as Request & { user?: { isAdmin: boolean } }).user?.isAdmin ?? false;

    const shareToken = crypto.randomBytes(24).toString('hex');
    const bundleId = crypto.randomUUID();
    const bundleName = title || `${uploaded.length} shared files`;
    const pwHash = password ? await hashPassword(password) : null;
    const pub = isPublic === 'true';
    const expiry = expiresAt || null;

    // SECURITY (S6): the quota check AND every one of these inserts run
    // inside ONE advisory-locked transaction (withQuotaReservation) — see
    // storageQuota.ts. This is what closes the check-then-act race a
    // separate SELECT-then-INSERT pair had before.
    const reservation = await withQuotaReservation(req.userId!, totalSize, isAdmin, async (client) => {
      const inserted: FileRow[] = [];
      for (const file of uploaded) {
        const result = await client.query<FileRow>(
          `INSERT INTO shared_files
             (id, user_id, original_name, title, mime_type, file_size, file_path, is_public, password_hash, expires_at, share_token, bundle_id, bundle_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING *`,
          [crypto.randomUUID(), req.userId, file.originalname, title || null, file.mimetype, file.size, file.filename, pub, pwHash, expiry, shareToken, bundleId, bundleName]
        );
        inserted.push({ ...result.rows[0], bundle_count: uploaded.length });
      }
      return inserted;
    });

    if (!reservation.ok) {
      uploaded.forEach(file => fs.unlinkSync(path.join(UPLOAD_DIR, file.filename)));
      res.status(413).json({ error: 'Storage quota exceeded. Please delete some files to free up space.' });
      return;
    }

    const rows = reservation.result;
    const base = getBaseUrl(req);
    res.status(201).json({ file: sanitizeFile(rows[0], base), files: rows.map(row => sanitizeFile(row, base)) });
    broadcastToUser(req.userId!, 'files');
  } catch (err) {
    uploaded.forEach(file => {
      const p = path.join(UPLOAD_DIR, file.filename);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });
    console.error('files bundle POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// How long a 'pending' row is allowed to sit unfinished before
// storage/orphanJanitor.ts's sweep reclaims it (deletes the row, releasing
// its quota reservation, and best-effort deletes whatever object bytes did
// or didn't make it to storage). Generous enough for a genuinely large file
// over a slow connection, bounded enough that a crashed upload doesn't tie
// up a quota reservation indefinitely.
const PENDING_UPLOAD_TTL_MS = 60 * 60 * 1000; // 1 hour

// B2 (Phase 2) — genuinely reserves a 'pending' `shared_files` row BEFORE
// any object bytes are transferred (called from
// storage/multerStorageEngine.ts's `_handleFile`, which awaits this and
// only then starts streaming to the adapter). This is the real reservation
// window the crash-safety story depends on — see multerStorageEngine.ts's
// header comment for the full design rationale, including why `file_size`
// is 0 here rather than reserved upfront (multipart's own size-unknown-
// until-received constraint).
async function reservePendingFile(opts: { userId: string; storageKey: string; originalName: string; mimeType: string }): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const shareToken = crypto.randomBytes(24).toString('hex');
  await query(
    `INSERT INTO shared_files
       (id, user_id, original_name, mime_type, file_size, file_path, share_token, object_status, pending_expires_at)
     VALUES ($1, $2, $3, $4, 0, $5, $6, 'pending', NOW() + ($7 || ' milliseconds')::interval)`,
    [id, opts.userId, opts.originalName, opts.mimeType, opts.storageKey, shareToken, PENDING_UPLOAD_TTL_MS]
  );
  return { id };
}

const adapterUpload = multer({ storage: createAdapterStorageEngine(getStorageAdapter(), reservePendingFile), limits: { fileSize: FILE_UPLOAD_MAX_BYTES } });

// POST /api/files  (multipart/form-data)
//
// B2 (Phase 2): by the time THIS handler runs, `adapterUpload`'s storage
// engine has already (a) reserved a genuine 'pending' `shared_files` row
// referencing this exact storage key — BEFORE any bytes were transferred —
// and (b) fully and durably written the object to the configured
// StorageAdapter. This handler's job is purely to FINALIZE that same row:
// an UPDATE (never an INSERT — the row already exists) that fills in the
// real, now-known file size and the user-supplied metadata, atomically
// quota-checked via the same per-user-locked `withQuotaReservation` as
// before, and flips `object_status` from 'pending' to 'ready'. A crash at
// ANY point up to and including this UPDATE leaves a genuine, reclaimable
// 'pending' row for storage/orphanJanitor.ts's sweep to find — for both the
// local adapter and S3 (see that module's header for why this is
// backend-agnostic).
router.post('/', adapterUpload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }
    const storageKey = req.file.filename; // the key createAdapterStorageEngine wrote it under
    const pendingId = (req.file as unknown as { pendingId?: string }).pendingId;
    if (!pendingId) {
      // Defensive fail-closed guard — this engine always attaches
      // `pendingId` on success (see multerStorageEngine.ts); its absence
      // here would mean the reservation step was silently skipped, which
      // should never happen but must never be treated as "proceed anyway"
      // if it somehow did.
      await getStorageAdapter().delete(storageKey).catch(() => {});
      console.error('files POST error: uploaded file has no pendingId — reservation step did not run as expected');
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    const { isPublic, password, expiresAt, title } = req.body as {
      isPublic?: string;
      password?: string;
      expiresAt?: string;
      title?: string;
    };

    // SECURITY (S6): quota check + finalizing UPDATE are atomic together —
    // see storageQuota.ts and the bundle route above for the full
    // rationale. The reservation row's placeholder `file_size = 0` never
    // counted toward quota, so this is exactly as race-safe against OTHER
    // concurrent uploads from the same user as the pre-B2-fix INSERT path
    // was — the atomic check-and-commit moment (this UPDATE) is unchanged,
    // only WHEN the row started existing moved earlier.
    const isAdmin = (req as Request & { user?: { isAdmin: boolean } }).user?.isAdmin ?? false;

    const pwHash = password ? await hashPassword(password) : null;
    const pub    = isPublic === 'true';
    const expiry = expiresAt || null;

    const reservation = await withQuotaReservation(req.userId!, req.file.size, isAdmin, (client) =>
      client.query<FileRow>(
        `UPDATE shared_files
         SET title = $1, mime_type = $2, file_size = $3, is_public = $4, password_hash = $5, expires_at = $6,
             object_status = 'ready', pending_expires_at = NULL
         WHERE id = $7 AND user_id = $8 AND object_status = 'pending'
         RETURNING *`,
        [title ?? null, req.file!.mimetype, req.file!.size, pub, pwHash, expiry, pendingId, req.userId]
      )
    );

    if (!reservation.ok) {
      await getStorageAdapter().delete(storageKey).catch(() => {});
      // Immediate cleanup of the now-dead reservation row — the janitor's
      // TTL sweep would eventually reclaim it too, but there is no reason
      // to leave a row around a KNOWN-failed request already told the
      // client about synchronously.
      await query(`DELETE FROM shared_files WHERE id = $1 AND object_status = 'pending'`, [pendingId]).catch(() => {});
      res.status(413).json({ error: 'Storage quota exceeded. Please delete some files to free up space.' });
      return;
    }
    if (reservation.result.rows.length === 0) {
      // The reservation row vanished between multer finishing and this
      // UPDATE running (e.g. the janitor's TTL swept it out from under an
      // unusually slow request) — fail cleanly rather than silently
      // reporting success for a row that no longer exists.
      await getStorageAdapter().delete(storageKey).catch(() => {});
      res.status(500).json({ error: 'Upload reservation expired before it could be finalized — please retry.' });
      return;
    }

    const base = getBaseUrl(req);
    res.status(201).json({ file: sanitizeFile(reservation.result.rows[0], base) });
    broadcastToUser(req.userId!, 'files');
  } catch (err) {
    if (req.file) {
      const key = req.file.filename;
      const pid = (req.file as unknown as { pendingId?: string }).pendingId;
      await getStorageAdapter().delete(key).catch(() => {});
      if (pid) await query(`DELETE FROM shared_files WHERE id = $1 AND object_status = 'pending'`, [pid]).catch(() => {});
    }
    console.error('files POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/files/:id
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, title, note, isPublic, password, expiresAt } = req.body as {
      name?: string;
      title?: string | null;
      note?: string | null;
      isPublic?: boolean;
      password?: string | null;
      expiresAt?: string | null;
    };

    const existing = await query<FileRow>(
      'SELECT * FROM shared_files WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const updatePw    = 'password'  in req.body;
    const updateExp   = 'expiresAt' in req.body;
    const updateTitle = 'title'     in req.body;
    const updateNote  = 'note'      in req.body;
    let pwHash: string | null = null;
    if (updatePw && typeof password === 'string' && password.length > 0) {
      pwHash = await hashPassword(password);
    }

    const result = await query<FileRow>(
      `UPDATE shared_files sf
       SET original_name = CASE WHEN sf.id = $1 THEN COALESCE($2, original_name) ELSE original_name END,
           title         = CASE WHEN $8  THEN $9  ELSE title         END,
           note          = CASE WHEN $10 THEN $11 ELSE note          END,
           bundle_name   = CASE WHEN $8  THEN $9  ELSE bundle_name   END,
           is_public     = COALESCE($3, is_public),
           password_hash = CASE WHEN $4 THEN $5 ELSE password_hash END,
           expires_at    = CASE WHEN $6 THEN $7 ELSE expires_at    END
       WHERE sf.user_id = $12
         AND COALESCE(sf.bundle_id, sf.id) = COALESCE((SELECT bundle_id FROM shared_files WHERE id = $1), $1)
       RETURNING *`,
      [id, name ?? null, isPublic ?? null, updatePw, pwHash, updateExp, expiresAt ?? null, updateTitle, title ?? null, updateNote, note ?? null, req.userId]
    );

    const base = getBaseUrl(req);
    res.json({ file: sanitizeFile(result.rows[0], base) });
    broadcastToUser(req.userId!, 'files');
  } catch (err) {
    console.error('files PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/files/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const existing = await query<FileRow>(
      'SELECT * FROM shared_files WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const deleteRows = await query<{ file_path: string }>(
      `DELETE FROM shared_files sf
       WHERE sf.user_id = $2
         AND COALESCE(sf.bundle_id, sf.id) = COALESCE((SELECT bundle_id FROM shared_files WHERE id = $1), $1)
       RETURNING file_path`,
      [id, req.userId]
    );

    const adapter = getStorageAdapter();
    await Promise.all(deleteRows.rows.map((row) => adapter.delete(path.basename(row.file_path)).catch(() => {})));

    res.json({ success: true });
    broadcastToUser(req.userId!, 'files');
  } catch (err) {
    console.error('files DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/files/:id/preview — authenticated inline file serving for owner preview
router.get('/:id/preview', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await query<{ file_path: string; mime_type: string; original_name: string }>(
      'SELECT file_path, mime_type, original_name FROM shared_files WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );
    if (result.rows.length === 0) { res.status(404).json({ error: 'File not found' }); return; }
    const { file_path, mime_type: untrustedMime, original_name } = result.rows[0];
    const storageKey = path.basename(file_path);

    // FIND-02: Secure file preview. Only allow safe types inline.
    const safeMimeTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'text/plain'];
    const isSafe = safeMimeTypes.includes(untrustedMime);

    const disposition = isSafe ? 'inline' : 'attachment';
    const sanitizedName = original_name.replace(/[^\w\s\-_.]/g, '_');

    res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(sanitizedName)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');

    if (isSafe) {
      res.setHeader('Content-Type', untrustedMime);
      if (untrustedMime === 'text/plain') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
      // Content-Security-Policy: sandbox to prevent any script execution even in images (e.g. SVG if allowed later)
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data: blob:;");
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
    }

    const found = await streamStorageObject(getStorageAdapter(), storageKey, res);
    if (!found) { res.status(404).json({ error: 'File not found on disk' }); return; }
  } catch (err) {
    console.error('files preview error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
