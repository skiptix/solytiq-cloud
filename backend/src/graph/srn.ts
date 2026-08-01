// ---------------------------------------------------------------------------
// SRN — "Solytiq Resource Name": the canonical, textual reference for any
// verlinkbare (linkable) entity in the graph layer.
//
//   srn:{entityType}:{entityId}[#{blockId}]
//
//   srn:list:list_7f3a9c21
//   srn:task:1751293847221
//   srn:markdownList:md_a91c#blk_h2_intro
//
// `entityType` is one of the 10 source tables `entity_index` indexes (see
// runMigrations() in index.ts) — deliberately NOT `workspace`, which is a
// container, not a graph node. `entityId` is always the id AS A STRING —
// tasks.id is BIGINT, serialized decimal here, which is what bridges the
// ID-type heterogeneity described in the graph-layer design doc (Blocker A).
// The optional `#blockId` addresses a Markdown block; it is never part of an
// entity_index row's identity, only an attribute callers may carry alongside
// a parsed SRN (e.g. entity_links.source_block_id).
// ---------------------------------------------------------------------------

export const ENTITY_TYPES = [
  'task',
  'list',
  'markdownList',
  'timeline',
  'milestone',
  'meeting',
  'folder',
  'file',
  'section',
  'gpsFile',
  'knowledgeBase',
  'knowledgeEntry',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export interface ParsedSrn {
  entityType: EntityType;
  entityId: string;
  blockId?: string;
}

// Entity ids in this codebase are either BIGINT-as-decimal (tasks) or
// `${prefix}_${uuidv4()}` VARCHAR(100) strings — letters, digits, `_`, `-`.
const ID_CHARS = 'A-Za-z0-9_-';
const SRN_PATTERN = new RegExp(`^srn:([A-Za-z]+):([${ID_CHARS}]{1,100})(?:#([${ID_CHARS}]{1,100}))?$`);

export function isValidEntityType(value: string): value is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}

/** Parse an SRN string. Returns null for anything malformed or an unknown entity type. */
export function parseSrn(srn: string): ParsedSrn | null {
  if (typeof srn !== 'string') return null;
  const match = SRN_PATTERN.exec(srn);
  if (!match) return null;
  const [, entityType, entityId, blockId] = match;
  if (!isValidEntityType(entityType)) return null;
  return blockId ? { entityType, entityId, blockId } : { entityType, entityId };
}

/** Build an SRN string. Throws on an unknown entity type — this is a programmer error, never user input. */
export function formatSrn(entityType: EntityType, entityId: string | number, blockId?: string | null): string {
  if (!isValidEntityType(entityType)) {
    throw new Error(`formatSrn: unknown entity type "${entityType}"`);
  }
  const base = `srn:${entityType}:${entityId}`;
  return blockId ? `${base}#${blockId}` : base;
}
