import { create } from 'zustand';
import { apiSyncBootstrap, apiSyncDelta, setMutationSettledHandler, ApiError } from '../api/client';
import type { SseFrame, DeltaChange } from '../api/client';
import useAppStore from './useAppStore';
import useWorkspaceStore from './useWorkspaceStore';
import useSharedItemsStore from './useSharedItemsStore';

// Entities the app store patches from full payloads. Everything else is a
// refetch signal owned by a screen/store (meetings → Calendar, files → Files,
// workspace → workspace list, trash → trash buckets).
const CORE = new Set(['task', 'list', 'folder', 'timeline']);

interface SyncState {
  cursor: number;
  status: 'idle' | 'bootstrapping' | 'live';
  // Monotonic per-entity-kind counters. Consumers of data that lives OUTSIDE the
  // app store (CalendarScreen for meetings, FilesScreen for files) subscribe to
  // their kind's counter and refetch when it bumps.
  entityRevisions: Record<string, number>;
  bootstrap: (workspaceId?: string) => Promise<void>;
  pullDelta: () => Promise<void>;
  applyFrame: (frame: SseFrame) => void;
}

// Single-flight guard: collapse overlapping delta pulls (SSE nudge + focus +
// post-write reconcile can all fire at once) into one in-flight request.
let pulling = false;
// Monotonic id so a superseded bootstrap (rapid workspace switches) can't land
// after a newer one and clobber it.
let bootstrapId = 0;

// Defense in depth: a `workspace` signal is supposed to mean "membership or
// visibility actually changed", but a backend defect that makes some write
// path unconditionally re-touch a row (an `ON CONFLICT DO UPDATE` missing a
// change-guard) can make it fire on every read, and reloading the workspace
// list on every one of those creates a self-sustaining request loop — a
// concrete instance of this already happened and is fixed server-side (see
// ensureOwnedWorkspaceMemberships in workspaceUtil.ts), but a signal this
// class of bug can produce should never be able to drive an unthrottled loop
// from the client either. A genuine membership change reflecting a few
// seconds late is imperceptible; a tight loop is not.
const WORKSPACE_RELOAD_MIN_INTERVAL_MS = 5000;
let lastWorkspaceReload = 0;
function reloadWorkspacesThrottled(): void {
  const now = Date.now();
  if (now - lastWorkspaceReload < WORKSPACE_RELOAD_MIN_INTERVAL_MS) return;
  lastWorkspaceReload = now;
  void useWorkspaceStore.getState().loadWorkspaces();
}

const useSyncStore = create<SyncState>((set, get) => ({
  cursor: 0,
  status: 'idle',
  entityRevisions: {},

  bootstrap: async (workspaceId) => {
    const wsId = workspaceId ?? useWorkspaceStore.getState().currentWorkspaceId ?? undefined;
    const myId = ++bootstrapId;
    set({ status: 'bootstrapping' });
    useAppStore.setState({ listsLoading: true });
    try {
      const snap = await apiSyncBootstrap(wsId);
      if (myId !== bootstrapId) return; // a newer bootstrap superseded this one
      useAppStore.getState().hydrateFromSnapshot(snap);
      set({ cursor: snap.cursor, status: 'live' });
      // Trash isn't in the bootstrap payload (only needed for the Trash modal) —
      // load it via the existing, tested loader.
      void useAppStore.getState().loadFromApi(wsId, { only: ['trash'] });
    } catch {
      // Bootstrap failed — fall back to the classic loader so data still shows.
      set({ status: 'idle' });
      void useAppStore.getState().loadFromApi(wsId);
    }
  },

  pullDelta: async () => {
    // Only pull once we've bootstrapped (have a real cursor). Before bootstrap,
    // or after it failed into legacy-loader fallback, a pull would fetch a huge
    // since=0 delta against stale/empty state — bootstrap is the loader then.
    if (get().status !== 'live') return;
    if (pulling) return;
    pulling = true;
    try {
      const wsId = useWorkspaceStore.getState().currentWorkspaceId ?? undefined;
      const since = get().cursor;
      const res = await apiSyncDelta(since, wsId);
      if (res.reset) {
        // Cursor older than retention → drop local state and re-bootstrap.
        await get().bootstrap(wsId);
        return;
      }
      const core: DeltaChange[] = [];
      const signals = new Set<string>();
      for (const c of res.changes) {
        if (CORE.has(c.entity)) core.push(c);
        else signals.add(c.entity);
      }
      if (core.length) useAppStore.getState().applyDeltas(core);
      if (signals.size) {
        set((s) => {
          const rev = { ...s.entityRevisions };
          for (const e of signals) rev[e] = (rev[e] ?? 0) + 1;
          return { entityRevisions: rev };
        });
        // Membership/visibility changed → the workspace list and its scoped
        // content may both differ; reload the workspace list (which re-bootstraps).
        if (signals.has('workspace')) reloadWorkspacesThrottled();
        // Trash changed → refresh the trash buckets (cheap; only visible in the modal).
        if (signals.has('trash')) void useAppStore.getState().loadFromApi(wsId, { only: ['trash'] });
      }
      if (res.cursor > get().cursor) set({ cursor: res.cursor });
    } catch (err) {
      // 403 → we lost access to the current workspace; reload the workspace list
      // so the UI drops it and switches away.
      if (err instanceof ApiError && err.status === 403) {
        reloadWorkspacesThrottled();
      }
      // Other errors are transient — the next nudge / focus / poll retries.
    } finally {
      pulling = false;
    }
  },

  applyFrame: (frame) => {
    const wsId = useWorkspaceStore.getState().currentWorkspaceId;
    // A change confined to a DIFFERENT workspace doesn't affect the current view
    // (we bootstrap that workspace when we switch to it) — unless it's a
    // workspace/membership change, which can grant or revoke access.
    const touchesWorkspace = frame.entities?.some((e) => e.entity === 'workspace');
    if (frame.workspaceId != null && wsId != null && frame.workspaceId !== wsId && !touchesWorkspace) return;
    // Skip only when the frame's cursor is present AND already applied; otherwise
    // (advanced cursor, or a legacy `{type}` nudge with no cursor) pull deltas.
    if (frame.cursor != null && frame.cursor <= get().cursor) return;
    void get().pullDelta();
  },
}));

// ~300ms after any successful write, reconcile optimistic local state via a
// delta pull (matches the NeetoPlanner cadence) — this is what corrects things
// like a stale post-edit `version` without waiting on a realtime frame or the
// 30s sweep. pullDelta is single-flight + a no-op before bootstrap, so this is
// always safe to fire. Debounced so a burst of writes (e.g. a drag-reorder)
// schedules one reconcile, not one per row.
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
setMutationSettledHandler(() => {
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    void useSyncStore.getState().pullDelta();
    // Edits to a "shared with me" item (from another workspace) don't ride the
    // active workspace's delta — refresh that set too, but only for users who
    // actually have shared items so it costs nothing for everyone else.
    const shared = useSharedItemsStore.getState();
    if (shared.lists.length || shared.timelines.length || shared.markdownLists.length) {
      void shared.load();
    }
  }, 300);
});

export default useSyncStore;
