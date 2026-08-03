// ---------------------------------------------------------------------------
// /api/admin/ai-skills — admin management of AI Skills (Settings → AI Skills).
//
// Skills are instance-wide, not workspace-scoped, so the access model is
// simpler than most of this app's other resources: every route here is
// admin-only (authenticate + requireAdmin). Reads for the assistant itself
// (any signed-in user, enabled skills only) live elsewhere — see
// GET /api/ai/skills in routes/ai.ts, and the list_skills/read_skill AI tools
// in aiTools.ts, which additionally let an admin manage skills BY ASKING SOL,
// reusing this exact data layer (aiSkills/skills.ts).
// ---------------------------------------------------------------------------

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { authenticate, requireAdmin } from '../middleware';
import {
  listSkills, getSkill, createSkill, updateSkill, deleteSkill,
  listSkillFiles, setSkillFile, removeSkillFile, replaceSkillFiles,
  sanitizeSkill, sanitizeSkillFile,
} from '../aiSkills/skills';
import { parseSkillBundle } from '../aiSkills/bundle';
import { withTransaction } from '../db';
import type { QueryExec } from '../workspaceUtil';

const router = Router();
router.use(authenticate, requireAdmin);

// 10MB covers a generously-sized SKILL.md or a reference-file bundle; the
// zip parser enforces its own tighter uncompressed-size/entry-count caps.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/** Minimal `---\nkey: value\n---` frontmatter reader — not a general YAML
 *  parser, just enough for the single-line name/description convention
 *  SKILL.md files commonly use. Anything more structured in there is left
 *  alone (kept in the body) rather than misparsed. */
function extractFrontmatter(raw: string): { name?: string; description?: string; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (m) meta[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/, '').replace(/["']$/, '');
  }
  return { name: meta.name || undefined, description: meta.description || undefined, body: raw.slice(match[0].length) };
}

function nameFromFilename(filename: string): string {
  const base = filename.replace(/\.(md|markdown|zip)$/i, '');
  return base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase()) || 'Untitled Skill';
}

/** Parse an uploaded .md or .zip buffer into {name, description, content, files, source}. */
function parseUpload(
  buffer: Buffer,
  originalname: string,
  mimetype: string
): { ok: true; name: string; description: string; content: string; files: { path: string; content: string }[]; source: 'upload_md' | 'upload_zip'; skippedCount: number } | { ok: false; error: string } {
  const isZip = mimetype === 'application/zip' || mimetype === 'application/x-zip-compressed' || /\.zip$/i.test(originalname);
  if (isZip) {
    const parsed = parseSkillBundle(buffer);
    if (!parsed.ok) return parsed;
    const fm = extractFrontmatter(parsed.bundle.skillMd);
    if (!fm.body.trim()) return { ok: false, error: 'SKILL.md has no content after its frontmatter' };
    return {
      ok: true,
      name: fm.name || nameFromFilename(originalname),
      description: fm.description || '',
      content: fm.body.trim(),
      files: parsed.bundle.files,
      source: 'upload_zip',
      skippedCount: parsed.bundle.skippedCount,
    };
  }
  const raw = buffer.toString('utf8');
  const fm = extractFrontmatter(raw);
  if (!fm.body.trim()) return { ok: false, error: 'The file has no content after its frontmatter' };
  return {
    ok: true,
    name: fm.name || nameFromFilename(originalname),
    description: fm.description || '',
    content: fm.body.trim(),
    files: [],
    source: 'upload_md',
    skippedCount: 0,
  };
}

