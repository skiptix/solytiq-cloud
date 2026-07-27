/**
 * Pure helpers for the all-workspace Overall Dashboard (DashboardScreen).
 *
 * Kept free of React/stores so the date-window filtering, completion counts and
 * task-source resolution can be unit-tested in isolation (see
 * `__tests__/dashboard.test.ts`).
 */
import type { Task, List, MarkdownList } from '../types';

export type TaskSourceKind = 'list' | 'markdown' | 'dashboard';

export interface TaskSource {
  kind: TaskSourceKind;
  /** Human label shown in grey next to the workspace badge. */
  name: string;
  emoji?: string | null;
  /** The workspace the task lives in — drives which workspace icon the badge shows. */
  workspaceId?: string | null;
}

/** `YYYY-MM-DD` shifted by whole days, computed in local calendar terms (no UTC
 *  round-trip, so it never slips a day in non-UTC timezones). */
export function addDaysIso(iso: string, days: number): string {
  const dt = new Date(iso.slice(0, 10) + 'T00:00:00');
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/** True when the deadline falls exactly on `todayIso`. */
export function isDueToday(deadline: string | null | undefined, todayIso: string): boolean {
  return !!deadline && deadline.slice(0, 10) === todayIso;
}

/** True when the deadline falls inside the `n`-day window that starts today and
 *  includes it: `todayIso <= deadline <= todayIso + (n - 1)`. "Next 7 days
 *  including today" is `n = 7` → today … today+6. */
export function isDueWithinNextDays(deadline: string | null | undefined, todayIso: string, n: number): boolean {
  if (!deadline) return false;
  const d = deadline.slice(0, 10);
  return d >= todayIso && d <= addDaysIso(todayIso, n - 1);
}

/** True when the deadline is strictly before today and the task is still open. */
export function isOverdue(task: Pick<Task, 'deadline' | 'checked'>, todayIso: string): boolean {
  return !!task.deadline && task.deadline.slice(0, 10) < todayIso && !task.checked;
}

export interface TaskCounts { total: number; completed: number; open: number; }

/** Completed vs open split (drives both donut charts). */
export function countTasks(tasks: Array<Pick<Task, 'checked'>>): TaskCounts {
  let completed = 0;
  for (const t of tasks) if (t.checked) completed++;
  return { total: tasks.length, completed, open: tasks.length - completed };
}

/** Percent complete as a whole number (0 when there are no tasks). */
export function pctComplete(counts: TaskCounts): number {
  return counts.total > 0 ? Math.round((counts.completed / counts.total) * 100) : 0;
}

/**
 * Resolve the badge label + owning workspace for a task's source container.
 * A markdown page's auto-managed Todo list resolves to the *page's* name/emoji
 * (not the generated Todo list), so the badge reads the way the user thinks of it.
 */
export function resolveTaskSource(
  task: Task,
  listById: Map<string, List>,
  mdByTodoListId: Map<string, MarkdownList>,
): TaskSource {
  const listId = task._listId ?? undefined;
  if (task._source === 'list' && listId) {
    const md = mdByTodoListId.get(listId);
    if (md) return { kind: 'markdown', name: md.name, emoji: md.emoji, workspaceId: md.workspaceId ?? task.workspaceId ?? null };
    const list = listById.get(listId);
    if (list) return { kind: 'list', name: list.name, emoji: list.emoji, workspaceId: list.workspaceId ?? task.workspaceId ?? null };
    return { kind: 'list', name: task._listName ?? 'Board', workspaceId: task.workspaceId ?? null };
  }
  return { kind: 'dashboard', name: 'Dashboard', workspaceId: task.workspaceId ?? null };
}

/** Ascending by deadline (undated last), then by time-of-day. Used for the
 *  Today / Next-7-days lists so the nearest deadline sits on top. */
export function sortByDeadline(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const da = a.deadline ?? '9999-12-31';
    const db = b.deadline ?? '9999-12-31';
    if (da !== db) return da < db ? -1 : 1;
    const ta = a.time ?? '99:99';
    const tb = b.time ?? '99:99';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
}

/** Most-recently-created first — the "newest tasks" timeline mode. */
export function sortByNewest(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const ca = a.createdAt ?? '';
    const cb = b.createdAt ?? '';
    return ca < cb ? 1 : ca > cb ? -1 : 0;
  });
}
