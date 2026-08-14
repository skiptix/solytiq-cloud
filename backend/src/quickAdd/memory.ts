// ---------------------------------------------------------------------------
// Quick Add — placement memory.
//
// TWO tables, and the split between them is the whole design:
//
//   section_placement_events  Append-only history. Every create/move/stage/
//                             delete a board's items ever went through, with
//                             the section id AND a label snapshot so a row
//                             stays readable after the section is gone.
//                             NOTHING in the prediction path reads this table.
//
//   section_memory            The projection the predictor reads. Keyed
//                             (list_id, title_key), holding exactly ONE row per
//                             remembered item title whose `last_section_id` is,
//                             by construction, the most recent placement.
//
// That split is how "only the LAST section may drive the automation" is
// guaranteed. It is not a WHERE clause or an ORDER BY … LIMIT 1 that a future
// query could forget: the projection PHYSICALLY CANNOT hold an earlier state,
// because writing a new placement overwrites the old one in the same UPSERT.
// The history is still there — in the table the predictor has no reason to
// open — so a later feature can chart an item's journey without any of that
// leaking into what the suggestion says.
//
// Recording is best-effort and NEVER throws into the caller's save — the same
// contract mentions.ts, graph/inlineLinks.ts and knowledge/queue.ts hold. A
// board's memory failing to update must not fail the task write that triggered
// it.
// ---------------------------------------------------------------------------

import { query } from '../db';
import type { QueryExec } from '../workspaceUtil';
import { werr } from '../workspaceUtil';
import type { MutationActor } from '../automationEngine';
import { isPgvectorAvailable } from '../knowledge/state';
import { titleKey } from './titleKey';

export type PlacementEventType = 'created' | 'moved' | 'staged' | 'deleted';

export interface RecordPlacementInput {
  listId: string;
  taskId: string | number;
  title: string;
  /** Section the item came FROM, or null when it was created / staged. */
  fromSectionId?: string | null;
  /** Section the item went TO. Null = it left the sections entirely (staged, or deleted). */
  toSectionId?: string | null;
  eventType: PlacementEventType;
  actor: MutationActor;
}

export interface MemoryRow {
  list_id: string;
  title_key: string;
  title: string;
  last_section_id: string;
  occurrences: number;
  last_seen_at: string;
}

async function sectionLabels(exec: QueryExec, ids: string[]): Promise<Record<string, string>> {
  const present = ids.filter((id): id is string => !!id);
  if (present.length === 0) return {};
  const r = await exec(`SELECT id, label FROM sections WHERE id = ANY($1::varchar[])`, [present]);
  return Object.fromEntries((r.rows as { id: string; label: string }[]).map((row) => [row.id, row.label]));
}

/**
 * Record one placement.
 *
 * The event row is always written. The projection is upserted ONLY when the
 * item landed in a real section: a delete or a move back to the staging tray
 * deliberately LEAVES the last known section in place, because "where did this
 * item end up last time I had one" is exactly as useful once the item is gone —
 * which is the behaviour this feature was asked for.
 */
