import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { query } from '../db';
import { authenticate } from '../middleware';
import { broadcastToUser } from '../sse';
import { UPLOAD_DIR } from './files';

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `ta_${crypto.randomUUID()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

const router = Router({ mergeParams: true });
router.use(authenticate);

interface AttachmentRow {
  id: string;
  task_id: string;
  user_id: string;
  attachment_type: 'upload' | 'linked';
  original_name: string;
  mime_type: string;
  file_size: number;
  file_path: string | null;
  shared_file_id: string | null;
  created_at: string;
}

function sanitize(a: AttachmentRow) {
  return {
    id:             a.id,
    taskId:         a.task_id,
    attachmentType: a.attachment_type,
    name:           a.original_name,
    mimeType:       a.mime_type,
    size:           Number(a.file_size),
    sharedFileId:   a.shared_file_id ?? null,
    createdAt:      a.created_at,
  };
}

async function ownsTask(taskId: string, userId: string): Promise<boolean> {
  const r = await query<{ id: string }>(
    `SELECT id FROM tasks WHERE id = $1 AND user_id = $2`,
    [taskId, userId]
  );
  return r.rows.length > 0;
}

// GET /api/tasks/:taskId/attachments
router.get('/', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    if (!await ownsTask(taskId, req.userId!)) {
      res.status(404).json({ error: 'Task not found' }); return;
    }
    const result = await query<AttachmentRow>(
      `SELECT ta.id, ta.task_id, ta.user_id, ta.attachment_type,
              COALESCE(ta.original_name, sf.original_name) AS original_name,
              COALESCE(ta.mime_type,     sf.mime_type)     AS mime_type,
              COALESCE(ta.file_size,     sf.file_size)     AS file_size,
              ta.file_path, ta.shared_file_id, ta.created_at
       FROM task_attachments ta
       LEFT JOIN shared_files sf ON ta.shared_file_id = sf.id
       WHERE ta.task_id = $1 AND ta.user_id = $2
       ORDER BY ta.created_at ASC`,
      [taskId, req.userId]
    );
    res.json({ attachments: result.rows.map(sanitize) });
  } catch (err) {
    console.error('task attachments GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/tasks/:taskId/attachments  — direct upload
router.post('/', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    if (!await ownsTask(taskId, req.userId!)) {
      if (req.file) fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename));
      res.status(404).json({ error: 'Task not found' }); return;
    }
    if (!req.file) { res.status(400).json({ error: 'No file provided' }); return; }

    const id = crypto.randomUUID();
    const result = await query<AttachmentRow>(
      `INSERT INTO task_attachments
         (id, task_id, user_id, attachment_type, original_name, mime_type, file_size, file_path)
       VALUES ($1,$2,$3,'upload',$4,$5,$6,$7) RETURNING *`,
      [id, taskId, req.userId, req.file.originalname, req.file.mimetype, req.file.size, req.file.filename]
    );
    res.status(201).json({ attachment: sanitize(result.rows[0]) });
    broadcastToUser(req.userId!, 'tasks');
  } catch (err) {
    if (req.file) {
      const p = path.join(UPLOAD_DIR, req.file.filename);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    console.error('task attachment upload error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/tasks/:taskId/attachments/link  — link existing shared file
router.post('/link', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const { sharedFileId } = req.body as { sharedFileId?: string };
    if (!sharedFileId) { res.status(400).json({ error: 'sharedFileId required' }); return; }
    if (!await ownsTask(taskId, req.userId!)) {
      res.status(404).json({ error: 'Task not found' }); return;
    }

    const fileRes = await query<{ id: string; original_name: string; mime_type: string; file_size: number }>(
      `SELECT id, original_name, mime_type, file_size FROM shared_files WHERE id = $1 AND user_id = $2`,
      [sharedFileId, req.userId]
    );
    if (fileRes.rows.length === 0) { res.status(404).json({ error: 'File not found' }); return; }
    const sf = fileRes.rows[0];

    const dup = await query<{ id: string }>(
      `SELECT id FROM task_attachments WHERE task_id = $1 AND shared_file_id = $2`,
      [taskId, sharedFileId]
    );
    if (dup.rows.length > 0) { res.status(409).json({ error: 'File already attached' }); return; }

    const id = crypto.randomUUID();
    const result = await query<AttachmentRow>(
      `INSERT INTO task_attachments
         (id, task_id, user_id, attachment_type, original_name, mime_type, file_size, shared_file_id)
       VALUES ($1,$2,$3,'linked',$4,$5,$6,$7) RETURNING *`,
      [id, taskId, req.userId, sf.original_name, sf.mime_type, sf.file_size, sharedFileId]
    );
    res.status(201).json({ attachment: sanitize(result.rows[0]) });
    broadcastToUser(req.userId!, 'tasks');
  } catch (err) {
    console.error('task attachment link error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/tasks/:taskId/attachments/:attachmentId
router.delete('/:attachmentId', async (req: Request, res: Response) => {
  try {
    const { taskId, attachmentId } = req.params;
    const r = await query<AttachmentRow>(
      `SELECT * FROM task_attachments WHERE id = $1 AND task_id = $2 AND user_id = $3`,
      [attachmentId, taskId, req.userId]
    );
    if (r.rows.length === 0) { res.status(404).json({ error: 'Attachment not found' }); return; }
    const att = r.rows[0];

    await query(`DELETE FROM task_attachments WHERE id = $1`, [attachmentId]);

    if (att.attachment_type === 'upload' && att.file_path) {
      const filePath = path.join(path.resolve(UPLOAD_DIR), att.file_path);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    res.json({ success: true });
    broadcastToUser(req.userId!, 'tasks');
  } catch (err) {
    console.error('task attachment DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/tasks/:taskId/attachments/:attachmentId/download
router.get('/:attachmentId/download', async (req: Request, res: Response) => {
  try {
    const { taskId, attachmentId } = req.params;
    const r = await query<AttachmentRow & { sf_file_path: string | null; sf_is_public: boolean }>(
      `SELECT ta.*, sf.file_path AS sf_file_path, sf.is_public AS sf_is_public
       FROM task_attachments ta
       LEFT JOIN shared_files sf ON ta.shared_file_id = sf.id
       WHERE ta.id = $1 AND ta.task_id = $2 AND ta.user_id = $3`,
      [attachmentId, taskId, req.userId]
    );
    if (r.rows.length === 0) { res.status(404).json({ error: 'Attachment not found' }); return; }
    const att = r.rows[0];

    const rawPath = att.attachment_type === 'upload' ? att.file_path : att.sf_file_path;
    if (!rawPath) { res.status(404).json({ error: 'File not found' }); return; }
    const filePath = path.join(path.resolve(UPLOAD_DIR), rawPath);
    if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'File not found on disk' }); return; }

    const safeMimes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'text/plain'];
    const isSafe = safeMimes.includes(att.mime_type);
    const sanitizedName = att.original_name.replace(/[^\w\s\-_.]/g, '_');

    res.setHeader('Content-Disposition', `${isSafe ? 'inline' : 'attachment'}; filename="${encodeURIComponent(sanitizedName)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', isSafe ? att.mime_type : 'application/octet-stream');
    if (isSafe) res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data: blob:;");
    res.sendFile(filePath);
  } catch (err) {
    console.error('task attachment download error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
