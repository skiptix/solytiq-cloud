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
  deletingWorkspaceId: string | null;
  setWorkspaces: (workspaces: Workspace[]) => void;
  setCurrentWorkspace: (id: string | null) => void;
  setDeletingWorkspaceId: (id: string | null) => void;
  loadWorkspaces: () => Promise<void>;
  createWorkspace: (data: { name: string; description?: string; emoji?: string; image?: string; visibility?: 'private' | 'public' }) => Promise<Workspace>;
  updateWorkspace: (id: string, data: Partial<Pick<Workspace, 'name' | 'description' | 'emoji' | 'image' | 'visibility'>> & { cascade?: boolean }) => Promise<void>;
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
      deletingWorkspaceId: null,

      setWorkspaces: (workspaces) => set({ workspaces }),

      setCurrentWorkspace: (id) => set({ currentWorkspaceId: id }),

      setDeletingWorkspaceId: (id) => set({ deletingWorkspaceId: id }),

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
        const patch = { ...data };
        delete patch.cascade;
        set(s => ({
          workspaces: s.workspaces.map(w => w.id === id ? { ...w, ...patch } : w),
        }));
      },

      deleteWorkspace: async (id) => {
        await apiDeleteWorkspace(id);
        set(s => {
          const filtered = s.workspaces.filter(w => w.id !== id);
          const newCurrent = s.currentWorkspaceId === id ? (filtered[0]?.id ?? null) : s.currentWorkspaceId;
          return { workspaces: filtered, currentWorkspaceId: newCurrent, deletingWorkspaceId: null };
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

export const clearWorkspaceStore = () => {
  // Keep the persisted `currentWorkspaceId` so a user lands back in the workspace
  // they last worked in after signing out and back in. loadWorkspaces() validates
  // it against the signed-in user's workspaces and falls back to the first one if
  // it isn't valid for them, so preserving it is safe even across different users.
  useWorkspaceStore.setState({
    workspaces: [],
    workspacesLoaded: false,
    deletingWorkspaceId: null,
  });
};

export default useWorkspaceStore;
