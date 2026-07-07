import { query } from './db';

/**
 * Optimistic-concurrency guard for entities that carry an auto-incrementing
 * `version` (lists, timelines). When the client sends the `expectedVersion` it
 * loaded, the handler compares it against the row's CURRENT version before
 * writing; a mismatch means someone else committed a change in the meantime, so
 * the write is rejected with 409 and the client reconciles to the winner
 * (which also arrives via the next delta).
 *
 * Returns the current version when there IS a conflict (caller responds 409),
 * or null when the write may proceed (no expectedVersion sent, or it matches).
 * `table` is only ever a hard-coded literal — never client input.
 */
export async function checkVersionConflict(
  table: 'lists' | 'timelines',
  id: string,
  expectedVersion: unknown,
): Promise<number | null> {
  if (typeof expectedVersion !== 'number') return null;
  const r = await query<{ version: number }>(`SELECT version FROM ${table} WHERE id = $1`, [id]);
  const current = r.rows[0]?.version;
  if (typeof current === 'number' && current !== expectedVersion) return current;
  return null;
}
