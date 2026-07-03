# Briefing for Jules — "Lists/timelines disappear after workspace switch"

**Severity:** High (perceived data loss in production)
**Status:** Root causes identified — codebase analysis complete, fixes specified below
**Affected areas:** `backend/src/routes/trash.ts`, `backend/src/routes/workspaces.ts`, `backend/src/index.ts` (`runMigrations`), `frontend/src/App.tsx`, `frontend/src/components/Sidebar.tsx`, `frontend/src/store/useAppStore.ts`

---

## 1. The reported symptom

> When a user switches between workspaces, sometimes the lists/timelines in the workspace disappear and cannot be restored to the user's view. The AI assistant, however, still lists them.

The AI clue is the smoking gun. The AI tool registry (`backend/src/aiTools.ts`) queries purely by `user_id` with **no workspace filter**:

```sql
-- aiTools.ts list_lists (line 76)
SELECT id, name, emoji, folder_id FROM lists WHERE user_id = $1 AND depth = 0 ...
-- aiTools.ts list_timelines (line 175)
SELECT ... FROM timelines t WHERE t.user_id = $1 ...
```

The app UI, however, loads via `GET /api/lists?workspaceId=…` → `buildListsForUser()` (`routes/lists.ts:151`), which filters:

```sql
AND (l.workspace_id = $2 OR l.workspace_id IS NULL)
```

