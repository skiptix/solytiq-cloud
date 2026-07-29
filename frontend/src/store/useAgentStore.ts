import { create } from 'zustand';
import type { AgentRun, AgentProposal, AgentMode, AgentPolicy } from '../types';
import {
  apiGetAgentRuns, apiGetAgentRun, apiStartAgentRun, apiCancelAgentRun, apiRevertAgentRun,
  apiGetAgentProposals, apiAcceptAgentProposal, apiRejectAgentProposal, apiSetWorkspaceAgent,
} from '../api/client';

interface AgentStore {
  runs: AgentRun[];
  proposals: AgentProposal[];
  loading: boolean;
  loaded: boolean;
  workspaceId: string | null;

  load: (workspaceId: string) => Promise<void>;
  loadProposals: (workspaceId: string) => Promise<void>;
  getRun: (id: string) => Promise<AgentRun>;
  startRun: (workspaceId: string, goal: string, triggerType?: string) => Promise<AgentRun>;
  cancelRun: (id: string) => Promise<void>;
  revertRun: (id: string) => Promise<{ reverted: number; failed: number; skipped: number }>;
  acceptProposal: (id: string) => Promise<void>;
  rejectProposal: (id: string, reason?: string) => Promise<void>;
  setWorkspaceAgent: (workspaceId: string, mode?: AgentMode, policy?: AgentPolicy) => Promise<{ agentMode: AgentMode; agentPolicy: AgentPolicy }>;
}

const useAgentStore = create<AgentStore>()((set, get) => ({
  runs: [],
  proposals: [],
  loading: false,
  loaded: false,
  workspaceId: null,

  load: async (workspaceId) => {
    set({ loading: true, workspaceId });
    try {
      const res = await apiGetAgentRuns(workspaceId);
      // A workspace switch mid-flight shouldn't let a stale response overwrite the newer one's data.
      if (get().workspaceId !== workspaceId) return;
      set({ runs: res.runs, loading: false, loaded: true });
    } catch {
      set({ loading: false });
    }
  },

  loadProposals: async (workspaceId) => {
    try {
      const res = await apiGetAgentProposals(workspaceId);
      if (get().workspaceId !== workspaceId) return;
      set({ proposals: res.proposals });
    } catch {
      /* the inbox just stays empty; retried on next open */
    }
  },

  getRun: async (id) => {
    const res = await apiGetAgentRun(id);
    set((s) => ({ runs: s.runs.map((r) => (r.id === id ? res.run : r)) }));
    return res.run;
  },

  startRun: async (workspaceId, goal, triggerType) => {
    const res = await apiStartAgentRun({ workspaceId, goal, triggerType });
    set((s) => ({ runs: [res.run, ...s.runs] }));
    return res.run;
  },

  cancelRun: async (id) => {
    const res = await apiCancelAgentRun(id);
    set((s) => ({ runs: s.runs.map((r) => (r.id === id ? res.run : r)) }));
  },

  revertRun: async (id) => apiRevertAgentRun(id),

  acceptProposal: async (id) => {
    await apiAcceptAgentProposal(id);
    set((s) => ({ proposals: s.proposals.filter((p) => p.id !== id) }));
  },

  rejectProposal: async (id, reason) => {
    await apiRejectAgentProposal(id, reason);
    set((s) => ({ proposals: s.proposals.filter((p) => p.id !== id) }));
  },

  setWorkspaceAgent: async (workspaceId, mode, policy) => {
    const res = await apiSetWorkspaceAgent(workspaceId, { agentMode: mode, agentPolicy: policy });
    return res;
  },
}));

export default useAgentStore;
