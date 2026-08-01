// ---------------------------------------------------------------------------
// Block mutation for Knowledge Base entries — the analogue of
// routes/markdownLists.ts's mutateMarkdownListBlocks, running the same
// lock → validate → prune-images → persist sequence against knowledge_entries.
//
// TWO deliberate differences from the Markdown Page path:
//
//   1. NO todo reconciliation. A Markdown Page mirrors its `/todo` blocks into
//      a real auto-managed list because a page is a place work gets tracked. A
//      dictionary entry is a definition — mirroring its checkboxes into a task
//      list would manufacture phantom work items out of documentation.
//      A /todo block still renders and toggles; it just stays local.
//
//   2. Images are owned polymorphically (owner_type='knowledgeEntry'), sharing
//      markdown_list_images and its on-disk directory rather than standing up a
//      second image subsystem.
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import { query, withTransaction } from '../db';
import type { QueryExec } from '../workspaceUtil';
import { buildMarkdownBlockFromSpec } from '../aiTools';
import { MARKDOWN_IMAGE_DIR } from '../routes/markdownLists';
import { syncInlineLinksForBlocks } from '../graph/inlineLinks';
import { enqueueEmbedding } from '../knowledge/queue';
import { notifyNewMentions } from '../mentions';
import { normalizeContent, type BlockLike, type KnowledgeEntryRow } from './entries';

/** Flatten every text-bearing block into one string, for @-mention diffing. */
export function collectBlockText(blocks: BlockLike[]): string {
  return blocks.map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n');
}

/**
 * Validate a caller-supplied block list (AI tool args, or an API body) into
 * real blocks, reusing the SAME validator Markdown Pages use so a heading is a
 * heading everywhere. Images may only be preserved, never invented — they need
 * a real upload.
 */
export function buildEntryBlocks(
  specs: unknown,
  existingImageIds: Set<string>
): { blocks: BlockLike[] } | { error: string } {
  if (!Array.isArray(specs)) return { error: 'blocks must be an array' };
  const out: BlockLike[] = [];
  for (const spec of specs) {
    if (!spec || typeof spec !== 'object') return { error: 'each block must be an object' };
    const built = buildMarkdownBlockFromSpec(spec as Record<string, unknown>, {
      allowImagePreserve: true,
      existingImageIds,
    });
    if ('error' in built) return { error: built.error };
    out.push(built.block as BlockLike);
  }
  return { blocks: out };
}

/** Every image currently uploaded against this entry. */
export async function entryImageIds(entryId: string, exec: QueryExec = query): Promise<Set<string>> {
  const r = await exec(
    `SELECT id FROM markdown_list_images WHERE owner_type = 'knowledgeEntry' AND owner_id = $1`,
    [entryId]
  );
  return new Set((r.rows as Array<{ id: string }>).map((row) => row.id));
}

/** Delete image rows + files no longer referenced by any block on the entry. */
async function pruneUnreferencedImages(exec: QueryExec, entryId: string, blocks: BlockLike[]): Promise<void> {
  const referenced = new Set(
    blocks.filter((b) => b.type === 'image' && typeof b.imageId === 'string').map((b) => b.imageId as string)
  );
  const existing = await exec(
    `SELECT id, file_path FROM markdown_list_images WHERE owner_type = 'knowledgeEntry' AND owner_id = $1`,
    [entryId]
  );
  for (const img of existing.rows as Array<{ id: string; file_path: string }>) {
    if (referenced.has(img.id)) continue;
    await exec(`DELETE FROM markdown_list_images WHERE id = $1`, [img.id]);
    const p = path.join(MARKDOWN_IMAGE_DIR, path.basename(img.file_path));
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* best-effort cleanup */ } }
  }
}

export type MutateResult =
  | { ok: true; entry: KnowledgeEntryRow }
  | { ok: false; error: string };

/**
 * Apply a block mutation to one entry inside a transaction, then run the same
 * post-save side effects every other content surface runs: inline `[[...]]`
 * link sync (so a definition that references a board draws a real graph edge),
 * @-mention notifications, and an embedding enqueue so the entry becomes
 * semantically searchable alongside everything else.
 *
 * Access is the CALLER's responsibility — routes/knowledgeBase.ts checks
 * workspace membership before ever reaching here.
 */
export async function mutateEntryBlocks(
  userId: string,
  entryId: string,
  workspaceId: string | null,
  mutate: (blocks: BlockLike[]) => BlockLike[] | { error: string },
  exec: QueryExec = query
): Promise<MutateResult> {
  let mutationError: string | null = null;
  let mentionBefore = '';
  let mentionAfter = '';
  let saved: KnowledgeEntryRow | null = null;

  await withTransaction(async (client) => {
    const tx: QueryExec = (text, params) => client.query(text, params);
    const lockedRes = await tx(`SELECT * FROM knowledge_entries WHERE id = $1 FOR UPDATE`, [entryId]);
    const locked = lockedRes.rows[0] as KnowledgeEntryRow | undefined;
    if (!locked) { mutationError = 'Entry not found'; return { result: lockedRes }; }

    const currentBlocks = normalizeContent(locked.content).blocks;
    const mutated = mutate(currentBlocks);
    if (!Array.isArray(mutated)) { mutationError = mutated.error; return { result: lockedRes }; }

    mentionBefore = collectBlockText(currentBlocks);
    mentionAfter = collectBlockText(mutated);
    await pruneUnreferencedImages(tx, entryId, mutated);

    const updateRes = await tx(
      `UPDATE knowledge_entries SET content = $1, version = version + 1, updated_at = NOW()
        WHERE id = $2 RETURNING *`,
      [JSON.stringify({ version: 1, blocks: mutated }), entryId]
    );
    saved = updateRes.rows[0] as KnowledgeEntryRow;
    return { result: updateRes };
  });

  if (mutationError) return { ok: false, error: mutationError };
  if (!saved) return { ok: false, error: 'Entry not found' };
  const entry: KnowledgeEntryRow = saved;

  // Every side effect below is best-effort: a failure here must not undo a save
  // the user already saw succeed, matching the convention used by every other
  // content-save site in the codebase.
  try {
    await syncInlineLinksForBlocks(
      { entityType: 'knowledgeEntry', entityId: entryId },
      normalizeContent(entry.content).blocks as Array<{ id: string; type: string }>,
      userId
    );
  } catch (err) { console.error('📚 ✗ knowledge entry inline-link sync failed:', err); }

  try {
    await notifyNewMentions({
      beforeText: mentionBefore,
      afterText: mentionAfter,
      workspaceId,
      actorId: userId,
      title: `mentioned you in "${entry.term}"`,
      entityType: 'knowledgeEntry',
      entityId: entryId,
      data: {},
    });
  } catch (err) { console.error('📚 ✗ knowledge entry mention notify failed:', err); }

  try {
    await enqueueEmbedding('knowledgeEntry', entryId, workspaceId, exec);
  } catch (err) { console.error('📚 ✗ knowledge entry embedding enqueue failed:', err); }

  return { ok: true, entry };
}