**Conclusion: the rows are alive in the database, but their `workspace_id` points at a workspace the user can no longer select in the UI (or at a workspace the user wasn't looking at).** They are invisible in *every* workspace view — the AI still sees them because it never filters by workspace. This is not a rendering bug per se; it is *stranded data*, plus one frontend amplifier described in §2.7/§2.8.

---

## 2. Root causes (ranked, all verified in code)

### 2.1 ★ Restore-from-trash drops `workspace_id` (and sublist structure)

`backend/src/routes/trash.ts`, list restore (`POST /api/trash/lists/:trashId/restore`, line ~338):

```sql
INSERT INTO lists (id, user_id, name, emoji, color, color_bg, subtitle, is_public, folder_id, position)
VALUES (...)
```

**`workspace_id`, `parent_task_id`, and `depth` are omitted.** Same for the restored tasks (no `workspace_id`), and the timeline restore (line ~481) also omits `workspace_id`.

Consequence chain:
1. Restored list comes back with `workspace_id = NULL` → it matches the `OR workspace_id IS NULL` clause and **appears in every workspace** (user thinks restore worked).
2. On the next backend restart, the `runMigrations()` heal (see §2.2) reassigns all NULL rows to an **arbitrary** workspace the user owns.
3. The list "vanishes" from where the user last saw it. It cannot be re-restored — it's not in the trash, it's live in a workspace the user isn't looking at.

This alone reproduces the exact ticket: *disappears, can't be restored, AI still sees it.*

Bonus defects in the same code path:
- A restored sublist loses `parent_task_id`/`depth` → detaches from its parent task and becomes a top-level list.
- The restore is **not transactional** — list insert, section inserts, and task inserts run as separate queries. A mid-way failure (e.g. dangling `folder_id` FK violation, which is not covered by `ON CONFLICT (id) DO NOTHING`) leaves a partially restored list *and* keeps the trash row half-consumed.
- The restored `folder_id` is inserted blindly; if that folder now lives in a different workspace (or was deleted), the list becomes unreachable in the sidebar (see §2.8).

### 2.2 ★ Startup NULL-heal is nondeterministic (`LIMIT 1` without `ORDER BY`)

`backend/src/index.ts` (`runMigrations`, lines ~969–983):

```sql
UPDATE lists l
SET workspace_id = (SELECT w.id FROM workspaces w WHERE w.owner_id = l.user_id LIMIT 1)
WHERE l.workspace_id IS NULL
```

Same pattern for `folders` and `tasks` — **no `ORDER BY`**, so PostgreSQL may pick *any* workspace the user owns, and may pick *different* workspaces for the lists heal vs. the folders heal in the same run. (The timelines heal at line ~1040 correctly uses `ORDER BY w.created_at ASC` — the other three were never aligned.)

Consequences:
- NULL rows (e.g. from §2.1 restores, or from the `ON DELETE SET NULL` FKs) get scattered into arbitrary owned workspaces on every restart.
- A folder can be healed into workspace A while its lists are healed into workspace B → the lists' `folder_id` dangles from the perspective of workspace B → invisible in the sidebar (§2.8).

### 2.3 ★ Removing a member (or leaving a workspace) strands that member's own content

`DELETE /api/workspaces/:id/members/:userId` (`routes/workspaces.ts:256`) only deletes the membership row. But the *removed member may own lists/timelines/folders/tasks inside that workspace* (`lists.user_id = member`, `lists.workspace_id = W`).

After removal, for a **private** workspace W:
- `GET /api/workspaces` (`WHERE wm.user_id = $1 OR w.owner_id = $1 OR w.visibility = 'public'`) no longer returns W → W disappears from the user's workspace picker.
- Every `GET /api/lists?workspaceId=X` for any selectable X excludes those lists (`workspace_id = W` matches nothing).
- The user's own lists are now unreachable **in every view, forever**, while `user_id`-scoped AI tools still list them. Not in trash → "cannot be restored".

The same happens when the user removes *themselves* (leaving a workspace is explicitly allowed by the `isSelf` branch).

### 2.4 Workspace switched `public → private` strands non-member contributors

`resolveWorkspaceForUser()` allows any user to create content in a **public** workspace (access check passes via `visibility = 'public'`). If the owner later flips the workspace to private (`PUT /api/workspaces/:id`), non-member users who own content inside it lose all access paths to it — identical stranding to §2.3. The existing `restrictDescendants` cascade only fixes `is_public` flags; it does nothing for non-member owners' rows.

### 2.5 Workspace DELETE forgets timelines — and hard-deletes everything without trash

`DELETE /api/workspaces/:id` (`routes/workspaces.ts:166`):

```ts
await client.query(`DELETE FROM tasks   WHERE workspace_id = $1`, [id]);
await client.query(`DELETE FROM lists   WHERE workspace_id = $1`, [id]);
await client.query(`DELETE FROM folders WHERE workspace_id = $1`, [id]);
await client.query(`DELETE FROM workspaces WHERE id = $1`, [id]);
```

Two defects:
- **`timelines` is missing from the cascade.** The `timelines.workspace_id` FK is `ON DELETE SET NULL`, so the workspace delete nulls it → the timeline leaks into *every* workspace view until the next restart, when the §2.2 heal moves it into the owner's first workspace. From other former members' perspective it simply vanishes.
- **Nothing is snapshotted to the trash tables.** Deleting a workspace permanently destroys every list/task/folder inside it with no recovery path — this directly feeds the "cannot be restored" complaint. Every other delete path in the app is a soft delete; this one silently isn't.

### 2.6 AI/MCP-created lists never land in the active workspace

`aiTools.ts` `create_list`/`create_timeline` call `resolveWorkspaceForUser(userId, null)` → always the user's **first-created** workspace (usually Personal), never the workspace the user is currently viewing. The user asks Sol to create a list while looking at workspace X, the list lands in Personal, and the UI shows nothing — reinforcing "the AI sees lists I can't see". (Lower priority; it's consistent, just surprising. Flagged so support can explain the reports.)

### 2.7 Frontend amplifier: workspace switch blanks state, and failed loads keep it blank

`frontend/src/App.tsx` (lines ~115–122): on a real workspace switch the store is cleared (`setLists([])`, `setFolders([])`, `setTimelines([])`) and then `loadFromApi(currentWorkspaceId)` fires **nine parallel requests** (tasks, lists, folders, timelines + five trash buckets). In `useAppStore.loadFromApi` each request is `.catch(() => null)`, and a `null` result means *that slice is silently skipped* — leaving the just-cleared empty array in place, with no error surfaced and no retry.

The global `apiLimiter` is 300 requests / 15 min per IP. One workspace switch = 9 requests; every SSE broadcast also triggers a full 9-request reload (App.tsx:69–73). An active user editing tasks (each edit = 1 mutation + 9-request reload) hits 429 within ~30 edits in a window. When that happens right after a switch: **everything disappears until a later reload succeeds** — and because `useAppStore` persists `lists`/`timelines` to localStorage, the empty state even survives a page refresh. This is the "sometimes, when switching" flavor of the bug.

### 2.8 Frontend amplifier: lists with an unknown `folderId` render nowhere

`Sidebar.tsx`:

```ts
const standaloneListItems = lists.filter(l => !l.folderId);            // line 1194
const folderLists = lists.filter(l => l.folderId === folder.id);       // line 1430 (per rendered folder)
```

A list whose `folderId` refers to a folder **not present in the loaded `folders` array** (folder in another workspace after a bad heal §2.2, folder fetch failed §2.7, restored list with stale folder §2.1) is filtered out of both groups → it renders **nowhere**, even though the API returned it.

---

## 3. Fix plan — production-ready requirements

Work top-down; fixes 1–5 are backend and are the core of the ticket. Everything must respect the security invariants in `CLAUDE.md` (all queries scoped by the verified `user_id`; never trust client-supplied workspace IDs; multi-write operations in `withTransaction`).

### Fix 1 — Trash restore must preserve and re-validate workspace linkage (`routes/trash.ts`)

For **list restore** and **timeline restore** (and folder restore — audit it the same way):

1. Read the original `workspaceId` out of the stored `list_data`/`timeline_data` JSON.
2. Resolve it through `resolveWorkspaceForUser(req.userId, originalWorkspaceId)` — if the user can still access the original workspace, restore there; otherwise it falls back to their Personal workspace (never NULL, never a dangling ID). Log the fallback with `wwarn`.
3. Include `workspace_id` in the `INSERT INTO lists/timelines`, and set the restored tasks' `workspace_id` to the list's resolved workspace (the invariant "an item always lives in its list's workspace" already exists elsewhere — `routes/lists.ts:878`).
4. Restore `parent_task_id` and `depth` for lists, but only if the parent task still exists (`SELECT 1 FROM tasks WHERE id = $parentTaskId AND user_id = $userId`); otherwise restore as a top-level list (`parent_task_id = NULL, depth = 0`).
5. Re-validate `folder_id`: keep it only if the folder still exists, belongs to the user, **and lives in the same resolved workspace**; otherwise set NULL. This prevents the §2.8 invisible-list state and the FK-violation crash.
6. Wrap the *entire* restore (list + sections + tasks + trash-row delete) in `withTransaction`. Same for timeline restore (timeline + milestones + trash-row delete). Partial restores must be impossible.
7. `broadcastToUser(userId, 'lists')` / `'timelines'` after restore (currently only `'trash'` is broadcast — the restored item doesn't appear live for other open tabs).

### Fix 2 — Workspace deletion: include timelines, and soft-delete contents (`routes/workspaces.ts`)

Inside the existing `withTransaction` in `DELETE /api/workspaces/:id`:

1. **Snapshot before deleting.** For every list, timeline, and folder in the workspace, insert the same JSON snapshots the normal delete endpoints produce into `trash_lists` / `trash_timelines` / `trash_folders` (keyed to each item's **owner** `user_id`, not the deleting admin/owner — members' items must land in *their* trash). Reuse/extract the snapshot-building logic from `routes/lists.ts` DELETE and `routes/timelines.ts` DELETE into shared helpers rather than duplicating it.
2. Add the missing `DELETE FROM milestones WHERE timeline_id IN (SELECT id FROM timelines WHERE workspace_id = $1)` and `DELETE FROM timelines WHERE workspace_id = $1` steps (before the workspace row delete, inside the transaction).
3. Broadcast `'lists'`, `'timelines'`, `'folders'`, `'trash'` to every member of the deleted workspace, not just the deleter.

### Fix 3 — Member removal / self-leave must re-home the member's own content (`routes/workspaces.ts`)

In `DELETE /api/workspaces/:id/members/:userId`, inside a transaction:

1. Resolve the removed member's Personal workspace: `ensurePersonalWorkspace(client.query, removedUserId)`.
2. Move everything the removed member **owns** inside the workspace they're leaving:
   ```sql
   UPDATE lists     SET workspace_id = $personal WHERE workspace_id = $ws AND user_id = $removedUser;
   UPDATE timelines SET workspace_id = $personal WHERE workspace_id = $ws AND user_id = $removedUser;
   UPDATE folders   SET workspace_id = $personal WHERE workspace_id = $ws AND user_id = $removedUser;
   UPDATE tasks     SET workspace_id = $personal WHERE workspace_id = $ws AND user_id = $removedUser;
   ```
   Then re-sync tasks to their list's workspace (the existing invariant): tasks whose `list_id` belongs to a list still in the old workspace must stay with the list — run the same `t.workspace_id = l.workspace_id` re-sync scoped to the affected rows. Also clear `folder_id` on moved lists/timelines whose folder stayed behind in the old workspace (otherwise §2.8 hides them again).
3. Then delete the membership row.
4. Log counts with `wlog`, and `broadcastToUser(removedUserId, …)` for `'lists'`, `'timelines'`, `'folders'`, `'workspaces'`.

*Design note:* moving content to the departing member's Personal workspace (rather than leaving it behind or deleting it) is the only option that is simultaneously non-destructive, IDOR-safe, and consistent with "the owner of a row always keeps access to it". If product wants "content stays in the workspace on removal", ownership would have to transfer — that's a product decision; see Open Questions.

### Fix 4 — `public → private` workspace transition (`routes/workspaces.ts` PUT)

When visibility flips to private, apply the same re-homing as Fix 3 for every user who owns content in the workspace but is **not** a member (`user_id NOT IN (SELECT user_id FROM workspace_members WHERE workspace_id = $ws)` and not the owner). Do it inside the existing transaction and include the affected users in the 409 cascade-preview payload so the owner sees the impact before confirming.

### Fix 5 — Make the startup heals deterministic and add a stranded-content self-heal (`index.ts` `runMigrations`)

1. Add `ORDER BY w.created_at ASC` to the three `LIMIT 1` subqueries (lists/folders/tasks NULL-heals) so they match the timelines heal and always pick the Personal workspace.
2. Add a new idempotent heal that **repairs already-stranded production data on deploy** — this is what actually fixes affected customers:
   ```sql
   -- Move content whose owner can no longer access its workspace back to the
   -- owner's first (Personal) workspace.
   UPDATE lists l
   SET workspace_id = (SELECT w.id FROM workspaces w WHERE w.owner_id = l.user_id ORDER BY w.created_at ASC LIMIT 1)
   WHERE l.workspace_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = l.workspace_id AND wm.user_id = l.user_id)
     AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = l.workspace_id AND (w.owner_id = l.user_id OR w.visibility = 'public'));
   ```
   Repeat for `timelines` and `folders`; then run the existing task→list workspace re-sync. Log healed row counts.
3. Add a folder-consistency heal: clear `folder_id` on lists/timelines whose folder is in a **different workspace** than the item (or missing), so nothing can dangle into the §2.8 rendering hole:
   ```sql
   UPDATE lists l SET folder_id = NULL
   FROM folders f
   WHERE l.folder_id = f.id AND l.workspace_id IS DISTINCT FROM f.workspace_id;
   ```
   (plus the same for `timelines`).

Remember the project rule: append these to `runMigrations()` in `index.ts` — no separate migration files.

### Fix 6 — Frontend: never leave the user staring at silently-empty state (`App.tsx`, `useAppStore.ts`)

1. On workspace switch, **stop blanking the store** (`setLists([])` etc. at App.tsx:117–119). Keep the previous data visible and rely on `listsLoading` for a loading indicator; `loadFromApi` fully replaces each slice on success and the existing load-ID/workspace guards already prevent stale writes. If product insists on an instant blank, then it must be paired with (2).
2. In `loadFromApi`, treat a failed core fetch (tasks/lists/folders/timelines) as a **load failure**: keep the previous slice (never persist a cleared slice over real data), set an error flag in the store, and schedule a retry with backoff (e.g. 1s/2s/4s, max 3). Surface a small non-blocking "Couldn't refresh — retrying" toast; on final failure show a retry button. A 429/network blip must never look like data deletion.
3. SSE reloads: reload **only the slice named by the SSE channel** (`'lists'` → lists, `'timelines'` → timelines, …) instead of all nine endpoints. This cuts request volume ~5–9× and makes the 429 scenario (§2.7) practically unreachable, without touching the rate-limit security posture. Do **not** loosen `authLimiter`/`setupLimiter`.

### Fix 7 — Frontend: defensive sidebar grouping (`Sidebar.tsx`)

Treat a list/timeline whose `folderId` doesn't match any loaded folder as standalone instead of dropping it:

```ts
const folderIds = new Set(folders.map(f => f.id));
const standaloneListItems = lists.filter(l => !l.folderId || !folderIds.has(l.folderId));
```

(same for timelines). Backend Fix 5.3 prevents the state; this makes the UI immune to it regardless.

### Fix 8 — Tests (Vitest, `backend/src/__tests__/`)

Minimum coverage for the regression class (mock `query`/use a test DB per existing conventions):

- Restore-from-trash preserves an accessible original workspace; falls back to Personal when the original is inaccessible; never inserts `workspace_id = NULL`; is atomic on mid-restore failure.
- Member removal re-homes the member's lists/timelines/tasks and clears cross-workspace `folder_id`.
- Workspace delete removes timelines + milestones and writes trash snapshots for each owner.
- The stranded-content heal moves an owner-inaccessible list to Personal and is idempotent (second run = 0 rows).

---

## 4. Deployment / verification notes

- **Ship Fix 5 in the same release as everything else** — it's the piece that repairs the data customers have already lost sight of. On deploy, watch the backend logs for the `📋 migration:` healed-row counts.
- Diagnostic query to size the damage in production *before* deploying (read-only):
  ```sql
  SELECT l.id, l.name, l.user_id, l.workspace_id
  FROM lists l
  WHERE l.workspace_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = l.workspace_id AND wm.user_id = l.user_id)
    AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = l.workspace_id AND (w.owner_id = l.user_id OR w.visibility = 'public'));
  ```
  (and the `timelines` twin). Non-zero counts confirm §2.3/§2.4 stranding in the wild.
- Manual test script: (a) two users, shared private workspace, member creates a list, owner removes member → member must find the list in Personal; (b) delete a list, restart backend, restore it → it must reappear in its original workspace; (c) delete a workspace containing a timeline → timeline must be gone from all views and present in its owner's trash; (d) rapid workspace switching under a throttled network → data must reappear, never a persistent empty sidebar. Test at 390 px and 1440 px per house rules.
- Bump the version string in `frontend/src/components/Sidebar.tsx` (both `v1.14.0` literals) on release — minor bump is appropriate.

## 5. Security guardrails (do not regress)

- Re-homing queries must be doubly scoped: `WHERE workspace_id = $ws AND user_id = $affectedUser` — never move another user's rows, never accept a target workspace from the client.
- Trash restore must keep the `user_id = req.userId` scoping on the trash-row lookup (it does today — keep it).
- `resolveWorkspaceForUser` is the only sanctioned way to turn a stored/requested workspace ID into a writable one. Use it everywhere a `workspace_id` is (re)assigned.
- All multi-row mutations above go through `withTransaction`. No partial states.

## 6. Open questions for product (non-blocking — defaults chosen above)

1. On member removal, should the member's content move to their Personal workspace (implemented default) or should ownership transfer to the workspace owner so the content stays? Default chosen: move with the member (non-destructive, least surprising for the content's author).
2. Should deleting a workspace require typing its name to confirm (given it currently nukes content)? With Fix 2 contents become recoverable from trash, but a stronger confirm is cheap insurance.
3. Should AI-created lists (§2.6) target the user's currently active workspace? Would require the frontend to pass the active workspace to `/api/ai/execute` and the tool defs to accept it (server still validates via `resolveWorkspaceForUser`).
