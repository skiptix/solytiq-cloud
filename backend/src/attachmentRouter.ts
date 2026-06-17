import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { query } from './db';
import { authenticate } from './middleware';
import { broadcastToUser } from './sse';
import { createUpload, UPLOAD_DIR } from './uploadStorage';
import { sendFileDownload, resolveUploadPath } from './fileDownload';

// ── Shared types ─────────────────────────────────────────────────────────────

export interface AttachmentRow {
  id: string;
  /** task_id or milestone_id depending on the parent entity */
  parent_id: string;
  user_id: string;
  attachment_type: 'upload' | 'linked';
  original_name: string;
  mime_type: string;
  file_size: number;
  file_path: string | null;
  shared_file_id: string | null;
  created_at: string;
}

/**
 * Config for creating an attachment sub-router.
 *
 * The two concrete attachment modules (task / milestone) only differ in:
 *  - which DB table they read/write
 *  - the URL param name for the parent entity
 *  - the access-check queries (owns / canAccess)
 *  - the file-prefix for multer filenames
 *  - the sanitized JSON key for the parent id (`taskId` / `milestoneId`)
 *  - the SSE broadcast channel
 */
export interface AttachmentConfig {
  table: string;
  parentColumn: string;
  parentParam: string;
  parentIdJsonKey: string;
  filePrefix: string;
  broadcastChannel: string;
  ownsParent: (parentId: string, userId: string) => Promise<boolean>;
  canAccessParent: (parentId: string, userId: string) => Promise<boolean>;
}

function sanitize(cfg: AttachmentConfig, a: AttachmentRow) {
  return {
    id:             a.id,
    [cfg.parentIdJsonKey]: a.parent_id,
    attachmentType: a.attachment_type,
    name:           a.original_name,
    mimeType:       a.mime_type,
    size:           Number(a.file_size),
    sharedFileId:   a.shared_file_id ?? null,
    createdAt:      a.created_at,
  };
}

/**
 * Creates a Router with all four attachment endpoints
 * (GET list, POST upload, POST link, DELETE, GET download).
 */
