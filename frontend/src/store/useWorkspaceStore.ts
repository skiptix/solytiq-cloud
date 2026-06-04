import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Workspace, WorkspaceMember } from '../types';
import {
  apiGetWorkspaces, apiCreateWorkspace, apiUpdateWorkspace, apiDeleteWorkspace,
  apiGetWorkspaceMembers, apiAddWorkspaceMember, apiRemoveWorkspaceMember,
} from '../api/client';

interface WorkspaceState {
  workspaces: Workspace[];
  currentWorkspaceId: string | null;
  workspacesLoaded: boolean;
  setWorkspaces: (workspaces: Workspace[]) => void;
  setCurrentWorkspace: (id: string | null) => void;
  loadWorkspaces: () => Promise<void>;
  createWorkspace: (data: { name: string; description?: string; emoji?: string; image?: string; visibility?: 'private' | 'public' }) => Promise<Workspace>;
  updateWorkspace: (id: string, data: Partial<Pick<Workspace, 'name' | 'description' | 'emoji' | 'image' | 'visibility'>>) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  getMembers: (id: string) => Promise<WorkspaceMember[]>;
  addMember: (id: string, username: string) => Promise<WorkspaceMember>;
  removeMember: (id: string, userId: string) => Promise<void>;
}

const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      workspaces: [],
      currentWorkspaceId: null,
      workspacesLoaded: false,

      setWorkspaces: (workspaces) => set({ workspaces }),

      setCurrentWorkspace: (id) => set({ currentWorkspaceId: id }),

      loadWorkspaces: async () => {
        try {
          const res = await apiGetWorkspaces();
          const workspaces = res.workspaces;
          set((s) => {
            const current = s.currentWorkspaceId;
            const stillValid = current && workspaces.find(w => w.id === current);
            return {
              workspaces,
              currentWorkspaceId: stillValid ? current : (workspaces[0]?.id ?? null),
              workspacesLoaded: true,
            };
          });
        } catch {
          set({ workspacesLoaded: true });
        }
      },

      createWorkspace: async (data) => {
        const res = await apiCreateWorkspace(data);
        set(s => ({ workspaces: [...s.workspaces, res.workspace] }));
        return res.workspace;
      },

      updateWorkspace: async (id, data) => {
        await apiUpdateWorkspace(id, data);
        set(s => ({
          workspaces: s.workspaces.map(w => w.id === id ? { ...w, ...data } : w),
        }));
      },

      deleteWorkspace: async (id) => {
        await apiDeleteWorkspace(id);
        set(s => {
          const filtered = s.workspaces.filter(w => w.id !== id);
          const newCurrent = s.currentWorkspaceId === id ? (filtered[0]?.id ?? null) : s.currentWorkspaceId;
          return { workspaces: filtered, currentWorkspaceId: newCurrent };
        });
      },

      getMembers: async (id) => {
        const res = await apiGetWorkspaceMembers(id);
        return res.members;
      },

      addMember: async (id, username) => {
        const res = await apiAddWorkspaceMember(id, username);
        return res.member;
      },

      removeMember: async (id, userId) => {
        await apiRemoveWorkspaceMember(id, userId);
      },
    }),
    {
      name: 'solytiq_workspace',
      partialize: (state) => ({
        currentWorkspaceId: state.currentWorkspaceId,
      }),
    }
  )
);

export default useWorkspaceStore;
