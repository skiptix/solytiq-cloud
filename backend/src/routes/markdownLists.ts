import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto, { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db';
import { authenticate } from '../middleware';
import { verifyToken, hashPassword } from '../auth';
import { broadcastToUser } from '../sse';
import { resolveWorkspaceForUser, wlog, werr, QueryExec } from '../workspaceUtil';
import { checkVersionConflict } from '../concurrency';
import { softDeleteListTreeExec } from '../trashUtil';
import { createListTask, updateListTaskFields, deleteTaskRow } from './lists';
import { UPLOAD_DIR } from './files';
import type { MutationActor } from '../automationEngine';

const router = Router();
// Every route requires auth EXCEPT the image-serve GET below, which does its
// own token check (header OR `?token=` query param) because `<img>` tags
// can't set an Authorization header — see that handler for details. So
// `authenticate` is applied per-route rather than globally via `router.use`.

// ---------------------------------------------------------------------------
// Dedicated inline-image store for `/image` blocks — deliberately separate
// from shared_files: doesn't count against the user's storage quota and isn't
// reachable via /api/share/:token. Own disk dir (a subdir of the same
// UPLOAD_DIR files.ts uses), own table, own auth-gated serve route below.
// ---------------------------------------------------------------------------

export const MARKDOWN_IMAGE_DIR = path.join(UPLOAD_DIR, 'markdown-images');
if (!fs.existsSync(MARKDOWN_IMAGE_DIR)) fs.mkdirSync(MARKDOWN_IMAGE_DIR, { recursive: true });

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const imageStorage = multer.diskStorage({
  destination: MARKDOWN_IMAGE_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});
const uploadImage = multer({
  storage: imageStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, IMAGE_MIME_TYPES.has(file.mimetype)),
});

// ---------------------------------------------------------------------------
// Row types + content shape
// ---------------------------------------------------------------------------

