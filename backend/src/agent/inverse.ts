// ---------------------------------------------------------------------------
// Agent Runtime — revert support for a curated, explicitly-tracked subset of
// mutating tools. This is NOT a generic "undo anything the agent did" system:
// building one on top of the shared AI tool registry (aiTools.ts) would need
// every one of its 40+ handlers to report structured before/after state, and
// most only return a human-readable summary string. Instead, this module
// snapshots the state IT needs directly (via the same tables the tool itself
// touches) around a small set of tools where doing so is straightforward and
// correct, and reports every other tool call as simply not revertible —
// visible in the run trace, never silently wrong.
//
// Extending coverage later just means adding another entry to
// REVERTIBLE_TOOLS with its own snapshot/apply pair; the runtime loop,
// agent_mutations table, and POST /revert endpoint are already fully general.
// ---------------------------------------------------------------------------

import type { QueryExec } from '../workspaceUtil';

export interface MutationRecord {
  toolName: string;
  entityType: string;
  entityId: string;
  /** Full prior-state snapshot for an update/delete; null for a create (nothing existed before). */
  beforeState: Record<string, unknown> | null;
}

interface RevertHandler {
  entityType: string;
  /** Snapshot whatever "before" state is needed, BEFORE the tool runs. Only defined for update/delete-shaped tools — a create has no "before". */
  snapshotBefore?: (args: Record<string, unknown>, userId: string, exec: QueryExec) => Promise<Record<string, unknown> | null>;
  /** After the tool ran (and after `before` was captured, if any), resolve the mutation's entity id + finalize its record. */
  afterRun: (args: Record<string, unknown>, userId: string, before: Record<string, unknown> | null, exec: QueryExec) => Promise<{ entityId: string; beforeState: Record<string, unknown> | null } | null>;
  /** Apply the inverse — restore `beforeState` (update/delete) or remove the created entity (create). */
  revert: (entityId: string, beforeState: Record<string, unknown> | null, userId: string, exec: QueryExec) => Promise<void>;
}

const TASK_COLUMNS = 'id, user_id, source, list_id, section_id, title, note, checked, deadline, priority, badge, position';

const REVERT_HANDLERS: Record<string, RevertHandler> = {
  update_task: {
    entityType: 'task',
    snapshotBefore: async (args, userId, exec) => {
      const taskId = Number(args.task_id);
      if (!Number.isFinite(taskId)) return null;
      const r = await exec(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $1 AND user_id = $2`, [taskId, userId]);
      return (r.rows[0] as Record<string, unknown>) ?? null;
    },
    afterRun: async (args, _userId, before) => {
      const taskId = Number(args.task_id);
      if (!Number.isFinite(taskId) || !before) return null;
      return { entityId: String(taskId), beforeState: before };
    },
    revert: async (entityId, beforeState, userId, exec) => {
      if (!beforeState) return;
      const b = beforeState;
      await exec(
        `UPDATE tasks SET title = $1, note = $2, checked = $3, deadline = $4, priority = $5, badge = $6 WHERE id = $7 AND user_id = $8`,
        [b.title, b.note, b.checked, b.deadline, b.priority, b.badge, entityId, userId]
      );
    },
  },

  delete_task: {
    entityType: 'task',
    snapshotBefore: async (args, userId, exec) => {
      const taskId = Number(args.task_id);
      if (!Number.isFinite(taskId)) return null;
      const r = await exec(`SELECT * FROM tasks WHERE id = $1 AND user_id = $2`, [taskId, userId]);
      return (r.rows[0] as Record<string, unknown>) ?? null;
    },
    afterRun: async (args, _userId, before) => {
      const taskId = Number(args.task_id);
      if (!Number.isFinite(taskId) || !before) return null;
      return { entityId: String(taskId), beforeState: before };
    },
    revert: async (_entityId, beforeState, _userId, exec) => {
      if (!beforeState) return;
      const cols = Object.keys(beforeState);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      await exec(
        `INSERT INTO tasks (${cols.join(', ')}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`,
        cols.map((c) => beforeState[c])
      );
    },
  },

  create_task: {
    entityType: 'task',
    // No "before" — the task doesn't exist yet.
    afterRun: async (args, userId, _before, exec) => {
      const title = typeof args.title === 'string' ? args.title : null;
      if (!title) return null;
      // Task ids are Date.now()-based and monotonically increasing per this
      // codebase's convention (see genTaskId() in aiTools.ts) — the newest
      // matching row for this user is, in a sequential single-threaded tool
      // loop, unambiguously the one this call just created.
      const r = await exec(`SELECT id FROM tasks WHERE user_id = $1 AND title = $2 ORDER BY id DESC LIMIT 1`, [userId, title]);
      const row = r.rows[0] as { id: string | number } | undefined;
      if (!row) return null;
      return { entityId: String(row.id), beforeState: null };
    },
    revert: async (entityId, _beforeState, userId, exec) => {
      await exec(`DELETE FROM tasks WHERE id = $1 AND user_id = $2`, [entityId, userId]);
    },
  },
};

export const REVERTIBLE_TOOL_NAMES = new Set(Object.keys(REVERT_HANDLERS));

/** Snapshot whatever "before" state a revertible tool needs, BEFORE it runs. No-op (returns null) for a non-revertible or create-shaped tool. */
export async function snapshotBeforeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  userId: string,
  exec: QueryExec
): Promise<Record<string, unknown> | null> {
  const handler = REVERT_HANDLERS[toolName];
  if (!handler?.snapshotBefore) return null;
  try {
    return await handler.snapshotBefore(args, userId, exec);
  } catch {
    return null;
  }
}

/** After a revertible tool ran successfully, build the mutation record the run should log. Returns null if this tool isn't tracked or the entity couldn't be resolved. */
export async function buildMutationRecord(
  toolName: string,
  args: Record<string, unknown>,
  before: Record<string, unknown> | null,
  userId: string,
  exec: QueryExec
): Promise<MutationRecord | null> {
  const handler = REVERT_HANDLERS[toolName];
  if (!handler) return null;
  try {
    const result = await handler.afterRun(args, userId, before, exec);
    if (!result) return null;
    return { toolName, entityType: handler.entityType, entityId: result.entityId, beforeState: result.beforeState };
  } catch {
    return null;
  }
}

/** Apply one mutation's inverse. Throws on failure — the caller (revert endpoint) records the error per-mutation and keeps going. */
export async function revertMutation(mutation: MutationRecord, userId: string, exec: QueryExec): Promise<void> {
  const handler = REVERT_HANDLERS[mutation.toolName];
  if (!handler) throw new Error(`"${mutation.toolName}" is not revertible`);
  await handler.revert(mutation.entityId, mutation.beforeState, userId, exec);
}
