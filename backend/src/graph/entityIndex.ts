// ---------------------------------------------------------------------------
// entity_index reads — the canonical node registry for the graph layer.
//
// `entity_index` is kept in sync by DB triggers (see runMigrations() in
// index.ts, `sync_entity_index()`), one row per linkable entity across the 10
// source tables. This module is the only place that reads it; every result is
// scoped through graph/visibility.ts so a caller never sees a row it
// shouldn't.
// ---------------------------------------------------------------------------

import { query } from '../db';
import type { QueryExec } from '../workspaceUtil';
import { visibleCondition } from './visibility';
import { formatSrn, type EntityType } from './srn';

export interface EntityRef {
  entityType: string;
  entityId: string;
}

export interface EntityIndexEntry {
  srn: string;
  entityType: EntityType;
  entityId: string;
  workspaceId: string | null;
  ownerId: string;
  title: string;
  emoji: string | null;
  color: string | null;
  subtitle: string | null;
  status: string | null;
  isArchived: boolean;
  isTrashed: boolean;
  deepLink: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface EntityIndexRow {
  entity_type: string;
  entity_id: string;
  workspace_id: string | null;
  owner_id: string;
  title: string;
  emoji: string | null;
  color: string | null;
  subtitle: string | null;
  status: string | null;
  is_archived: boolean;
  is_trashed: boolean;
  deep_link: string | null;
  entity_created_at: string | null;
  entity_updated_at: string | null;
}

function toEntry(row: EntityIndexRow): EntityIndexEntry {
  const entityType = row.entity_type as EntityType;
  return {
    srn: formatSrn(entityType, row.entity_id),
    entityType,
    entityId: row.entity_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    title: row.title,
    emoji: row.emoji,
    color: row.color,
    subtitle: row.subtitle,
    status: row.status,
    isArchived: row.is_archived,
    isTrashed: row.is_trashed,
    deepLink: row.deep_link,
    createdAt: row.entity_created_at,
    updatedAt: row.entity_updated_at,
  };
}

/** A single entity, or null if it doesn't exist / isn't visible to this user. */
export async function getEntityIndexEntry(
  userId: string,
  entityType: string,
  entityId: string,
  exec: QueryExec = query
): Promise<EntityIndexEntry | null> {
  const r = await exec(
    `SELECT * FROM entity_index e WHERE e.entity_type = $1 AND e.entity_id = $2 AND ${visibleCondition('e', 3)}`,
    [entityType, entityId, userId]
  );
  return r.rows[0] ? toEntry(r.rows[0] as EntityIndexRow) : null;
}

/**
 * Batch-resolve a list of (entityType, entityId) refs to their entity_index
 * rows in one query, scoped to what the user can see. Refs the user can't see
 * (or that don't exist) are simply absent from the returned map — callers
 * decide how to treat a miss (drop the edge, show a "restricted" placeholder,
 * etc.), matching the cross-workspace visibility model in the design doc.
 */
export async function resolveRefs(
  userId: string,
  refs: EntityRef[],
  exec: QueryExec = query
): Promise<Map<string, EntityIndexEntry>> {
  const out = new Map<string, EntityIndexEntry>();
  if (refs.length === 0) return out;

  const types = refs.map((r) => r.entityType);
  const ids = refs.map((r) => r.entityId);
  const r = await exec(
    `SELECT e.* FROM entity_index e
       JOIN unnest($1::text[], $2::text[]) AS want(entity_type, entity_id)
         ON e.entity_type = want.entity_type AND e.entity_id = want.entity_id
      WHERE ${visibleCondition('e', 3)}`,
    [types, ids, userId]
  );
  for (const row of r.rows) {
    const entry = toEntry(row as EntityIndexRow);
    out.set(`${entry.entityType}:${entry.entityId}`, entry);
  }
  return out;
}

/** Quick-switcher style search over entity_index titles (trigram similarity), scoped to what the user can see. */
export async function searchEntityIndex(
  userId: string,
  q: string,
  opts: { entityTypes?: string[]; workspaceId?: string; limit?: number } = {},
  exec: QueryExec = query
): Promise<EntityIndexEntry[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const params: unknown[] = [userId, `%${q}%`];
  let filter = '';
  if (opts.entityTypes && opts.entityTypes.length > 0) {
    params.push(opts.entityTypes);
    filter += ` AND e.entity_type = ANY($${params.length}::text[])`;
  }
  if (opts.workspaceId) {
    params.push(opts.workspaceId);
    filter += ` AND e.workspace_id = $${params.length}`;
  }
  const r = await exec(
    `SELECT e.* FROM entity_index e
      WHERE ${visibleCondition('e', 1)} AND e.title ILIKE $2 ${filter}
      ORDER BY similarity(e.title, $2) DESC, e.entity_updated_at DESC NULLS LAST
      LIMIT ${limit}`,
    params
  );
  return (r.rows as EntityIndexRow[]).map(toEntry);
}
