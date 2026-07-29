import { useEffect, useRef, useState } from 'react';
import type { EntityIndexEntry, GraphEntityType } from '../types';
import { apiSearchEntities } from '../api/client';

export interface UseEntitySearchOpts {
  entityTypes?: GraphEntityType[];
  workspaceId?: string;
  /** SRNs to drop from the results — e.g. entities already linked, or the entity being edited itself. */
  excludeSrns?: string[];
  limit?: number;
  minLength?: number;
  debounceMs?: number;
}

/** Debounced entity_index search (LinkPicker's data source). Empty/short queries never hit the network. */
export function useEntitySearch(query: string, opts: UseEntitySearchOpts = {}) {
  const { entityTypes, workspaceId, excludeSrns, limit, minLength = 1, debounceMs = 200 } = opts;
  const [results, setResults] = useState<EntityIndexEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < minLength) { setResults([]); setLoading(false); return; }
    const id = ++reqId.current;
    setLoading(true);
    const timer = setTimeout(() => {
      apiSearchEntities(q, { types: entityTypes, workspaceId, limit })
        .then((r) => {
          if (reqId.current !== id) return;
          const excluded = new Set(excludeSrns ?? []);
          setResults(r.results.filter((e) => !excluded.has(e.srn)));
        })
        .catch(() => { if (reqId.current === id) setResults([]); })
        .finally(() => { if (reqId.current === id) setLoading(false); });
    }, debounceMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, workspaceId, limit, minLength, debounceMs, JSON.stringify(entityTypes), JSON.stringify(excludeSrns)]);

  return { results, loading };
}
