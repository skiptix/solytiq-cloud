// ---------------------------------------------------------------------------
// Link-type registry — the catalog half of the graph layer, following the same
// "catalog in code, state in DB" split as appsRegistry.ts. System types below
// are versioned, refactorable code; a workspace may additionally define its
// own custom types (workspace_link_types, key prefix `x_`, see
// backend/src/index.ts runMigrations()).
// ---------------------------------------------------------------------------

import { query } from '../db';
import type { QueryExec } from '../workspaceUtil';
import type { EntityType } from './srn';

export interface LinkTypeDef {
  key: string;
  label: string;
  inverseKey: string;
  inverseLabel: string;
  /** Symmetric types store one canonically-ordered row and read the same both ways. */
  symmetric: boolean;
  color: string;
  edgeStyle: 'solid' | 'dashed' | 'dotted';
  /** Whether the graph explore view shows this link type by default. */
  showInGraph: boolean;
  /** System-origin links of this type can never be user-deleted. */
  deletable: boolean;
  allowCrossWorkspace: boolean;
  /** Allowed (srcType, dstType) pairs. Empty = any type on that side. */
  allowedSrc: EntityType[];
  allowedDst: EntityType[];
}

const t = (
  key: string,
  label: string,
  inverseKey: string,
  inverseLabel: string,
  opts: Partial<LinkTypeDef> = {}
): LinkTypeDef => ({
  key,
  label,
  inverseKey,
  inverseLabel,
  symmetric: false,
  color: '#9d8dff',
  edgeStyle: 'solid',
  showInGraph: true,
  deletable: true,
  allowCrossWorkspace: false,
  allowedSrc: [],
  allowedDst: [],
  ...opts,
});

export const SYSTEM_LINK_TYPES: Record<string, LinkTypeDef> = {
  references: t('references', 'References', 'referenced_by', 'Referenced by', {
    color: '#9d8dff',
  }),
  child_of: t('child_of', 'Child of', 'parent_of', 'Parent of', {
    color: '#5e4dbb',
    allowedSrc: ['list', 'task'],
    allowedDst: ['task', 'list'],
    deletable: false,
  }),
  links_to: t('links_to', 'Links to', 'linked_from', 'Linked from', {
    color: '#5e4dbb',
    allowedSrc: ['task'],
    allowedDst: ['list'],
    deletable: false,
  }),
  tracks: t('tracks', 'Tracks', 'tracked_by', 'Tracked by', {
    color: '#10b981',
    allowedSrc: ['markdownList'],
    allowedDst: ['list', 'task'],
    deletable: false,
  }),
  attached_to: t('attached_to', 'Attached to', 'has_attachment', 'Has attachment', {
    color: '#b0acbe',
    allowedSrc: ['file', 'gpsFile'],
    deletable: false,
  }),
  blocks: t('blocks', 'Blocks', 'blocked_by', 'Blocked by', {
    color: '#ba1a1a',
    allowedSrc: ['task', 'milestone'],
    allowedDst: ['task', 'milestone'],
  }),
  duplicates: t('duplicates', 'Duplicates', 'duplicated_by', 'Duplicated by', {
    color: '#d97706',
    allowedSrc: ['task'],
    allowedDst: ['task'],
  }),
  relates_to: t('relates_to', 'Relates to', 'relates_to', 'Relates to', {
    symmetric: true,
    color: '#9d8dff',
    edgeStyle: 'dashed',
  }),
  derived_from: t('derived_from', 'Derived from', 'derived_into', 'Derived into', {
    color: '#c4b8f0',
    edgeStyle: 'dotted',
  }),
  part_of: t('part_of', 'Part of', 'contains', 'Contains', {
    color: '#e8e4f0',
    allowedSrc: ['milestone', 'section', 'task'],
    allowedDst: ['timeline', 'list'],
    showInGraph: false,
    deletable: false,
  }),
  scheduled_as: t('scheduled_as', 'Scheduled as', 'schedules', 'Schedules', {
    color: '#ea580c',
    allowedSrc: ['task', 'milestone'],
    allowedDst: ['meeting'],
  }),
  documents: t('documents', 'Documents', 'documented_by', 'Documented by', {
    color: '#5e4dbb',
    allowedSrc: ['markdownList'],
  }),
};

export const CUSTOM_LINK_TYPE_PREFIX = 'x_';

export function isSystemLinkType(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(SYSTEM_LINK_TYPES, key);
}

export function getSystemLinkType(key: string): LinkTypeDef | null {
  return SYSTEM_LINK_TYPES[key] ?? null;
}

interface WorkspaceLinkTypeRow {
  id: string;
  workspace_id: string;
  key: string;
  label: string;
  inverse_key: string;
  inverse_label: string;
  is_symmetric: boolean;
  color: string | null;
  edge_style: string;
  allowed_src: string[];
  allowed_dst: string[];
}

function customToDef(row: WorkspaceLinkTypeRow): LinkTypeDef {
  return {
    key: row.key,
    label: row.label,
    inverseKey: row.inverse_key,
    inverseLabel: row.inverse_label,
    symmetric: row.is_symmetric,
    color: row.color ?? '#9d8dff',
    edgeStyle: (row.edge_style as LinkTypeDef['edgeStyle']) ?? 'solid',
    showInGraph: true,
    deletable: true,
    allowCrossWorkspace: false,
    allowedSrc: (row.allowed_src ?? []) as EntityType[],
    allowedDst: (row.allowed_dst ?? []) as EntityType[],
  };
}

/**
 * Resolve a link-type key to its definition — a system type, or a custom type
 * scoped to the workspace. Accepts an injectable `exec` (defaulting to the
 * pool) so a caller running inside a transaction (e.g. upsertLink) resolves
 * against the SAME connection — a custom type created earlier in that same
 * transaction must be visible here, not just after commit.
 */
export async function resolveLinkType(
  key: string,
  workspaceId: string | null,
  exec: QueryExec = query
): Promise<LinkTypeDef | null> {
  const system = getSystemLinkType(key);
  if (system) return system;
  if (!workspaceId || !key.startsWith(CUSTOM_LINK_TYPE_PREFIX)) return null;
  const r = await exec(
    `SELECT * FROM workspace_link_types WHERE workspace_id = $1 AND key = $2`,
    [workspaceId, key]
  );
  return r.rows[0] ? customToDef(r.rows[0] as WorkspaceLinkTypeRow) : null;
}

/** Every link type usable in a workspace: all system types + that workspace's custom types. */
export async function listLinkTypes(workspaceId: string | null, exec: QueryExec = query): Promise<LinkTypeDef[]> {
  const system = Object.values(SYSTEM_LINK_TYPES);
  if (!workspaceId) return system;
  const r = await exec(
    `SELECT * FROM workspace_link_types WHERE workspace_id = $1 ORDER BY created_at ASC`,
    [workspaceId]
  );
  return [...system, ...(r.rows as WorkspaceLinkTypeRow[]).map(customToDef)];
}
