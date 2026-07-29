// ---------------------------------------------------------------------------
// One-time backfill: materialize the 5 pre-existing "hard link" mechanisms
// (sublists, task↔list links, the markdown-page Todo sync, and the two
// attachment tables) as real entity_links rows, `origin = 'system'`.
//
// This is Phase R1 of the rolling refactor described in the graph-layer
// design doc (§6): purely additive — the legacy columns/tables that are the
// SOURCE of truth today are untouched, so nothing about existing behavior
// changes. Every statement is `ON CONFLICT DO NOTHING` against entity_links'
// unique index, so re-running this on every startup (as runMigrations() does)
// converges to zero additional rows after the first run — see
// backend/src/__tests__/linkMigration.test.ts.
//
// Extracted into its own function (rather than inlined in runMigrations())
// so it's unit-testable against a mock QueryExec without a live database,
// matching the convention in workspaceUtil.ts / trashUtil.ts.
// ---------------------------------------------------------------------------

import type { QueryExec } from '../workspaceUtil';

async function backfillSublistChildOf(exec: QueryExec): Promise<void> {
  // tasks.linked_list_id (type 'sublist') → the LIST is the task's child.
  await exec(`
    INSERT INTO entity_links (id, workspace_id, src_type, src_id, dst_type, dst_id, link_type, origin, created_by, created_at)
    SELECT 'lnk_' || gen_random_uuid(), t.workspace_id,
           'list', t.linked_list_id, 'task', t.id::text,
           'child_of', 'system', t.user_id, t.created_at
      FROM tasks t
     WHERE t.linked_list_id IS NOT NULL AND t.linked_list_type = 'sublist'
       AND EXISTS (SELECT 1 FROM entity_index e WHERE e.entity_type = 'list' AND e.entity_id = t.linked_list_id)
       AND EXISTS (SELECT 1 FROM entity_index e WHERE e.entity_type = 'task' AND e.entity_id = t.id::text)
    ON CONFLICT DO NOTHING
  `);
}

async function backfillTaskLinksTo(exec: QueryExec): Promise<void> {
  // tasks.linked_list_id (type 'link') → a plain reference, task → list.
  await exec(`
    INSERT INTO entity_links (id, workspace_id, src_type, src_id, dst_type, dst_id, link_type, origin, created_by, created_at)
    SELECT 'lnk_' || gen_random_uuid(), t.workspace_id,
           'task', t.id::text, 'list', t.linked_list_id,
           'links_to', 'system', t.user_id, t.created_at
      FROM tasks t
     WHERE t.linked_list_id IS NOT NULL AND t.linked_list_type = 'link'
       AND EXISTS (SELECT 1 FROM entity_index e WHERE e.entity_type = 'list' AND e.entity_id = t.linked_list_id)
       AND EXISTS (SELECT 1 FROM entity_index e WHERE e.entity_type = 'task' AND e.entity_id = t.id::text)
    ON CONFLICT DO NOTHING
  `);
}

async function backfillParentTaskIdChildOf(exec: QueryExec): Promise<void> {
  // lists.parent_task_id — the OTHER (redundant, divergence-prone) representation
  // of the same relationship as #1. Filling any gap where the two disagree.
  await exec(`
    INSERT INTO entity_links (id, workspace_id, src_type, src_id, dst_type, dst_id, link_type, origin, created_by, created_at)
    SELECT 'lnk_' || gen_random_uuid(), l.workspace_id,
           'list', l.id, 'task', l.parent_task_id::text,
           'child_of', 'system', l.user_id, l.created_at
      FROM lists l
     WHERE l.parent_task_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM entity_index e WHERE e.entity_type = 'task' AND e.entity_id = l.parent_task_id::text)
    ON CONFLICT DO NOTHING
  `);
}

