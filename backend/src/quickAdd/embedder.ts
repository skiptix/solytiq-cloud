// ---------------------------------------------------------------------------
// Quick Add — memory-row embedding sweep.
//
// Deliberately NOT routed through knowledge/embedding_queue: that queue is
// keyed on (entity_type, entity_id) for rows that exist in entity_index, and a
// memory row is not an entity — it is a (board, normalized title) pair that
// deliberately outlives the task it was learned from. Rather than bending the
// queue's shape around a non-entity, this reuses the parts that actually
// generalize (the provider client, the pgvector-availability gate, the vector
// literal encoding) and keeps its own tiny sweep.
//
// Everything here is additive. No pgvector, or no embedding key, and this sweep
// simply never writes a vector — predictions keep running on the trigram and
// word-overlap channels, which need no external service at all.
// ---------------------------------------------------------------------------

import { query } from '../db';
import type { QueryExec } from '../workspaceUtil';
import { werr, wlog } from '../workspaceUtil';
import { isPgvectorAvailable } from '../knowledge/state';
import { getEmbeddingConfig, embedTexts, toVectorLiteral, type KnowledgeAppSettings } from '../knowledge/embedProvider';

/** Rows embedded per sweep. One provider call, small enough to stay well inside the batch limits every provider imposes. */
const BATCH_SIZE = 64;

async function appSettings(exec: QueryExec): Promise<KnowledgeAppSettings> {
  const r = await exec(`SELECT key, value FROM app_settings`);
  const out: Record<string, string> = {};
  for (const row of r.rows as Array<{ key: string; value: string }>) out[row.key] = row.value;
  return out as KnowledgeAppSettings;
}

/**
 * Embed memory rows that don't have a vector yet (new rows, and rows whose
 * stored title changed — recordPlacement nulls the embedding in that case, so
 * a stale vector is never left describing older wording).
 *
 * Returns how many rows were embedded. Best-effort throughout: a provider
 * outage logs and returns 0, leaving the rows to be retried next sweep.
 */
export async function sweepMemoryEmbeddings(exec: QueryExec = query): Promise<number> {
  if (!isPgvectorAvailable()) return 0;
  try {
    const config = getEmbeddingConfig(await appSettings(exec));
    if (!config) return 0;

    const pending = await exec(
      `SELECT list_id, title_key, title FROM section_memory
        WHERE embedding IS NULL
        ORDER BY last_seen_at DESC LIMIT $1`,
      [BATCH_SIZE]
    );
    const rows = pending.rows as Array<{ list_id: string; title_key: string; title: string }>;
    if (rows.length === 0) return 0;

    const vectors = await embedTexts(rows.map((r) => r.title), config);
    let written = 0;
    for (let i = 0; i < rows.length; i++) {
      const vector = vectors[i];
      if (!Array.isArray(vector) || vector.length === 0) continue;
      await exec(
        `UPDATE section_memory SET embedding = $1::vector WHERE list_id = $2 AND title_key = $3`,
        [toVectorLiteral(vector), rows[i].list_id, rows[i].title_key]
      );
      written++;
    }
    if (written > 0) wlog(`quickAdd embedded ${written} memory row(s)`);
    return written;
  } catch (err) {
    werr('quickAdd embedding sweep failed (non-fatal — lexical prediction continues):', err);
    return 0;
  }
}
