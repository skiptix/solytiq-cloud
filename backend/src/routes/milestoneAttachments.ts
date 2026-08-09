import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { query } from '../db';
import { authenticate } from '../middleware';
import { broadcastToUser } from '../sse';
import { UPLOAD_DIR } from './files';
import { objectAccessCondition, workspaceMembersJoin } from '../objectPolicy';
import { withQuotaReservation } from '../storageQuota';
import { MILESTONE_ATTACHMENT_MAX_BYTES } from '../uploadLimits';

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `ma_${crypto.randomUUID()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: MILESTONE_ATTACHMENT_MAX_BYTES } });

const router = Router({ mergeParams: true });
router.use(authenticate);

interface AttachmentRow {
  id: string;
  milestone_id: string;
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
    milestoneId:    a.milestone_id,
    attachmentType: a.attachment_type,
    name:           a.original_name,
    mimeType:       a.mime_type,
    size:           Number(a.file_size),
    sharedFileId:   a.shared_file_id ?? null,
    createdAt:      a.created_at,
  };
}

// Only the owner of the milestone's timeline may add/remove attachments.
async function ownsMilestone(milestoneId: string, userId: string): Promise<boolean> {
  const r = await query<{ id: string }>(
    `SELECT m.id FROM milestones m JOIN timelines t ON m.timeline_id = t.id
     WHERE m.id = $1 AND t.user_id = $2`,
    [milestoneId, userId]
  );
  return r.rows.length > 0;
}

// Broader access: owner OR the milestone's timeline is visible under the SAME
// central policy (objectPolicy.ts) that gates the timeline itself. The
// pre-fix version of this check (`t.is_public = true` alone, with no
// workspace-membership or item_shares check at all) leaked every milestone
// attachment on every public timeline across the WHOLE instance — see S2 in
// CLAUDE.md's security notes and objectPolicy.test.ts's regression coverage.
export async function canAccessMilestone(milestoneId: string, userId: string): Promise<boolean> {
  const r = await query<{ id: string }>(
    `SELECT m.id FROM milestones m
     JOIN timelines t ON m.timeline_id = t.id
     ${workspaceMembersJoin('t', '$2')}
     WHERE m.id = $1 AND ${objectAccessCondition('t', 'timeline', '$2')}`,
    [milestoneId, userId]
  );
  return r.rows.length > 0;
}

// GET /api/timelines/milestones/:milestoneId/attachments
router.get('/', async (req: Request, res: Response) => {
  try {
    const { milestoneId } = req.params;
    if (!await canAccessMilestone(milestoneId, req.userId!)) {
      res.status(404).json({ error: 'Milestone not found' }); return;
    }
    const result = await query<AttachmentRow>(
      `SELECT ma.id, ma.milestone_id, ma.user_id, ma.attachment_type,
              COALESCE(ma.original_name, sf.original_name) AS original_name,
              COALESCE(ma.mime_type,     sf.mime_type)     AS mime_type,
              COALESCE(ma.file_size,     sf.file_size)     AS file_size,
              ma.file_path, ma.shared_file_id, ma.created_at
       FROM milestone_attachments ma
       LEFT JOIN shared_files sf ON ma.shared_file_id = sf.id
       WHERE ma.milestone_id = $1
         AND (
           ma.attachment_type = 'upload'
           OR ma.user_id = $2
           OR (ma.attachment_type = 'linked' AND sf.is_public = true)
         )
       ORDER BY ma.created_at ASC`,
      [milestoneId, req.userId]
    );
    res.json({ attachments: result.rows.map(sanitize) });
  } catch (err) {
    console.error('milestone attachments GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/timelines/milestones/:milestoneId/attachments  — direct upload
router.post('/', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const { milestoneId } = req.params;
    if (!await ownsMilestone(milestoneId, req.userId!)) {
      if (req.file) fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename));
      res.status(404).json({ error: 'Milestone not found' }); return;
    }
    if (!req.file) { res.status(400).json({ error: 'No file provided' }); return; }

    // SECURITY (S6): this endpoint previously had NO storage-quota check at
    // all — a user could attach unlimited 200MB files to milestones,
    // completely bypassing the 15GB-per-user cap the Files screen enforces.
    // Reused the same race-safe reservation (storageQuota.ts) that guards
    // files.ts / taskAttachments.ts.
    const id = crypto.randomUUID();
    const reservation = await withQuotaReservation(req.userId!, req.file.size, req.user?.isAdmin ?? false, (client) =>
      client.query<AttachmentRow>(
        `INSERT INTO milestone_attachments
           (id, milestone_id, user_id, attachment_type, original_name, mime_type, file_size, file_path)
         VALUES ($1,$2,$3,'upload',$4,$5,$6,$7) RETURNING *`,
        [id, milestoneId, req.userId, req.file!.originalname, req.file!.mimetype, req.file!.size, req.file!.filename]
      )
    );
    if (!reservation.ok) {
      fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename));
      res.status(413).json({ error: 'Storage quota exceeded. Please delete some files to free up space.' });
      return;
    }
    res.status(201).json({ attachment: sanitize(reservation.result.rows[0]) });
    broadcastToUser(req.userId!, 'timelines');
  } catch (err) {
    if (req.file) {
      const p = path.join(UPLOAD_DIR, req.file.filename);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    console.error('milestone attachment upload error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/timelines/milestones/:milestoneId/attachments/link  — link existing shared file
router.post('/link', async (req: Request, res: Response) => {
  try {
    const { milestoneId } = req.params;
    const { sharedFileId } = req.body as { sharedFileId?: string };
    if (!sharedFileId) { res.status(400).json({ error: 'sharedFileId required' }); return; }
    if (!await ownsMilestone(milestoneId, req.userId!)) {
      res.status(404).json({ error: 'Milestone not found' }); return;
    }

    const fileRes = await query<{ id: string; original_name: string; mime_type: string; file_size: number }>(
      `SELECT id, original_name, mime_type, file_size FROM shared_files WHERE id = $1 AND user_id = $2`,
      [sharedFileId, req.userId]
    );
    if (fileRes.rows.length === 0) { res.status(404).json({ error: 'File not found' }); return; }
    const sf = fileRes.rows[0];

    const dup = await query<{ id: string }>(
      `SELECT id FROM milestone_attachments WHERE milestone_id = $1 AND shared_file_id = $2`,
      [milestoneId, sharedFileId]
    );
    if (dup.rows.length > 0) { res.status(409).json({ error: 'File already attached' }); return; }

    const id = crypto.randomUUID();
    const result = await query<AttachmentRow>(
      `INSERT INTO milestone_attachments
         (id, milestone_id, user_id, attachment_type, original_name, mime_type, file_size, shared_file_id)
       VALUES ($1,$2,$3,'linked',$4,$5,$6,$7) RETURNING *`,
      [id, milestoneId, req.userId, sf.original_name, sf.mime_type, sf.file_size, sharedFileId]
    );
    res.status(201).json({ attachment: sanitize(result.rows[0]) });
    broadcastToUser(req.userId!, 'timelines');
  } catch (err) {
    console.error('milestone attachment link error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/timelines/milestones/:milestoneId/attachments/:attachmentId
router.delete('/:attachmentId', async (req: Request, res: Response) => {
  try {
    const { milestoneId, attachmentId } = req.params;
    const r = await query<AttachmentRow>(
      `SELECT * FROM milestone_attachments WHERE id = $1 AND milestone_id = $2 AND user_id = $3`,
      [attachmentId, milestoneId, req.userId]
    );
    if (r.rows.length === 0) { res.status(404).json({ error: 'Attachment not found' }); return; }
    const att = r.rows[0];

    await query(`DELETE FROM milestone_attachments WHERE id = $1`, [attachmentId]);

    if (att.attachment_type === 'upload' && att.file_path) {
      const filePath = path.join(path.resolve(UPLOAD_DIR), path.basename(att.file_path));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    res.json({ success: true });
    broadcastToUser(req.userId!, 'timelines');
  } catch (err) {
    console.error('milestone attachment DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/timelines/milestones/:milestoneId/attachments/:attachmentId/download
router.get('/:attachmentId/download', async (req: Request, res: Response) => {
  try {
    const { milestoneId, attachmentId } = req.params;
    if (!await canAccessMilestone(milestoneId, req.userId!)) {
      res.status(404).json({ error: 'Milestone not found' }); return;
    }
    const r = await query<AttachmentRow & { sf_file_path: string | null; sf_is_public: boolean }>(
      `SELECT ma.*, sf.file_path AS sf_file_path, sf.is_public AS sf_is_public
       FROM milestone_attachments ma
       LEFT JOIN shared_files sf ON ma.shared_file_id = sf.id
       WHERE ma.id = $1 AND ma.milestone_id = $2
         AND (
           ma.attachment_type = 'upload'
           OR ma.user_id = $3
           OR (ma.attachment_type = 'linked' AND sf.is_public = true)
         )`,
      [attachmentId, milestoneId, req.userId]
    );
    if (r.rows.length === 0) { res.status(404).json({ error: 'Attachment not found' }); return; }
    const att = r.rows[0];

    const rawPath = att.attachment_type === 'upload' ? att.file_path : att.sf_file_path;
    if (!rawPath) { res.status(404).json({ error: 'File not found' }); return; }
    const filePath = path.join(path.resolve(UPLOAD_DIR), path.basename(rawPath));
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
    console.error('milestone attachment download error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