async function backfillMarkdownTracks(exec: QueryExec): Promise<void> {
  // markdown_lists.todo_list_id → the page tracks its auto-managed Todo list.
  await exec(`
    INSERT INTO entity_links (id, workspace_id, src_type, src_id, dst_type, dst_id, link_type, origin, created_by, created_at)
    SELECT 'lnk_' || gen_random_uuid(), m.workspace_id,
           'markdownList', m.id, 'list', m.todo_list_id,
           'tracks', 'system', m.user_id, m.created_at
      FROM markdown_lists m
     WHERE m.todo_list_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM entity_index e WHERE e.entity_type = 'list' AND e.entity_id = m.todo_list_id)
    ON CONFLICT DO NOTHING
  `);
}

async function backfillTaskAttachments(exec: QueryExec): Promise<void> {
  // task_attachments (type 'linked' — the only kind that names a durable,
  // independently-owned shared_files row) → attached_to.
  await exec(`
    INSERT INTO entity_links (id, workspace_id, src_type, src_id, dst_type, dst_id, link_type, origin, created_by, created_at)
    SELECT 'lnk_' || gen_random_uuid(), t.workspace_id,
           'file', a.shared_file_id, 'task', a.task_id::text,
           'attached_to', 'system', a.user_id, a.created_at
      FROM task_attachments a
      JOIN tasks t ON t.id = a.task_id
     WHERE a.shared_file_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM entity_index e WHERE e.entity_type = 'file' AND e.entity_id = a.shared_file_id)
    ON CONFLICT DO NOTHING
  `);
}

async function backfillMilestoneAttachments(exec: QueryExec): Promise<void> {
  await exec(`
    INSERT INTO entity_links (id, workspace_id, src_type, src_id, dst_type, dst_id, link_type, origin, created_by, created_at)
    SELECT 'lnk_' || gen_random_uuid(), tl.workspace_id,
           'file', a.shared_file_id, 'milestone', a.milestone_id,
           'attached_to', 'system', a.user_id, a.created_at
      FROM milestone_attachments a
      JOIN milestones ms ON ms.id = a.milestone_id
      JOIN timelines tl ON tl.id = ms.timeline_id
     WHERE a.shared_file_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM entity_index e WHERE e.entity_type = 'file' AND e.entity_id = a.shared_file_id)
    ON CONFLICT DO NOTHING
  `);
}

async function backfillStructuralPartOf(exec: QueryExec): Promise<void> {
  // Purely structural edges derived from existing FKs — hidden from the graph
  // explore view by default (link-type registry's `showInGraph: false`).
  await exec(`
    INSERT INTO entity_links (id, workspace_id, src_type, src_id, dst_type, dst_id, link_type, origin, created_at)
    SELECT 'lnk_' || gen_random_uuid(), tl.workspace_id, 'milestone', ms.id, 'timeline', ms.timeline_id, 'part_of', 'system', ms.created_at
      FROM milestones ms
      JOIN timelines tl ON tl.id = ms.timeline_id
     WHERE EXISTS (SELECT 1 FROM entity_index e WHERE e.entity_type = 'milestone' AND e.entity_id = ms.id)
    ON CONFLICT DO NOTHING
  `);
  await exec(`
    INSERT INTO entity_links (id, workspace_id, src_type, src_id, dst_type, dst_id, link_type, origin, created_at)
    SELECT 'lnk_' || gen_random_uuid(), t.workspace_id, 'task', t.id::text, 'list', t.list_id, 'part_of', 'system', t.created_at
      FROM tasks t
     WHERE t.list_id IS NOT NULL AND t.source = 'list'
    ON CONFLICT DO NOTHING
  `);
}

/**
 * Run every hard-link backfill statement, in order. Safe to call on every
 * startup — each statement is `ON CONFLICT DO NOTHING`, so a second run
 * inserts zero additional rows (see linkMigration.test.ts's idempotency
 * assertions). Must run AFTER entity_index has been fully populated (both
 * endpoints of every backfilled edge must already have an entity_index row,
 * or the composite FK on entity_links rejects the insert).
 */
export async function backfillHardLinks(exec: QueryExec): Promise<void> {
  await backfillSublistChildOf(exec);
  await backfillTaskLinksTo(exec);
  await backfillParentTaskIdChildOf(exec);
  await backfillMarkdownTracks(exec);
  await backfillTaskAttachments(exec);
  await backfillMilestoneAttachments(exec);
  await backfillStructuralPartOf(exec);
}
