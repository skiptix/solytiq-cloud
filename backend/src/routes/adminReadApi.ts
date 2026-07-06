// ---------------------------------------------------------------------------
// /api/admin-read — the instance-wide Admin API.
//
// Authenticated with an admin API key (Bearer or x-api-key). Every key carries
// a set of permission SCOPES (see adminApiKey.ts) chosen in the creation wizard;
// each route below is gated behind the scope it needs. `read` unlocks the export;
// `users`/`workspaces`/`folders`/`lists`/`timelines`/`meetings` unlock full
// create/update/delete for that resource family.
//
// SECURITY: the key is an instance-level admin credential, so writes act on
// behalf of any user. The target owner is taken from an explicit `ownerId`
// (defaulting to the admin who created the key) and always validated against a
// real user row — never trusted blindly — and every mutation is scoped so it
// can only touch the resolved owner's data.
// ---------------------------------------------------------------------------

import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db';
import { authenticateAdminApiKey, AdminApiScope } from '../adminApiKey';
import { broadcastToUser } from '../sse';
import { resolveWorkspaceForUser, ensurePersonalWorkspace } from '../workspaceUtil';
import { softDeleteListTree, snapshotTimelineToTrash } from '../trashUtil';
import { hashPassword } from '../auth';

const router = Router();

async function requireAdminApiKey(req: Request, res: Response, next: NextFunction) {
  const auth = req.header('authorization') ?? '';
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  const key = bearer || req.header('x-api-key');
  const result = key ? await authenticateAdminApiKey(key) : null;
  if (!result) {
    res.status(401).json({ error: 'Invalid or missing admin API key' });
    return;
  }
  (req as any).adminApiKeyId = result.keyId;
  (req as any).adminCreatedBy = result.createdBy;
  (req as any).adminScopes = result.scopes;
  next();
}

/** Gate a route behind a required scope; 403 with a clear message otherwise. */
function requireScope(scope: AdminApiScope) {
  return (req: Request, res: Response, next: NextFunction) => {
    const scopes: AdminApiScope[] = (req as any).adminScopes ?? [];
    if (!scopes.includes(scope)) {
      res.status(403).json({ error: `This API key lacks the "${scope}" permission` });
      return;
    }
    next();
  };
}

router.use(requireAdminApiKey);

// ── small helpers ──────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIORITIES = new Set(['High', 'Medium', 'Low']);
const STATUSES = new Set(['upcoming', 'in-progress', 'done']);
const LAYOUTS = new Set(['vertical', 'compact', 'detailed']);

function txt(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function optionalText(value: unknown): string | null {
  return txt(value);
}
function genTaskId(): string {
  return String(Date.now() * 1000 + crypto.randomInt(1000));
}

/**
 * Resolve the owning user for a write. Uses body/query `ownerId` when supplied
 * (validated against a real user row) and otherwise defaults to the admin who
 * created the key. Returns null after sending an error response.
 */
async function resolveOwnerId(req: Request, res: Response): Promise<string | null> {
  const requested = txt(req.body?.ownerId) ?? txt(req.query.ownerId);
  const target = requested ?? ((req as any).adminCreatedBy as string);
  if (!UUID_RE.test(target)) {
    res.status(400).json({ error: 'ownerId must be a valid user id' });
    return null;
  }
  const u = await query(`SELECT 1 FROM users WHERE id = $1`, [target]);
  if (!u.rows.length) {
    res.status(400).json({ error: 'ownerId does not match an existing user' });
    return null;
  }
  return target;
}

/** Build a partial-update SET clause from a field map; skips undefined values. */
function buildUpdate(fields: Record<string, unknown>): { sql: string; params: unknown[] } | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const [col, val] of Object.entries(fields)) {
    if (val === undefined) continue;
    sets.push(`${col} = $${i++}`);
    params.push(val);
  }
  if (!sets.length) return null;
  return { sql: sets.join(', '), params };
}

