// ---------------------------------------------------------------------------
// Task change log — audit trail behind the Timeline view's per-task change
// markers and TaskDialog's "Change history" panel (see TaskTimelineView.tsx
// / TaskChangeHistory.tsx on the frontend).
//
// recordTaskChanges() is the single place that diffs a task's tracked
// fields and writes task_change_log rows. It's deliberately snapshot-based
// (before/after values, not SQL introspection) so any call site — the HTTP
// task-update route, the Automation Hub's consolidated Task "edit"
// operation (via updateListTaskFields), or the hidden rename_task/move_task
// actions doing a narrower raw UPDATE — can feed it whatever slice of
// fields it actually knows the before/after value of. Only keys present in
// BOTH `before` and `after` are compared, so a caller that only touched one
// field (e.g. rename_task) doesn't need to fetch/pass the rest.
// ---------------------------------------------------------------------------

import { QueryExec } from './workspaceUtil';
import type { MutationActor } from './automationEngine';

export type TaskChangeField = 'title' | 'note' | 'deadline' | 'priority' | 'badge' | 'section' | 'checked';

export interface TaskChangeSnapshot {
  title?: string;
  note?: string | null;
  deadline?: string | null;
  priority?: string | null;
  badge?: string | null;
  section_id?: string | null;
  checked?: boolean;
}

const NOTE_PREVIEW_LEN = 300;

function previewNote(note: string | null | undefined): string | null {
  if (!note) return null;
  const trimmed = note.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > NOTE_PREVIEW_LEN ? `${trimmed.slice(0, NOTE_PREVIEW_LEN)}…` : trimmed;
}

async function resolveActorName(exec: QueryExec, actor: MutationActor): Promise<string | null> {
  if (actor.type === 'user') {
    const r = await exec(`SELECT username FROM users WHERE id = $1`, [actor.userId]);
    return r.rows.length > 0 ? (r.rows[0] as { username: string }).username : null;
  }
  const r = await exec(`SELECT name FROM automations WHERE id = $1`, [actor.automationId]);
  return r.rows.length > 0 ? (r.rows[0] as { name: string }).name : null;
}

export async function recordTaskChanges(
  exec: QueryExec,
  listId: string,
  taskId: string | number,
  before: TaskChangeSnapshot,
  after: TaskChangeSnapshot,
  actor: MutationActor
): Promise<void> {
  const diffs: { field: TaskChangeField; oldValue: string | null; newValue: string | null }[] = [];

  if (before.title !== undefined && after.title !== undefined && before.title !== after.title) {
    diffs.push({ field: 'title', oldValue: before.title, newValue: after.title });
  }
  if (before.note !== undefined && after.note !== undefined && (before.note ?? '') !== (after.note ?? '')) {
    diffs.push({ field: 'note', oldValue: previewNote(before.note), newValue: previewNote(after.note) });
  }
  if (before.deadline !== undefined && after.deadline !== undefined && before.deadline !== after.deadline) {
    diffs.push({ field: 'deadline', oldValue: before.deadline, newValue: after.deadline });
  }
  if (before.priority !== undefined && after.priority !== undefined && before.priority !== after.priority) {
    diffs.push({ field: 'priority', oldValue: before.priority, newValue: after.priority });
  }
  if (before.badge !== undefined && after.badge !== undefined && before.badge !== after.badge) {
    diffs.push({ field: 'badge', oldValue: before.badge, newValue: after.badge });
  }
  if (before.checked !== undefined && after.checked !== undefined && before.checked !== after.checked) {
    diffs.push({ field: 'checked', oldValue: String(before.checked), newValue: String(after.checked) });
  }
  if (before.section_id !== undefined && after.section_id !== undefined && before.section_id !== after.section_id) {
    const ids = [before.section_id, after.section_id].filter((v): v is string => !!v);
    let labels: Record<string, string> = {};
    if (ids.length > 0) {
      const rows = await exec(`SELECT id, label FROM sections WHERE id = ANY($1)`, [ids]);
      labels = Object.fromEntries((rows.rows as { id: string; label: string }[]).map((r) => [r.id, r.label]));
    }
    diffs.push({
      field: 'section',
      oldValue: before.section_id ? labels[before.section_id] ?? null : null,
      newValue: after.section_id ? labels[after.section_id] ?? null : null,
    });
  }

  if (diffs.length === 0) return;

  const actorId = actor.type === 'user' ? actor.userId : actor.automationId;
  const actorName = await resolveActorName(exec, actor);

  for (const d of diffs) {
    await exec(
      `INSERT INTO task_change_log (task_id, list_id, field, old_value, new_value, actor_type, actor_id, actor_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [taskId, listId, d.field, d.oldValue, d.newValue, actor.type, actorId, actorName]
    );
  }
}
