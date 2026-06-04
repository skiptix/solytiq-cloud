import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppState, TrashedTask, TrashedList, TrashedFolder } from '../types';
import useWorkspaceStore from './useWorkspaceStore';
import {
  apiGetTasks,
  apiGetLists,
  apiGetFolders,
  apiCreateFolder,
  apiUpdateFolder,
  apiDeleteFolder,
  apiGetTrash,
  apiGetTrashLists,
  apiGetTrashFolders,
  apiCreateTask,
  apiUpdateTask,
  apiDeleteTask,
  apiCreateList,
  apiUpdateList,
  apiDeleteList,
  apiUpdateListTask,
  apiDeleteListTask,
  apiAddListTask,
  apiAddToTrash,
  apiRestoreFromTrash,
  apiDeleteFromTrash,
  apiRestoreListFromTrash,
  apiDeleteListFromTrash,
  apiRestoreFolderFromTrash,
  apiDeleteFolderFromTrash,
  apiEmptyTrash,
} from '../api/client';

let trashCounter = Date.now();
let currentLoadId = 0;

const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      dashTasks: [],
      lists: [],
      folders: [],
      listsLoading: false,
      trashTasks: [],
      trashLists: [],
      trashFolders: [],
      sidebarWidth: 256,

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

      setFolders: (folders) => {
        if (typeof folders === 'function') {
          set((state) => ({ folders: folders(state.folders) }));
        } else {
          set({ folders });
        }
      },

      addFolder: (folder) => {
        const { currentWorkspaceId } = useWorkspaceStore.getState();
        const folderWithDefaults = {
          ...folder,
          isPublic: folder.isPublic ?? true,
          workspaceId: folder.workspaceId ?? currentWorkspaceId ?? undefined,
        };
        set((state) => ({ folders: [...state.folders, folderWithDefaults] }));
        apiCreateFolder({
          id: folderWithDefaults.id,
          name: folderWithDefaults.name,
          emoji: folderWithDefaults.emoji,
          color: folderWithDefaults.color,
          isPublic: folderWithDefaults.isPublic,
          workspaceId: folderWithDefaults.workspaceId,
        }).catch(() => {
          set((state) => ({ folders: state.folders.filter((f) => f.id !== folderWithDefaults.id) }));
          get().loadFromApi();
        });
      },

      updateFolder: (id, updates) => {
        const prev = get().folders.find((f) => f.id === id);
        set((state) => ({
          folders: state.folders.map((f) => (f.id === id ? { ...f, ...updates } : f)),
        }));
        apiUpdateFolder(id, updates).catch(() => {
          if (prev) {
            set((state) => ({
              folders: state.folders.map((f) => (f.id === id ? prev : f)),
            }));
          }
          get().loadFromApi();
        });
      },

      deleteFolder: (id) => {
        const state = get();
        const folder = state.folders.find((f) => f.id === id);
        const listIds = state.lists.filter((l) => l.folderId === id).map((l) => l.id);

        set((s) => ({
          folders: s.folders.filter((f) => f.id !== id),
          lists: s.lists.map((l) => l.folderId === id ? { ...l, folderId: undefined } : l),
        }));

        let trashId: number | null = null;
        if (folder) {
          trashId = ++trashCounter;
          const trashEntry: TrashedFolder = {
            id: trashId,
            folderId: folder.id,
            folder: { ...folder, listIds },
            deletedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          };
          set((s) => ({ trashFolders: [...s.trashFolders, trashEntry] }));
        }

        apiDeleteFolder(id).catch(() => {
          if (folder) {
            set((s) => ({
              folders: [...s.folders, folder],
              lists: s.lists.map((l) => listIds.includes(l.id) ? { ...l, folderId: id } : l),
              trashFolders: trashId != null ? s.trashFolders.filter((t) => t.id !== trashId) : s.trashFolders,
            }));
          }
          get().loadFromApi();
        });
      },

      updateList: (listId, updates) => {
        const prev = get().lists.find((l) => l.id === listId);
        set((state) => ({
          lists: state.lists.map((l) => (l.id === listId ? { ...l, ...updates } : l)),
        }));
        apiUpdateList(listId, updates).catch(() => {
          if (prev) {
            set((state) => ({
              lists: state.lists.map((l) => (l.id === listId ? prev : l)),
            }));
          }
          get().loadFromApi();
        });
      },

      deleteList: (listId) => {
        const state = get();
        const list = state.lists.find((l) => l.id === listId);

        set((s) => ({ lists: s.lists.filter((l) => l.id !== listId) }));

        let trashId: number | null = null;
        if (list) {
          trashId = ++trashCounter;
          const trashEntry: TrashedList = {
            id: trashId,
            listId: list.id,
            list,
            deletedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          };
          set((s) => ({ trashLists: [...s.trashLists, trashEntry] }));
        }

        apiDeleteList(listId).catch(() => {
          if (list) {
            set((s) => ({
              lists: [...s.lists, list],
              trashLists: trashId != null ? s.trashLists.filter((t) => t.id !== trashId) : s.trashLists,
            }));
          }
          get().loadFromApi();
        });
      },

      updateDashTask: (taskId, updates) => {
        const prev = get().dashTasks.find((t) => t.id === taskId);
        set((state) => ({
          dashTasks: state.dashTasks.map((t) =>
            t.id === taskId ? { ...t, ...updates } : t
          ),
        }));
        apiUpdateTask(taskId, updates).catch(() => {
          if (prev) {
            set((state) => ({
              dashTasks: state.dashTasks.map((t) => (t.id === taskId ? prev : t)),
            }));
          }
          get().loadFromApi();
        });
      },

      updateListTask: (listId, taskId, updates) => {
        const prevTask = get()
          .lists.find((l) => l.id === listId)
          ?.sections.flatMap((s) => s.tasks)
          .find((t) => t.id === taskId);
        set((state) => ({
          lists: state.lists.map((list) => {
            if (list.id !== listId) return list;
            const updatedSections = list.sections.map((sec) => ({
              ...sec,
              tasks: sec.tasks.map((t) =>
                t.id === taskId ? { ...t, ...updates } : t
              ),
            }));
            const allTasks = updatedSections.flatMap((s) => s.tasks);
            return {
              ...list,
              sections: updatedSections,
              linkedProgress: {
                total: allTasks.length,
                completed: allTasks.filter((t) => t.checked).length,
              },
            };
          }),
        }));
        apiUpdateListTask(listId, taskId, updates).catch(() => {
          if (prevTask) {
            set((state) => ({
              lists: state.lists.map((list) => {
                if (list.id !== listId) return list;
                return {
                  ...list,
                  sections: list.sections.map((sec) => ({
                    ...sec,
                    tasks: sec.tasks.map((t) => (t.id === taskId ? prevTask : t)),
                  })),
                };
              }),
            }));
          }
          get().loadFromApi();
        });
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
        apiDeleteListTask(listId, taskId).catch(() => { get().loadFromApi(); });
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

      restoreListFromTrash: (trashId) => {
        const state = get();
        const entry = state.trashLists.find((t) => t.id === trashId);
        if (!entry) return;
        set((s) => ({
          lists: [...s.lists, entry.list],
          trashLists: s.trashLists.filter((t) => t.id !== trashId),
        }));
        apiRestoreListFromTrash(trashId).catch(() => {});
      },

      deleteListFromTrash: (trashId) => {
        set((s) => ({ trashLists: s.trashLists.filter((t) => t.id !== trashId) }));
        apiDeleteListFromTrash(trashId).catch(() => {});
      },

      restoreFolderFromTrash: (trashId) => {
        const state = get();
        const entry = state.trashFolders.find((t) => t.id === trashId);
        if (!entry) return;
        const { listIds, ...folderData } = entry.folder;
        set((s) => ({
          folders: [...s.folders, folderData],
          lists: s.lists.map((l) =>
            (listIds ?? []).includes(l.id) ? { ...l, folderId: entry.folderId } : l
          ),
          trashFolders: s.trashFolders.filter((t) => t.id !== trashId),
        }));
        apiRestoreFolderFromTrash(trashId).catch(() => {});
      },

      deleteFolderFromTrash: (trashId) => {
        set((s) => ({ trashFolders: s.trashFolders.filter((t) => t.id !== trashId) }));
        apiDeleteFolderFromTrash(trashId).catch(() => {});
      },

      setSidebarWidth: (w) => set({ sidebarWidth: w }),

      moveTaskToList: (taskId, targetListId) => {
        const state = get();
        const task = state.dashTasks.find(t => t.id === taskId);
        if (!task) return;
        const targetList = state.lists.find(l => l.id === targetListId);
        if (!targetList || !targetList.sections.length) return;
        const firstSection = targetList.sections[0];
        const tempTask = { ...task, _source: 'list' as const, _listId: targetListId, _listName: targetList.name };

        set(s => ({
          dashTasks: s.dashTasks.filter(t => t.id !== taskId),
          lists: s.lists.map(l =>
            l.id !== targetListId ? l : {
              ...l,
              sections: l.sections.map((sec, i) =>
                i === 0 ? { ...sec, tasks: [...sec.tasks, tempTask] } : sec
              ),
            }
          ),
        }));

        (async () => {
          try {
            await apiDeleteTask(taskId);
            const res = await apiAddListTask(targetListId, firstSection.id, {
              title: task.title,
              note: task.note,
              deadline: task.deadline,
              priority: task.priority,
              badge: task.badge,
            });
            const realId = Number(res.task.id);
            set(s => ({
              lists: s.lists.map(l =>
                l.id !== targetListId ? l : {
                  ...l,
                  sections: l.sections.map(sec => ({
                    ...sec,
                    tasks: sec.tasks.map(t => t.id === taskId ? { ...t, id: realId } : t),
                  })),
                }
              ),
            }));
          } catch {
            set(s => ({
              dashTasks: [...s.dashTasks, task],
              lists: s.lists.map(l =>
                l.id !== targetListId ? l : {
                  ...l,
                  sections: l.sections.map((sec, i) =>
                    i === 0 ? { ...sec, tasks: sec.tasks.filter(t => t.id !== taskId) } : sec
                  ),
                }
              ),
            }));
          }
        })();
      },

      loadFromApi: async (workspaceId?: string) => {
        const myLoadId = ++currentLoadId;
        set({ listsLoading: true });
        try {
          const [tasksRes, listsRes, foldersRes, trashRes, trashListsRes, trashFoldersRes] = await Promise.all([
            apiGetTasks().catch(() => null),                    // always global for dashboard
            apiGetLists(workspaceId).catch(() => null),
            apiGetFolders(workspaceId).catch(() => null),
            apiGetTrash().catch(() => null),
            apiGetTrashLists().catch(() => null),
            apiGetTrashFolders().catch(() => null),
          ]);
          // Discard results if a newer load has been requested (e.g. workspace switched mid-load)
          if (myLoadId !== currentLoadId) return;
          const update: Partial<Pick<AppState, 'dashTasks' | 'lists' | 'folders' | 'trashTasks' | 'trashLists' | 'trashFolders' | 'listsLoading'>> = {};
          update.listsLoading = false;
          if (tasksRes) update.dashTasks = tasksRes.tasks.map(t => ({ ...t, id: Number(t.id) }));
          if (foldersRes) update.folders = foldersRes.folders;
          if (listsRes) update.lists = listsRes.lists.map(l => ({
            ...l,
            parentTaskId: l.parentTaskId != null ? Number(l.parentTaskId) : null,
            sections: l.sections.map(s => ({
              ...s,
              tasks: s.tasks.map(t => ({ ...t, id: Number(t.id) })),
            })),
          }));
          if (trashRes) update.trashTasks = trashRes.trash.map(tr => ({
            ...tr,
            id: Number(tr.id),
            taskId: Number(tr.taskId),
            task: { ...tr.task, id: Number(tr.task.id) },
          }));
          if (trashListsRes) update.trashLists = trashListsRes.trash.map(tr => ({
            id: Number(tr.id),
            listId: tr.listId,
            list: tr.listData,
            deletedAt: tr.deletedAt,
            expiresAt: tr.expiresAt,
          }));
          if (trashFoldersRes) update.trashFolders = trashFoldersRes.trash.map(tr => ({
            id: Number(tr.id),
            folderId: tr.folderId,
            folder: tr.folderData,
            deletedAt: tr.deletedAt,
            expiresAt: tr.expiresAt,
          }));
          set(update as AppState);
        } catch {
          set({ listsLoading: false });
        }
      },
    }),
    {
      name: 'solytiq_app',
      partialize: (state) => ({
        dashTasks: state.dashTasks,
        lists: state.lists,
        folders: state.folders,
        trashTasks: state.trashTasks,
        trashLists: state.trashLists,
        trashFolders: state.trashFolders,
        sidebarWidth: state.sidebarWidth,
      }),
    }
  )
);

export function getLinkedProgress(listId: string, lists: import('../types').List[]): { total: number; completed: number } {
  function gatherTasks(id: string): import('../types').Task[] {
    const list = lists.find(l => l.id === id);
    if (!list) return [];
    const direct = list.sections.flatMap(s => s.tasks);
    const sublistIds = lists
      .filter(l => l.parentTaskId != null && direct.some(t => t.id === l.parentTaskId))
      .map(l => l.id);
    return [...direct, ...sublistIds.flatMap(sid => gatherTasks(sid))];
  }
  const tasks = gatherTasks(listId);
  return { total: tasks.length, completed: tasks.filter(t => t.checked).length };
}

// Expose API functions for components to use directly
export {
  apiCreateTask,
  apiUpdateTask,
  apiDeleteTask,
  apiCreateList,
  apiUpdateList,
  apiDeleteList,
  apiEmptyTrash,
  apiAddListTask,
};

export default useAppStore;
