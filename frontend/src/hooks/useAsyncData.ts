import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Load data for a key, and keep the loading flag and the "no data for this key
 * yet" state honest without setting either from inside an effect.
 *
 * ## Why this exists
 *
 * ~24 files hand-rolled the same effect:
 *
 * ```tsx
 * useEffect(() => {
 *   if (!id) { setData([]); return; }   // clear the PREVIOUS id's data
 *   setLoading(true);
 *   let cancelled = false;
 *   fetchThing(id).then(r => { if (!cancelled) setData(r); });
 *   return () => { cancelled = true; };
 * }, [id]);
 * ```
 *
 * Both of those synchronous setState calls are load-bearing — drop the reset
 * and the previous entity's data stays on screen while the new request is in
 * flight — which is why `react-hooks/set-state-in-effect` could not simply be
 * obeyed at each call site. It is also three different spellings of
 * cancellation across the codebase (`cancelled`, `alive`, `reqId.current`),
 * each subtly re-derived.
 *
 * ## How it avoids the effect-setState entirely
 *
 * State holds the key the data was fetched FOR, not just the data. Everything
 * else is derived at render:
 *
 * - `data` is the stored value only while its key still matches the current
 *   one; otherwise it is `initial`. That IS the guard-reset, for free, with no
 *   frame where stale data is shown against a new key.
 * - `loading` is "the current key has no settled result yet". It becomes true
 *   the instant the key changes, without anyone setting it.
 *
 * The effect's only job is to fetch and store, and its setState happens in an
 * async continuation, which is not what the rule is about.
 *
 * Requests are also serialised by key: a response whose key is no longer the
 * current one is discarded, so an out-of-order slow response cannot overwrite
 * a newer fast one.
 */

export interface AsyncDataOptions {
  /**
   * When false, no request is made and `data` stays at `initial` — the
   * `if (!id) return;` guard, expressed as a value rather than a branch.
   * Defaults to true.
   */
  enabled?: boolean;
  /**
   * Wait this long after the key settles before fetching. For search-as-you-
   * type callers that debounced by hand with a setTimeout in the effect.
   */
  debounceMs?: number;
}

export interface AsyncDataResult<T> {
  data: T;
  loading: boolean;
  error: unknown;
  /** Re-run the current key's fetch (e.g. after a mutation). */
  reload: () => void;
  /**
   * Patch the loaded value locally, for lists that are fetched once and then
   * mutated in place — an attachment added after upload, a row removed after
   * delete. Writes against the CURRENT key only, so an edit cannot leak onto
   * whatever loads next; if the key has moved on, the write is dropped rather
   * than corrupting the new key's data.
   */
  setData: (update: T | ((prev: T) => T)) => void;
}

/**
 * @param key    Identifies what is being loaded. `null` means "nothing to
 *               load" and is equivalent to `enabled: false`. Objects are
 *               compared by their JSON form, so an inline `{ a, b }` is fine.
 * @param fetcher Receives an AbortSignal — pass it to fetch/the API client
 *               where the call supports it. Cancellation is handled either
 *               way: a response for a stale key is discarded.
 * @param initial The value `data` takes before anything has loaded, and
 *               whenever the current key has no result.
 */
export default function useAsyncData<T>(
  key: unknown,
  fetcher: (signal: AbortSignal) => Promise<T>,
  initial: T,
  { enabled = true, debounceMs = 0 }: AsyncDataOptions = {}
): AsyncDataResult<T> {
  const active = enabled && key !== null && key !== undefined;
  // A stable string for an arbitrary key. Deliberately not reference identity:
  // the common call site passes an inline object or array, which would be a
  // new reference every render and refetch forever.
  const keyId = active ? JSON.stringify(key) : null;

  const [settled, setSettled] = useState<{ key: string; data: T } | null>(null);
  const [failure, setFailure] = useState<{ key: string; error: unknown } | null>(null);
  // Bumping this re-runs the current key's fetch without changing the key.
  const [reloadTick, setReloadTick] = useState(0);

  // Read from a ref so a caller may pass a fresh closure every render — the
  // usual case, since it closes over props — without restarting the request.
  const fetcherRef = useRef(fetcher);
  useEffect(() => { fetcherRef.current = fetcher; }, [fetcher]);

  const matches = keyId !== null && settled?.key === keyId;
  const failed = keyId !== null && failure?.key === keyId;

  useEffect(() => {
    if (keyId === null) return;
    let cancelled = false;
    const controller = new AbortController();

    const run = async () => {
      try {
        const value = await fetcherRef.current(controller.signal);
        if (cancelled) return;
        setSettled({ key: keyId, data: value });
        setFailure(null);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setFailure({ key: keyId, error: err });
      }
    };

    // A debounced caller must not fire during the wait, so the timer is the
    // thing that gets cancelled — not just the response that comes back.
    if (debounceMs > 0) {
      const timer = setTimeout(() => { void run(); }, debounceMs);
      return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
    }
    void run();
    return () => { cancelled = true; controller.abort(); };
  }, [keyId, debounceMs, reloadTick]);

  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  // `initial` is a dependency rather than a ref written during render: writing
  // a ref mid-render is exactly what react-hooks/refs forbids, and callers are
  // already expected to pass a stable identity here (see the EMPTY_* consts at
  // every call site) precisely because `data` returns it as-is.
  const setData = useCallback((update: T | ((prev: T) => T)) => {
    setSettled((prev) => {
      if (keyId === null) return prev;
      const base = prev?.key === keyId ? prev.data : initial;
      const next = typeof update === 'function' ? (update as (p: T) => T)(base) : update;
      return { key: keyId, data: next };
    });
  }, [keyId, initial]);

  return {
    data: matches ? (settled as { key: string; data: T }).data : initial,
    // True whenever this key has neither a result nor an error yet. Nobody
    // sets this; it follows from the key changing.
    loading: keyId !== null && !matches && !failed,
    error: failed ? failure?.error : null,
    reload,
    setData,
  };
}
