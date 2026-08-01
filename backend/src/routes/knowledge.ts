// ---------------------------------------------------------------------------
// /api/knowledge — the Knowledge Layer's search + status + admin-reindex
// surface. Search is available to any authenticated user (results are
// visibility-scoped by hybridSearch itself, same boundary as /api/links and
// /api/graph); status/reindex are read-only diagnostics and an admin-only
// power action respectively.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from 'express';
import { query } from '../db';
import { authenticate, requireAdmin } from '../middleware';
import { werr } from '../workspaceUtil';
import { isValidEntityType } from '../graph/srn';
import { hybridSearch } from '../knowledge/search';
import { getQueueStats, enqueueEmbedding } from '../knowledge/queue';
import { isPgvectorAvailable } from '../knowledge/state';
import { getEmbeddingConfig } from '../knowledge/embedProvider';

const router = Router();
router.use(authenticate);

async function loadAppSettings(): Promise<Record<string, string>> {
  const r = await query<{ key: string; value: string }>(`SELECT key, value FROM app_settings`);
  const out: Record<string, string> = {};
  for (const row of r.rows) out[row.key] = row.value;
  return out;
}

// POST /api/knowledge/search — { q, entityTypes?, workspaceId?, limit? }
router.post('/search', async (req: Request, res: Response) => {
  try {
    const { q, entityTypes, workspaceId, limit } = req.body as {
      q?: string; entityTypes?: string[]; workspaceId?: string; limit?: number;
    };
    if (!q || typeof q !== 'string' || q.trim().length < 2) { res.json({ results: [] }); return; }
    if (entityTypes && !entityTypes.every((t) => isValidEntityType(t))) { res.status(400).json({ error: 'Invalid entity type in "entityTypes"' }); return; }

    const settings = await loadAppSettings();
    const hits = await hybridSearch(req.userId!, q, settings, { entityTypes, workspaceId, limit });
    res.json({ results: hits });
  } catch (err) {
    werr('knowledge POST /search error:', err);
    res.status(500).json({ error: 'Internal search error' });
  }
});

// GET /api/knowledge/status — pgvector availability, provider configured, queue + budget state.
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const settings = await loadAppSettings();
    const stats = await getQueueStats();
    const monthKey = `embedding_tokens_used_${new Date().toISOString().slice(0, 7)}`;
    res.json({
      pgvectorAvailable: isPgvectorAvailable(),
      providerConfigured: getEmbeddingConfig(settings) !== null,
      searchEnabled: settings.knowledge_search_enabled !== 'false',
      queue: stats,
      budget: {
        monthlyLimit: Number(settings.embedding_monthly_token_budget ?? '0'),
        usedThisMonth: Number(settings[monthKey] ?? '0'),
      },
    });
  } catch (err) {
    werr('knowledge GET /status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/knowledge/reindex — admin-only. Re-queues every content-bearing
// entity (task/markdownList/milestone/meeting) instance-wide for re-chunking
// + re-embedding — a deliberate power action, mirrored on Nuke/admin settings
// rather than exposed per-workspace to avoid a lower-privileged user forcing
// a full-instance embedding-budget spend.
router.post('/reindex', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const r = await query<{ entity_type: string; entity_id: string; workspace_id: string | null }>(
      `SELECT entity_type, entity_id, workspace_id FROM entity_index
        WHERE entity_type IN ('task', 'markdownList', 'milestone', 'meeting', 'knowledgeEntry') AND is_trashed = false`
    );
    for (const row of r.rows) {
      await enqueueEmbedding(row.entity_type, row.entity_id, row.workspace_id);
    }
    res.json({ enqueued: r.rows.length });
  } catch (err) {
    werr('knowledge POST /reindex error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
