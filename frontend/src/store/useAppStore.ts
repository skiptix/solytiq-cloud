import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppState, Task, List, Folder, Timeline, TrashedTask, TrashedList, TrashedFolder, TrashedTimeline } from '../types';
import useWorkspaceStore from './useWorkspaceStore';
import {
  ApiError,
  apiGetTasks,
  apiGetLists,
  apiGetFolders,
  apiGetTimelines,
  apiUpdateTimeline,
  apiDeleteTimeline,
  apiGetTrashTimelines,
  apiRestoreTimelineFromTrash,
  apiDeleteTimelineFromTrash,
  apiGetTrashMilestones,
  apiRestoreMilestoneFromTrash,
  apiDeleteMilestoneFromTrash,
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

export type LoadSlice = 'tasks' | 'lists' | 'folders' | 'timelines' | 'trash';
const ALL_SLICES: LoadSlice[] = ['tasks', 'lists', 'folders', 'timelines', 'trash'];
const MAX_LOAD_RETRIES = 3;
// Core slices that failed their last (post-retry) load. loadError stays up
// until every slice in here is successfully refetched — a partial reload of
// OTHER slices must not clear the banner while a failed slice is still stale.
const failedSlices = new Set<LoadSlice>();
// Signatures (workspace + requested slices) of loads currently in flight. A
// second trigger for an identical load — e.g. the workspace-change effect firing
// alongside the initial mount load — would just refetch the same data, so it is
// suppressed. Retries (attempt > 0) intentionally bypass this.
const inFlightLoads = new Set<string>();
// Per-slice "who's newest" ownership, keyed by the monotonic load id that most
// recently recorded an outcome for that slice. A load's result for a given
// slice is only applied if no NEWER load that also requested that same slice
// has already landed. This is deliberately per-slice rather than one global
// "latest call wins" gate: a narrow reload (e.g. an SSE 'tasks'-only refresh)
// finishing after a full reload started must not discard the full reload's
// still-valid 'lists'/'folders'/'timelines' results — a global gate did
// exactly that, which could orphan a stale `failedSlices` entry forever
// (nothing else was ever going to re-test that specific slice again) and left
// the "Couldn't refresh your data" banner stuck even though every subsequent
// request was succeeding.
const sliceEpoch: Record<LoadSlice, number> = { tasks: 0, lists: 0, folders: 0, timelines: 0, trash: 0 };

function getScopedWorkspaceId(workspaceId?: string): string | undefined {
  return workspaceId ?? useWorkspaceStore.getState().currentWorkspaceId ?? undefined;
}

// ── Slice normalizers ────────────────────────────────────────────────────────
// The delta engine (hydrateFromSnapshot / applyDeltas) MUST apply the exact same
// coercions the classic loadFromApi loader does, so the two data paths agree
// (task ids → number, list.parentTaskId → number, timelines carry a milestones
// array). Kept as shared helpers so they can never drift.
const normTask = (t: Task): Task => ({ ...t, id: Number(t.id) });
const normList = (l: List): List => ({
  ...l,
  parentTaskId: l.parentTaskId != null ? Number(l.parentTaskId) : null,
  sections: l.sections.map((s) => ({ ...s, tasks: s.tasks.map(normTask) })),
});
const normTimeline = (t: Timeline): Timeline => ({ ...t, milestones: t.milestones ?? [] });

function upsertById<T extends { id: string | number }>(arr: T[], item: T): T[] {
  const i = arr.findIndex((x) => String(x.id) === String(item.id));
  if (i === -1) return [...arr, item];
  const copy = arr.slice();
  copy[i] = item;
  return copy;
}

// A list's nested (source='list') tasks, as they appear in the flat dashTasks
// slice. The dashboard reads list tasks out of dashTasks (see DashboardScreen),
// so a `list` delta must keep that flat copy in sync with the list payload.
function listTasksAsDash(list: List): Task[] {
  return list.sections.flatMap((s) => s.tasks).map((t) => ({ ...t, workspaceId: list.workspaceId }));
}

const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      dashTasks: [],
      lists: [],
      folders: [],
      timelines: [],
      listsLoading: false,
      loadError: false,
      trashTasks: [],
      trashLists: [],
      trashFolders: [],
      trashTimelines: [],
      trashMilestones: [],
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

      setTimelines: (timelines) => {
        if (typeof timelines === 'function') {
          set((state) => ({ timelines: timelines(state.timelines) }));
        } else {
          set({ timelines });
        }
      },

      updateTimeline: (timelineId, updates) => {
        const prev = get().timelines.find((t) => t.id === timelineId);
        set((state) => ({
          timelines: state.timelines.map((t) => (t.id === timelineId ? { ...t, ...updates } : t)),
        }));
        const payload = !('position' in updates) && prev?.version != null
          ? { ...updates, expectedVersion: prev.version }
          : updates;
        apiUpdateTimeline(timelineId, payload).catch((err) => {
          const body = err instanceof ApiError && err.status === 409 ? (err.body as { error?: string; timeline?: Timeline }) : null;
          if (body?.error === 'version_conflict' && body.timeline) {
            get().applyDeltas([{ entity: 'timeline', entityId: timelineId, op: 'upsert', payload: body.timeline }]);
            return;
          }
          if (prev) {
            set((state) => ({
              timelines: state.timelines.map((t) => (t.id === timelineId ? prev : t)),
            }));
          }
          get().loadFromApi();
        });
      },

      deleteTimeline: (timelineId) => {
        const state = get();
        const timeline = state.timelines.find((t) => t.id === timelineId);

        set((s) => ({ timelines: s.timelines.filter((t) => t.id !== timelineId) }));

        let trashId: number | null = null;
        if (timeline) {
          trashId = ++trashCounter;
          const trashEntry: TrashedTimeline = {
            id: trashId,
            timelineId: timeline.id,
            timeline,
            deletedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          };
          set((s) => ({ trashTimelines: [...s.trashTimelines, trashEntry] }));
        }

        apiDeleteTimeline(timelineId).catch(() => {
          if (timeline) {
            set((s) => ({
              timelines: [...s.timelines, timeline],
              trashTimelines: trashId != null ? s.trashTimelines.filter((t) => t.id !== trashId) : s.trashTimelines,
            }));
          }
          get().loadFromApi();
        });
      },

      restoreTimelineFromTrash: (trashId) => {
        const state = get();
        const entry = state.trashTimelines.find((t) => t.id === trashId);
        if (!entry) return;
        set((s) => ({
          timelines: [...s.timelines, entry.timeline],
          trashTimelines: s.trashTimelines.filter((t) => t.id !== trashId),
        }));
        apiRestoreTimelineFromTrash(trashId).catch(() => {});
      },

      deleteTimelineFromTrash: (trashId) => {
        set((s) => ({ trashTimelines: s.trashTimelines.filter((t) => t.id !== trashId) }));
        apiDeleteTimelineFromTrash(trashId).catch(() => {});
      },

      restoreMilestoneFromTrash: (trashId) => {
        const state = get();
        const entry = state.trashMilestones.find((t) => t.id === trashId);
        if (!entry) return;
        // Re-insert the milestone into its parent timeline, if it still exists.
        set((s) => ({
          timelines: s.timelines.map((t) =>
            t.id === entry.timelineId && !t.milestones.some((m) => m.id === entry.milestone.id)
              ? { ...t, milestones: [...t.milestones, entry.milestone] }
              : t
          ),
          trashMilestones: s.trashMilestones.filter((t) => t.id !== trashId),
        }));
        apiRestoreMilestoneFromTrash(trashId).catch(() => get().loadFromApi());
      },

      deleteMilestoneFromTrash: (trashId) => {
        set((s) => ({ trashMilestones: s.trashMilestones.filter((t) => t.id !== trashId) }));
        apiDeleteMilestoneFromTrash(trashId).catch(() => {});
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
        // Content edits carry the version they were based on so a concurrent
        // edit is detected (409) instead of silently clobbered. Position-only
        // reorders opt out (last-write-wins; avoids false conflicts on the hot path).
        const payload = !('position' in updates) && prev?.version != null
          ? { ...updates, expectedVersion: prev.version }
          : updates;
        apiUpdateList(listId, payload).catch((err) => {
          const body = err instanceof ApiError && err.status === 409 ? (err.body as { error?: string; list?: List }) : null;
          if (body?.error === 'version_conflict' && body.list) {
            // Reconcile to the winner rather than reverting to our stale base.
            get().applyDeltas([{ entity: 'list', entityId: listId, op: 'upsert', payload: body.list }]);
            return;
          }
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
              workspaceId: targetList.workspaceId,
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

      hydrateFromSnapshot: (snap) => {
        set({
          dashTasks: snap.tasks.map(normTask),
          lists: snap.lists.map(normList),
          folders: snap.folders,
          timelines: snap.timelines.map(normTimeline),
          listsLoading: false,
          loadError: false,
        });
      },

      applyDeltas: (changes) => {
        if (changes.length === 0) return;
        set((state) => {
          let dashTasks = state.dashTasks;
          let lists = state.lists;
          let folders = state.folders;
          let timelines = state.timelines;
          for (const c of changes) {
            switch (c.entity) {
              case 'task': {
                const id = Number(c.entityId);
                if (c.op === 'delete') dashTasks = dashTasks.filter((t) => t.id !== id);
                else if (c.payload) dashTasks = upsertById(dashTasks, normTask(c.payload as Task));
                break;
              }
              case 'list': {
                if (c.op === 'delete') {
                  lists = lists.filter((l) => l.id !== c.entityId);
                  dashTasks = dashTasks.filter((t) => !(t._source === 'list' && t._listId === c.entityId));
                } else if (c.payload) {
                  const l = normList(c.payload as List);
                  lists = upsertById(lists, l);
                  dashTasks = [
                    ...dashTasks.filter((t) => !(t._source === 'list' && t._listId === l.id)),
                    ...listTasksAsDash(l),
                  ];
                }
                break;
              }
              case 'folder': {
                if (c.op === 'delete') folders = folders.filter((f) => f.id !== c.entityId);
                else if (c.payload) folders = upsertById(folders, c.payload as Folder);
                break;
              }
              case 'timeline': {
                if (c.op === 'delete') timelines = timelines.filter((t) => t.id !== c.entityId);
                else if (c.payload) timelines = upsertById(timelines, normTimeline(c.payload as Timeline));
                break;
              }
              // meeting / file / workspace / trash are signal-only and handled by
              // useSyncStore (screens/stores refetch) — ignored here.
            }
          }
          return { dashTasks, lists, folders, timelines };
        });
      },

      loadFromApi: async (workspaceId?: string, opts?: { only?: LoadSlice[]; attempt?: number }) => {
        const scopedWorkspaceId = getScopedWorkspaceId(workspaceId);
        const slices = new Set<LoadSlice>(opts?.only ?? ALL_SLICES);
        const attempt = opts?.attempt ?? 0;
        const sig = `${scopedWorkspaceId ?? ''}|${Array.from(slices).sort().join(',')}`;
        // Collapse duplicate in-flight loads (a fresh attempt only — retries re-run on purpose).
        if (attempt === 0 && inFlightLoads.has(sig)) return;
        inFlightLoads.add(sig);
        const myLoadId = ++currentLoadId;
        if (slices.has('lists')) set({ listsLoading: true });
        try {
          const skip = Promise.resolve(null);
          const [tasksRes, listsRes, foldersRes, timelinesRes, trashRes, trashListsRes, trashFoldersRes, trashTimelinesRes, trashMilestonesRes] = await Promise.all([
            slices.has('tasks')     ? apiGetTasks(scopedWorkspaceId).catch(() => null)     : skip,
            slices.has('lists')     ? apiGetLists(scopedWorkspaceId).catch(() => null)     : skip,
            slices.has('folders')   ? apiGetFolders(scopedWorkspaceId).catch(() => null)   : skip,
            slices.has('timelines') ? apiGetTimelines(scopedWorkspaceId).catch(() => null) : skip,
            slices.has('trash')     ? apiGetTrash().catch(() => null)                      : skip,
            slices.has('trash')     ? apiGetTrashLists().catch(() => null)                 : skip,
            slices.has('trash')     ? apiGetTrashFolders().catch(() => null)               : skip,
            slices.has('trash')     ? apiGetTrashTimelines().catch(() => null)             : skip,
            slices.has('trash')     ? apiGetTrashMilestones().catch(() => null)            : skip,
          ]);
          // A response is only irrelevant if the workspace changed underneath
          // it (e.g. the user switched workspaces mid-load).
          if (scopedWorkspaceId !== getScopedWorkspaceId()) return;
          // Claim per-slice ownership up front, before applying anything, and
          // bump the epoch immediately. This is the single point where "who's
          // authoritative for this slice" is decided, so an older, still-in-flight
          // duplicate call can never land afterward and clobber a newer call's
          // result — whether that newer call's outcome was a success, an interim
          // retry, or a terminal failure.
          const owns: Record<LoadSlice, boolean> = {
            tasks: slices.has('tasks') && myLoadId > sliceEpoch.tasks,
            lists: slices.has('lists') && myLoadId > sliceEpoch.lists,
            folders: slices.has('folders') && myLoadId > sliceEpoch.folders,
            timelines: slices.has('timelines') && myLoadId > sliceEpoch.timelines,
            trash: slices.has('trash') && myLoadId > sliceEpoch.trash,
          };
          (Object.keys(owns) as LoadSlice[]).forEach(s => { if (owns[s]) sliceEpoch[s] = myLoadId; });
          const update: Partial<Pick<AppState, 'dashTasks' | 'lists' | 'folders' | 'timelines' | 'trashTasks' | 'trashLists' | 'trashFolders' | 'trashTimelines' | 'trashMilestones' | 'listsLoading' | 'loadError'>> = {};
          if (tasksRes && owns.tasks) update.dashTasks = tasksRes.tasks.map(t => ({ ...t, id: Number(t.id) }));
          if (foldersRes && owns.folders) update.folders = foldersRes.folders;
          if (timelinesRes && owns.timelines) update.timelines = timelinesRes.timelines.map(t => ({ ...t, milestones: t.milestones ?? [] }));
          if (listsRes && owns.lists) update.lists = listsRes.lists.map(l => ({
            ...l,
            parentTaskId: l.parentTaskId != null ? Number(l.parentTaskId) : null,
            sections: l.sections.map(s => ({
              ...s,
              tasks: s.tasks.map(t => ({ ...t, id: Number(t.id) })),
            })),
          }));
          if (trashRes && owns.trash) update.trashTasks = trashRes.trash.map(tr => ({
            ...tr,
            id: Number(tr.id),
            taskId: Number(tr.taskId),
            task: { ...tr.task, id: Number(tr.task.id) },
          }));
          if (trashListsRes && owns.trash) update.trashLists = trashListsRes.trash.map(tr => ({
            id: Number(tr.id),
            listId: tr.listId,
            list: tr.listData,
            deletedAt: tr.deletedAt,
            expiresAt: tr.expiresAt,
          }));
          if (trashFoldersRes && owns.trash) update.trashFolders = trashFoldersRes.trash.map(tr => ({
            id: Number(tr.id),
            folderId: tr.folderId,
            folder: tr.folderData,
            deletedAt: tr.deletedAt,
            expiresAt: tr.expiresAt,
          }));
          if (trashTimelinesRes && owns.trash) update.trashTimelines = trashTimelinesRes.trash.map(tr => ({
            id: Number(tr.id),
            timelineId: tr.timelineId,
            timeline: { ...tr.timelineData, milestones: tr.timelineData.milestones ?? [] },
            deletedAt: tr.deletedAt,
            expiresAt: tr.expiresAt,
          }));
          if (trashMilestonesRes && owns.trash) update.trashMilestones = trashMilestonesRes.trash.map(tr => ({
            id: Number(tr.id),
            milestoneId: tr.milestoneId,
            timelineId: tr.timelineId,
            milestone: tr.milestoneData,
            deletedAt: tr.deletedAt,
            expiresAt: tr.expiresAt,
          }));

          // A failed core fetch (429 / network blip) must never look like data
          // deletion: the previous slice is kept (its update key was skipped),
          // and we retry with backoff before surfacing a visible error.
          const sliceSucceeded: Record<Exclude<LoadSlice, 'trash'>, boolean> = {
            tasks: !!tasksRes,
            lists: !!listsRes,
            folders: !!foldersRes,
            timelines: !!timelinesRes,
          };
          const coreFailed = (Object.keys(sliceSucceeded) as Array<Exclude<LoadSlice, 'trash'>>)
            .some((s) => slices.has(s) && !sliceSucceeded[s]);
          if (coreFailed && attempt < MAX_LOAD_RETRIES) {
            const delay = 1000 * 2 ** attempt;
            setTimeout(() => {
              if (scopedWorkspaceId !== getScopedWorkspaceId()) return; // workspace changed — stale retry
              get().loadFromApi(scopedWorkspaceId, { only: Array.from(slices), attempt: attempt + 1 });
            }, delay);
            if (owns.lists) update.listsLoading = true; // keep the loading state while retrying
          } else {
            for (const s of Object.keys(sliceSucceeded) as Array<Exclude<LoadSlice, 'trash'>>) {
              if (!owns[s]) continue; // not requested, or a newer load already claimed this slice
              if (sliceSucceeded[s]) failedSlices.delete(s);
              else failedSlices.add(s);
            }
            if (owns.lists) update.listsLoading = false;
            update.loadError = failedSlices.size > 0;
          }
          set(update as AppState);
        } catch {
          set({ listsLoading: false, loadError: true });
        } finally {
          inFlightLoads.delete(sig);
        }
      },
    }),
    {
      name: 'solytiq_app',
      partialize: (state) => ({
        dashTasks: state.dashTasks,
        lists: state.lists,
        folders: state.folders,
        timelines: state.timelines,
        trashTasks: state.trashTasks,
        trashLists: state.trashLists,
        trashFolders: state.trashFolders,
        trashTimelines: state.trashTimelines,
        trashMilestones: state.trashMilestones,
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

export const clearAppStore = () => {
  useAppStore.setState({
    dashTasks: [],
    lists: [],
    folders: [],
    timelines: [],
    trashTasks: [],
    trashLists: [],
    trashFolders: [],
    trashTimelines: [],
    trashMilestones: [],
    listsLoading: false,
  });
};

export default useAppStore;
