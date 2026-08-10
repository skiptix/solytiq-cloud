import type { PoolClient } from 'pg';
import { query as dbQuery } from './db';

// ---------------------------------------------------------------------------
// B4 (Phase 2) — atomic, validated, bulk reorder.
//
// Every reorder endpoint in this codebase (lists, sections, list tasks,
// timelines, milestones, markdown pages, dash tasks) previously did:
//
//   await Promise.all(ids.map((id, index) => query('UPDATE ... WHERE id=$2', [index, id, ...])))
//
// This has two independent defects this module closes:
//
//   1. NOT ATOMIC. N separate UPDATE statements, each its own implicit
//      transaction, fired concurrently via Promise.all with NO wrapping
//      transaction. If the 6th of 10 statements fails (a transient DB error,
//      a connection drop, a constraint violation on a since-changed row),
//      the first 5 have already committed and the last 4 never ran — the
//      list is left in a genuinely corrupt intermediate order that matches
//      neither the old order nor the new one, and the client sees a 500
//      with no idea which of its intended positions actually landed.
//
//   2. NO VALIDATION. `ids.map(...)` blindly issues an UPDATE for whatever
//      the client sent — a duplicate id in the array silently races itself
//      for a final position, a foreign id (belonging to another user/list)
//      is a no-op UPDATE that the caller has no way to detect, and nothing
//      bounds the array size (an attacker-sized array is O(n) round trips
//      to the database per request).
//
// The fix: `validateReorderIds` rejects a malformed/oversized/duplicate-
// containing array BEFORE any write is attempted, and `bulkSetPositions`
// performs the entire reorder as ONE statement (`UPDATE ... FROM
// unnest(...)`) — a single SQL statement is atomically all-or-nothing by
// Postgres's own guarantee, so there is no intermediate state to observe:
// either every targeted row gets its new position, or (on any error) none
// do and the prior order is exactly as it was. Every call site additionally
// proves every id belongs to the caller's own permitted container via a
// membership SELECT *before* calling this — see each route for its own
// membership check — so `bulkSetPositions`'s own `scopeWhereSql` is a
// second, redundant belt-and-suspenders guard, not the only one.
// ---------------------------------------------------------------------------

/** Server-side hard cap — independent of whatever a client sends. A client
 *  can only ever request FEWER items reordered in one call, never more (see
 *  the shared "every list has a server-side maximum" invariant from B5). */
export const MAX_REORDER_ITEMS = 500;

export type ReorderValidation =
  | { ok: true; ids: Array<string | number> }
  | { ok: false; status: number; error: string };

/**
 * Validates a reorder request body's id array: must be an array, within the
 * server-side size cap, every entry a well-formed id of the expected kind,
 * and free of duplicates. Pure — no DB access, no side effects — so it's
 * unit-testable with zero mocking.
 */
export function validateReorderIds(raw: unknown, idKind: 'string' | 'number'): ReorderValidation {
  if (!Array.isArray(raw)) return { ok: false, status: 400, error: 'ids must be an array' };
  if (raw.length > MAX_REORDER_ITEMS) {
    return { ok: false, status: 400, error: `ids exceeds the maximum of ${MAX_REORDER_ITEMS} items per request` };
  }
  for (const v of raw) {
    if (idKind === 'string') {
      if (typeof v !== 'string' || v.length === 0) return { ok: false, status: 400, error: 'every id must be a non-empty string' };
    } else {
      if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
        return { ok: false, status: 400, error: 'every id must be a finite integer' };
      }
    }
  }
  const unique = new Set(raw);
  if (unique.size !== raw.length) return { ok: false, status: 400, error: 'ids must not contain duplicate entries' };
  return { ok: true, ids: raw as Array<string | number> };
}

export type ReorderTable = 'lists' | 'sections' | 'tasks' | 'timelines' | 'milestones' | 'markdown_lists';

/**
 * Sets `position = <index within ids>` for every row in `ids` that ALSO
 * matches `scopeWhereSql` — one bulk `UPDATE ... FROM unnest(...)`
 * statement, atomic by construction (see module header). `scopeWhereSql`
 * must be a caller-controlled, HARD-CODED literal (never built from request
 * input) referencing the target table as `t` and any additional params as
 * `$3`, `$4`, ... (positions 1 and 2 are always the id array and the
 * position array). Returns the number of rows actually updated — the
 * caller compares this against `ids.length` to detect a partial-membership
 * mismatch (some ids didn't belong to the claimed scope) even though the
 * membership pre-check should already have caught that; belt-and-suspenders,
 * not the only guard.
 */
export async function bulkSetPositions(
  table: ReorderTable,
  idSqlType: 'varchar' | 'bigint',
  ids: Array<string | number>,
  scopeWhereSql: string,
  scopeParams: unknown[],
  client?: Pick<PoolClient, 'query'>,
): Promise<number> {
  if (ids.length === 0) return 0;
  const exec = client ?? { query: dbQuery };
  const positions = ids.map((_, i) => i);
  const sql =
    `UPDATE ${table} AS t
     SET position = data.position
     FROM (SELECT * FROM unnest($1::${idSqlType}[], $2::int[]) AS d(id, position)) AS data
     WHERE t.id = data.id AND (${scopeWhereSql})`;
  const result = await exec.query(sql, [ids, positions, ...scopeParams]);
  return result.rowCount ?? 0;
}
