// ---------------------------------------------------------------------------
// /api/knowledge-base — the per-workspace curated dictionary.
//
// Named apart from /api/knowledge (the RAG layer: chunking, embeddings, hybrid
// search) on purpose; see knowledgeBase/entries.ts for why.
//
// Access model, stated once and applied uniformly below:
//   READ   — anyone who can access the workspace (member, owner, or public).
//   WRITE  — any MEMBER of the workspace. A workspace has exactly one Knowledge
//            Base and it is a shared artifact of that workspace, so restricting
//            authoring to whoever clicked "add" would defeat the point. This
//            mirrors the same decision made in graph/visibility.ts's
//            canWriteEntity for the two knowledge* entity types.
//   DELETE THE BASE — workspace owner or instance admin only. Removing the
//            base cascades every entry, so it is not an ordinary member action.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db';
import { authenticate } from '../middleware';
import { userCanAccessWorkspace, werr } from '../workspaceUtil';
import { broadcastToUser } from '../sse';
import { MARKDOWN_IMAGE_DIR } from './markdownLists';
import { enqueueEmbedding } from '../knowledge/queue';
import { upsertLink, deleteLinksBetween } from '../graph/links';
import {
  getBaseForWorkspace, getBaseById, createBase, updateBase, deleteBase,
  listEntries, getEntry, createEntry, updateEntry, deleteEntry,
  sanitizeBase, sanitizeEntry,
  ENTRY_TYPES, type KnowledgeBaseRow,
} from '../knowledgeBase/entries';
import { buildEntryBlocks, entryImageIds, mutateEntryBlocks } from '../knowledgeBase/blocks';
import { lookupTerm, listGlossary } from '../knowledgeBase/lookup';
import { runConceptScan, listSuggestions, decideSuggestion } from '../knowledgeBase/extract';

const router = Router();

// ---------------------------------------------------------------------------
// Access helpers
// ---------------------------------------------------------------------------

