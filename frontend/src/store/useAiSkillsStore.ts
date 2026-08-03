import { create } from 'zustand';
import type { AiSkill, AiSkillHint } from '../types';
import {
  apiGetEnabledAiSkills,
  apiListAiSkills,
  apiCreateAiSkill,
  apiUpdateAiSkill,
  apiSetAiSkillEnabled,
  apiDeleteAiSkill,
} from '../api/client';

interface AiSkillsStore {
  // Lightweight, always-loaded index (name + description of ENABLED skills
  // only) — this is what buildSystemPrompt injects into every chat via
  // progressive disclosure. Loaded once per session, like useInstalledAppsStore.
  enabledSkills: AiSkillHint[];
  enabledLoaded: boolean;
  loadEnabled: () => Promise<void>;

  // Full admin management list (Settings → AI Skills) — every skill, enabled
  // or not, with content. Loaded on demand when the admin tab opens.
  skills: AiSkill[];
  loading: boolean;
  loaded: boolean;
  load: () => Promise<void>;
  create: (data: { name: string; description?: string; content: string }) => Promise<AiSkill>;
  update: (id: string, data: { name?: string; description?: string; content?: string; enabled?: boolean }) => Promise<AiSkill>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Patch a single skill already loaded into `skills` (e.g. after a REST
   *  upload response) without a full refetch. */
  patchOne: (skill: AiSkill) => void;
}

const useAiSkillsStore = create<AiSkillsStore>()((set, get) => ({
  enabledSkills: [],
  enabledLoaded: false,

  loadEnabled: async () => {
    try {
      const res = await apiGetEnabledAiSkills();
      set({ enabledSkills: res.skills, enabledLoaded: true });
    } catch {
      set({ enabledLoaded: true });
    }
  },

  skills: [],
  loading: false,
  loaded: false,

  load: async () => {
    set({ loading: true });
    try {
      const res = await apiListAiSkills();
      set({ skills: res.skills, loading: false, loaded: true });
    } catch {
      set({ loading: false });
    }
  },

  create: async (data) => {
    const res = await apiCreateAiSkill(data);
    set((s) => ({ skills: [res.skill, ...s.skills] }));
    get().loadEnabled();
    return res.skill;
  },

  update: async (id, data) => {
    const res = await apiUpdateAiSkill(id, data);
    set((s) => ({ skills: s.skills.map((sk) => (sk.id === id ? res.skill : sk)) }));
    get().loadEnabled();
    return res.skill;
  },

  setEnabled: async (id, enabled) => {
    const prev = get().skills;
    set({ skills: prev.map((s) => (s.id === id ? { ...s, enabled } : s)) });
    try {
      const res = await apiSetAiSkillEnabled(id, enabled);
      set((s) => ({ skills: s.skills.map((sk) => (sk.id === id ? res.skill : sk)) }));
      get().loadEnabled();
    } catch {
      set({ skills: prev });
    }
  },

  remove: async (id) => {
    const prev = get().skills;
    set({ skills: prev.filter((s) => s.id !== id) });
    try {
      await apiDeleteAiSkill(id);
      get().loadEnabled();
    } catch {
      set({ skills: prev });
    }
  },

  patchOne: (skill) => {
    set((s) => {
      const exists = s.skills.some((sk) => sk.id === skill.id);
      return { skills: exists ? s.skills.map((sk) => (sk.id === skill.id ? skill : sk)) : [skill, ...s.skills] };
    });
    get().loadEnabled();
  },
}));

export default useAiSkillsStore;
