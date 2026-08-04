// ---------------------------------------------------------------------------
// Sol's long-term memory — small, durable per-user facts that ride in every
// chat's system prompt (progressive-disclosure-free: unlike AI Skills there's
// no separate "read the full body on demand" step, memory entries are small
// enough to just inline outright). Loaded once per session, like
// useAiSkillsStore's enabled index. Also backs the Account Settings →
// Preferences "Memory" list, which is why this store keeps full entries
// (id + content), not just a hint shape.
// ---------------------------------------------------------------------------

import { create } from 'zustand';
import type { AiMemoryEntry } from '../types';
import { apiGetMemory, apiDeleteMemoryEntry, apiClearMemory } from '../api/client';

interface AiMemoryStore {
  entries: AiMemoryEntry[];
  loaded: boolean;
  loading: boolean;
  load: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  clear: () => Promise<void>;
}

const useAiMemoryStore = create<AiMemoryStore>()((set, get) => ({
  entries: [],
  loaded: false,
  loading: false,

  load: async () => {
    set({ loading: true });
    try {
      const res = await apiGetMemory();
      set({ entries: res.memory, loaded: true, loading: false });
    } catch {
      set({ loaded: true, loading: false });
    }
  },

  remove: async (id) => {
    const prev = get().entries;
    set({ entries: prev.filter((e) => e.id !== id) });
    try {
      await apiDeleteMemoryEntry(id);
    } catch {
      set({ entries: prev });
    }
  },

  clear: async () => {
    const prev = get().entries;
    set({ entries: [] });
    try {
      await apiClearMemory();
    } catch {
      set({ entries: prev });
    }
  },
}));

export default useAiMemoryStore;