// GET /api/admin/ai-skills — every skill, enabled or not.
router.get('/', async (_req: Request, res: Response) => {
  try {
    const skills = await listSkills();
    res.json({ skills: skills.map(sanitizeSkill) });
  } catch (err) {
    console.error('ai-skills GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/ai-skills/:id — one skill, plus its bundled files' full content.
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const skill = await getSkill(req.params.id);
    if (!skill) { res.status(404).json({ error: 'Skill not found' }); return; }
    const files = await listSkillFiles(req.params.id);
    res.json({ skill: sanitizeSkill(skill), files: files.map(sanitizeSkillFile) });
  } catch (err) {
    console.error('ai-skills GET :id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/ai-skills — create from pasted text (no upload).
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, description, content } = req.body as { name?: string; description?: string; content?: string };
    const result = await createSkill({ name: name ?? '', description, content: content ?? '', source: 'manual', createdBy: req.userId! });
    if (!result.ok) { res.status(400).json({ error: result.error }); return; }
    res.status(201).json({ skill: sanitizeSkill(result.skill) });
  } catch (err) {
    console.error('ai-skills POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/ai-skills/upload — create from an uploaded SKILL.md or .zip bundle.
router.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'A file is required (SKILL.md or a .zip bundle)' }); return; }
    const parsed = parseUpload(req.file.buffer, req.file.originalname, req.file.mimetype);
    if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
    const overrideName = (req.body as { name?: string }).name?.trim();
    const overrideDescription = (req.body as { description?: string }).description?.trim();

    const result = await withTransaction(async (client) => {
      const exec: QueryExec = (text, params) => client.query(text, params);
      const created = await createSkill(
        { name: overrideName || parsed.name, description: overrideDescription ?? parsed.description, content: parsed.content, source: parsed.source, createdBy: req.userId! },
        exec
      );
      if (!created.ok) return created;
      if (parsed.files.length) await replaceSkillFiles(created.skill.id, parsed.files, exec);
      return created;
    });
    if (!result.ok) { res.status(400).json({ error: result.error }); return; }

    const fresh = await getSkill(result.skill.id);
    res.status(201).json({ skill: sanitizeSkill(fresh!), skippedFiles: parsed.skippedCount });
  } catch (err) {
    console.error('ai-skills POST upload error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/admin/ai-skills/:id — update metadata/content/enabled state.
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { name, description, content, enabled } = req.body as {
      name?: string; description?: string; content?: string; enabled?: boolean;
    };
    const result = await updateSkill(req.params.id, { name, description, content, enabled, updatedBy: req.userId! });
    if (!result.ok) { res.status(result.error === 'Skill not found' ? 404 : 400).json({ error: result.error }); return; }
    res.json({ skill: sanitizeSkill(result.skill) });
  } catch (err) {
    console.error('ai-skills PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/admin/ai-skills/:id/upload — replace content+files from a re-uploaded SKILL.md or .zip.
router.put('/:id/upload', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const existing = await getSkill(req.params.id);
    if (!existing) { res.status(404).json({ error: 'Skill not found' }); return; }
    if (!req.file) { res.status(400).json({ error: 'A file is required (SKILL.md or a .zip bundle)' }); return; }
    const parsed = parseUpload(req.file.buffer, req.file.originalname, req.file.mimetype);
    if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }

    const result = await withTransaction(async (client) => {
      const exec: QueryExec = (text, params) => client.query(text, params);
      const updated = await updateSkill(
        req.params.id,
        { description: parsed.description || undefined, content: parsed.content, updatedBy: req.userId! },
        exec
      );
      if (!updated.ok) return updated;
      await replaceSkillFiles(req.params.id, parsed.files, exec);
      return updated;
    });
    if (!result.ok) { res.status(400).json({ error: result.error }); return; }

    const fresh = await getSkill(req.params.id);
    const files = await listSkillFiles(req.params.id);
    res.json({ skill: sanitizeSkill(fresh!), files: files.map(sanitizeSkillFile), skippedFiles: parsed.skippedCount });
  } catch (err) {
    console.error('ai-skills PUT upload error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin/ai-skills/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const removed = await deleteSkill(req.params.id);
    if (!removed) { res.status(404).json({ error: 'Skill not found' }); return; }
    res.json({ success: true });
  } catch (err) {
    console.error('ai-skills DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/admin/ai-skills/:id/files — add/update one bundled reference file.
router.put('/:id/files', async (req: Request, res: Response) => {
  try {
    const skill = await getSkill(req.params.id);
    if (!skill) { res.status(404).json({ error: 'Skill not found' }); return; }
    const { filePath, content } = req.body as { filePath?: string; content?: string };
    if (!filePath) { res.status(400).json({ error: 'filePath is required' }); return; }
    const result = await setSkillFile(req.params.id, filePath, content ?? '');
    if (!result.ok) { res.status(400).json({ error: result.error }); return; }
    res.json({ file: sanitizeSkillFile(result.skill) });
  } catch (err) {
    console.error('ai-skills PUT files error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin/ai-skills/:id/files?filePath=...
router.delete('/:id/files', async (req: Request, res: Response) => {
  try {
    const filePath = req.query.filePath as string | undefined;
    if (!filePath) { res.status(400).json({ error: 'filePath is required' }); return; }
    const removed = await removeSkillFile(req.params.id, filePath);
    if (!removed) { res.status(404).json({ error: 'File not found' }); return; }
    res.json({ success: true });
  } catch (err) {
    console.error('ai-skills DELETE files error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
