// ---------------------------------------------------------------------------
// B6 (Phase 2) — measured, evidence-backed hot-path indexes.
//
// Every index below was added ONLY after confirming BOTH (a) the exact query
// shape actually issued by a route (grepped/read directly, not guessed) and
// (b) that no existing index already served it — see the Phase 2 handoff's
// B6 section for the full before/after `EXPLAIN (ANALYZE, BUFFERS)` evidence
// against a 100k+-row seed (backend/src/__tests__/queryPlans.perf.test.ts).
//
// Every step here is `concurrent: true` — see versionedMigrations.ts's own
// header for why (`CREATE INDEX CONCURRENTLY` cannot run inside the
// transaction wrapper an ordinary step gets, and CONCURRENTLY is what avoids
// taking an ACCESS EXCLUSIVE lock on a production table for the build's
// full duration, which is the entire point of measuring "large production
// index" rollout-safety at all).
//
// One deliberately SKIPPED candidate, for the record (a database invariant
// documented here so it isn't silently "discovered" and re-investigated
// later): `workspace_members(user_id)` was NOT added. Every call site that
// queries `workspace_members` (objectPolicy.ts, workspaceUtil.ts, search.ts,
// taskTags.ts, timelines.ts, folders.ts, markdownLists.ts, workspaces.ts,
// aiTools.ts, mentions.ts, syncLog.ts — grepped exhaustively) always supplies
// `workspace_id` as a known bound (either a literal or an outer join row),
// which the existing PRIMARY KEY `(workspace_id, user_id)` already serves
// via leftmost-prefix — a standalone `user_id` index would only help a query
// that filters by `user_id` with NO `workspace_id` bound at all, which does
// not exist in this codebase today. Adding one anyway would be exactly the
// "Indexsammlung ohne Query-Evidenz" this sprint's own gate forbids.
// ---------------------------------------------------------------------------

import { pool } from './db';
import type { VersionedMigration } from './versionedMigrations';

function concurrentIndexStep(opts: { id: string; description: string; indexName: string; sql: string }): VersionedMigration {
  return {
    id: opts.id,
    description: opts.description,
    concurrent: true,
    indexName: opts.indexName,
    up: async () => { await pool.query(opts.sql); },
  };
}

export const B6_INDEX_MIGRATIONS: VersionedMigration[] = [
  // Attachments by parent — `task_attachments` had ZERO index on `task_id`
  // before this. Every list/task hydration (routes/lists.ts's
  // buildListsForUser/getListForUser, routes/tasks.ts) runs a CORRELATED
  // subquery `(SELECT COUNT(*) FROM task_attachments ta WHERE ta.task_id =
  // t.id)` once PER TASK ROW — with no index this is a sequential scan of
  // the entire task_attachments table for every single task on every list
  // load, an O(tasks × attachments) access pattern.
  concurrentIndexStep({
    id: '2026_08_09_idx_task_attachments_task_id',
    description: 'CONCURRENTLY index task_attachments(task_id) — hot per-row correlated subquery in list/task hydration',
    indexName: 'task_attachments_task_id_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS task_attachments_task_id_idx ON task_attachments(task_id)`,
  }),

  // Sections by list, in position order — `SELECT * FROM sections WHERE
  // list_id = $1 ORDER BY position ASC` (routes/lists.ts's getListForUser
  // and buildListsForUser's JOIN variant) — every single Board screen load.
  concurrentIndexStep({
    id: '2026_08_09_idx_sections_list_position',
    description: 'CONCURRENTLY index sections(list_id, position) — every Board screen load',
    indexName: 'sections_list_position_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS sections_list_position_idx ON sections(list_id, position)`,
  }),

  // List tasks, in position order — `SELECT t.* FROM tasks t WHERE
  // t.list_id = $1 AND t.source = 'list' ORDER BY t.position ASC,
  // t.created_at ASC` (routes/lists.ts, routes/tasks.ts). Partial on
  // `source = 'list'` — the exact predicate every one of these queries
  // already carries, so the index stays smaller than an unfiltered one
  // while still matching every observed call site.
  concurrentIndexStep({
    id: '2026_08_09_idx_tasks_list_position',
    description: "CONCURRENTLY partial index tasks(list_id, position) WHERE source='list' — Board screen task hydration",
    indexName: 'tasks_list_position_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_list_position_idx ON tasks(list_id, position) WHERE source = 'list'`,
  }),

  // Tasks within one section — `SELECT MAX(position) FROM tasks WHERE
  // section_id = $1` (task creation, three call sites in routes/lists.ts)
  // and the section-scoped reorder's membership check.
  concurrentIndexStep({
    id: '2026_08_09_idx_tasks_section_position',
    description: 'CONCURRENTLY index tasks(section_id, position) — task creation/reorder within a section',
    indexName: 'tasks_section_position_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_section_position_idx ON tasks(section_id, position)`,
  }),

  // Workspace-scoped lists/folders/timelines — `l.workspace_id = $2 OR
  // l.workspace_id IS NULL` (routes/lists.ts, routes/folders.ts,
  // routes/timelines.ts) on every workspace-switch/load. A partial index
  // already existed for `lists WHERE is_archived = true` only (the
  // Archived-modal query); this covers the far more common non-archived
  // path (every normal Board/sidebar view).
  concurrentIndexStep({
    id: '2026_08_09_idx_lists_workspace_id',
    description: 'CONCURRENTLY index lists(workspace_id) — workspace switch/load, distinct from the existing archived-only partial index',
    indexName: 'lists_workspace_id_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS lists_workspace_id_idx ON lists(workspace_id)`,
  }),
  concurrentIndexStep({
    id: '2026_08_09_idx_folders_workspace_id',
    description: 'CONCURRENTLY index folders(workspace_id) — workspace switch/load',
    indexName: 'folders_workspace_id_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS folders_workspace_id_idx ON folders(workspace_id)`,
  }),
  concurrentIndexStep({
    id: '2026_08_09_idx_timelines_workspace_id',
    description: 'CONCURRENTLY index timelines(workspace_id) — workspace switch/load',
    indexName: 'timelines_workspace_id_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS timelines_workspace_id_idx ON timelines(workspace_id)`,
  }),

  // Files by user, newest first — `WHERE user_id = $1 ... ORDER BY
  // created_at DESC` (routes/files.ts's list endpoint's window function,
  // and storageQuota.ts's per-user SUM(file_size) run on EVERY upload via
  // withQuotaReservation's advisory-locked transaction).
  concurrentIndexStep({
    id: '2026_08_09_idx_shared_files_user_created',
    description: 'CONCURRENTLY index shared_files(user_id, created_at DESC) — Files screen listing + every quota-reservation SUM',
    indexName: 'shared_files_user_created_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS shared_files_user_created_idx ON shared_files(user_id, created_at DESC)`,
  }),
];