export function createAttachmentRouter(cfg: AttachmentConfig): Router {
  const upload = createUpload(cfg.filePrefix);
  const router = Router({ mergeParams: true });
  router.use(authenticate);

  const alias = cfg.table.replace('_attachments', '').charAt(0) + 'a'; // 'ta' or 'ma'

  // GET  /:parentParam/attachments
  router.get('/', async (req: Request, res: Response) => {
    try {
      const parentId = req.params[cfg.parentParam];
      if (!await cfg.canAccessParent(parentId, req.userId!)) {
        res.status(404).json({ error: `${capitalize(cfg.parentParam)} not found` }); return;
      }
      const result = await query<AttachmentRow>(
        `SELECT ${alias}.id,
                ${alias}.${cfg.parentColumn} AS parent_id,
                ${alias}.user_id,
                ${alias}.attachment_type,
                COALESCE(${alias}.original_name, sf.original_name) AS original_name,
                COALESCE(${alias}.mime_type,     sf.mime_type)     AS mime_type,
                COALESCE(${alias}.file_size,     sf.file_size)     AS file_size,
                ${alias}.file_path, ${alias}.shared_file_id, ${alias}.created_at
         FROM ${cfg.table} ${alias}
         LEFT JOIN shared_files sf ON ${alias}.shared_file_id = sf.id
         WHERE ${alias}.${cfg.parentColumn} = $1
           AND (
             ${alias}.attachment_type = 'upload'
             OR ${alias}.user_id = $2
             OR (${alias}.attachment_type = 'linked' AND sf.is_public = true)
           )
         ORDER BY ${alias}.created_at ASC`,
        [parentId, req.userId]
      );
      res.json({ attachments: result.rows.map(r => sanitize(cfg, r)) });
    } catch (err) {
      console.error(`${cfg.table} GET error:`, err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST  /:parentParam/attachments  — direct upload
  router.post('/', upload.single('file'), async (req: Request, res: Response) => {
    try {
      const parentId = req.params[cfg.parentParam];
      if (!await cfg.ownsParent(parentId, req.userId!)) {
        if (req.file) fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename));
        res.status(404).json({ error: `${capitalize(cfg.parentParam)} not found` }); return;
      }
      if (!req.file) { res.status(400).json({ error: 'No file provided' }); return; }

      const id = crypto.randomUUID();
      const result = await query<AttachmentRow>(
        `INSERT INTO ${cfg.table}
           (id, ${cfg.parentColumn}, user_id, attachment_type, original_name, mime_type, file_size, file_path)
         VALUES ($1,$2,$3,'upload',$4,$5,$6,$7) RETURNING
           id, ${cfg.parentColumn} AS parent_id, user_id, attachment_type,
           original_name, mime_type, file_size, file_path, shared_file_id, created_at`,
        [id, parentId, req.userId, req.file.originalname, req.file.mimetype, req.file.size, req.file.filename]
      );
      res.status(201).json({ attachment: sanitize(cfg, result.rows[0]) });
      broadcastToUser(req.userId!, cfg.broadcastChannel);
    } catch (err) {
      if (req.file) {
        const p = path.join(UPLOAD_DIR, req.file.filename);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      console.error(`${cfg.table} upload error:`, err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST  /:parentParam/attachments/link  — link existing shared file
  router.post('/link', async (req: Request, res: Response) => {
    try {
      const parentId = req.params[cfg.parentParam];
      const { sharedFileId } = req.body as { sharedFileId?: string };
      if (!sharedFileId) { res.status(400).json({ error: 'sharedFileId required' }); return; }
      if (!await cfg.ownsParent(parentId, req.userId!)) {
        res.status(404).json({ error: `${capitalize(cfg.parentParam)} not found` }); return;
      }

      const fileRes = await query<{ id: string; original_name: string; mime_type: string; file_size: number }>(
        `SELECT id, original_name, mime_type, file_size FROM shared_files WHERE id = $1 AND user_id = $2`,
        [sharedFileId, req.userId]
      );
      if (fileRes.rows.length === 0) { res.status(404).json({ error: 'File not found' }); return; }
      const sf = fileRes.rows[0];

      const dup = await query<{ id: string }>(
        `SELECT id FROM ${cfg.table} WHERE ${cfg.parentColumn} = $1 AND shared_file_id = $2`,
        [parentId, sharedFileId]
      );
      if (dup.rows.length > 0) { res.status(409).json({ error: 'File already attached' }); return; }

      const id = crypto.randomUUID();
      const result = await query<AttachmentRow>(
        `INSERT INTO ${cfg.table}
           (id, ${cfg.parentColumn}, user_id, attachment_type, original_name, mime_type, file_size, shared_file_id)
         VALUES ($1,$2,$3,'linked',$4,$5,$6,$7) RETURNING
           id, ${cfg.parentColumn} AS parent_id, user_id, attachment_type,
           original_name, mime_type, file_size, file_path, shared_file_id, created_at`,
        [id, parentId, req.userId, sf.original_name, sf.mime_type, sf.file_size, sharedFileId]
      );
      res.status(201).json({ attachment: sanitize(cfg, result.rows[0]) });
      broadcastToUser(req.userId!, cfg.broadcastChannel);
    } catch (err) {
      console.error(`${cfg.table} link error:`, err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE  /:parentParam/attachments/:attachmentId
  router.delete('/:attachmentId', async (req: Request, res: Response) => {
    try {
      const parentId = req.params[cfg.parentParam];
      const { attachmentId } = req.params;
      const r = await query<{ attachment_type: string; file_path: string | null }>(
        `SELECT attachment_type, file_path FROM ${cfg.table} WHERE id = $1 AND ${cfg.parentColumn} = $2 AND user_id = $3`,
        [attachmentId, parentId, req.userId]
      );
      if (r.rows.length === 0) { res.status(404).json({ error: 'Attachment not found' }); return; }
      const att = r.rows[0];

      await query(`DELETE FROM ${cfg.table} WHERE id = $1`, [attachmentId]);

      if (att.attachment_type === 'upload' && att.file_path) {
        const filePath = path.join(path.resolve(UPLOAD_DIR), att.file_path);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }

      res.json({ success: true });
      broadcastToUser(req.userId!, cfg.broadcastChannel);
    } catch (err) {
      console.error(`${cfg.table} DELETE error:`, err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET  /:parentParam/attachments/:attachmentId/download
  router.get('/:attachmentId/download', async (req: Request, res: Response) => {
    try {
      const parentId = req.params[cfg.parentParam];
      const { attachmentId } = req.params;
      if (!await cfg.canAccessParent(parentId, req.userId!)) {
        res.status(404).json({ error: `${capitalize(cfg.parentParam)} not found` }); return;
      }
      const r = await query<{
        attachment_type: string;
        file_path: string | null;
        original_name: string;
        mime_type: string;
        sf_file_path: string | null;
        sf_is_public: boolean;
      }>(
        `SELECT ${alias}.attachment_type, ${alias}.file_path,
                ${alias}.original_name, ${alias}.mime_type,
                sf.file_path AS sf_file_path, sf.is_public AS sf_is_public
         FROM ${cfg.table} ${alias}
         LEFT JOIN shared_files sf ON ${alias}.shared_file_id = sf.id
         WHERE ${alias}.id = $1 AND ${alias}.${cfg.parentColumn} = $2
           AND (
             ${alias}.attachment_type = 'upload'
             OR ${alias}.user_id = $3
             OR (${alias}.attachment_type = 'linked' AND sf.is_public = true)
           )`,
        [attachmentId, parentId, req.userId]
      );
      if (r.rows.length === 0) { res.status(404).json({ error: 'Attachment not found' }); return; }
      const att = r.rows[0];

      const rawPath = att.attachment_type === 'upload' ? att.file_path : att.sf_file_path;
      if (!rawPath) { res.status(404).json({ error: 'File not found' }); return; }
      const filePath = resolveUploadPath(UPLOAD_DIR, rawPath);
      if (!filePath) { res.status(404).json({ error: 'File not found on disk' }); return; }

      sendFileDownload(res, filePath, att.original_name, att.mime_type);
    } catch (err) {
      console.error(`${cfg.table} download error:`, err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
