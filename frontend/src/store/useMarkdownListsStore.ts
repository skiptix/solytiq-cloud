import { create } from 'zustand';
import type { MarkdownList, MarkdownListContent } from '../types';
import {
  apiGetMarkdownLists,
  apiGetMarkdownList,
  apiCreateMarkdownList,
  apiUpdateMarkdownList,
  apiDeleteMarkdownList,
} from '../api/client';

interface MarkdownListsStore {
  markdownLists: MarkdownList[];
  loading: boolean;
  loaded: boolean;
  workspaceId: string | null;

  load: (workspaceId?: string) => Promise<void>;
  getDetail: (id: string) => Promise<MarkdownList>;
  create: (data: { name: string; emoji?: string; color?: string; colorBg?: string; subtitle?: string; isPublic?: boolean; folderId?: string; workspaceId?: string }) => Promise<MarkdownList>;
  update: (id: string, data: Partial<Pick<MarkdownList, 'name' | 'emoji' | 'color' | 'colorBg' | 'subtitle' | 'isPublic' | 'fullWidth' | 'folderId' | 'position'>> & { content?: MarkdownListContent; expectedVersion?: number }) => Promise<MarkdownList>;
  remove: (id: string) => Promise<void>;
  /** Local-only patch, no network call — for syncing state after a caller
   *  (e.g. ItemSettingsModal's ShareSection/AccessibilitySection) already
   *  made its own API call and just needs the store to reflect the result. */
  patch: (id: string, updates: Partial<MarkdownList>) => void;
}

const useMarkdownListsStore = create<MarkdownListsStore>()((set, get) => ({
  markdownLists: [],
  loading: false,
  loaded: false,
  workspaceId: null,

  load: async (workspaceId) => {
    set({ loading: true, workspaceId: workspaceId ?? null });
    try {
      const res = await apiGetMarkdownLists(workspaceId);
      // A workspace switch mid-flight shouldn't let a stale response overwrite
      // the newer one's data.
      if (get().workspaceId !== (workspaceId ?? null)) return;
      set({ markdownLists: res.markdownLists, loading: false, loaded: true });
    } catch {
      set({ loading: false });
    }
  },

  getDetail: async (id) => (await apiGetMarkdownList(id)).markdownList,

  create: async (data) => {
    const res = await apiCreateMarkdownList(data);
    set((s) => ({ markdownLists: [...s.markdownLists, res.markdownList] }));
    return res.markdownList;
  },

  update: async (id, data) => {
    const res = await apiUpdateMarkdownList(id, data);
    set((s) => ({ markdownLists: s.markdownLists.map((m) => (m.id === id ? res.markdownList : m)) }));
    return res.markdownList;
  },

  remove: async (id) => {
    const prev = get().markdownLists;
    set({ markdownLists: prev.filter((m) => m.id !== id) });
    try {
      await apiDeleteMarkdownList(id);
    } catch {
      set({ markdownLists: prev });
    }
  },

  patch: (id, updates) => {
    set((s) => ({ markdownLists: s.markdownLists.map((m) => (m.id === id ? { ...m, ...updates } : m)) }));
  },
}));

export default useMarkdownListsStore;
