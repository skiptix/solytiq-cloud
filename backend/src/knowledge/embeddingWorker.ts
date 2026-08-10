// ---------------------------------------------------------------------------
// Embedding worker — the DB/HTTP orchestration for the embedding_queue.
// Pulls a small batch, chunks each entity's current text (chunker.ts), reuses
// unchanged chunks' embeddings (planEmbeddingWork), calls the configured
// provider only for what actually changed, and enforces a soft monthly token
// budget (app_settings.embedding_monthly_token_budget, 0 = unlimited).
//
// Registered on a 2-minute sweep in index.ts's start() — short enough that a
// freshly-saved note gets searchable quickly, long enough not to hammer the
// provider. Every step is best-effort: a provider outage or a missing key
// degrades a queue item to 'failed'/kept 'pending' rather than crashing the
// sweep, matching the rest of the codebase's cron conventions (AI file purge,
// overdue-deadline sweep, Automation Hub's schedule sweep).
// ---------------------------------------------------------------------------

import { query } from '../db';
import type { QueryExec } from '../workspaceUtil';
import { chunkText, flattenMarkdownBlocks, planEmbeddingWork, estimateTokens, type ExistingChunkRow } from './chunker';
import { claimQueueBatch, markQueueItem, type EmbeddingQueueRow } from './queue';
import { isPgvectorAvailable } from './state';
import { getEmbeddingConfig, embedTexts, toVectorLiteral, type KnowledgeAppSettings } from './embedProvider';
import { releaseOwnedLeases } from '../jobLease';
import { WORKER_ID } from '../workerId';

const BATCH_SIZE = 5;

async function fetchDocumentText(entityType: string, entityId: string, exec: QueryExec): Promise<string | null> {
  switch (entityType) {
    case 'task': {
      const r = await exec(`SELECT title, note FROM tasks WHERE id = $1::bigint`, [entityId]);
      const row = r.rows[0] as { title: string; note: string | null } | undefined;
      if (!row) return null;
      return [row.title, row.note].filter(Boolean).join('\n\n');
    }
    case 'markdownList': {
      const r = await exec(`SELECT name, subtitle, content FROM markdown_lists WHERE id = $1`, [entityId]);
      const row = r.rows[0] as { name: string; subtitle: string | null; content: unknown } | undefined;
      if (!row) return null;
      const content = row.content as { blocks?: unknown } | null;
      const blocks = Array.isArray(content?.blocks) ? (content!.blocks as never[]) : [];
      return [row.name, row.subtitle, flattenMarkdownBlocks(blocks)].filter(Boolean).join('\n\n');
    }
    case 'milestone': {
      const r = await exec(`SELECT title, description FROM milestones WHERE id = $1`, [entityId]);
      const row = r.rows[0] as { title: string; description: string | null } | undefined;
      if (!row) return null;
      return [row.title, row.description].filter(Boolean).join('\n\n');
    }
    case 'meeting': {
      const r = await exec(`SELECT title, description FROM meetings WHERE id = $1`, [entityId]);
      const row = r.rows[0] as { title: string; description: string | null } | undefined;
      if (!row) return null;
      return [row.title, row.description].filter(Boolean).join('\n\n');
    }
    // A Knowledge Base entry is indexed like any other document, so a semantic
    // search surfaces curated definitions alongside ordinary content. The term
    // and its aliases lead the text on purpose: they are the highest-signal
    // part of the entry, and a chunk that opens with them embeds closer to the
    // queries people actually ask about that term.
    case 'knowledgeEntry': {
      const r = await exec(`SELECT term, aliases, summary, content FROM knowledge_entries WHERE id = $1`, [entityId]);
      const row = r.rows[0] as { term: string; aliases: string[] | null; summary: string | null; content: unknown } | undefined;
      if (!row) return null;
      const content = row.content as { blocks?: unknown } | null;
      const blocks = Array.isArray(content?.blocks) ? (content!.blocks as never[]) : [];
      const aliases = (row.aliases ?? []).length > 0 ? `Also known as: ${(row.aliases ?? []).join(', ')}` : null;
      return [row.term, aliases, row.summary, flattenMarkdownBlocks(blocks)].filter(Boolean).join('\n\n');
    }
    default:
      return null;
  }
}

function parseVectorLiteral(literal: string): number[] {
  return literal.slice(1, -1).split(',').filter(Boolean).map(Number);
}

async function getAppSettings(exec: QueryExec): Promise<KnowledgeAppSettings & Record<string, string>> {
  const r = await exec(`SELECT key, value FROM app_settings`);
  const out: Record<string, string> = {};
  for (const row of r.rows as Array<{ key: string; value: string }>) out[row.key] = row.value;
  return out;
}

async function getMonthlyBudgetState(exec: QueryExec): Promise<{ used: number; budget: number; monthKey: string }> {
  const monthKey = `embedding_tokens_used_${new Date().toISOString().slice(0, 7)}`;
  const settings = await getAppSettings(exec);
  return {
    used: Number(settings[monthKey] ?? '0'),
    budget: Number(settings.embedding_monthly_token_budget ?? '0'),
    monthKey,
  };
}

