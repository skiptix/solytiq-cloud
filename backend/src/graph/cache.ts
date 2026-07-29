// ---------------------------------------------------------------------------
// In-memory LRU cache for full-workspace graph payloads, keyed on the
// workspace's max sync_log seq — the moment any tracked mutation lands the
// seq advances and the cached entry is naturally invalid. No manual
// invalidation, no race window (see CLAUDE.md's Graph Layer section).
// ---------------------------------------------------------------------------

import { query } from '../db';

interface CacheEntry<T> {
  seq: number;
  payload: T;
  at: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const MAX_ENTRIES = 50;
const TTL_MS = 10 * 60 * 1000;

export async function currentSyncSeq(workspaceId: string): Promise<number> {
  const r = await query<{ m: string }>(
    `SELECT COALESCE(MAX(seq), 0) AS m FROM sync_log WHERE workspace_id = $1`,
    [workspaceId]
  );
  return Number(r.rows[0].m);
}

export function getCachedGraph<T>(workspaceId: string, seq: number): T | null {
  const hit = cache.get(workspaceId) as CacheEntry<T> | undefined;
  if (!hit) return null;
  if (hit.seq !== seq || Date.now() - hit.at > TTL_MS) {
    cache.delete(workspaceId);
    return null;
  }
  return hit.payload;
}

export function setCachedGraph<T>(workspaceId: string, seq: number, payload: T): void {
  if (cache.size >= MAX_ENTRIES && !cache.has(workspaceId)) {
    const oldestKey = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(workspaceId, { seq, payload, at: Date.now() });
}

/** Test/ops helper — drop every cached entry. */
export function clearGraphCache(): void {
  cache.clear();
}
