// ---------------------------------------------------------------------------
// Quick Add — the Knowledge Base bubble.
//
// Every board with Quick Add enabled gets ONE knowledge_entries row: its
// memory, rendered. It is a real entry in the workspace's single Knowledge
// Base, so it appears as its own bubble on the /knowledge net, opens in the
// EntryInspector like any other term, is indexed into the Knowledge Layer, and
// is reachable by Sol/MCP through the existing knowledge tools — none of which
// needed a line of new code, which is the point of putting it there.
//
// ONE entry per board, not one per remembered item. A busy board would
// otherwise add hundreds of entries to a dictionary a human curates and Sol
// reads on every turn; the placements belong INSIDE the board's bubble, as its
// rendered body.
//
// The entry is a PROJECTION of section_memory, never the source of truth for a
// prediction. Editing the rendered table by hand changes what a person reads,
// not what the predictor decides — the predictor never opens this table. That
// asymmetry is deliberate: a readable mirror can be reconciled, but a dictionary
// entry a human can retype is not something a ranking algorithm should trust.
//
// Regeneration is DEBOUNCED, not per-write: recordPlacement() flags the board
// (lists.quick_add_memory_dirty) and the sweep below reconciles it, the same
// dirty-flag-plus-interval shape graph/metrics.ts uses for pagerank rather than
// rewriting a JSONB document on every drag of a card.
// ---------------------------------------------------------------------------

import { query } from '../db';
import type { QueryExec } from '../workspaceUtil';
import { werr, wlog } from '../workspaceUtil';
import { createBase, createEntry, getEntry, setEntryContent, updateEntry, type BlockLike } from '../knowledgeBase/entries';
import { buildMarkdownBlockFromSpec } from '../aiTools';
import { upsertLink } from '../graph/links';
import { enqueueEmbedding } from '../knowledge/queue';

/** Rows rendered into the bubble's table. Beyond this the entry stops being readable and starts being a data dump. */
const MAX_RENDERED_ROWS = 100;

interface BubbleContext {
  listId: string;
  listName: string;
  workspaceId: string;
  userId: string;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 10);
}

/**
 * Build the entry's body: an explanation, then the placement table.
 *
 * The explanatory paragraph is not decoration. This entry shows up in a
 * human-curated dictionary and in Sol's context; a bare table of task titles
 * with no statement of what it is or where it came from would read as noise a
 * reader might reasonably delete.
 */
export function buildBubbleBlocks(
  listName: string,
  rows: Array<{ title: string; sectionLabel: string; occurrences: number; lastSeenAt: string }>
): BlockLike[] {
  const specs: Record<string, unknown>[] = [
    {
      type: 'paragraph',
      text: `What Quick Add has learned about “${listName}”. Each row is an item that has been placed on this board, and the section it ended up in MOST RECENTLY — earlier placements are kept in the board's history but never influence a suggestion. Typing a similar item into the board's Quick Add bar suggests that section.`,
    },
  ];

  if (rows.length === 0) {
    specs.push({
      type: 'paragraph',
      text: 'Nothing learned yet. Add items to this board and move them into sections — the memory fills itself in as you work.',
    });
  } else {
    specs.push({
      type: 'table',
      columns: ['Item', 'Last section', 'Times placed', 'Last seen'],
      rows: rows.slice(0, MAX_RENDERED_ROWS).map((r) => [r.title, r.sectionLabel, String(r.occurrences), formatDate(r.lastSeenAt)]),
    });
    if (rows.length > MAX_RENDERED_ROWS) {
      specs.push({
        type: 'paragraph',
        text: `…and ${rows.length - MAX_RENDERED_ROWS} more remembered ${rows.length - MAX_RENDERED_ROWS === 1 ? 'item' : 'items'} not shown here. All of them still inform suggestions.`,
      });
    }
  }

  const blocks: BlockLike[] = [];
  for (const spec of specs) {
    const built = buildMarkdownBlockFromSpec(spec);
    if ('error' in built) continue; // Shapes are built right here — a rejection means a spec bug, not user input.
    blocks.push(built.block as BlockLike);
  }
  return blocks;
}

/** Term the bubble is filed under. Unique per KB, so a second board with the same name is disambiguated rather than colliding. */
function bubbleTerm(listName: string, listId: string, disambiguate: boolean): string {
  const base = `Quick Add memory — ${listName}`.slice(0, 180);
  return disambiguate ? `${base} (${listId.slice(-6)})` : base;
}

/**
 * Create the board's bubble if it doesn't have one yet, and remember its id on
 * the list. Idempotent: safe to call on every enable-toggle and from the sweep.
 * Returns the entry id, or null when the board can't have one (no workspace).
 */
