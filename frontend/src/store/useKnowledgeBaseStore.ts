// ---------------------------------------------------------------------------
// Knowledge Base store — the workspace's single curated dictionary.
//
// Loads as one payload (base + every entry) rather than paging: a Knowledge
// Base is tens-to-hundreds of entries and the net view needs all of them at
// once to lay out anyway. That is also why the backend emits ONE
// `knowledgeBase` sync signal for base and entry mutations alike — this store
// just refetches.
// ---------------------------------------------------------------------------

import { create } from 'zustand';
import type { KnowledgeBase, KnowledgeEntry, KnowledgeSuggestion } from '../types';
import {
  apiGetKnowledgeBase, apiCreateKnowledgeBase, apiUpdateKnowledgeBase, apiDeleteKnowledgeBase,
  apiCreateKnowledgeEntry, apiUpdateKnowledgeEntry, apiUpdateKnowledgeEntryContent, apiDeleteKnowledgeEntry,
  apiScanKnowledgeConcepts, apiGetKnowledgeSuggestions, apiDecideKnowledgeSuggestion,
} from '../api/client';

interface KnowledgeBaseStore {
  base: KnowledgeBase | null;
  entries: KnowledgeEntry[];
  suggestions: KnowledgeSuggestion[];
  /** Whether the signed-in user may author this base (workspace membership). */
  canWrite: boolean;
  loading: boolean;
  loaded: boolean;
  workspaceId: string | null;
  scanning: boolean;

  load: (workspaceId: string) => Promise<void>;
  /** Refetch the current workspace's base — wired to the `knowledgeBase` sync signal. */
  syncRefresh: () => Promise<void>;
  create: (workspaceId: string, input?: { name?: string; emoji?: string | null }) => Promise<KnowledgeBase>;
  updateBase: (input: { name?: string; emoji?: string | null; color?: string | null; description?: string | null }) => Promise<void>;
  removeBase: () => Promise<void>;

  createEntry: (input: { term: string; summary?: string | null; entryType?: string; aliases?: string[] }) => Promise<KnowledgeEntry>;
  updateEntry: (id: string, input: Partial<Pick<KnowledgeEntry, 'term' | 'aliases' | 'entryType' | 'summary' | 'properties' | 'emoji' | 'color' | 'position'>>) => Promise<KnowledgeEntry>;
  saveEntryContent: (id: string, blocks: unknown[]) => Promise<KnowledgeEntry>;
  removeEntry: (id: string) => Promise<void>;
  /** Local-only patch, for callers that already persisted (mirrors the other stores). */
  patchEntry: (id: string, updates: Partial<KnowledgeEntry>) => void;

  scan: () => Promise<{ proposed: number } | null>;
  loadSuggestions: () => Promise<void>;
  decideSuggestion: (suggestionId: string, accept: boolean) => Promise<void>;
}

const useKnowledgeBaseStore = create<KnowledgeBaseStore>()((set, get) => ({
  base: null,
  entries: [],
  suggestions: [],
  canWrite: false,
  loading: false,
  loaded: false,
  workspaceId: null,
  scanning: false,

  load: async (workspaceId) => {
    set({ loading: true, workspaceId });
    try {
      const res = await apiGetKnowledgeBase(workspaceId);
      // A workspace switch mid-flight must not let the older response win.
      if (get().workspaceId !== workspaceId) return;
      set({
        base: res.knowledgeBase, entries: res.entries, canWrite: res.canWrite ?? false,
        loading: false, loaded: true,
      });
    } catch {
      set({ loading: false });
    }
  },

  syncRefresh: async () => {
    const ws = get().workspaceId;
    if (!ws || !get().loaded) return;
    try {
      const res = await apiGetKnowledgeBase(ws);
      if (get().workspaceId !== ws) return;
      set({ base: res.knowledgeBase, entries: res.entries, canWrite: res.canWrite ?? false });
    } catch { /* a dropped refresh just means the next signal or navigation refetches */ }
  },

  create: async (workspaceId, input) => {
    const res = await apiCreateKnowledgeBase({ workspaceId, ...input });
    set({ base: res.knowledgeBase, workspaceId, canWrite: true, loaded: true });
    return res.knowledgeBase;
  },

  updateBase: async (input) => {
    const base = get().base;
    if (!base) return;
    const res = await apiUpdateKnowledgeBase(base.id, input);
    set({ base: res.knowledgeBase });
  },

  removeBase: async () => {
    const base = get().base;
    if (!base) return;
    await apiDeleteKnowledgeBase(base.id);
    set({ base: null, entries: [], suggestions: [] });
  },

  createEntry: async (input) => {
    const base = get().base;
    if (!base) throw new Error('No Knowledge Base in this workspace yet');
    const res = await apiCreateKnowledgeEntry(base.id, input);
    set((s) => ({ entries: [...s.entries, res.entry] }));
    return res.entry;
  },

  updateEntry: async (id, input) => {
    const res = await apiUpdateKnowledgeEntry(id, input);
    set((s) => ({ entries: s.entries.map((e) => (e.id === id ? res.entry : e)) }));
    return res.entry;
  },

  saveEntryContent: async (id, blocks) => {
    const res = await apiUpdateKnowledgeEntryContent(id, blocks);
    set((s) => ({ entries: s.entries.map((e) => (e.id === id ? res.entry : e)) }));
    return res.entry;
  },

  removeEntry: async (id) => {
    const prev = get().entries;
    set({ entries: prev.filter((e) => e.id !== id) });
    try {
      await apiDeleteKnowledgeEntry(id);
    } catch {
      set({ entries: prev });
    }
  },

  patchEntry: (id, updates) => {
    set((s) => ({ entries: s.entries.map((e) => (e.id === id ? { ...e, ...updates } : e)) }));
  },

  scan: async () => {
    const base = get().base;
    if (!base) return null;
    set({ scanning: true });
    try {
      const res = await apiScanKnowledgeConcepts(base.id);
      await get().loadSuggestions();
      return { proposed: res.proposed };
    } catch {
      return null;
    } finally {
      set({ scanning: false });
    }
  },

  loadSuggestions: async () => {
    const base = get().base;
    if (!base) return;
    try {
      const res = await apiGetKnowledgeSuggestions(base.id);
      set({ suggestions: res.suggestions });
    } catch { /* best-effort — the review list simply stays as-is */ }
  },

  decideSuggestion: async (suggestionId, accept) => {
    const prev = get().suggestions;
    set({ suggestions: prev.filter((s) => s.id !== suggestionId) });
    try {
      const res = await apiDecideKnowledgeSuggestion(suggestionId, accept);
      if (res.entry) set((s) => ({ entries: [...s.entries, res.entry as typeof s.entries[number]] }));
    } catch {
      set({ suggestions: prev });
    }
  },
}));

/** Drop everything loaded. Used on sign-out / account switch so one user's
 *  Knowledge Base can never be shown to the next. */
export const clearKnowledgeBaseStore = () => {
  useKnowledgeBaseStore.setState({
    base: null, entries: [], suggestions: [], canWrite: false,
    loading: false, loaded: false, workspaceId: null, scanning: false,
  });
};

export default useKnowledgeBaseStore;