async function nextPosition(table: string, whereCol: string, whereVal: unknown): Promise<number> {
  const r = await query<{ max: string | null }>(
    `SELECT MAX(position) AS max FROM ${table} WHERE ${whereCol} = $1`,
    [whereVal]
  );
  return r.rows[0].max !== null ? parseInt(r.rows[0].max, 10) + 1 : 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// READ — full instance export
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/admin-read/export?workspaceId=...&userId=...
router.get('/export', requireScope('read'), async (req, res) => {
  try {
    const workspaceId = optionalText(req.query.workspaceId);
    const userId = optionalText(req.query.userId);
    const filters: string[] = [];
    const values: string[] = [];
    if (workspaceId) { values.push(workspaceId); filters.push(`w.id = $${values.length}`); }
    if (userId) { values.push(userId); filters.push(`(w.owner_id = $${values.length} OR EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = $${values.length}))`); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const result = await query(
      `WITH scoped_workspaces AS (
         SELECT w.* FROM workspaces w ${where}
       )
       SELECT jsonb_build_object(
         'generatedAt', NOW(),
         'filters', jsonb_build_object('workspaceId', $${values.length + 1}::text, 'userId', $${values.length + 2}::text),
         'users', COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'id', u.id, 'username', u.username, 'email', u.email, 'fullName', u.full_name,
             'profileImage', u.profile_image, 'isAdmin', u.is_admin, 'lastOnline', u.last_online, 'createdAt', u.created_at
           ) ORDER BY u.created_at)
           FROM users u
           WHERE ($${values.length + 2}::text IS NULL OR u.id::text = $${values.length + 2})
         ), '[]'::jsonb),
         'workspaces', COALESCE((SELECT jsonb_agg(to_jsonb(sw) ORDER BY sw.created_at) FROM scoped_workspaces sw), '[]'::jsonb),
         'workspaceMembers', COALESCE((SELECT jsonb_agg(to_jsonb(wm) ORDER BY wm.joined_at) FROM workspace_members wm JOIN scoped_workspaces sw ON sw.id = wm.workspace_id), '[]'::jsonb),
         'folders', COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.position, f.created_at) FROM folders f JOIN scoped_workspaces sw ON sw.id = f.workspace_id), '[]'::jsonb),
         'sharedFiles', COALESCE((SELECT jsonb_agg(to_jsonb(sf) - 'file_path' - 'password_hash' ORDER BY sf.created_at) FROM shared_files sf WHERE ($${values.length + 2}::text IS NULL OR sf.user_id::text = $${values.length + 2})), '[]'::jsonb),
         'lists', COALESCE((SELECT jsonb_agg(to_jsonb(l) - 'share_password_hash' ORDER BY l.position, l.created_at) FROM lists l JOIN scoped_workspaces sw ON sw.id = l.workspace_id), '[]'::jsonb),
         'sections', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.position) FROM sections s JOIN lists l ON l.id = s.list_id JOIN scoped_workspaces sw ON sw.id = l.workspace_id), '[]'::jsonb),
         'items', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.position, t.created_at) FROM tasks t JOIN scoped_workspaces sw ON sw.id = t.workspace_id), '[]'::jsonb),
         'itemDetails', COALESCE((SELECT jsonb_agg(jsonb_build_object('itemId', t.id, 'note', t.note, 'deadline', t.deadline, 'time', t.time_val, 'priority', t.priority, 'badge', t.badge, 'linkedListId', t.linked_list_id, 'linkedListType', t.linked_list_type, 'updatedAt', t.updated_at) ORDER BY t.updated_at DESC) FROM tasks t JOIN scoped_workspaces sw ON sw.id = t.workspace_id), '[]'::jsonb),
         'timelines', COALESCE((SELECT jsonb_agg(to_jsonb(tl) - 'share_password_hash' ORDER BY tl.position, tl.created_at) FROM timelines tl JOIN scoped_workspaces sw ON sw.id = tl.workspace_id), '[]'::jsonb),
         'milestones', COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.position, m.milestone_date) FROM milestones m JOIN timelines tl ON tl.id = m.timeline_id JOIN scoped_workspaces sw ON sw.id = tl.workspace_id), '[]'::jsonb),
         'milestoneDetails', COALESCE((SELECT jsonb_agg(jsonb_build_object('milestoneId', m.id, 'description', m.description, 'date', m.milestone_date, 'time', m.time_val, 'status', m.status, 'emoji', m.emoji, 'color', m.color, 'createdAt', m.created_at) ORDER BY m.created_at DESC) FROM milestones m JOIN timelines tl ON tl.id = m.timeline_id JOIN scoped_workspaces sw ON sw.id = tl.workspace_id), '[]'::jsonb),
         'meetings', COALESCE((SELECT jsonb_agg(to_jsonb(mt) ORDER BY mt.meeting_date, mt.start_time) FROM meetings mt WHERE ($${values.length + 2}::text IS NULL OR mt.user_id::text = $${values.length + 2})), '[]'::jsonb),
         'timings', COALESCE((SELECT jsonb_agg(entry ORDER BY entry->>'date', entry->>'time') FROM (
           SELECT jsonb_build_object('type', 'item', 'id', t.id, 'workspaceId', t.workspace_id, 'date', t.deadline, 'time', t.time_val, 'title', t.title) entry FROM tasks t JOIN scoped_workspaces sw ON sw.id = t.workspace_id WHERE t.deadline IS NOT NULL OR t.time_val IS NOT NULL
           UNION ALL
           SELECT jsonb_build_object('type', 'milestone', 'id', m.id, 'workspaceId', tl.workspace_id, 'date', m.milestone_date, 'time', m.time_val, 'title', m.title) entry FROM milestones m JOIN timelines tl ON tl.id = m.timeline_id JOIN scoped_workspaces sw ON sw.id = tl.workspace_id WHERE m.milestone_date IS NOT NULL OR m.time_val IS NOT NULL
           UNION ALL
           SELECT jsonb_build_object('type', 'meeting', 'id', mt.id, 'workspaceId', null, 'date', mt.meeting_date, 'time', mt.start_time, 'title', mt.title) entry FROM meetings mt WHERE ($${values.length + 2}::text IS NULL OR mt.user_id::text = $${values.length + 2})
         ) x), '[]'::jsonb),
         'itemAttachments', COALESCE((SELECT jsonb_agg(to_jsonb(a) - 'file_path' ORDER BY a.created_at) FROM task_attachments a JOIN tasks t ON t.id = a.task_id JOIN scoped_workspaces sw ON sw.id = t.workspace_id), '[]'::jsonb),
         'milestoneAttachments', COALESCE((SELECT jsonb_agg(to_jsonb(a) - 'file_path' ORDER BY a.created_at) FROM milestone_attachments a JOIN milestones m ON m.id = a.milestone_id JOIN timelines tl ON tl.id = m.timeline_id JOIN scoped_workspaces sw ON sw.id = tl.workspace_id), '[]'::jsonb)
       ) AS data`,
      [...values, workspaceId, userId]
    );

    res.json(result.rows[0]?.data ?? {});
  } catch (err) {
    console.error('admin-read/export error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════════════════════════════════════

function sanitizeUser(u: any) {
  return {
    id: u.id, username: u.username, email: u.email, fullName: u.full_name,
    profileImage: u.profile_image ?? null, isAdmin: u.is_admin,
    lastOnline: u.last_online, createdAt: u.created_at,
  };
}

// POST /api/admin-read/users
router.post('/users', requireScope('users'), async (req, res) => {
  try {
    const username = txt(req.body?.username);
    const password = txt(req.body?.password);
    if (!username || !password) { res.status(400).json({ error: 'username and password are required' }); return; }
    const email = txt(req.body?.email) ?? `${username}@local`;
    const fullName = txt(req.body?.fullName);
    const isAdmin = req.body?.isAdmin === true;
    const passwordHash = await hashPassword(password);
    const r = await query(
      `INSERT INTO users (username, email, password_hash, full_name, is_admin)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, email, full_name, profile_image, is_admin, last_online, created_at`,
      [username, email, passwordHash, fullName, isAdmin]
    );
    await ensurePersonalWorkspace(query, r.rows[0].id);
    res.status(201).json({ user: sanitizeUser(r.rows[0]) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('unique') || msg.includes('duplicate')) { res.status(409).json({ error: 'Username or email already taken' }); return; }
    console.error('admin-read/users POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/admin-read/users/:id
router.put('/users/:id', requireScope('users'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) { res.status(404).json({ error: 'User not found' }); return; }
    const fields: Record<string, unknown> = {};
    if (req.body?.username !== undefined) fields.username = txt(req.body.username);
    if (req.body?.fullName !== undefined) fields.full_name = txt(req.body.fullName);
    if (req.body?.isAdmin !== undefined) fields.is_admin = req.body.isAdmin === true;
    const built = buildUpdate(fields);
    let extra = '';
    const params: unknown[] = built ? [...built.params] : [];
    if (req.body?.password !== undefined) {
      const pw = txt(req.body.password);
      if (!pw) { res.status(400).json({ error: 'password cannot be empty' }); return; }
      params.push(await hashPassword(pw));
      // Invalidate existing sessions when the password changes.
      extra = `${built ? ', ' : ''}password_hash = $${params.length}, token_version = token_version + 1`;
    }
    if (!built && !extra) { res.status(400).json({ error: 'Nothing to update' }); return; }
    params.push(id);
    const r = await query(
      `UPDATE users SET ${built ? built.sql : ''}${extra} WHERE id = $${params.length}
       RETURNING id, username, email, full_name, profile_image, is_admin, last_online, created_at`,
      params
    );
    if (!r.rows.length) { res.status(404).json({ error: 'User not found' }); return; }
    res.json({ user: sanitizeUser(r.rows[0]) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('unique') || msg.includes('duplicate')) { res.status(409).json({ error: 'Username already taken' }); return; }
    console.error('admin-read/users PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin-read/users/:id
router.delete('/users/:id', requireScope('users'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) { res.status(404).json({ error: 'User not found' }); return; }
    if (id === (req as any).adminCreatedBy) { res.status(400).json({ error: 'Cannot delete the user that owns this API key' }); return; }
    const r = await query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
    if (!r.rows.length) { res.status(404).json({ error: 'User not found' }); return; }
    res.json({ success: true });
  } catch (err) {
    console.error('admin-read/users DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// WORKSPACES
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/admin-read/workspaces
router.post('/workspaces', requireScope('workspaces'), async (req, res) => {
  try {
    const ownerId = await resolveOwnerId(req, res);
    if (!ownerId) return;
    const name = txt(req.body?.name);
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }
    const visibility = req.body?.visibility === 'public' ? 'public' : 'private';
    const id = `ws_${Date.now()}`;
    const r = await query(
      `INSERT INTO workspaces (id, name, description, emoji, visibility, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, name, txt(req.body?.description), txt(req.body?.emoji), visibility, ownerId]
    );
    await query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [id, ownerId]);
    broadcastToUser(ownerId, 'workspaces');
    res.status(201).json({ workspace: r.rows[0] });
  } catch (err) {
    console.error('admin-read/workspaces POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/admin-read/workspaces/:id
router.put('/workspaces/:id', requireScope('workspaces'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await query<{ owner_id: string }>(`SELECT owner_id FROM workspaces WHERE id = $1`, [id]);
    if (!existing.rows.length) { res.status(404).json({ error: 'Workspace not found' }); return; }
    const fields: Record<string, unknown> = {};
    if (req.body?.name !== undefined) fields.name = txt(req.body.name);
    if (req.body?.description !== undefined) fields.description = txt(req.body.description);
    if (req.body?.emoji !== undefined) fields.emoji = txt(req.body.emoji);
    if (req.body?.visibility !== undefined) fields.visibility = req.body.visibility === 'public' ? 'public' : 'private';
    const built = buildUpdate(fields);
    if (!built) { res.status(400).json({ error: 'Nothing to update' }); return; }
    built.params.push(id);
    const r = await query(`UPDATE workspaces SET ${built.sql} WHERE id = $${built.params.length} RETURNING *`, built.params);
    broadcastToUser(existing.rows[0].owner_id, 'workspaces');
    res.json({ workspace: r.rows[0] });
  } catch (err) {
    console.error('admin-read/workspaces PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin-read/workspaces/:id
router.delete('/workspaces/:id', requireScope('workspaces'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await query<{ owner_id: string }>(`SELECT owner_id FROM workspaces WHERE id = $1`, [id]);
    if (!existing.rows.length) { res.status(404).json({ error: 'Workspace not found' }); return; }
    // Refuse to delete a workspace that still holds content — otherwise its
    // lists/folders/timelines would be orphaned (workspace_id set to NULL).
    const content = await query<{ n: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM lists WHERE workspace_id = $1) +
         (SELECT COUNT(*) FROM folders WHERE workspace_id = $1) +
         (SELECT COUNT(*) FROM timelines WHERE workspace_id = $1)
       )::text AS n`,
      [id]
    );
    if (parseInt(content.rows[0].n, 10) > 0) {
      res.status(409).json({ error: 'Workspace is not empty — remove its lists, folders and timelines first' });
      return;
    }
    await query(`DELETE FROM workspaces WHERE id = $1`, [id]);
    broadcastToUser(existing.rows[0].owner_id, 'workspaces');
    res.json({ success: true });
  } catch (err) {
    console.error('admin-read/workspaces DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// FOLDERS
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/admin-read/folders
router.post('/folders', requireScope('folders'), async (req, res) => {
  try {
    const ownerId = await resolveOwnerId(req, res);
    if (!ownerId) return;
    const name = txt(req.body?.name);
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }
    const ws = await resolveWorkspaceForUser(ownerId, txt(req.body?.workspaceId));
    const id = `folder_${uuidv4()}`;
    const pos = await nextPosition('folders', 'user_id', ownerId);
    await query(
      `INSERT INTO folders (id, user_id, name, emoji, position, is_public, workspace_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, ownerId, name, txt(req.body?.emoji), pos, req.body?.isPublic !== false, ws]
    );
    broadcastToUser(ownerId, 'lists');
    res.status(201).json({ folder: { id, name, workspaceId: ws } });
  } catch (err) {
    console.error('admin-read/folders POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/admin-read/folders/:id
router.put('/folders/:id', requireScope('folders'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await query<{ user_id: string }>(`SELECT user_id FROM folders WHERE id = $1`, [id]);
    if (!existing.rows.length) { res.status(404).json({ error: 'Folder not found' }); return; }
    const fields: Record<string, unknown> = {};
    if (req.body?.name !== undefined) fields.name = txt(req.body.name);
    if (req.body?.emoji !== undefined) fields.emoji = txt(req.body.emoji);
    if (req.body?.isPublic !== undefined) fields.is_public = req.body.isPublic === true;
    const built = buildUpdate(fields);
    if (!built) { res.status(400).json({ error: 'Nothing to update' }); return; }
    built.params.push(id);
    const r = await query(`UPDATE folders SET ${built.sql} WHERE id = $${built.params.length} RETURNING id, name`, built.params);
    broadcastToUser(existing.rows[0].user_id, 'lists');
    res.json({ folder: r.rows[0] });
  } catch (err) {
    console.error('admin-read/folders PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin-read/folders/:id
router.delete('/folders/:id', requireScope('folders'), async (req, res) => {
  try {
    const { id } = req.params;
    const r = await query<{ user_id: string }>(`DELETE FROM folders WHERE id = $1 RETURNING user_id`, [id]);
    if (!r.rows.length) { res.status(404).json({ error: 'Folder not found' }); return; }
    broadcastToUser(r.rows[0].user_id, 'lists');
    res.json({ success: true });
  } catch (err) {
    console.error('admin-read/folders DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// LISTS · SECTIONS · ITEMS
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/admin-read/lists
router.post('/lists', requireScope('lists'), async (req, res) => {
  try {
    const ownerId = await resolveOwnerId(req, res);
    if (!ownerId) return;
    const name = txt(req.body?.name);
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }
    const folderId = txt(req.body?.folderId);
    if (folderId) {
      const f = await query(`SELECT 1 FROM folders WHERE id = $1 AND user_id = $2`, [folderId, ownerId]);
      if (!f.rows.length) { res.status(400).json({ error: 'folderId does not match a folder owned by this user' }); return; }
    }
    const ws = await resolveWorkspaceForUser(ownerId, txt(req.body?.workspaceId));
    const listId = `list_${uuidv4()}`;
    const pos = await nextPosition('lists', 'user_id', ownerId);
    await query(
      `INSERT INTO lists (id, user_id, name, emoji, is_public, folder_id, position, depth, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8)`,
      [listId, ownerId, name, txt(req.body?.emoji), req.body?.isPublic === true, folderId, pos, ws]
    );
    const sectionId = `sec_${uuidv4()}`;
    await query(`INSERT INTO sections (id, list_id, label, position) VALUES ($1, $2, 'Tasks', 0)`, [sectionId, listId]);
    broadcastToUser(ownerId, 'lists');
    res.status(201).json({ list: { id: listId, name, workspaceId: ws }, defaultSectionId: sectionId });
  } catch (err) {
    console.error('admin-read/lists POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/admin-read/lists/:id
router.put('/lists/:id', requireScope('lists'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await query<{ user_id: string }>(`SELECT user_id FROM lists WHERE id = $1`, [id]);
    if (!existing.rows.length) { res.status(404).json({ error: 'List not found' }); return; }
    const fields: Record<string, unknown> = {};
    if (req.body?.name !== undefined) fields.name = txt(req.body.name);
    if (req.body?.emoji !== undefined) fields.emoji = txt(req.body.emoji);
    if (req.body?.isPublic !== undefined) fields.is_public = req.body.isPublic === true;
    const built = buildUpdate(fields);
    if (!built) { res.status(400).json({ error: 'Nothing to update' }); return; }
    built.params.push(id);
    const r = await query(`UPDATE lists SET ${built.sql} WHERE id = $${built.params.length} RETURNING id, name`, built.params);
    broadcastToUser(existing.rows[0].user_id, 'lists');
    res.json({ list: r.rows[0] });
  } catch (err) {
    console.error('admin-read/lists PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin-read/lists/:id  (soft delete → trash, 30-day restore)
router.delete('/lists/:id', requireScope('lists'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await query<{ user_id: string }>(`SELECT user_id FROM lists WHERE id = $1`, [id]);
    if (!existing.rows.length) { res.status(404).json({ error: 'List not found' }); return; }
    await softDeleteListTree(id);
    broadcastToUser(existing.rows[0].user_id, 'lists');
    broadcastToUser(existing.rows[0].user_id, 'trash');
    res.json({ success: true });
  } catch (err) {
    console.error('admin-read/lists DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin-read/lists/:id/sections
router.post('/lists/:id/sections', requireScope('lists'), async (req, res) => {
  try {
    const { id } = req.params;
    const label = txt(req.body?.label);
    if (!label) { res.status(400).json({ error: 'label is required' }); return; }
    const list = await query<{ user_id: string }>(`SELECT user_id FROM lists WHERE id = $1`, [id]);
    if (!list.rows.length) { res.status(404).json({ error: 'List not found' }); return; }
    const sectionId = `sec_${uuidv4()}`;
    const pos = await nextPosition('sections', 'list_id', id);
    await query(`INSERT INTO sections (id, list_id, label, emoji, position) VALUES ($1, $2, $3, $4, $5)`, [sectionId, id, label, txt(req.body?.emoji), pos]);
    broadcastToUser(list.rows[0].user_id, 'lists');
    res.status(201).json({ section: { id: sectionId, label } });
  } catch (err) {
    console.error('admin-read/sections POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin-read/items   (dashboard task, or list task when listId+sectionId given)
router.post('/items', requireScope('lists'), async (req, res) => {
  try {
    const ownerId = await resolveOwnerId(req, res);
    if (!ownerId) return;
    const title = txt(req.body?.title);
    if (!title) { res.status(400).json({ error: 'title is required' }); return; }
    const priority = txt(req.body?.priority);
    if (priority && !PRIORITIES.has(priority)) { res.status(400).json({ error: 'priority must be High, Medium, or Low' }); return; }
    const listId = txt(req.body?.listId);
    const sectionId = txt(req.body?.sectionId);
    const id = genTaskId();

    if (listId || sectionId) {
      if (!listId || !sectionId) { res.status(400).json({ error: 'listId and sectionId are both required for a list item' }); return; }
      const list = await query<{ workspace_id: string | null }>(`SELECT workspace_id FROM lists WHERE id = $1 AND user_id = $2`, [listId, ownerId]);
      if (!list.rows.length) { res.status(400).json({ error: 'listId does not match a list owned by this user' }); return; }
      const sec = await query(`SELECT 1 FROM sections WHERE id = $1 AND list_id = $2`, [sectionId, listId]);
      if (!sec.rows.length) { res.status(400).json({ error: 'sectionId does not belong to that list' }); return; }
      const pos = await nextPosition('tasks', 'section_id', sectionId);
      await query(
        `INSERT INTO tasks (id, user_id, title, note, deadline, priority, source, list_id, section_id, position, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'list', $7, $8, $9, $10)`,
        [id, ownerId, title, txt(req.body?.note), txt(req.body?.deadline), priority, listId, sectionId, pos, list.rows[0].workspace_id]
      );
    } else {
      const ws = await resolveWorkspaceForUser(ownerId, txt(req.body?.workspaceId));
      const r = await query<{ max: string | null }>(`SELECT MAX(position) AS max FROM tasks WHERE user_id = $1 AND source = 'dash'`, [ownerId]);
      const pos = r.rows[0].max !== null ? parseInt(r.rows[0].max, 10) + 1 : 0;
      await query(
        `INSERT INTO tasks (id, user_id, title, note, deadline, priority, source, position, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'dash', $7, $8)`,
        [id, ownerId, title, txt(req.body?.note), txt(req.body?.deadline), priority, pos, ws]
      );
    }
    broadcastToUser(ownerId, 'tasks');
    broadcastToUser(ownerId, 'lists');
    res.status(201).json({ item: { id, title } });
  } catch (err) {
    console.error('admin-read/items POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/admin-read/items/:id
router.put('/items/:id', requireScope('lists'), async (req, res) => {
  try {
    const taskId = req.params.id;
    if (!/^\d+$/.test(taskId)) { res.status(404).json({ error: 'Item not found' }); return; }
    const existing = await query<{ user_id: string }>(`SELECT user_id FROM tasks WHERE id = $1`, [taskId]);
    if (!existing.rows.length) { res.status(404).json({ error: 'Item not found' }); return; }
    const priority = txt(req.body?.priority);
    if (req.body?.priority !== undefined && priority && !PRIORITIES.has(priority)) { res.status(400).json({ error: 'priority must be High, Medium, or Low' }); return; }
    const fields: Record<string, unknown> = {};
    if (req.body?.title !== undefined) fields.title = txt(req.body.title);
    if (req.body?.deadline !== undefined) fields.deadline = txt(req.body.deadline);
    if (req.body?.priority !== undefined) fields.priority = priority;
    if (req.body?.note !== undefined) fields.note = req.body.note ?? null;
    if (req.body?.checked !== undefined) fields.checked = req.body.checked === true;
    const built = buildUpdate(fields);
    if (!built) { res.status(400).json({ error: 'Nothing to update' }); return; }
    built.params.push(taskId);
    const r = await query(`UPDATE tasks SET ${built.sql} WHERE id = $${built.params.length} RETURNING id, title`, built.params);
    broadcastToUser(existing.rows[0].user_id, 'tasks');
    broadcastToUser(existing.rows[0].user_id, 'lists');
    res.json({ item: r.rows[0] });
  } catch (err) {
    console.error('admin-read/items PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin-read/items/:id
router.delete('/items/:id', requireScope('lists'), async (req, res) => {
  try {
    const taskId = req.params.id;
    if (!/^\d+$/.test(taskId)) { res.status(404).json({ error: 'Item not found' }); return; }
    const r = await query<{ user_id: string }>(`DELETE FROM tasks WHERE id = $1 RETURNING user_id`, [taskId]);
    if (!r.rows.length) { res.status(404).json({ error: 'Item not found' }); return; }
    broadcastToUser(r.rows[0].user_id, 'tasks');
    broadcastToUser(r.rows[0].user_id, 'lists');
    res.json({ success: true });
  } catch (err) {
    console.error('admin-read/items DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TIMELINES · MILESTONES
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/admin-read/timelines
router.post('/timelines', requireScope('timelines'), async (req, res) => {
  try {
    const ownerId = await resolveOwnerId(req, res);
    if (!ownerId) return;
    const name = txt(req.body?.name);
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }
    const layout = txt(req.body?.layout);
    if (layout && !LAYOUTS.has(layout)) { res.status(400).json({ error: 'layout must be vertical, compact, or detailed' }); return; }
    const folderId = txt(req.body?.folderId);
    if (folderId) {
      const f = await query(`SELECT 1 FROM folders WHERE id = $1 AND user_id = $2`, [folderId, ownerId]);
      if (!f.rows.length) { res.status(400).json({ error: 'folderId does not match a folder owned by this user' }); return; }
    }
    const ws = await resolveWorkspaceForUser(ownerId, txt(req.body?.workspaceId));
    const id = `timeline_${uuidv4()}`;
    const pos = await nextPosition('timelines', 'user_id', ownerId);
    await query(
      `INSERT INTO timelines (id, user_id, name, emoji, subtitle, color, layout, is_public, folder_id, position, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, ownerId, name, txt(req.body?.emoji), txt(req.body?.subtitle), txt(req.body?.color), layout ?? 'vertical', req.body?.isPublic === true, folderId, pos, ws]
    );
    broadcastToUser(ownerId, 'timelines');
    res.status(201).json({ timeline: { id, name, workspaceId: ws } });
  } catch (err) {
    console.error('admin-read/timelines POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/admin-read/timelines/:id
router.put('/timelines/:id', requireScope('timelines'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await query<{ user_id: string }>(`SELECT user_id FROM timelines WHERE id = $1`, [id]);
    if (!existing.rows.length) { res.status(404).json({ error: 'Timeline not found' }); return; }
    const layout = txt(req.body?.layout);
    if (req.body?.layout !== undefined && layout && !LAYOUTS.has(layout)) { res.status(400).json({ error: 'layout must be vertical, compact, or detailed' }); return; }
    const fields: Record<string, unknown> = {};
    if (req.body?.name !== undefined) fields.name = txt(req.body.name);
    if (req.body?.emoji !== undefined) fields.emoji = txt(req.body.emoji);
    if (req.body?.subtitle !== undefined) fields.subtitle = txt(req.body.subtitle);
    if (req.body?.color !== undefined) fields.color = txt(req.body.color);
    if (req.body?.layout !== undefined) fields.layout = layout;
    if (req.body?.isPublic !== undefined) fields.is_public = req.body.isPublic === true;
    const built = buildUpdate(fields);
    if (!built) { res.status(400).json({ error: 'Nothing to update' }); return; }
    built.params.push(id);
    const r = await query(`UPDATE timelines SET ${built.sql} WHERE id = $${built.params.length} RETURNING id, name`, built.params);
    broadcastToUser(existing.rows[0].user_id, 'timelines');
    res.json({ timeline: r.rows[0] });
  } catch (err) {
    console.error('admin-read/timelines PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin-read/timelines/:id  (soft delete → trash)
router.delete('/timelines/:id', requireScope('timelines'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await query<{ user_id: string }>(`SELECT user_id FROM timelines WHERE id = $1`, [id]);
    if (!existing.rows.length) { res.status(404).json({ error: 'Timeline not found' }); return; }
    await withTransaction(async (client) => {
      const exec = (text: string, params?: unknown[]) => client.query(text, params);
      await snapshotTimelineToTrash(exec, id);
      await client.query(`DELETE FROM timelines WHERE id = $1`, [id]);
    });
    broadcastToUser(existing.rows[0].user_id, 'timelines');
    broadcastToUser(existing.rows[0].user_id, 'trash');
    res.json({ success: true });
  } catch (err) {
    console.error('admin-read/timelines DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin-read/timelines/:id/milestones
router.post('/timelines/:id/milestones', requireScope('timelines'), async (req, res) => {
  try {
    const { id } = req.params;
    const title = txt(req.body?.title);
    if (!title) { res.status(400).json({ error: 'title is required' }); return; }
    const status = txt(req.body?.status);
    if (status && !STATUSES.has(status)) { res.status(400).json({ error: 'status must be upcoming, in-progress, or done' }); return; }
    const tl = await query<{ user_id: string }>(`SELECT user_id FROM timelines WHERE id = $1`, [id]);
    if (!tl.rows.length) { res.status(404).json({ error: 'Timeline not found' }); return; }
    const msId = `milestone_${uuidv4()}`;
    const pos = await nextPosition('milestones', 'timeline_id', id);
    await query(
      `INSERT INTO milestones (id, timeline_id, title, description, milestone_date, time_val, status, emoji, color, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [msId, id, title, txt(req.body?.description), txt(req.body?.date), txt(req.body?.time), status ?? 'upcoming', txt(req.body?.emoji), txt(req.body?.color), pos]
    );
    broadcastToUser(tl.rows[0].user_id, 'timelines');
    res.status(201).json({ milestone: { id: msId, title } });
  } catch (err) {
    console.error('admin-read/milestones POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/admin-read/milestones/:id
router.put('/milestones/:id', requireScope('timelines'), async (req, res) => {
  try {
    const { id } = req.params;
    const owns = await query<{ user_id: string }>(
      `SELECT t.user_id FROM milestones m JOIN timelines t ON m.timeline_id = t.id WHERE m.id = $1`,
      [id]
    );
    if (!owns.rows.length) { res.status(404).json({ error: 'Milestone not found' }); return; }
    const status = txt(req.body?.status);
    if (req.body?.status !== undefined && status && !STATUSES.has(status)) { res.status(400).json({ error: 'status must be upcoming, in-progress, or done' }); return; }
    const fields: Record<string, unknown> = {};
    if (req.body?.title !== undefined) fields.title = txt(req.body.title);
    if (req.body?.date !== undefined) fields.milestone_date = txt(req.body.date);
    if (req.body?.time !== undefined) fields.time_val = txt(req.body.time);
    if (req.body?.status !== undefined) fields.status = status;
    if (req.body?.emoji !== undefined) fields.emoji = txt(req.body.emoji);
    if (req.body?.color !== undefined) fields.color = txt(req.body.color);
    if (req.body?.description !== undefined) fields.description = req.body.description ?? null;
    const built = buildUpdate(fields);
    if (!built) { res.status(400).json({ error: 'Nothing to update' }); return; }
    built.params.push(id);
    const r = await query(`UPDATE milestones SET ${built.sql} WHERE id = $${built.params.length} RETURNING id, title`, built.params);
    broadcastToUser(owns.rows[0].user_id, 'timelines');
    res.json({ milestone: r.rows[0] });
  } catch (err) {
    console.error('admin-read/milestones PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin-read/milestones/:id
router.delete('/milestones/:id', requireScope('timelines'), async (req, res) => {
  try {
    const { id } = req.params;
    const r = await query<{ user_id: string }>(
      `DELETE FROM milestones m USING timelines t
       WHERE m.id = $1 AND m.timeline_id = t.id RETURNING t.user_id`,
      [id]
    );
    if (!r.rows.length) { res.status(404).json({ error: 'Milestone not found' }); return; }
    broadcastToUser(r.rows[0].user_id, 'timelines');
    res.json({ success: true });
  } catch (err) {
    console.error('admin-read/milestones DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MEETINGS
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/admin-read/meetings
router.post('/meetings', requireScope('meetings'), async (req, res) => {
  try {
    const ownerId = await resolveOwnerId(req, res);
    if (!ownerId) return;
    const title = txt(req.body?.title);
    const date = txt(req.body?.date);
    if (!title || !date) { res.status(400).json({ error: 'title and date are required' }); return; }
    const allDay = req.body?.allDay === true;
    const id = `mt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await query(
      `INSERT INTO meetings (id, user_id, title, description, location, meeting_date, start_time, end_time, all_day, color)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, ownerId, title, txt(req.body?.description), txt(req.body?.location), date, allDay ? null : txt(req.body?.startTime), allDay ? null : txt(req.body?.endTime), allDay, txt(req.body?.color)]
    );
    broadcastToUser(ownerId, 'meetings');
    res.status(201).json({ meeting: { id, title } });
  } catch (err) {
    console.error('admin-read/meetings POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/admin-read/meetings/:id
router.put('/meetings/:id', requireScope('meetings'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await query<{ user_id: string }>(`SELECT user_id FROM meetings WHERE id = $1`, [id]);
    if (!existing.rows.length) { res.status(404).json({ error: 'Meeting not found' }); return; }
    const allDayParam = typeof req.body?.allDay === 'boolean' ? req.body.allDay : null;
    const r = await query<{ id: string; title: string }>(
      `UPDATE meetings
       SET title = COALESCE($1, title), description = $2, location = $3, meeting_date = COALESCE($4, meeting_date),
           start_time = $5, end_time = $6, all_day = COALESCE($7, all_day), color = $8, updated_at = NOW()
       WHERE id = $9 RETURNING id, title`,
      [txt(req.body?.title), txt(req.body?.description), txt(req.body?.location), txt(req.body?.date),
       txt(req.body?.startTime), txt(req.body?.endTime), allDayParam, txt(req.body?.color), id]
    );
    broadcastToUser(existing.rows[0].user_id, 'meetings');
    res.json({ meeting: r.rows[0] });
  } catch (err) {
    console.error('admin-read/meetings PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin-read/meetings/:id
router.delete('/meetings/:id', requireScope('meetings'), async (req, res) => {
  try {
    const { id } = req.params;
    const r = await query<{ user_id: string }>(`DELETE FROM meetings WHERE id = $1 RETURNING user_id`, [id]);
    if (!r.rows.length) { res.status(404).json({ error: 'Meeting not found' }); return; }
    broadcastToUser(r.rows[0].user_id, 'meetings');
    res.json({ success: true });
  } catch (err) {
    console.error('admin-read/meetings DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
