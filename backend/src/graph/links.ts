// ---------------------------------------------------------------------------
// entity_links — the core CRUD + read helpers for graph edges. This is the
// ONLY module allowed to query entity_links directly (see graph/visibility.ts
// and CLAUDE.md's Graph Layer section) — routes must go through it.
// ---------------------------------------------------------------------------

import { v4 as uuidv4 } from 'uuid';
import { query } from '../db';
import type { QueryExec } from '../workspaceUtil';
import { resolveLinkType } from './linkTypes';
import { formatSrn, type EntityType } from './srn';
import { resolveRefs, getEntityIndexEntry, type EntityRef, type EntityIndexEntry } from './entityIndex';
import { visibleCondition } from './visibility';

export type LinkOrigin = 'manual' | 'inline' | 'system' | 'automation' | 'agent';

export class LinkError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'LinkError';
  }
}

export interface LinkInput {
  srcType: string;
  srcId: string;
  dstType: string;
  dstId: string;
  linkType: string;
  origin?: LinkOrigin;
  props?: Record<string, unknown>;
  sourceBlockId?: string | null;
  weight?: number;
  createdBy?: string | null;
}

export interface EntityLink {
  id: string;
  workspaceId: string | null;
  srcType: string;
  srcId: string;
  dstType: string;
  dstId: string;
  linkType: string;
  origin: LinkOrigin;
  sourceBlockId: string | null;
  props: Record<string, unknown>;
  weight: number;
  isCrossWorkspace: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EntityLinkRow {
  id: string;
  workspace_id: string | null;
  src_type: string;
  src_id: string;
  dst_type: string;
  dst_id: string;
  link_type: string;
  origin: LinkOrigin;
  source_block_id: string | null;
  props: Record<string, unknown>;
  weight: number;
  is_cross_workspace: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function toEntityLink(row: EntityLinkRow): EntityLink {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    srcType: row.src_type,
    srcId: row.src_id,
    dstType: row.dst_type,
    dstId: row.dst_id,
    linkType: row.link_type,
    origin: row.origin,
    sourceBlockId: row.source_block_id,
    props: row.props ?? {},
    weight: row.weight,
    isCrossWorkspace: row.is_cross_workspace,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Create (or update, if an identical src/dst/type/block tuple already exists)
 * an edge. Validates the link type against the registry (system, or a
 * workspace's own custom `x_` type) and its allowed src/dst entity types, and
 * that both endpoints exist in entity_index. `workspace_id` is denormalized
 * from the SOURCE entity; symmetric-type ordering and `is_cross_workspace` are
 * computed by the `trg_links_normalize` DB trigger (see index.ts), not here.
 */
export async function upsertLink(exec: QueryExec, input: LinkInput): Promise<EntityLink> {
  if (input.srcType === input.dstType && input.srcId === input.dstId) {
    throw new LinkError('self_loop', 'An entity cannot link to itself');
  }

  const srcMeta = await exec(
    `SELECT workspace_id FROM entity_index WHERE entity_type = $1 AND entity_id = $2 AND is_trashed = false`,
    [input.srcType, input.srcId]
  );
  const srcRow = srcMeta.rows[0] as { workspace_id: string | null } | undefined;
  if (!srcRow) throw new LinkError('src_not_found', 'Source entity not found');

  const dstMeta = await exec(
    `SELECT 1 FROM entity_index WHERE entity_type = $1 AND entity_id = $2 AND is_trashed = false`,
    [input.dstType, input.dstId]
  );
  if (dstMeta.rows.length === 0) throw new LinkError('dst_not_found', 'Destination entity not found');

  const linkType = await resolveLinkType(input.linkType, srcRow.workspace_id, exec);
  if (!linkType) throw new LinkError('unknown_link_type', `Unknown link type "${input.linkType}"`);
  if (linkType.allowedSrc.length > 0 && !linkType.allowedSrc.includes(input.srcType as EntityType)) {
    throw new LinkError('invalid_src_type', `Link type "${input.linkType}" does not allow a "${input.srcType}" source`);
  }
  if (linkType.allowedDst.length > 0 && !linkType.allowedDst.includes(input.dstType as EntityType)) {
    throw new LinkError('invalid_dst_type', `Link type "${input.linkType}" does not allow a "${input.dstType}" destination`);
  }

  const id = `lnk_${uuidv4()}`;
  const r = await exec(
    `INSERT INTO entity_links
       (id, workspace_id, src_type, src_id, dst_type, dst_id, link_type, origin, source_block_id, props, weight, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (src_type, src_id, dst_type, dst_id, link_type, COALESCE(source_block_id, ''))
     DO UPDATE SET props = EXCLUDED.props, weight = EXCLUDED.weight, updated_at = NOW()
     RETURNING *`,
    [
      id,
      srcRow.workspace_id,
      input.srcType,
      input.srcId,
      input.dstType,
      input.dstId,
      input.linkType,
      input.origin ?? 'manual',
      input.sourceBlockId ?? null,
      JSON.stringify(input.props ?? {}),
      input.weight ?? 1.0,
      input.createdBy ?? null,
    ]
  );
  return toEntityLink(r.rows[0] as EntityLinkRow);
}

export async function getLinkById(exec: QueryExec, id: string): Promise<EntityLink | null> {
  const r = await exec(`SELECT * FROM entity_links WHERE id = $1`, [id]);
  return r.rows[0] ? toEntityLink(r.rows[0] as EntityLinkRow) : null;
}

/** Update a link's `props`/`weight`. Changing `linkType` or endpoints is not supported — delete and recreate instead. Refuses `origin = 'system'` links. */
export async function updateLink(
  exec: QueryExec,
  id: string,
  patch: { props?: Record<string, unknown>; weight?: number }
): Promise<EntityLink | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.props !== undefined) {
    params.push(JSON.stringify(patch.props));
    sets.push(`props = $${params.length}`);
  }
  if (patch.weight !== undefined) {
    params.push(patch.weight);
    sets.push(`weight = $${params.length}`);
  }
  if (sets.length === 0) return getLinkById(exec, id);
  params.push(id);
  const r = await exec(
    `UPDATE entity_links SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length} AND origin != 'system' RETURNING *`,
    params
  );
  return r.rows[0] ? toEntityLink(r.rows[0] as EntityLinkRow) : null;
}

/** Delete a link. Refuses (no-op, returns null) for `origin = 'system'` links — those are application-managed, not user-deletable. */
export async function deleteLink(exec: QueryExec, id: string): Promise<EntityLink | null> {
  const r = await exec(`DELETE FROM entity_links WHERE id = $1 AND origin != 'system' RETURNING *`, [id]);
  return r.rows[0] ? toEntityLink(r.rows[0] as EntityLinkRow) : null;
}

/** Delete every (non-system) link directly between two entities, optionally scoped to one link type. Returns the count removed. */
export async function deleteLinksBetween(
  exec: QueryExec,
  src: EntityRef,
  dst: EntityRef,
  linkType?: string
): Promise<number> {
  const params: unknown[] = [src.entityType, src.entityId, dst.entityType, dst.entityId];
  let filter = '';
  if (linkType) {
    params.push(linkType);
    filter = ` AND link_type = $5`;
  }
  const r = await exec(
    `DELETE FROM entity_links
      WHERE src_type = $1 AND src_id = $2 AND dst_type = $3 AND dst_id = $4 AND origin != 'system' ${filter}`,
    params
  );
  return r.rowCount ?? 0;
}

/** Every (non-directional) link directly between two specific entities, optionally scoped to one link type. */
export async function getLinksBetween(
  src: EntityRef,
  dst: EntityRef,
  linkType?: string,
  exec: QueryExec = query
): Promise<EntityLink[]> {
  const params: unknown[] = [src.entityType, src.entityId, dst.entityType, dst.entityId];
  let filter = '';
  if (linkType) {
    params.push(linkType);
    filter = ` AND link_type = $5`;
  }
  const r = await exec(
    `SELECT * FROM entity_links WHERE src_type = $1 AND src_id = $2 AND dst_type = $3 AND dst_id = $4 ${filter} ORDER BY created_at ASC`,
    params
  );
  return (r.rows as EntityLinkRow[]).map(toEntityLink);
}

export interface ResolvedLink {
  link: EntityLink;
  direction: 'out' | 'in';
  /** The OTHER endpoint's entity_index row, or null if it doesn't exist or isn't visible to this user. */
  neighbor: EntityIndexEntry | null;
}

/**
 * Every direct (single-hop) link touching `ref`, both directions, with the
 * neighbor entity resolved through the same visibility boundary as any other
 * read. Callers must check `isEntityVisible(ref)` themselves first — this
 * function assumes the caller may see `ref` and only scopes the NEIGHBORS.
 */
export async function getEntityLinks(
  userId: string,
  ref: EntityRef,
  opts: { linkTypes?: string[] } = {},
  exec: QueryExec = query
): Promise<ResolvedLink[]> {
  const params: unknown[] = [ref.entityType, ref.entityId];
  let filter = '';
  if (opts.linkTypes && opts.linkTypes.length > 0) {
    params.push(opts.linkTypes);
    filter = ` AND link_type = ANY($${params.length}::text[])`;
  }
  const [outR, inR] = await Promise.all([
    exec(
      `SELECT * FROM entity_links WHERE src_type = $1 AND src_id = $2 ${filter} ORDER BY created_at ASC`,
      params
    ),
    exec(
      `SELECT * FROM entity_links WHERE dst_type = $1 AND dst_id = $2 ${filter} ORDER BY created_at ASC`,
      params
    ),
  ]);

  const entries: Array<{ link: EntityLink; direction: 'out' | 'in' }> = [
    ...(outR.rows as EntityLinkRow[]).map((row) => ({ link: toEntityLink(row), direction: 'out' as const })),
    ...(inR.rows as EntityLinkRow[]).map((row) => ({ link: toEntityLink(row), direction: 'in' as const })),
  ];

  const neighborRefs = entries.map(({ link, direction }) =>
    direction === 'out' ? { entityType: link.dstType, entityId: link.dstId } : { entityType: link.srcType, entityId: link.srcId }
  );
  const resolved = await resolveRefs(userId, neighborRefs, exec);

  return entries.map(({ link, direction }) => {
    const key = direction === 'out' ? `${link.dstType}:${link.dstId}` : `${link.srcType}:${link.srcId}`;
    return { link, direction, neighbor: resolved.get(key) ?? null };
  });
}

/** Incoming links only — the "Backlinks" half of getEntityLinks. */
export async function getBacklinks(userId: string, ref: EntityRef, exec: QueryExec = query): Promise<ResolvedLink[]> {
  const all = await getEntityLinks(userId, ref, {}, exec);
  return all.filter((l) => l.direction === 'in');
}

const MIN_UNLINKED_TITLE_LEN = 3;

/**
 * Unlinked-mentions heuristic (v1): other entities in the same workspace whose
 * title substring-matches `ref`'s title and that have no existing link to/from
 * it. This is a title-only stand-in — real content-mention detection (parsing
 * `[[...]]` tokens and prose out of Markdown blocks / task notes) lands with
 * the inline-links work; see the design doc's WP-5.
 */
export async function findUnlinkedMentions(
  userId: string,
  ref: EntityRef,
  opts: { limit?: number } = {},
  exec: QueryExec = query
): Promise<EntityIndexEntry[]> {
  const self = await getEntityIndexEntry(userId, ref.entityType, ref.entityId, exec);
  if (!self || !self.workspaceId || self.title.trim().length < MIN_UNLINKED_TITLE_LEN) return [];
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);

  const r = await exec(
    `SELECT e.* FROM entity_index e
      WHERE ${visibleCondition('e', 1)}
        AND e.workspace_id = $2
        AND NOT (e.entity_type = $3 AND e.entity_id = $4)
        AND (e.title ILIKE '%' || $5 || '%' OR $5 ILIKE '%' || e.title || '%')
        AND length(e.title) >= ${MIN_UNLINKED_TITLE_LEN}
        AND NOT EXISTS (
          SELECT 1 FROM entity_links l
           WHERE (l.src_type = $3 AND l.src_id = $4 AND l.dst_type = e.entity_type AND l.dst_id = e.entity_id)
              OR (l.dst_type = $3 AND l.dst_id = $4 AND l.src_type = e.entity_type AND l.src_id = e.entity_id)
        )
      ORDER BY e.entity_updated_at DESC NULLS LAST
      LIMIT ${limit}`,
    [userId, self.workspaceId, ref.entityType, ref.entityId, self.title]
  );
  interface UnlinkedRow {
    entity_type: string; entity_id: string; workspace_id: string | null; owner_id: string;
    title: string; emoji: string | null; color: string | null; subtitle: string | null;
    status: string | null; is_archived: boolean; is_trashed: boolean; deep_link: string | null;
    entity_created_at: string | null; entity_updated_at: string | null;
  }
  return (r.rows as UnlinkedRow[]).map((row) => ({
    srn: formatSrn(row.entity_type as EntityType, row.entity_id),
    entityType: row.entity_type as EntityType,
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
  }));
}
