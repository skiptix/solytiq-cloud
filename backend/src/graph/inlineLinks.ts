// ---------------------------------------------------------------------------
// Inline `[[type:id|Label]]` link parsing — modeled directly on mentions.ts's
// diff-and-notify pattern, but diff-and-relink. A token is ID-anchored (D4 in
// the design doc): the pipe text is a display fallback only, never the source
// of truth — the editor renders a live-titled EntityChip instead.
//
//   [[list:list_7f3a9c21]]
//   [[markdownList:md_a91c#blk_h2_intro|Training Notes]]
//
// A token can only ever resolve to an existing, VISIBLE (to the acting user)
// entity or fail silently — same guarantee mentions.ts gives for @-mentions.
// Re-saving unchanged content is a no-op: only the diff against the previous
// `origin='inline'` edge set is written, so a manually-added edge from the
// same source is never touched (that's what the `origin` column is for).
// ---------------------------------------------------------------------------

import type { QueryExec } from '../workspaceUtil';
import { query } from '../db';
import { isValidEntityType, type EntityType } from './srn';
import { upsertLink } from './links';
import { isEntityVisible } from './visibility';
import type { EntityRef } from './entityIndex';

const LINK_RE = /\[\[(task|list|markdownList|timeline|milestone|meeting|folder|file|gpsFile):([A-Za-z0-9_-]{1,100})(?:#([A-Za-z0-9_-]{1,100}))?(?:\|([^\]]{0,200}))?\]\]/g;

export interface InlineLinkHit {
  entityType: EntityType;
  entityId: string;
  blockId?: string;
  displayText?: string;
}

/** Extract every `[[...]]` token from a blob of text. */
export function extractInlineLinks(text: string | null | undefined): InlineLinkHit[] {
  const hits: InlineLinkHit[] = [];
  if (!text) return hits;
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(text)) !== null) {
    const [, type, id, blockId, displayText] = m;
    if (!isValidEntityType(type)) continue;
    hits.push({ entityType: type as EntityType, entityId: id, blockId, displayText });
  }
  return hits;
}

export interface MarkdownBlockLike {
  id: string;
  [key: string]: unknown;
}

/** Extract `[[...]]` tokens from every text-bearing field of a set of Markdown blocks, tagging each hit with its containing block id. */
export function extractFromBlocks(blocks: MarkdownBlockLike[]): Array<InlineLinkHit & { blockId: string }> {
  const out: Array<InlineLinkHit & { blockId: string }> = [];
  for (const block of blocks) {
    const texts: string[] = [];
    for (const key of ['text', 'content', 'caption']) {
      const v = block[key];
      if (typeof v === 'string') texts.push(v);
    }
    const rows = block.rows;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (Array.isArray(row)) for (const cell of row) if (typeof cell === 'string') texts.push(cell);
      }
    }
    for (const text of texts) {
      for (const hit of extractInlineLinks(text)) out.push({ ...hit, blockId: block.id });
    }
  }
  return out;
}

export interface LinkDiff {
  added: number;
  removed: number;
  unchanged: number;
}

/**
 * Diff this source's `origin='inline'` edges against a freshly parsed set of
 * hits, writing only the difference. A hit that doesn't resolve to a visible
 * entity is silently dropped (never an error) — same contract as
 * mentions.ts's username resolver.
 */
export async function replaceInlineLinks(
  exec: QueryExec,
  src: EntityRef,
  hits: InlineLinkHit[],
  actorId: string
): Promise<LinkDiff> {
  const existingRes = await exec(
    `SELECT id, dst_type, dst_id, source_block_id FROM entity_links WHERE src_type = $1 AND src_id = $2 AND origin = 'inline'`,
    [src.entityType, src.entityId]
  );
  const existing = existingRes.rows as Array<{ id: string; dst_type: string; dst_id: string; source_block_id: string | null }>;
  const existingKey = (r: { dst_type: string; dst_id: string; source_block_id: string | null }) => `${r.dst_type}:${r.dst_id}:${r.source_block_id ?? ''}`;
  const hitKey = (h: InlineLinkHit) => `${h.entityType}:${h.entityId}:${h.blockId ?? ''}`;

  const existingKeys = new Set(existing.map(existingKey));
  const wantedKeys = new Set(hits.map(hitKey));

  let added = 0, removed = 0, unchanged = 0;

  for (const row of existing) {
    if (!wantedKeys.has(existingKey(row))) {
      await exec(`DELETE FROM entity_links WHERE id = $1`, [row.id]);
      removed++;
    } else {
      unchanged++;
    }
  }

  for (const hit of hits) {
    if (existingKeys.has(hitKey(hit))) continue;
    if (hit.entityType === src.entityType && hit.entityId === src.entityId) continue; // self-loop, never valid
    if (!(await isEntityVisible(exec, actorId, hit.entityType, hit.entityId))) continue; // can't reference what you can't see
    try {
      await upsertLink(exec, {
        srcType: src.entityType,
        srcId: src.entityId,
        dstType: hit.entityType,
        dstId: hit.entityId,
        linkType: 'references',
        origin: 'inline',
        sourceBlockId: hit.blockId ?? null,
        createdBy: actorId,
      });
      added++;
    } catch {
      // unknown/invalid combination — treat exactly like an unresolved token
    }
  }

  return { added, removed, unchanged };
}

/**
 * Best-effort wrapper for a single free-text field (task note, milestone
 * description, meeting description) — never throws into the caller's save.
 */
export async function syncInlineLinksForText(
  src: EntityRef,
  text: string | null | undefined,
  actorId: string,
  exec: QueryExec = query
): Promise<void> {
  try {
    await replaceInlineLinks(exec, src, extractInlineLinks(text), actorId);
  } catch (err) {
    console.error('🔗 ✗ syncInlineLinksForText failed', src.entityType, src.entityId, err);
  }
}

/** Best-effort wrapper for a Markdown page's full block array. */
export async function syncInlineLinksForBlocks(
  src: EntityRef,
  blocks: MarkdownBlockLike[],
  actorId: string,
  exec: QueryExec = query
): Promise<void> {
  try {
    await replaceInlineLinks(exec, src, extractFromBlocks(blocks), actorId);
  } catch (err) {
    console.error('🔗 ✗ syncInlineLinksForBlocks failed', src.entityType, src.entityId, err);
  }
}