export async function recordPlacement(exec: QueryExec, input: RecordPlacementInput): Promise<void> {
  try {
    const key = titleKey(input.title);
    if (!key) return; // Nothing memorable — an all-punctuation title has no identity to key on.

    const labels = await sectionLabels(exec, [input.fromSectionId ?? '', input.toSectionId ?? '']);
    const actorId = input.actor.type === 'user' ? input.actor.userId : input.actor.automationId;

    await exec(
      `INSERT INTO section_placement_events
         (list_id, task_id, title, title_key, from_section_id, from_section_label, to_section_id, to_section_label, event_type, actor_type, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        input.listId, String(input.taskId), input.title, key,
        input.fromSectionId ?? null, input.fromSectionId ? labels[input.fromSectionId] ?? null : null,
        input.toSectionId ?? null, input.toSectionId ? labels[input.toSectionId] ?? null : null,
        input.eventType, input.actor.type, actorId,
      ]
    );

    if (!input.toSectionId) return;

    // The UPSERT that makes "last section only" a structural fact. `occurrences`
    // counts how often this title has been placed at all (evidence strength);
    // `last_section_id` is simply overwritten, never appended to.
    //
    // The `embedding` clause is appended ONLY when pgvector is available: on a
    // plain postgres:16 image the column does not exist at all (see the
    // migration), and naming it unconditionally made this whole statement fail
    // — silently, since recording is best-effort, which would have left the
    // board learning nothing while appearing to work. Every other module in
    // this feature already checks reality the same way rather than assuming.
    //
    // When it IS present, the embedding is cleared whenever the stored title
    // text changes, so the sweep re-embeds rather than leaving a vector that
    // describes older wording.
    const embeddingClause = isPgvectorAvailable()
      ? `, embedding = CASE WHEN section_memory.title IS DISTINCT FROM EXCLUDED.title THEN NULL ELSE section_memory.embedding END`
      : '';
    await exec(
      `INSERT INTO section_memory (list_id, title_key, title, last_section_id, occurrences, last_seen_at)
       VALUES ($1, $2, $3, $4, 1, NOW())
       ON CONFLICT (list_id, title_key) DO UPDATE
         SET last_section_id = EXCLUDED.last_section_id,
             title           = EXCLUDED.title,
             occurrences     = section_memory.occurrences + 1,
             last_seen_at    = NOW()${embeddingClause}`,
      [input.listId, key, input.title.trim().slice(0, 500), input.toSectionId]
    );

    // Flag the board's Knowledge Base bubble as stale. Regenerating its body on
    // every single task move would rewrite a JSONB document per drag; a
    // debounced sweep (quickAdd/bubbleSweep) reconciles it instead — the same
    // dirty-flag-plus-interval shape graph/metrics.ts uses for pagerank.
    await exec(`UPDATE lists SET quick_add_memory_dirty = true WHERE id = $1`, [input.listId]);
  } catch (err) {
    werr('quickAdd recordPlacement failed (non-fatal):', err);
  }
}

/** Every remembered item on a board, most recently seen first. Powers the KB bubble's rendered table. */
export async function getMemoryForList(listId: string, exec: QueryExec = query): Promise<MemoryRow[]> {
  const r = await exec(
    `SELECT list_id, title_key, title, last_section_id, occurrences, last_seen_at
       FROM section_memory WHERE list_id = $1
      ORDER BY last_seen_at DESC`,
    [listId]
  );
  return r.rows as MemoryRow[];
}

/** Placement history for one board — stored, never consulted by the predictor. Exposed for a future timeline view. */
export async function getPlacementHistory(
  listId: string,
  limit = 200,
  exec: QueryExec = query
): Promise<Array<{ taskId: string; title: string; fromSectionLabel: string | null; toSectionLabel: string | null; eventType: PlacementEventType; occurredAt: string }>> {
  const r = await exec(
    `SELECT task_id, title, from_section_label, to_section_label, event_type, occurred_at
       FROM section_placement_events WHERE list_id = $1
      ORDER BY occurred_at DESC LIMIT $2`,
    [listId, Math.min(1000, Math.max(1, limit))]
  );
  return (r.rows as Array<{ task_id: string; title: string; from_section_label: string | null; to_section_label: string | null; event_type: PlacementEventType; occurred_at: string }>)
    .map((row) => ({
      taskId: row.task_id,
      title: row.title,
      fromSectionLabel: row.from_section_label,
      toSectionLabel: row.to_section_label,
      eventType: row.event_type,
      occurredAt: row.occurred_at,
    }));
}

/** How much a board has learned — surfaced in list settings so the toggle isn't a black box. */
export async function getMemoryStats(
  listId: string,
  exec: QueryExec = query
): Promise<{ remembered: number; events: number; lastLearnedAt: string | null }> {
  const [memory, events] = await Promise.all([
    exec(`SELECT COUNT(*)::int AS n, MAX(last_seen_at) AS last FROM section_memory WHERE list_id = $1`, [listId]),
    exec(`SELECT COUNT(*)::int AS n FROM section_placement_events WHERE list_id = $1`, [listId]),
  ]);
  const m = memory.rows[0] as { n: number; last: string | null } | undefined;
  const e = events.rows[0] as { n: number } | undefined;
  return { remembered: Number(m?.n ?? 0), events: Number(e?.n ?? 0), lastLearnedAt: m?.last ?? null };
}
