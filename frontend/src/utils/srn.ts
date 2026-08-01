// ---------------------------------------------------------------------------
// SRN — "Solytiq Resource Name": the canonical, textual reference for any
// linkable entity in the graph layer. Mirrors backend/src/graph/srn.ts —
// keep the two in sync.
//
//   srn:{entityType}:{entityId}[#{blockId}]
//
//   srn:list:list_7f3a9c21
//   srn:task:1751293847221
//   srn:markdownList:md_a91c#blk_h2_intro
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
