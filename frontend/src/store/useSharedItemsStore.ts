import { create } from 'zustand';
import { apiGetSharedWithMe } from '../api/client';
import type { List, Timeline, MarkdownList } from '../types';

// ── "Shared with me" store ────────────────────────────────────────────────────
// Items (lists / timelines / markdown pages) another user has invited THIS user
// to, loaded independently of the workspace-scoped app store so they're reachable
// from any workspace. The screens fall back to this store when an item isn't in
// the active workspace's data; the Sidebar renders them in a "Shared with me"
// section (de-duped against items already visible in the current workspace).

interface SharedItemsState {
  lists: List[];
  timelines: Timeline[];
  markdownLists: MarkdownList[];
  loaded: boolean;
  loading: boolean;
  load: () => Promise<void>;
  reset: () => void;
}

const useSharedItemsStore = create<SharedItemsState>()((set, get) => ({
  lists: [],
  timelines: [],
  markdownLists: [],
  loaded: false,
  loading: false,

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const res = await apiGetSharedWithMe();
      set({ lists: res.lists, timelines: res.timelines, markdownLists: res.markdownLists, loaded: true });
    } catch {
      /* transient — retried on the next signal / focus */
    } finally {
      set({ loading: false });
    }
  },

  reset: () => set({ lists: [], timelines: [], markdownLists: [], loaded: false, loading: false }),
}));

export default useSharedItemsStore;
