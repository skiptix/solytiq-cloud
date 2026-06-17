import { query } from './db';
import type { PoolClient } from 'pg';

/**
 * Returns the next ordinal position for a row in the given table.
 *
 * Usage:
 *   const pos = await nextPosition('tasks', 'user_id = $1 AND source = \'dash\'', [userId]);
 *   const pos = await nextPosition('milestones', 'timeline_id = $1', [timelineId], client);
 */
export async function nextPosition(
  table: string,
  whereClause: string,
  params: unknown[],
  client?: PoolClient,
): Promise<number> {
  const sql = `SELECT MAX(position) AS max FROM ${table} WHERE ${whereClause}`;
  const result = client
    ? await client.query<{ max: string | null }>(sql, params)
    : await query<{ max: string | null }>(sql, params);
  return result.rows[0].max !== null
    ? parseInt(result.rows[0].max, 10) + 1
    : 0;
}
