import { create } from 'zustand';
import { apiGetSharedWithMe } from '../api/client';
import type { Folder, List, Timeline, MarkdownList } from '../types';

// ── "Shared with me" store ────────────────────────────────────────────────────
// Items (folders / lists / timelines / markdown pages) another user has invited
// THIS user to, loaded independently of the workspace-scoped app store so
// they're reachable from any workspace. The screens fall back to this store when
// an item isn't in the active workspace's data; the Sidebar renders them in a
// "Shared with me" section (de-duped against items already visible in the
// current workspace).
//
// A folder invitation arrives here as the folder PLUS its current contents —
// the server resolves that cascade (see backend/src/itemShares.ts), so nothing
// on the client needs to know the containment rules to render the group.

interface SharedItemsState {
  folders: Folder[];
  lists: List[];
  timelines: Timeline[];
  markdownLists: MarkdownList[];
  loaded: boolean;
  loading: boolean;
  load: () => Promise<void>;
  reset: () => void;
}

const useSharedItemsStore = create<SharedItemsState>()((set, get) => ({
  folders: [],
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
      set({
        folders: res.folders ?? [],
        lists: res.lists,
        timelines: res.timelines,
        markdownLists: res.markdownLists,
        loaded: true,
      });
    } catch {
      /* transient — retried on the next signal / focus */
    } finally {
      set({ loading: false });
    }
  },

  reset: () => set({ folders: [], lists: [], timelines: [], markdownLists: [], loaded: false, loading: false }),
}));

export default useSharedItemsStore;
