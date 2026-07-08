import { create } from 'zustand';
import type { Template } from '../types';
import {
  apiGetTemplates,
  apiCreateTemplate,
  apiUpdateTemplate,
  apiDeleteTemplate,
  apiUseTemplate,
} from '../api/client';
import type { List, Timeline } from '../types';

interface TemplatesStore {
  templates: Template[];
  loading: boolean;
  loaded: boolean;
  load: (type?: 'list' | 'timeline') => Promise<void>;
  create: (data: { type: 'list' | 'timeline'; sourceId: string; name?: string; description?: string; isShared?: boolean }) => Promise<Template>;
  update: (id: string, data: Partial<Pick<Template, 'name' | 'description' | 'emoji' | 'color' | 'colorBg' | 'isShared'>>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  use: (id: string, data: { name?: string; isPublic?: boolean; workspaceId?: string; folderId?: string }) => Promise<{ list?: List; timeline?: Timeline }>;
}

const useTemplatesStore = create<TemplatesStore>()((set, get) => ({
  templates: [],
  loading: false,
  loaded: false,

  load: async (type) => {
    set({ loading: true });
    try {
      const res = await apiGetTemplates(type);
      set({ templates: res.templates, loading: false, loaded: true });
    } catch {
      set({ loading: false });
    }
  },

  create: async (data) => {
    const res = await apiCreateTemplate(data);
    set((s) => ({ templates: [res.template, ...s.templates] }));
    return res.template;
  },

  update: async (id, data) => {
    const prev = get().templates;
    set({ templates: prev.map((t) => (t.id === id ? { ...t, ...data } : t)) });
    try {
      const res = await apiUpdateTemplate(id, data);
      set((s) => ({ templates: s.templates.map((t) => (t.id === id ? res.template : t)) }));
    } catch {
      set({ templates: prev });
    }
  },

  remove: async (id) => {
    const prev = get().templates;
    set({ templates: prev.filter((t) => t.id !== id) });
    try {
      await apiDeleteTemplate(id);
    } catch {
      set({ templates: prev });
    }
  },

  use: (id, data) => apiUseTemplate(id, data),
}));

export default useTemplatesStore;
