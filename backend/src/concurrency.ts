import { query } from './db';

// ---------------------------------------------------------------------------
// B4 (Phase 2) — atomic optimistic concurrency.
//
// The PREVIOUS implementation here (`checkVersionConflict`) ran a bare
// `SELECT version FROM <table> WHERE id = $1` as its own standalone
// statement, and every call site then ran a SEPARATE `UPDATE ... WHERE id =
// $id` (no version predicate at all) afterward. That is a textbook
// check-then-act race: two concurrent requests both loading `expectedVersion
// = 5` could both pass the SELECT-based check (neither has committed yet),
// and then BOTH UPDATEs would succeed — Postgres serializes the two writes
// via its own row lock, so the second writer's UPDATE still runs and still
// commits, silently overwriting the first writer's change with whatever
// fields the second writer's own buffered edit held. Neither request ever
// saw a 409; the loser's edit was clobbered without anyone being told.
//
// The fix: fold the version check directly into the UPDATE statement's own
// WHERE clause (`versionGuardSql`), so the check and the write are the SAME
// atomic SQL statement — there is no window between them for a second writer
// to sneak through. Postgres's row-level locking on UPDATE does the rest:
// the first writer to reach the row wins and bumps `version` (via the
// existing `bump_version()` BEFORE UPDATE trigger — see migrations.ts); the
// second writer's UPDATE then evaluates its WHERE clause against the
// ALREADY-bumped row, matches zero rows, and the caller reports 409.
//
// `resolveVersionedUpdateFailure` is the one place a zero-row result gets
// disambiguated into 404 (row genuinely gone) vs 409 (version mismatch) — a
// single READ-ONLY follow-up query, never a second write, so it can't itself
// introduce a new race: worst case is a millisecond-stale `currentVersion` in
// the error body, never an incorrect mutation.
// ---------------------------------------------------------------------------

export type VersionedTable = 'lists' | 'timelines' | 'automations' | 'markdown_lists' | 'graph_canvases';

/**
 * Appends `AND version = $N` to an UPDATE's WHERE clause and pushes the
 * corresponding param, ONLY when the client actually sent a numeric
 * `expectedVersion` — an absent value means "no concurrency check requested"
 * (a legacy/simple client), matching the exact optional contract the old
 * `checkVersionConflict` had. `params` must already contain every other
 * positional parameter the caller's UPDATE statement uses, in order — this
 * function only ever APPENDS, so existing `$1..$N` placeholders in the
 * caller's SQL text stay valid.
 */
export function versionGuardSql(params: unknown[], expectedVersion: unknown): string {
  if (typeof expectedVersion !== 'number' || !Number.isFinite(expectedVersion)) return '';
  params.push(expectedVersion);
  return ` AND version = $${params.length}`;
}

export type VersionedUpdateFailure =
  | { notFound: true }
  | { notFound: false; currentVersion: number };

/**
 * Called ONLY after a versioned UPDATE returned zero rows, to decide whether
 * the caller should respond 404 (row doesn't exist / already deleted) or 409
 * (row exists, but its version had already moved past what the client
 * expected). Read-only — see the module header for why this can't reintroduce
 * a race.
 */
export async function resolveVersionedUpdateFailure(
  table: VersionedTable,
  id: string,
): Promise<VersionedUpdateFailure> {
  const r = await query<{ version: number }>(`SELECT version FROM ${table} WHERE id = $1`, [id]);
  if (r.rows.length === 0) return { notFound: true };
  return { notFound: false, currentVersion: r.rows[0].version };
}