interface MarkdownListRow {
  id: string;
  user_id: string;
  name: string;
  emoji: string | null;
  color: string | null;
  color_bg: string | null;
  subtitle: string | null;
  is_public: boolean;
  folder_id: string | null;
  workspace_id: string | null;
  position: number;
  content: MarkdownListContent;
  todo_list_id: string | null;
  version: number;
  share_token: string | null;
  share_enabled: boolean;
  share_password_hash: string | null;
  share_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MarkdownBlockLike {
  id: string;
  type: string;
  [key: string]: unknown;
}

interface MarkdownListContent {
  version: 1;
  blocks: MarkdownBlockLike[];
}

function normalizeContent(raw: unknown): MarkdownListContent {
  if (raw && typeof raw === 'object' && Array.isArray((raw as MarkdownListContent).blocks)) {
    return { version: 1, blocks: (raw as MarkdownListContent).blocks };
  }
  return { version: 1, blocks: [] };
}

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------

function sanitize(row: MarkdownListRow) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    emoji: row.emoji,
    color: row.color,
    colorBg: row.color_bg,
    subtitle: row.subtitle,
    isPublic: row.is_public,
    folderId: row.folder_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    position: row.position,
    content: normalizeContent(row.content),
    todoListId: row.todo_list_id,
    version: row.version ?? 1,
    shareEnabled: row.share_enabled ?? false,
    shareToken: row.share_token ?? null,
    shareHasPassword: row.share_password_hash != null,
    shareExpiresAt: row.share_expires_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Overlay live `checked` state from each list's linked Todo tasks onto its
 * `/todo` blocks — the task row is the source of truth for checked (it can
 * be toggled either from the doc or directly from the generated Todo list's
 * normal ListScreen view), so reads always reconcile before returning.
 */
async function hydrateTodoChecked(rows: MarkdownListRow[]) {
  const todoListIds = [...new Set(rows.map((r) => r.todo_list_id).filter((x): x is string => !!x))];
  const checkedByTaskId: Record<string, boolean> = {};
  if (todoListIds.length > 0) {
    const tasksRes = await query<{ id: string; checked: boolean }>(
      `SELECT id, checked FROM tasks WHERE list_id = ANY($1::varchar[]) AND source = 'list'`,
      [todoListIds]
    );
    for (const t of tasksRes.rows) checkedByTaskId[String(t.id)] = t.checked;
  }
  return rows.map((row) => {
    const base = sanitize(row);
    const blocks = base.content.blocks.map((b) => {
      if (b.type === 'todo' && typeof b.taskId === 'string' && b.taskId in checkedByTaskId) {
        return { ...b, checked: checkedByTaskId[b.taskId] };
      }
      return b;
    });
    return { ...base, content: { version: 1 as const, blocks } };
  });
}

const ACCESS_CONDITION = `(
  m.user_id = $1
  OR (m.is_public = true AND (
    wm.user_id = $1
    OR m.workspace_id IS NULL
    OR EXISTS (SELECT 1 FROM workspaces w WHERE w.id = m.workspace_id AND w.visibility = 'public')
  ))
)`;

export async function buildMarkdownListsForUser(userId: string, workspaceId?: string) {
  const params: unknown[] = [userId];
  const wsFilter = workspaceId ? `AND (m.workspace_id = $2 OR m.workspace_id IS NULL)` : '';
  if (workspaceId) params.push(workspaceId);
  const result = await query<MarkdownListRow>(
    `SELECT m.* FROM markdown_lists m
     LEFT JOIN workspace_members wm ON wm.workspace_id = m.workspace_id AND wm.user_id = $1
     WHERE ${ACCESS_CONDITION} ${wsFilter}
     ORDER BY m.position ASC, m.created_at ASC`,
    params
  );
  return hydrateTodoChecked(result.rows);
}

export async function getMarkdownListForUser(userId: string, id: string) {
  const result = await query<MarkdownListRow>(
    `SELECT m.* FROM markdown_lists m
     LEFT JOIN workspace_members wm ON wm.workspace_id = m.workspace_id AND wm.user_id = $1
     WHERE m.id = $2 AND ${ACCESS_CONDITION}`,
    [userId, id]
  );
  if (result.rows.length === 0) return null;
  const [hydrated] = await hydrateTodoChecked(result.rows);
  return hydrated;
}

// ---------------------------------------------------------------------------
// Todo sub-list reconciliation — see CLAUDE.md "Automation Hub" MutationActor
// convention: every write here is tagged `{type:'user', userId}` so it goes
// through the exact same path (and can fire the exact same triggers) as a
// user editing the generated Todo list directly.
// ---------------------------------------------------------------------------

export async function reconcileTodoBlocks(
  exec: QueryExec,
  userId: string,
  markdownList: { id: string; name: string; workspaceId: string | null; todoListId: string | null },
  blocks: MarkdownBlockLike[]
): Promise<{ blocks: MarkdownBlockLike[]; todoListId: string | null }> {
  const actor: MutationActor = { type: 'user', userId };
  let todoListId = markdownList.todoListId;
  const todoBlocks = blocks.filter((b) => b.type === 'todo');

  if (todoBlocks.length === 0) {
    // No todos left in the doc — clear out any stale tasks but keep the list
    // itself around (it may still be referenced/browsed).
    if (todoListId) {
      const existing = await exec(`SELECT id FROM tasks WHERE list_id = $1 AND source = 'list'`, [todoListId]);
      for (const row of existing.rows as Array<{ id: string }>) {
        await deleteTaskRow(exec, todoListId, row.id);
      }
    }
    return { blocks, todoListId };
  }

  if (!todoListId) {
    todoListId = `list_${uuidv4()}`;
    const posResult = await exec(`SELECT MAX(position) AS max FROM lists WHERE user_id = $1`, [userId]);
    const maxPos = (posResult.rows[0] as { max: string | null }).max;
    const nextPos = maxPos !== null ? parseInt(maxPos, 10) + 1 : 0;
    await exec(
      `INSERT INTO lists (id, user_id, name, emoji, position, workspace_id, view_mode)
       VALUES ($1, $2, $3, '✅', $4, $5, 'list')`,
      [todoListId, userId, `${markdownList.name} — Todos`, nextPos, markdownList.workspaceId]
    );
    await exec(`INSERT INTO sections (id, list_id, label, position) VALUES ($1, $2, 'Todos', 0)`, [`section_${uuidv4()}`, todoListId]);
  }

  const sectionRes = await exec(`SELECT id FROM sections WHERE list_id = $1 ORDER BY position ASC LIMIT 1`, [todoListId]);
  const sectionId = (sectionRes.rows[0] as { id: string } | undefined)?.id ?? null;

  const existingTasksRes = await exec(`SELECT id FROM tasks WHERE list_id = $1 AND source = 'list'`, [todoListId]);
  const existingTaskIds = new Set((existingTasksRes.rows as Array<{ id: string }>).map((r) => String(r.id)));
  const keptTaskIds = new Set<string>();

  const resultBlocks: MarkdownBlockLike[] = [];
  for (const block of blocks) {
    if (block.type !== 'todo') { resultBlocks.push(block); continue; }
    const text = typeof block.text === 'string' && block.text.trim() ? block.text : 'Untitled';
    const wantChecked = block.checked === true;
    let taskId = typeof block.taskId === 'string' && existingTaskIds.has(block.taskId) ? block.taskId : null;

    if (!taskId && sectionId) {
      const created = await createListTask(exec, todoListId, sectionId, userId, { title: text }, actor);
      if (created) {
        taskId = String(created.task.id);
        if (wantChecked) {
          await updateListTaskFields(exec, todoListId, taskId, { checked: true, updateLinkedList: false }, actor);
        }
      }
    } else if (taskId) {
      await updateListTaskFields(exec, todoListId, taskId, { title: text, checked: wantChecked, updateLinkedList: false }, actor);
    }

    if (taskId) keptTaskIds.add(taskId);
    resultBlocks.push({ ...block, taskId });
  }

  for (const existingId of existingTaskIds) {
    if (!keptTaskIds.has(existingId)) await deleteTaskRow(exec, todoListId, existingId);
  }

  return { blocks: resultBlocks, todoListId };
}

/** Remove markdown_list_images rows (+ disk files) no longer referenced by any `image` block. */
async function pruneUnreferencedImages(exec: QueryExec, markdownListId: string, blocks: MarkdownBlockLike[]): Promise<void> {
  const referenced = new Set(blocks.filter((b) => b.type === 'image' && typeof b.imageId === 'string').map((b) => b.imageId as string));
  const existing = await exec(`SELECT id, file_path FROM markdown_list_images WHERE markdown_list_id = $1`, [markdownListId]);
  for (const img of existing.rows as Array<{ id: string; file_path: string }>) {
    if (referenced.has(img.id)) continue;
    await exec(`DELETE FROM markdown_list_images WHERE id = $1`, [img.id]);
    const p = path.join(MARKDOWN_IMAGE_DIR, path.basename(img.file_path));
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* best-effort cleanup */ } }
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

// GET /api/markdown-lists?workspaceId=
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    const lists = await buildMarkdownListsForUser(req.userId!, workspaceId);
    res.json({ markdownLists: lists });
  } catch (err) {
    werr('markdown-lists GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/markdown-lists/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const list = await getMarkdownListForUser(req.userId!, req.params.id);
    if (!list) { res.status(404).json({ error: 'Markdown list not found' }); return; }
    res.json({ markdownList: list });
  } catch (err) {
    werr('markdown-lists GET :id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/markdown-lists
router.post('/', authenticate, async (req: Request, res: Response) => {
  try {
    const { id, name, emoji, color, colorBg, subtitle, isPublic, folderId, workspaceId } = req.body as {
      id?: string; name?: string; emoji?: string; color?: string; colorBg?: string; subtitle?: string;
      isPublic?: boolean; folderId?: string; workspaceId?: string;
    };
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }

    const listId = id ?? `mdlist_${uuidv4()}`;
    const resolvedWs = await resolveWorkspaceForUser(req.userId!, workspaceId);

    const posResult = await query<{ max: string | null }>('SELECT MAX(position) AS max FROM markdown_lists WHERE user_id = $1', [req.userId]);
    const nextPos = posResult.rows[0].max !== null ? parseInt(posResult.rows[0].max, 10) + 1 : 0;

    const result = await query<MarkdownListRow>(
      `INSERT INTO markdown_lists (id, user_id, name, emoji, color, color_bg, subtitle, is_public, folder_id, workspace_id, position, content)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [listId, req.userId, name, emoji ?? null, color ?? null, colorBg ?? null, subtitle ?? null, isPublic ?? false,
        folderId ?? null, resolvedWs, nextPos, JSON.stringify({ version: 1, blocks: [] })]
    );

    wlog(`markdown-list CREATE ✓ id=${result.rows[0].id} owner=${req.userId} workspace=${resolvedWs}`);
    res.status(201).json({ markdownList: sanitize(result.rows[0]) });
    broadcastToUser(req.userId!, 'markdownLists');
  } catch (err) {
    werr('markdown-lists POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/markdown-lists/:id — metadata and/or content. When `content` is
// present, every `/todo` block is reconciled against the auto-managed Todo
// list (created lazily on first use) and every `/image` block no longer
// present triggers cleanup of its stored file.
router.put('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, emoji, color, colorBg, subtitle, isPublic, folderId, position, content, expectedVersion } = req.body as {
      name?: string; emoji?: string; color?: string; colorBg?: string; subtitle?: string;
      isPublic?: boolean; folderId?: string | null; position?: number;
      content?: MarkdownListContent; expectedVersion?: number;
    };

    const existing = await query<MarkdownListRow>('SELECT * FROM markdown_lists WHERE id = $1', [id]);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'Markdown list not found' }); return; }
    const row = existing.rows[0];
    const isOwner = row.user_id === req.userId;
    if (!isOwner && !req.user?.isAdmin) { res.status(403).json({ error: 'Permission denied' }); return; }

    const conflict = await checkVersionConflict('markdown_lists', id, expectedVersion);
    if (conflict !== null) {
      res.status(409).json({ error: 'version_conflict', markdownList: await getMarkdownListForUser(req.userId!, id) });
      return;
    }

    const updateFolderId = 'folderId' in req.body;

    // The whole read-reconcile-write sequence runs inside ONE transaction,
    // locking this row with SELECT ... FOR UPDATE before deciding anything.
    // Without this, two concurrent PUTs (e.g. a debounced content autosave
    // racing an immediate todo-checkbox save) can each read the same stale
    // todo_list_id, independently decide to lazily create a new Todo list,
    // and then each overwrite the other's write — silently orphaning
    // whichever Todo list lost the race instead of reusing it.
    const { result, newTodoListId, priorTodoListId } = await withTransaction(async (client) => {
      const exec: QueryExec = (text, params) => client.query(text, params);
      const lockedRes = await exec('SELECT * FROM markdown_lists WHERE id = $1 FOR UPDATE', [id]);
      const locked = lockedRes.rows[0] as unknown as MarkdownListRow;

      let todoListId = locked.todo_list_id;
      let contentJson: string | null = null;
      if (content) {
        const incomingBlocks = normalizeContent(content).blocks;
        await pruneUnreferencedImages(exec, id, incomingBlocks);
        const reconciled = await reconcileTodoBlocks(exec, req.userId!, {
          id: locked.id, name: name ?? locked.name, workspaceId: locked.workspace_id, todoListId: locked.todo_list_id,
        }, incomingBlocks);
        todoListId = reconciled.todoListId;
        contentJson = JSON.stringify({ version: 1, blocks: reconciled.blocks });
      }

      const updateRes = await exec(
        `UPDATE markdown_lists
         SET name       = COALESCE($1, name),
             emoji      = COALESCE($2, emoji),
             color      = COALESCE($3, color),
             color_bg   = COALESCE($4, color_bg),
             subtitle   = COALESCE($5, subtitle),
             is_public  = COALESCE($6, is_public),
             folder_id  = CASE WHEN $8 THEN $9 ELSE folder_id END,
             position   = COALESCE($10, position),
             content    = COALESCE($11, content),
             todo_list_id = $12,
             updated_at = NOW()
         WHERE id = $7
         RETURNING *`,
        [name ?? null, emoji ?? null, color ?? null, colorBg ?? null, subtitle ?? null, isPublic ?? null, id,
          updateFolderId, folderId ?? null, position ?? null, contentJson, todoListId]
      );
      return { result: updateRes, newTodoListId: todoListId, priorTodoListId: locked.todo_list_id };
    });

    const [hydrated] = await hydrateTodoChecked([result.rows[0] as unknown as MarkdownListRow]);
    res.json({ markdownList: hydrated });
    broadcastToUser(req.userId!, 'markdownLists');
    if (newTodoListId && newTodoListId !== priorTodoListId) broadcastToUser(req.userId!, 'lists');
    else if (content) broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    werr('markdown-lists PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/markdown-lists/:id — soft delete: snapshot to trash, cascade
// the linked Todo list through the same soft-delete path a normal list
// delete uses, remove image rows/files, then remove the row itself.
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const existing = await query<MarkdownListRow>('SELECT * FROM markdown_lists WHERE id = $1', [id]);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'Markdown list not found' }); return; }
    const row = existing.rows[0];
    const isOwner = row.user_id === req.userId;
    if (!isOwner && !req.user?.isAdmin) { res.status(403).json({ error: 'Permission denied' }); return; }

    const images = await query<{ id: string; file_path: string }>(
      'SELECT id, file_path FROM markdown_list_images WHERE markdown_list_id = $1', [id]
    );

    await withTransaction(async (client) => {
      const exec: QueryExec = (text, params) => client.query(text, params);
      await exec(
        `INSERT INTO trash_markdown_lists (markdown_list_id, user_id, markdown_list_data) VALUES ($1, $2, $3)`,
        [row.id, row.user_id, JSON.stringify(sanitize(row))]
      );
      if (row.todo_list_id) await softDeleteListTreeExec(exec, row.todo_list_id);
      await exec('DELETE FROM markdown_list_images WHERE markdown_list_id = $1', [id]);
      await exec('DELETE FROM markdown_lists WHERE id = $1', [id]);
    });

    for (const img of images.rows) {
      const p = path.join(MARKDOWN_IMAGE_DIR, path.basename(img.file_path));
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* best-effort cleanup */ } }
    }

    wlog(`markdown-list DELETE ✓ id=${id} owner=${req.userId}`);
    res.json({ success: true });
    broadcastToUser(req.userId!, 'markdownLists');
    broadcastToUser(req.userId!, 'trash');
    if (row.todo_list_id) broadcastToUser(req.userId!, 'lists');
  } catch (err) {
    werr('markdown-lists DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/markdown-lists/:id/share — manage the public read-only share
// link. Body: { enabled?, password?: string|null, expiresAt?: string|null }
// (password/expiresAt: omit = unchanged, null = clear, value = set). Mirrors
// PUT /api/lists/:listId/share minus the subpage cascade (markdown lists
// have no nesting concept).
router.put('/:id/share', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { enabled, password, expiresAt } = req.body as {
      enabled?: boolean; password?: string | null; expiresAt?: string | null;
    };

    const existing = await query<MarkdownListRow>('SELECT * FROM markdown_lists WHERE id = $1', [id]);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'Markdown list not found' }); return; }
    const row = existing.rows[0];
    const isOwner = row.user_id === req.userId;
    if (!isOwner && !req.user?.isAdmin) { res.status(403).json({ error: 'Permission denied' }); return; }

    const updatePw = 'password' in req.body;
    const updateExp = 'expiresAt' in req.body;
    const updateEnabled = 'enabled' in req.body;

    const willBeEnabled = updateEnabled ? Boolean(enabled) : row.share_enabled;
    let token = row.share_token;
    if (willBeEnabled && !token) token = randomBytes(24).toString('hex');

    let pwHash: string | null = null;
    if (updatePw && typeof password === 'string' && password.length > 0) {
      pwHash = await hashPassword(password);
    }

    const result = await query<MarkdownListRow>(
      `UPDATE markdown_lists
       SET share_enabled       = COALESCE($2, share_enabled),
           share_token         = $3,
           share_password_hash = CASE WHEN $4 THEN $5 ELSE share_password_hash END,
           share_expires_at    = CASE WHEN $6 THEN $7 ELSE share_expires_at END
       WHERE id = $1
       RETURNING *`,
      [id, updateEnabled ? enabled : null, token, updatePw, pwHash, updateExp, expiresAt ?? null]
    );
    const saved = result.rows[0];

    res.json({
      share: {
        enabled: saved.share_enabled,
        token: saved.share_token,
        hasPassword: saved.share_password_hash != null,
        expiresAt: saved.share_expires_at ?? null,
      },
    });
    broadcastToUser(req.userId!, 'markdownLists');
  } catch (err) {
    werr('markdown-lists share PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Inline images — `/image` blocks
// ---------------------------------------------------------------------------

// POST /api/markdown-lists/:id/images — multipart `image` field. Owner only.
router.post('/:id/images', authenticate, (req: Request, res: Response) => {
  uploadImage.single('image')(req, res, async (err) => {
    try {
      const { id } = req.params;
      const ownerCheck = await query<{ user_id: string }>('SELECT user_id FROM markdown_lists WHERE id = $1', [id]);
      if (ownerCheck.rows.length === 0) {
        if (req.file) fs.unlinkSync(path.join(MARKDOWN_IMAGE_DIR, req.file.filename));
        res.status(404).json({ error: 'Markdown list not found' });
        return;
      }
      if (ownerCheck.rows[0].user_id !== req.userId && !req.user?.isAdmin) {
        if (req.file) fs.unlinkSync(path.join(MARKDOWN_IMAGE_DIR, req.file.filename));
        res.status(403).json({ error: 'Permission denied' });
        return;
      }
      if (err) {
        res.status(400).json({ error: err instanceof multer.MulterError ? err.message : 'Upload failed' });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'Only PNG, JPEG, WEBP or GIF images are supported' });
        return;
      }

      const imageId = `mdimg_${uuidv4()}`;
      await query(
        `INSERT INTO markdown_list_images (id, user_id, markdown_list_id, original_name, mime_type, file_size, file_path)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [imageId, req.userId, id, req.file.originalname, req.file.mimetype, req.file.size, req.file.filename]
      );

      res.status(201).json({
        image: {
          id: imageId,
          name: req.file.originalname,
          mimeType: req.file.mimetype,
          size: req.file.size,
          url: `/api/markdown-lists/${id}/images/${imageId}`,
        },
      });
    } catch (e) {
      if (req.file) { try { fs.unlinkSync(path.join(MARKDOWN_IMAGE_DIR, req.file.filename)); } catch { /* best-effort */ } }
      werr('markdown-lists image upload error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
});

// GET /api/markdown-lists/:id/images/:imageId — inline auth-gated serve.
// `<img>` tags can't set an Authorization header, so — matching the existing
// SSE endpoint's convention (`/api/events?token=`) — this route additionally
// accepts the JWT as a `?token=` query param.
router.get('/:id/images/:imageId', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
    const token = headerToken ?? queryToken;
    if (!token) { res.status(401).json({ error: 'Missing token' }); return; }
    let userId: string;
    try {
      ({ userId } = verifyToken(token));
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const { id, imageId } = req.params;
    const access = await query<{ user_id: string; is_public: boolean; workspace_id: string | null }>(
      `SELECT m.user_id, m.is_public, m.workspace_id FROM markdown_lists m WHERE m.id = $1`, [id]
    );
    if (access.rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
    const m = access.rows[0];
    let canView = m.user_id === userId;
    if (!canView && m.is_public) {
      if (!m.workspace_id) canView = true;
      else {
        const member = await query('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [m.workspace_id, userId]);
        canView = member.rows.length > 0;
      }
    }
    if (!canView) { res.status(403).json({ error: 'Permission denied' }); return; }

    const imgRes = await query<{ file_path: string; mime_type: string; original_name: string | null }>(
      'SELECT file_path, mime_type, original_name FROM markdown_list_images WHERE id = $1 AND markdown_list_id = $2', [imageId, id]
    );
    if (imgRes.rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
    const img = imgRes.rows[0];
    const filePath = path.join(path.resolve(MARKDOWN_IMAGE_DIR), path.basename(img.file_path));
    if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'Not found on disk' }); return; }

    res.setHeader('Content-Type', img.mime_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    // Helmet's default Cross-Origin-Resource-Policy: same-origin blocks an
    // <img> tag from loading this when the frontend is served from a
    // different origin (e.g. the split `vite dev` + backend-on-3001 setup in
    // CLAUDE.md's "Running locally without Docker"). The route is already
    // auth-gated above, so relaxing this to cross-origin is safe.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.sendFile(filePath);
  } catch (err) {
    werr('markdown-lists image serve error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
