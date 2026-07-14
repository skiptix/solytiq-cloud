import { create } from 'zustand';
import type { Automation, AutomationGraph, AutomationRun, AutomationRunResult, TriggerTypeDef, ActionTypeDef } from '../types';
import {
  apiGetAutomations,
  apiGetAutomation,
  apiCreateAutomation,
  apiUpdateAutomation,
  apiSetAutomationEnabled,
  apiDeleteAutomation,
  apiGetAutomationRuns,
  apiGetAutomationNodeTypes,
  apiTestAutomationNode,
} from '../api/client';

interface AutomationsStore {
  automations: Automation[];
  nodeTypes: { triggers: TriggerTypeDef[]; actions: ActionTypeDef[] } | null;
  loading: boolean;
  loaded: boolean;
  workspaceId: string | null;

  load: (workspaceId: string) => Promise<void>;
  loadNodeTypes: () => Promise<void>;
  getDetail: (id: string) => Promise<Automation>;
  create: (data: { workspaceId: string; name: string; description?: string; graph: AutomationGraph }) => Promise<Automation>;
  update: (id: string, data: { name?: string; description?: string | null; graph?: AutomationGraph; expectedVersion?: number }) => Promise<Automation>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
  getRuns: (id: string, limit?: number) => Promise<AutomationRun[]>;
  testNode: (id: string, nodeId?: string) => Promise<AutomationRunResult>;
}

const useAutomationsStore = create<AutomationsStore>()((set, get) => ({
  automations: [],
  nodeTypes: null,
  loading: false,
  loaded: false,
  workspaceId: null,

  load: async (workspaceId) => {
    set({ loading: true, workspaceId });
    try {
      const res = await apiGetAutomations(workspaceId);
      // A workspace switch mid-flight shouldn't let a stale response overwrite
      // the newer one's data.
      if (get().workspaceId !== workspaceId) return;
      set({ automations: res.automations, loading: false, loaded: true });
    } catch {
      set({ loading: false });
    }
  },

  loadNodeTypes: async () => {
    if (get().nodeTypes) return;
    try {
      const res = await apiGetAutomationNodeTypes();
      set({ nodeTypes: res });
    } catch {
      /* editor falls back to an empty palette; retried on next open */
    }
  },

  getDetail: async (id) => (await apiGetAutomation(id)).automation,

  create: async (data) => {
    const res = await apiCreateAutomation(data);
    set((s) => ({ automations: [res.automation, ...s.automations] }));
    return res.automation;
  },

  update: async (id, data) => {
    const res = await apiUpdateAutomation(id, data);
    set((s) => ({ automations: s.automations.map((a) => (a.id === id ? res.automation : a)) }));
    return res.automation;
  },

  setEnabled: async (id, enabled) => {
    const prev = get().automations;
    set({ automations: prev.map((a) => (a.id === id ? { ...a, enabled } : a)) });
    try {
      const res = await apiSetAutomationEnabled(id, enabled);
      set((s) => ({ automations: s.automations.map((a) => (a.id === id ? res.automation : a)) }));
    } catch {
      set({ automations: prev });
    }
  },

  remove: async (id) => {
    const prev = get().automations;
    set({ automations: prev.filter((a) => a.id !== id) });
    try {
      await apiDeleteAutomation(id);
    } catch {
      set({ automations: prev });
    }
  },

  getRuns: async (id, limit) => (await apiGetAutomationRuns(id, limit)).runs,

  testNode: async (id, nodeId) => (await apiTestAutomationNode(id, nodeId)).result,
}));

export default useAutomationsStore;