async function recordTokenUsage(monthKey: string, tokens: number, exec: QueryExec): Promise<void> {
  await exec(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = (COALESCE(app_settings.value, '0')::bigint + $2::bigint)::text`,
    [monthKey, String(tokens)]
  );
}

async function processQueueItem(item: EmbeddingQueueRow, exec: QueryExec): Promise<void> {
  try {
    const text = await fetchDocumentText(item.entityType, item.entityId, exec);
    if (!text?.trim()) {
      await exec(`DELETE FROM entity_chunks WHERE entity_type = $1 AND entity_id = $2`, [item.entityType, item.entityId]);
      await markQueueItem(item.id, 'done', null, exec);
      return;
    }

    const chunks = chunkText(text);
    const pgvector = isPgvectorAvailable();
    const existingRes = await exec(
      `SELECT chunk_index, content_hash${pgvector ? ', embedding' : ''} FROM entity_chunks WHERE entity_type = $1 AND entity_id = $2`,
      [item.entityType, item.entityId]
    );
    const existing: ExistingChunkRow[] = (existingRes.rows as Array<{ chunk_index: number; content_hash: string; embedding?: string | null }>).map((r) => ({
      index: r.chunk_index,
      contentHash: r.content_hash,
      embedding: pgvector && r.embedding ? parseVectorLiteral(r.embedding) : null,
    }));
    const planned = planEmbeddingWork(chunks, existing);
    const needsEmbedding = planned.filter((p) => p.needsEmbedding);

    if (needsEmbedding.length > 0 && pgvector) {
      const settings = await getAppSettings(exec);
      const config = getEmbeddingConfig(settings);
      if (config) {
        const { used, budget, monthKey } = await getMonthlyBudgetState(exec);
        const estimatedTokens = needsEmbedding.reduce((sum, c) => sum + estimateTokens(c.content), 0);
        if (budget > 0 && used + estimatedTokens > budget) {
          await markQueueItem(item.id, 'skipped_budget', 'monthly embedding token budget exceeded', exec);
          return;
        }
        const vectors = await embedTexts(needsEmbedding.map((c) => c.content), config);
        needsEmbedding.forEach((c, i) => { c.embedding = vectors[i] ?? null; });
        await recordTokenUsage(monthKey, estimatedTokens, exec);
      }
    }

    await exec(`DELETE FROM entity_chunks WHERE entity_type = $1 AND entity_id = $2`, [item.entityType, item.entityId]);
    for (const c of planned) {
      if (pgvector) {
        await exec(
          `INSERT INTO entity_chunks (id, entity_type, entity_id, workspace_id, chunk_index, content, content_hash, token_count, embedding, created_at, updated_at)
           VALUES ('chk_' || gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::vector, NOW(), NOW())`,
          [item.entityType, item.entityId, item.workspaceId, c.index, c.content, c.contentHash, estimateTokens(c.content), c.embedding ? toVectorLiteral(c.embedding) : null]
        );
      } else {
        await exec(
          `INSERT INTO entity_chunks (id, entity_type, entity_id, workspace_id, chunk_index, content, content_hash, token_count, created_at, updated_at)
           VALUES ('chk_' || gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
          [item.entityType, item.entityId, item.workspaceId, c.index, c.content, c.contentHash, estimateTokens(c.content)]
        );
      }
    }
    await markQueueItem(item.id, 'done', null, exec);
  } catch (err) {
    console.error('📚 ✗ embedding worker failed for', item.entityType, item.entityId, err);
    try { await markQueueItem(item.id, 'failed', err instanceof Error ? err.message : String(err), exec); } catch { /* best-effort */ }
  }
}

// B8 — mirrors automationEngine.ts's `currentlyExecutingScheduleAutomationId`
// (see that module's own comment for the full rationale): the embedding_
// queue item id (if any) THIS process is actively processing right now,
// within sweepEmbeddingQueue()'s own sequential loop below. A plain
// module-level variable is sufficient — this loop is strictly sequential,
// never more than one item in flight per process.
let currentlyProcessingQueueItemId: string | null = null;

/**
 * B8 — releases the lease on every `embedding_queue` row THIS process
 * currently holds, EXCEPT whichever one (if any) is actively mid-
 * `processQueueItem()` right now. See automationEngine.ts's
 * `releaseUnstartedScheduleLeases()` for the identical pattern applied to
 * the OTHER lease-based sweep, and jobLease.ts's `releaseOwnedLeases()` for
 * why excluding the in-flight one is essential.
 */
export async function releaseUnstartedEmbeddingLeases(): Promise<number> {
  const exclude = currentlyProcessingQueueItemId ? [currentlyProcessingQueueItemId] : [];
  return releaseOwnedLeases('embedding_queue', WORKER_ID, exclude);
}

export async function sweepEmbeddingQueue(exec: QueryExec = query): Promise<void> {
  try {
    const batch = await claimQueueBatch(BATCH_SIZE, exec);
    for (const item of batch) {
      currentlyProcessingQueueItemId = item.id;
      try {
        await processQueueItem(item, exec);
      } finally {
        currentlyProcessingQueueItemId = null;
      }
    }
  } catch (err) {
    console.error('📚 ✗ sweepEmbeddingQueue failed:', err);
  }
}
