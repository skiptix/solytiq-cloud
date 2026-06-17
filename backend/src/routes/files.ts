import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { query } from '../db';
import { authenticate } from '../middleware';
import { hashPassword } from '../auth';
import { broadcastToUser } from '../sse';
import { createUpload, UPLOAD_DIR } from '../uploadStorage';
import { sendFileDownload, resolveUploadPath } from '../fileDownload';

/** @deprecated — import UPLOAD_DIR from '../uploadStorage' instead */
export { UPLOAD_DIR };

const upload = createUpload('');

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
    size:        f.file_size,
    isPublic:    f.is_public,
    hasPassword: f.password_hash !== null,
    expiresAt:   f.expires_at ?? null,
    shareToken:  f.share_token,
    shareUrl:    `${baseUrl}/share/${f.share_token}`,
    createdAt:   f.created_at,
  };
}

const DEFAULT_QUOTA = 15 * 1024 * 1024 * 1024; // 15 GB

async function getUserQuota(): Promise<number> {
  const r = await query<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = 'storage_quota_per_user'"
  );
  return r.rows[0] ? parseInt(r.rows[0].value, 10) : DEFAULT_QUOTA;
}

// ── Authenticated routes ──────────────────────────────────────────
router.use(authenticate);

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
      'SELECT * FROM shared_files WHERE user_id = $1 ORDER BY created_at DESC',
      [req.userId]
    );
    const base = getBaseUrl(req);
    res.json({ files: result.rows.map(f => sanitizeFile(f, base)) });
  } catch (err) {
    console.error('files GET error:', err);
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

    // Enforce per-user storage quota (admins are exempt)
    const isAdmin = (req as Request & { user?: { isAdmin: boolean } }).user?.isAdmin ?? false;
    if (!isAdmin) {
      const quota = await getUserQuota();
      const usageRes = await query<{ used: string }>(
        'SELECT COALESCE(SUM(file_size), 0) AS used FROM shared_files WHERE user_id = $1',
        [req.userId]
      );
      const used = parseInt(usageRes.rows[0].used, 10);
      if (used + req.file!.size > quota) {
        fs.unlinkSync(path.join(UPLOAD_DIR, req.file!.filename));
        res.status(413).json({ error: 'Storage quota exceeded. Please delete some files to free up space.' });
        return;
      }
    }

    const id          = crypto.randomUUID();
    const shareToken  = crypto.randomBytes(24).toString('hex');
    const pwHash      = password ? await hashPassword(password) : null;
    const pub         = isPublic === 'true';
    const expiry      = expiresAt || null;

    const result = await query<FileRow>(
      `INSERT INTO shared_files
         (id, user_id, original_name, title, mime_type, file_size, file_path, is_public, password_hash, expires_at, share_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [id, req.userId, req.file.originalname, title ?? null, req.file.mimetype, req.file.size, req.file.filename, pub, pwHash, expiry, shareToken]
    );

    const base = getBaseUrl(req);
    res.status(201).json({ file: sanitizeFile(result.rows[0], base) });
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
      `UPDATE shared_files
       SET original_name = COALESCE($2, original_name),
           title         = CASE WHEN $8  THEN $9  ELSE title         END,
           note          = CASE WHEN $10 THEN $11 ELSE note          END,
           is_public     = COALESCE($3, is_public),
           password_hash = CASE WHEN $4 THEN $5 ELSE password_hash END,
           expires_at    = CASE WHEN $6 THEN $7 ELSE expires_at    END
       WHERE id = $1
       RETURNING *`,
      [id, name ?? null, isPublic ?? null, updatePw, pwHash, updateExp, expiresAt ?? null, updateTitle, title ?? null, updateNote, note ?? null]
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

    await query('DELETE FROM shared_files WHERE id = $1', [id]);

    const filePath = path.join(UPLOAD_DIR, existing.rows[0].file_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

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
    const filePath = resolveUploadPath(UPLOAD_DIR, file_path);
    if (!filePath) { res.status(404).json({ error: 'File not found on disk' }); return; }

    sendFileDownload(res, filePath, original_name, untrustedMime);
  } catch (err) {
    console.error('files preview error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