export async function ensureBubble(ctx: BubbleContext, exec: QueryExec = query): Promise<string | null> {
  const existing = await exec(`SELECT quick_add_kb_entry_id FROM lists WHERE id = $1`, [ctx.listId]);
  const currentId = (existing.rows[0] as { quick_add_kb_entry_id: string | null } | undefined)?.quick_add_kb_entry_id ?? null;
  if (currentId && (await getEntry(currentId, exec))) return currentId;

  // createBase is itself idempotent (returns the existing base rather than
  // erroring), so enabling Quick Add on a workspace with no Knowledge Base yet
  // creates one instead of failing — a user shouldn't have to know the
  // Knowledge Base exists to turn on a board setting.
  const { base } = await createBase(ctx.userId, ctx.workspaceId, {}, exec);

  let created = await createEntry(ctx.userId, base.id, {
    term: bubbleTerm(ctx.listName, ctx.listId, false),
    entryType: 'system',
    summary: `Quick Add's learned item → section placements for the “${ctx.listName}” board.`,
    properties: { quickAdd: true, listId: ctx.listId, board: ctx.listName },
    emoji: '⚡',
    // 'extracted' — machine-derived from this workspace's own activity. The
    // inspector badges it "Scanned", which is exactly what it is; 'ai' would
    // badge it as Sol-authored, which it isn't.
    origin: 'extracted',
    content: { version: 1, blocks: buildBubbleBlocks(ctx.listName, []) },
  }, exec);

  if (!created.ok && created.conflict) {
    created = await createEntry(ctx.userId, base.id, {
      term: bubbleTerm(ctx.listName, ctx.listId, true),
      entryType: 'system',
      summary: `Quick Add's learned item → section placements for the “${ctx.listName}” board.`,
      properties: { quickAdd: true, listId: ctx.listId, board: ctx.listName },
      emoji: '⚡',
      origin: 'extracted',
      content: { version: 1, blocks: buildBubbleBlocks(ctx.listName, []) },
    }, exec);
  }
  if (!created.ok) {
    werr(`quickAdd ensureBubble: could not create entry for list ${ctx.listId}: ${created.error}`);
    return null;
  }

  await exec(`UPDATE lists SET quick_add_kb_entry_id = $1, quick_add_memory_dirty = true WHERE id = $2`, [created.entry.id, ctx.listId]);

  // A real graph edge, so the bubble renders next to the board it belongs to
  // rather than floating loose among the workspace's terms. Best-effort: the
  // bubble is still useful if the entity_index row isn't there yet.
  await upsertLink(exec, {
    srcType: 'knowledgeEntry', srcId: created.entry.id,
    dstType: 'list', dstId: ctx.listId,
    linkType: 'defines', origin: 'system', createdBy: ctx.userId,
  }).catch((err) => werr('quickAdd ensureBubble: link to board failed (non-fatal):', err));

  wlog(`quickAdd bubble created entry=${created.entry.id} list=${ctx.listId}`);
  return created.entry.id;
}

/** Regenerate one board's bubble body from its current memory. No-op when the board has no bubble. */
export async function syncBubble(listId: string, exec: QueryExec = query): Promise<boolean> {
  const listRes = await exec(
    `SELECT name, quick_add_kb_entry_id FROM lists WHERE id = $1`,
    [listId]
  );
  const list = listRes.rows[0] as { name: string; quick_add_kb_entry_id: string | null } | undefined;
  if (!list?.quick_add_kb_entry_id) return false;

  const entry = await getEntry(list.quick_add_kb_entry_id, exec);
  if (!entry) {
    // The bubble was deleted from the Knowledge Base — respect that rather than
    // resurrecting it on the next sweep. Prediction is unaffected: it reads
    // section_memory, not this entry.
    await exec(`UPDATE lists SET quick_add_kb_entry_id = NULL WHERE id = $1`, [listId]);
    return false;
  }

  const rows = await exec(
    `SELECT m.title, m.occurrences, m.last_seen_at, s.label AS section_label
       FROM section_memory m JOIN sections s ON s.id = m.last_section_id
      WHERE m.list_id = $1
      ORDER BY m.last_seen_at DESC`,
    [listId]
  );
  const memory = (rows.rows as Array<{ title: string; occurrences: number; last_seen_at: string; section_label: string }>)
    .map((r) => ({ title: r.title, sectionLabel: r.section_label, occurrences: Number(r.occurrences), lastSeenAt: r.last_seen_at }));

  await setEntryContent(entry.id, buildBubbleBlocks(list.name, memory), exec);
  await updateEntry(entry.id, {
    summary: memory.length === 0
      ? `Quick Add has not learned anything about the “${list.name}” board yet.`
      : `Quick Add remembers where ${memory.length} ${memory.length === 1 ? 'item belongs' : 'items belong'} on the “${list.name}” board.`,
    properties: { ...(entry.properties ?? {}), quickAdd: true, listId, board: list.name, remembered: memory.length },
  }, exec);

  // Re-index the entry so the Knowledge Layer's search reflects the new body.
  const wsRes = await exec(`SELECT workspace_id FROM lists WHERE id = $1`, [listId]);
  const workspaceId = (wsRes.rows[0] as { workspace_id: string | null } | undefined)?.workspace_id ?? null;
  await enqueueEmbedding('knowledgeEntry', entry.id, workspaceId, exec);

  return true;
}

/**
 * Reconcile every board flagged dirty. Registered on an interval in index.ts's
 * start(). Bounded per pass so a bulk import can't turn one sweep into a long
 * write storm — the remaining boards keep their flag and are picked up next time.
 */
export async function sweepDirtyBubbles(exec: QueryExec = query, batchSize = 20): Promise<number> {
  try {
    // Ordered by id purely for a deterministic, non-starving batch — `lists`
    // has no updated_at to prioritise by, and every dirty board gets picked up
    // within a sweep or two regardless of order.
    const dirty = await exec(
      `SELECT id FROM lists
        WHERE quick_add_memory_dirty = true AND quick_add_kb_entry_id IS NOT NULL
        ORDER BY id ASC LIMIT $1`,
      [batchSize]
    );
    let synced = 0;
    for (const row of dirty.rows as Array<{ id: string }>) {
      try {
        await syncBubble(row.id, exec);
        synced++;
      } catch (err) {
        werr(`quickAdd bubble sweep failed for list ${row.id}:`, err);
      }
      // Cleared regardless: a board whose sync failed shouldn't spin the sweep
      // forever. The next placement re-flags it.
      await exec(`UPDATE lists SET quick_add_memory_dirty = false WHERE id = $1`, [row.id]);
    }
    if (synced > 0) wlog(`quickAdd bubble sweep synced ${synced} board(s)`);
    return synced;
  } catch (err) {
    werr('quickAdd bubble sweep error:', err);
    return 0;
  }
}