async function isWorkspaceMember(userId: string, workspaceId: string): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2
     UNION
     SELECT 1 FROM workspaces WHERE id = $1 AND owner_id = $2`,
    [workspaceId, userId]
  );
  return r.rows.length > 0;
}

async function isWorkspaceOwner(userId: string, workspaceId: string): Promise<boolean> {
  const r = await query(`SELECT 1 FROM workspaces WHERE id = $1 AND owner_id = $2`, [workspaceId, userId]);
  return r.rows.length > 0;
}

/**
 * Resolve the base an entry belongs to, plus the caller's rights over it.
 * Existence-safe: a base in a workspace the caller can't see reports as absent
 * rather than forbidden, matching the Graph Layer's 404-not-403 rule.
 */
async function resolveBaseAccess(
  userId: string,
  base: KnowledgeBaseRow | null
): Promise<{ base: KnowledgeBaseRow; canRead: boolean; canWrite: boolean } | null> {
  if (!base) return null;
  const canRead = await userCanAccessWorkspace(userId, base.workspace_id);
  if (!canRead) return null;
  const canWrite = await isWorkspaceMember(userId, base.workspace_id);
  return { base, canRead, canWrite };
}

/** Structural `entry_of` edge so an entry is reachable by graph traversal from its base. */
async function linkEntryToBase(entryId: string, baseId: string, userId: string): Promise<void> {
  try {
    await upsertLink(query, {
      srcType: 'knowledgeEntry', srcId: entryId,
      dstType: 'knowledgeBase', dstId: baseId,
      linkType: 'entry_of', origin: 'system', createdBy: userId,
    });
  } catch (err) {
    // Structural only — the entry is already saved and the Net computes its own
    // hierarchy client-side, so this never blocks a create.
    werr('knowledge-base entry_of link failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

// GET /api/knowledge-base?workspaceId= — the workspace's base + every entry.
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) { res.status(400).json({ error: 'workspaceId is required' }); return; }
    if (!(await userCanAccessWorkspace(req.userId!, workspaceId))) {
      // Not "forbidden" — a workspace you can't see is indistinguishable from one that isn't there.
      res.json({ knowledgeBase: null, entries: [] });
      return;
    }
    const base = await getBaseForWorkspace(workspaceId);
    if (!base) { res.json({ knowledgeBase: null, entries: [] }); return; }
    const entries = await listEntries(base.id);
    res.json({
      knowledgeBase: sanitizeBase(base),
      entries: entries.map(sanitizeEntry),
      canWrite: await isWorkspaceMember(req.userId!, workspaceId),
    });
  } catch (err) {
    werr('knowledge-base GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/knowledge-base — add the workspace's Knowledge Base (sidebar "add").
router.post('/', authenticate, async (req: Request, res: Response) => {
  try {
    const { workspaceId, name, emoji, color, description } = req.body as {
      workspaceId?: string; name?: string; emoji?: string | null; color?: string | null; description?: string | null;
    };
    if (!workspaceId) { res.status(400).json({ error: 'workspaceId is required' }); return; }
    if (!(await isWorkspaceMember(req.userId!, workspaceId))) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    const { base, created } = await createBase(req.userId!, workspaceId, { name, emoji, color, description });
    broadcastToUser(req.userId!, 'knowledgeBase');
    res.status(created ? 201 : 200).json({ knowledgeBase: sanitizeBase(base), created });
  } catch (err) {
    werr('knowledge-base POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/knowledge-base/:id — rename / restyle the base.
router.put('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const access = await resolveBaseAccess(req.userId!, await getBaseById(req.params.id));
    if (!access) { res.status(404).json({ error: 'Knowledge Base not found' }); return; }
    if (!access.canWrite) { res.status(403).json({ error: 'You do not have permission to edit this Knowledge Base' }); return; }
    const { name, emoji, color, description } = req.body as {
      name?: string; emoji?: string | null; color?: string | null; description?: string | null;
    };
    const updated = await updateBase(req.params.id, { name, emoji, color, description });
    if (!updated) { res.status(404).json({ error: 'Knowledge Base not found' }); return; }
    broadcastToUser(req.userId!, 'knowledgeBase');
    res.json({ knowledgeBase: sanitizeBase(updated) });
  } catch (err) {
    werr('knowledge-base PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/knowledge-base/:id — owner/admin only; cascades every entry.
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const access = await resolveBaseAccess(req.userId!, await getBaseById(req.params.id));
    if (!access) { res.status(404).json({ error: 'Knowledge Base not found' }); return; }
    const allowed = req.user?.isAdmin || (await isWorkspaceOwner(req.userId!, access.base.workspace_id));
    if (!allowed) { res.status(403).json({ error: 'Only the workspace owner can delete the Knowledge Base' }); return; }
    await deleteBase(req.params.id);
    broadcastToUser(req.userId!, 'knowledgeBase');
    res.json({ success: true });
  } catch (err) {
    werr('knowledge-base DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/** Load an entry together with its base and the caller's rights, or null. */
async function resolveEntryAccess(userId: string, entryId: string) {
  const entry = await getEntry(entryId);
  if (!entry) return null;
  const access = await resolveBaseAccess(userId, await getBaseById(entry.kb_id));
  if (!access) return null;
  return { entry, ...access };
}

// GET /api/knowledge-base/entries/:id
router.get('/entries/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const found = await resolveEntryAccess(req.userId!, req.params.id);
    if (!found) { res.status(404).json({ error: 'Entry not found' }); return; }
    res.json({ entry: sanitizeEntry(found.entry), canWrite: found.canWrite });
  } catch (err) {
    werr('knowledge-base GET entry error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/knowledge-base/:id/entries — add a term.
router.post('/:id/entries', authenticate, async (req: Request, res: Response) => {
  try {
    const access = await resolveBaseAccess(req.userId!, await getBaseById(req.params.id));
    if (!access) { res.status(404).json({ error: 'Knowledge Base not found' }); return; }
    if (!access.canWrite) { res.status(403).json({ error: 'You do not have permission to edit this Knowledge Base' }); return; }

    const body = req.body as Record<string, unknown>;
    let blocks: { id: string; type: string; [k: string]: unknown }[] | undefined;
    if (body.blocks !== undefined) {
      const built = buildEntryBlocks(body.blocks, new Set());
      if ('error' in built) { res.status(400).json({ error: built.error }); return; }
      blocks = built.blocks;
    }

    const result = await createEntry(req.userId!, access.base.id, {
      term: String(body.term ?? ''),
      aliases: body.aliases,
      entryType: body.entryType as string | undefined,
      summary: (body.summary as string | null | undefined) ?? null,
      properties: (body.properties as Record<string, unknown> | undefined) ?? {},
      emoji: (body.emoji as string | null | undefined) ?? null,
      color: (body.color as string | null | undefined) ?? null,
      ...(blocks ? { content: { version: 1 as const, blocks } } : {}),
    });
    if (!result.ok) { res.status(result.conflict ? 409 : 400).json({ error: result.error }); return; }

    await linkEntryToBase(result.entry.id, access.base.id, req.userId!);
    await enqueueEmbedding('knowledgeEntry', result.entry.id, access.base.workspace_id);
    broadcastToUser(req.userId!, 'knowledgeBase');
    res.status(201).json({ entry: sanitizeEntry(result.entry) });
  } catch (err) {
    werr('knowledge-base POST entry error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/knowledge-base/entries/:id — metadata fields (not blocks).
router.put('/entries/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const found = await resolveEntryAccess(req.userId!, req.params.id);
    if (!found) { res.status(404).json({ error: 'Entry not found' }); return; }
    if (!found.canWrite) { res.status(403).json({ error: 'You do not have permission to edit this Knowledge Base' }); return; }

    const body = req.body as Record<string, unknown>;
    const result = await updateEntry(req.params.id, {
      term: body.term as string | undefined,
      aliases: body.aliases,
      entryType: body.entryType as string | undefined,
      summary: body.summary as string | null | undefined,
      properties: body.properties as Record<string, unknown> | undefined,
      emoji: body.emoji as string | null | undefined,
      color: body.color as string | null | undefined,
      position: body.position as number | undefined,
    });
    if (!result.ok) { res.status(result.conflict ? 409 : 400).json({ error: result.error }); return; }

    // The term IS the searchable content of an entry, so a rename has to
    // re-enter the embedding queue just like a body edit does.
    await enqueueEmbedding('knowledgeEntry', req.params.id, found.base.workspace_id);
    broadcastToUser(req.userId!, 'knowledgeBase');
    res.json({ entry: sanitizeEntry(result.entry) });
  } catch (err) {
    werr('knowledge-base PUT entry error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/knowledge-base/entries/:id/content — replace the entry's blocks.
router.put('/entries/:id/content', authenticate, async (req: Request, res: Response) => {
  try {
    const found = await resolveEntryAccess(req.userId!, req.params.id);
    if (!found) { res.status(404).json({ error: 'Entry not found' }); return; }
    if (!found.canWrite) { res.status(403).json({ error: 'You do not have permission to edit this Knowledge Base' }); return; }

    const raw = (req.body as { content?: { blocks?: unknown }; blocks?: unknown });
    const specs = raw.blocks ?? raw.content?.blocks;
    const existingImages = await entryImageIds(req.params.id);
    const built = buildEntryBlocks(specs, existingImages);
    if ('error' in built) { res.status(400).json({ error: built.error }); return; }

    const result = await mutateEntryBlocks(
      req.userId!, req.params.id, found.base.workspace_id, () => built.blocks
    );
    if (!result.ok) { res.status(400).json({ error: result.error }); return; }
    broadcastToUser(req.userId!, 'knowledgeBase');
    res.json({ entry: sanitizeEntry(result.entry) });
  } catch (err) {
    werr('knowledge-base PUT entry content error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/knowledge-base/entries/:id
router.delete('/entries/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const found = await resolveEntryAccess(req.userId!, req.params.id);
    if (!found) { res.status(404).json({ error: 'Entry not found' }); return; }
    if (!found.canWrite) { res.status(403).json({ error: 'You do not have permission to edit this Knowledge Base' }); return; }
    // entity_links cascades through entity_index's composite FK, and
    // entity_chunks through its own — nothing to clean up by hand here.
    await deleteEntry(req.params.id);
    broadcastToUser(req.userId!, 'knowledgeBase');
    res.json({ success: true });
  } catch (err) {
    werr('knowledge-base DELETE entry error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/knowledge-base/entries/:id/relations — link two entries (or an
// entry to anything else) with one of the glossary relation types.
router.post('/entries/:id/relations', authenticate, async (req: Request, res: Response) => {
  try {
    const found = await resolveEntryAccess(req.userId!, req.params.id);
    if (!found) { res.status(404).json({ error: 'Entry not found' }); return; }
    if (!found.canWrite) { res.status(403).json({ error: 'You do not have permission to edit this Knowledge Base' }); return; }

    const { targetType, targetId, linkType } = req.body as { targetType?: string; targetId?: string; linkType?: string };
    if (!targetType || !targetId) { res.status(400).json({ error: 'targetType and targetId are required' }); return; }
    await upsertLink(query, {
      srcType: 'knowledgeEntry', srcId: req.params.id,
      dstType: targetType, dstId: targetId,
      linkType: linkType || 'relates_to', origin: 'manual', createdBy: req.userId!,
    });
    broadcastToUser(req.userId!, 'knowledgeBase');
    res.status(201).json({ success: true });
  } catch (err) {
    werr('knowledge-base POST relation error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not create that relation' });
  }
});

// DELETE /api/knowledge-base/entries/:id/relations
router.delete('/entries/:id/relations', authenticate, async (req: Request, res: Response) => {
  try {
    const found = await resolveEntryAccess(req.userId!, req.params.id);
    if (!found) { res.status(404).json({ error: 'Entry not found' }); return; }
    if (!found.canWrite) { res.status(403).json({ error: 'You do not have permission to edit this Knowledge Base' }); return; }
    const targetType = req.query.targetType as string | undefined;
    const targetId = req.query.targetId as string | undefined;
    const linkType = req.query.linkType as string | undefined;
    if (!targetType || !targetId) { res.status(400).json({ error: 'targetType and targetId are required' }); return; }
    await deleteLinksBetween(
      query,
      { entityType: 'knowledgeEntry', entityId: req.params.id },
      { entityType: targetType, entityId: targetId },
      linkType
    );
    broadcastToUser(req.userId!, 'knowledgeBase');
    res.json({ success: true });
  } catch (err) {
    werr('knowledge-base DELETE relation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Lookup — the dictionary surface (also exposed to AI/MCP via aiTools.ts)
// ---------------------------------------------------------------------------

// GET /api/knowledge-base/lookup?workspaceId=&term=
router.get('/lookup', authenticate, async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    const term = req.query.term as string | undefined;
    if (!workspaceId || !term) { res.status(400).json({ error: 'workspaceId and term are required' }); return; }
    if (!(await userCanAccessWorkspace(req.userId!, workspaceId))) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(await lookupTerm(workspaceId, term));
  } catch (err) {
    werr('knowledge-base lookup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/knowledge-base/glossary?workspaceId= — terms only, no bodies.
router.get('/glossary', authenticate, async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) { res.status(400).json({ error: 'workspaceId is required' }); return; }
    if (!(await userCanAccessWorkspace(req.userId!, workspaceId))) { res.json({ terms: [] }); return; }
    res.json({ terms: await listGlossary(workspaceId) });
  } catch (err) {
    werr('knowledge-base glossary error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/knowledge-base/entry-types — catalog for the inspector's dropdown.
router.get('/entry-types', authenticate, (_req: Request, res: Response) => {
  res.json({ entryTypes: ENTRY_TYPES });
});

// ---------------------------------------------------------------------------
// Suggestions (suggest-only concept extraction)
// ---------------------------------------------------------------------------

// POST /api/knowledge-base/:id/scan — propose candidate terms from workspace content.
router.post('/:id/scan', authenticate, async (req: Request, res: Response) => {
  try {
    const access = await resolveBaseAccess(req.userId!, await getBaseById(req.params.id));
    if (!access) { res.status(404).json({ error: 'Knowledge Base not found' }); return; }
    if (!access.canWrite) { res.status(403).json({ error: 'You do not have permission to edit this Knowledge Base' }); return; }
    const result = await runConceptScan(req.userId!, access.base);
    broadcastToUser(req.userId!, 'knowledgeBase');
    res.json(result);
  } catch (err) {
    werr('knowledge-base scan error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/knowledge-base/:id/suggestions
router.get('/:id/suggestions', authenticate, async (req: Request, res: Response) => {
  try {
    const access = await resolveBaseAccess(req.userId!, await getBaseById(req.params.id));
    if (!access) { res.status(404).json({ error: 'Knowledge Base not found' }); return; }
    res.json({ suggestions: await listSuggestions(access.base.id) });
  } catch (err) {
    werr('knowledge-base suggestions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/knowledge-base/suggestions/:suggestionId — { accept: boolean }
router.post('/suggestions/:suggestionId', authenticate, async (req: Request, res: Response) => {
  try {
    const sug = await query(`SELECT * FROM knowledge_suggestions WHERE id = $1`, [req.params.suggestionId]);
    const row = sug.rows[0] as { id: string; kb_id: string } | undefined;
    if (!row) { res.status(404).json({ error: 'Suggestion not found' }); return; }
    const access = await resolveBaseAccess(req.userId!, await getBaseById(row.kb_id));
    if (!access) { res.status(404).json({ error: 'Suggestion not found' }); return; }
    if (!access.canWrite) { res.status(403).json({ error: 'You do not have permission to edit this Knowledge Base' }); return; }

    const accept = (req.body as { accept?: boolean }).accept === true;
    const result = await decideSuggestion(req.userId!, access.base, req.params.suggestionId, accept);
    if (!result.ok) { res.status(400).json({ error: result.error }); return; }
    if (result.entry) await linkEntryToBase(result.entry.id, access.base.id, req.userId!);
    broadcastToUser(req.userId!, 'knowledgeBase');
    res.json({ entry: result.entry ? sanitizeEntry(result.entry) : null });
  } catch (err) {
    werr('knowledge-base suggestion decision error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Entry images — same store and directory as Markdown Page images, owned
// polymorphically. Kept here rather than in markdownLists.ts so each feature's
// access checks live with its own routes.
// ---------------------------------------------------------------------------

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const uploadImage = multer({
  storage: multer.diskStorage({
    destination: MARKDOWN_IMAGE_DIR,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, IMAGE_MIME_TYPES.has(file.mimetype)),
});

// POST /api/knowledge-base/entries/:id/images
router.post('/entries/:id/images', authenticate, uploadImage.single('image'), async (req: Request, res: Response) => {
  const cleanup = () => {
    if (req.file) { try { fs.unlinkSync(path.join(MARKDOWN_IMAGE_DIR, req.file.filename)); } catch { /* best-effort */ } }
  };
  try {
    if (!req.file) { res.status(400).json({ error: 'An image file is required (PNG, JPEG, WEBP or GIF)' }); return; }
    const found = await resolveEntryAccess(req.userId!, req.params.id);
    if (!found) { cleanup(); res.status(404).json({ error: 'Entry not found' }); return; }
    if (!found.canWrite) { cleanup(); res.status(403).json({ error: 'You do not have permission to edit this Knowledge Base' }); return; }

    const id = `kbimg_${uuidv4()}`;
    await query(
      `INSERT INTO markdown_list_images (id, user_id, markdown_list_id, owner_type, owner_id, original_name, mime_type, file_size, file_path)
       VALUES ($1, $2, NULL, 'knowledgeEntry', $3, $4, $5, $6, $7)`,
      [id, req.userId!, req.params.id, req.file.originalname, req.file.mimetype, req.file.size, req.file.filename]
    );
    res.status(201).json({ image: { id, name: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size } });
  } catch (err) {
    cleanup();
    werr('knowledge-base image upload error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/knowledge-base/entries/:id/images/:imageId
// `<img>` can't send an Authorization header, so `authenticate` here also
// accepts a `?token=` query param (same accommodation the Markdown Page image
// route makes — see routes/markdownLists.ts).
router.get('/entries/:id/images/:imageId', authenticate, async (req: Request, res: Response) => {
  try {
    const found = await resolveEntryAccess(req.userId!, req.params.id);
    if (!found) { res.status(404).json({ error: 'Not found' }); return; }
    const r = await query(
      `SELECT file_path, mime_type FROM markdown_list_images
        WHERE id = $1 AND owner_type = 'knowledgeEntry' AND owner_id = $2`,
      [req.params.imageId, req.params.id]
    );
    const img = r.rows[0] as { file_path: string; mime_type: string } | undefined;
    if (!img) { res.status(404).json({ error: 'Not found' }); return; }
    // basename() keeps a crafted file_path from escaping the upload dir.
    const filePath = path.join(path.resolve(MARKDOWN_IMAGE_DIR), path.basename(img.file_path));
    if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'Not found' }); return; }
    res.setHeader('Content-Type', img.mime_type);
    res.sendFile(filePath);
  } catch (err) {
    werr('knowledge-base image serve error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
