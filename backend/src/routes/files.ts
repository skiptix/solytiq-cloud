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

// GET /api/files
router.get('/', async (req: Request, res: Response) => {
  try {
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
    const base = getBaseUrl(req);
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

// POST /api/files  (multipart/form-data)
router.post('/', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const { isPublic, password, expiresAt, title } = req.body as {
      isPublic?: string;
      password?: string;
      expiresAt?: string;
      title?: string;
    };

    // SECURITY (S6): quota check + insert are atomic together — see
    // storageQuota.ts and the bundle route above for the full rationale.
    const isAdmin = (req as Request & { user?: { isAdmin: boolean } }).user?.isAdmin ?? false;

    const id          = crypto.randomUUID();
    const shareToken  = crypto.randomBytes(24).toString('hex');
    const pwHash      = password ? await hashPassword(password) : null;
    const pub         = isPublic === 'true';
    const expiry      = expiresAt || null;

    const reservation = await withQuotaReservation(req.userId!, req.file.size, isAdmin, (client) =>
      client.query<FileRow>(
        `INSERT INTO shared_files
           (id, user_id, original_name, title, mime_type, file_size, file_path, is_public, password_hash, expires_at, share_token)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [id, req.userId, req.file!.originalname, title ?? null, req.file!.mimetype, req.file!.size, req.file!.filename, pub, pwHash, expiry, shareToken]
      )
    );

    if (!reservation.ok) {
      fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename));
      res.status(413).json({ error: 'Storage quota exceeded. Please delete some files to free up space.' });
      return;
    }

    const base = getBaseUrl(req);
    res.status(201).json({ file: sanitizeFile(reservation.result.rows[0], base) });
    broadcastToUser(req.userId!, 'files');
  } catch (err) {
    if (req.file) {
      const p = path.join(UPLOAD_DIR, req.file.filename);
      if (fs.existsSync(p)) fs.unlinkSync(p);
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

    deleteRows.rows.forEach(row => {
      const filePath = path.join(UPLOAD_DIR, path.basename(row.file_path));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });

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
    const filePath = path.join(path.resolve(UPLOAD_DIR), path.basename(file_path));
    if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'File not found on disk' }); return; }

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

    res.sendFile(filePath);
  } catch (err) {
    console.error('files preview error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
