import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppState, TrashedTask } from '../types';
import {
  apiGetTasks,
  apiGetLists,
  apiGetTrash,
  apiCreateTask,
  apiUpdateTask,
  apiDeleteTask,
  apiCreateList,
  apiUpdateList,
  apiDeleteList,
  apiUpdateListTask,
  apiDeleteListTask,
  apiAddToTrash,
  apiRestoreFromTrash,
  apiDeleteFromTrash,
  apiEmptyTrash,
} from '../api/client';

let trashCounter = Date.now();

const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      dashTasks: [],
      lists: [],
      trashTasks: [],
      sidebarWidth: 256,
      synced: false,
      lastSynced: null,

      setDashTasks: (tasks) => {
        if (typeof tasks === 'function') {
          set((state) => ({ dashTasks: tasks(state.dashTasks) }));
        } else {
          set({ dashTasks: tasks });
        }
      },

      setLists: (lists) => {
        if (typeof lists === 'function') {
          set((state) => ({ lists: lists(state.lists) }));
        } else {
          set({ lists });
        }
      },

      updateListTask: (listId, taskId, updates) => {
        set((state) => ({
          lists: state.lists.map((list) =>
            list.id !== listId
              ? list
              : {
                  ...list,
                  sections: list.sections.map((sec) => ({
                    ...sec,
                    tasks: sec.tasks.map((t) =>
                      t.id === taskId ? { ...t, ...updates } : t
                    ),
                  })),
                }
          ),
        }));
        apiUpdateListTask(listId, taskId, updates).catch(() => {});
      },

      deleteListTask: (listId, taskId) => {
        set((state) => ({
          lists: state.lists.map((list) =>
            list.id !== listId
              ? list
              : {
                  ...list,
                  sections: list.sections.map((sec) => ({
                    ...sec,
                    tasks: sec.tasks.filter((t) => t.id !== taskId),
                  })),
                }
          ),
        }));
        apiDeleteListTask(listId, taskId).catch(() => {});
      },

      addToTrash: (task, meta) => {
        const id = ++trashCounter;
        const trashEntry: TrashedTask = {
          id,
          taskId: task.id,
          task,
          meta,
          deletedAt: new Date().toISOString(),
        };
        set((state) => ({ trashTasks: [...state.trashTasks, trashEntry] }));
        apiAddToTrash(task.id, task, meta).catch(() => {});
      },

      restoreFromTrash: (trashId) => {
        const state = get();
        const trashEntry = state.trashTasks.find((t) => t.id === trashId);
        if (!trashEntry) return;

        if (trashEntry.meta.src === 'dash') {
          const restored = { ...trashEntry.task, checked: false };
          set((s) => ({
            dashTasks: [...s.dashTasks, restored],
            trashTasks: s.trashTasks.filter((t) => t.id !== trashId),
          }));
        } else if (trashEntry.meta.src === 'list' && trashEntry.meta.listId) {
          const listId = trashEntry.meta.listId;
          set((s) => ({
            lists: s.lists.map((list) => {
              if (list.id !== listId) return list;
              const firstSection = list.sections[0];
              if (!firstSection) return list;
              return {
                ...list,
                sections: list.sections.map((sec, idx) =>
                  idx === 0
                    ? { ...sec, tasks: [...sec.tasks, { ...trashEntry.task, checked: false }] }
                    : sec
                ),
              };
            }),
            trashTasks: s.trashTasks.filter((t) => t.id !== trashId),
          }));
        } else {
          set((s) => ({ trashTasks: s.trashTasks.filter((t) => t.id !== trashId) }));
        }
        apiRestoreFromTrash(trashId).catch(() => {});
      },

      deleteFromTrash: (trashId) => {
        set((state) => ({ trashTasks: state.trashTasks.filter((t) => t.id !== trashId) }));
        apiDeleteFromTrash(trashId).catch(() => {});
      },

      setSidebarWidth: (w) => set({ sidebarWidth: w }),

      setSynced: (synced, time) => {
        set({ synced, lastSynced: time ?? get().lastSynced });
      },

      loadFromApi: async () => {
        try {
          const [tasksRes, listsRes, trashRes] = await Promise.all([
            apiGetTasks().catch(() => null),
            apiGetLists().catch(() => null),
            apiGetTrash().catch(() => null),
          ]);
          const update: Partial<Pick<AppState, 'dashTasks' | 'lists' | 'trashTasks' | 'synced' | 'lastSynced'>> = {};
          if (tasksRes) update.dashTasks = tasksRes.tasks;
          if (listsRes) update.lists = listsRes.lists;
          if (trashRes) update.trashTasks = trashRes.trash;
          update.synced = true;
          update.lastSynced = new Date().toISOString();
          set(update as AppState);
        } catch {
          // fall back to persisted state
        }
      },
    }),
    {
      name: 'solytiq_app',
      partialize: (state) => ({
        dashTasks: state.dashTasks,
        lists: state.lists,
        trashTasks: state.trashTasks,
        sidebarWidth: state.sidebarWidth,
        lastSynced: state.lastSynced,
      }),
    }
  )
);

// Expose API functions for components to use directly
export {
  apiCreateTask,
  apiUpdateTask,
  apiDeleteTask,
  apiCreateList,
  apiUpdateList,
  apiDeleteList,
  apiEmptyTrash,
};

export default useAppStore;
