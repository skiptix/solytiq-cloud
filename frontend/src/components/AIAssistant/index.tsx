import { useEffect, useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import useAIStore, {
  buildContext,
  buildSystemPrompt,
  buildTools,
  type AIChatMessage,
} from '../../store/useAIStore';
import useAppStore, {
  apiCreateTask,
  apiUpdateTask,
  apiDeleteTask,
  apiAddListTask,
} from '../../store/useAppStore';
import useAuthStore from '../../store/useAuthStore';
import useWorkspaceStore from '../../store/useWorkspaceStore';
import {
  apiGetAISettings,
  apiAIChat,
  apiSaveAIMessage,
  apiClearAIHistory,
  apiCreateSection,
  apiUpdateSection,
  apiDeleteSection,
  apiUpdateListTask,
  apiDeleteListTask,
  apiCreateAISession,
  apiGetAISessions,
  apiGetAISessionMessages,
  apiDeleteAISession,
  apiCreateList,
  apiUpdateList,
  apiDeleteList,
  apiCreateFolder,
  apiCreateSublistTask,
  apiLinkListAsTask,
  apiAddWorkspaceMember,
  apiRemoveWorkspaceMember,
  apiGetWorkspaceMembers,
  apiReorderSectionTasks,
  apiReorderListSections,
} from '../../api/client';
import AIBubble from './AIBubble';
import AIChatWindow from './AIChatWindow';

interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export default function AIAssistant() {
  const location = useLocation();
  const {
    isOpen,
    settings,
    messages,
    isThinking,
    settingsLoaded,
    recentSessions,
    showRecentChats,
    uploadedFiles,
    setOpen,
    setSettings,
    setMessages,
    addMessage,
    removeMessage,
    setThinking,
    setSettingsLoaded,
    clearHistory,
    setCurrentSessionId,
    setRecentSessions,
    setShowRecentChats,
    addUploadedFile,
    removeUploadedFile,
    clearUploadedFiles,
  } = useAIStore();

  const appStore = useAppStore();
  const { username, userId } = useAuthStore();
  const workspaceStore = useWorkspaceStore();
  const thinkingIdRef = useRef<string | null>(null);

  // Load AI settings once
  useEffect(() => {
    if (settingsLoaded) return;
    apiGetAISettings()
      .then((data) => { setSettings(data); setSettingsLoaded(true); })
      .catch(() => setSettingsLoaded(true));
  }, [settingsLoaded, setSettings, setSettingsLoaded]);

  // Create a new session every time the chat opens
  const handleToggle = useCallback(async () => {
    if (isOpen) {
      setOpen(false);
      return;
    }
    // Start fresh
    clearHistory();
    setCurrentSessionId(null);
    setOpen(true);

    if (settings.enabled && userId) {
      apiCreateAISession()
        .then((data) => setCurrentSessionId(data.session.id))
        .catch(() => {});
    }
  }, [isOpen, settings.enabled, userId, setOpen, clearHistory, setCurrentSessionId]);

  // ── Tool execution ────────────────────────────────────────────
  const executeTool = useCallback(
    async (call: ToolCall, ctx: ReturnType<typeof buildContext>): Promise<{ id: string; name: string; result: string; summary?: string }> => {
      const name = call.function.name;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        return { id: call.id, name, result: 'Error: invalid arguments' };
      }

      try {
        if (name === 'create_dashboard_task') {
          const res = await apiCreateTask({
            title: args.title as string,
            deadline: (args.deadline as string) || undefined,
            priority: args.priority as 'High' | 'Medium' | 'Low' | undefined,
            note: (args.note as string) || undefined,
          });
          appStore.setDashTasks((prev) => [...prev, { ...res.task, id: Number(res.task.id) }]);
          return { id: call.id, name, result: `Created task "${res.task.title}"`, summary: `Added "${res.task.title}"` };
        }

        if (name === 'update_dashboard_task') {
          const taskId = Number(args.task_id);
          const updates: Record<string, unknown> = {};
          if (args.title !== undefined) updates.title = args.title;
          if (args.deadline !== undefined) updates.deadline = (args.deadline as string) || null;
          if (args.priority !== undefined) updates.priority = args.priority;
          if (args.note !== undefined) updates.note = args.note;
          if (args.checked !== undefined) updates.checked = args.checked;
          await apiUpdateTask(taskId, updates as Parameters<typeof apiUpdateTask>[1]);
          appStore.setDashTasks((prev) =>
            prev.map((t) => (t.id === taskId ? { ...t, ...updates } : t))
          );
          const task = appStore.dashTasks.find((t) => t.id === taskId);
          return { id: call.id, name, result: `Updated task ${taskId}`, summary: `Updated "${task?.title ?? taskId}"` };
        }

        if (name === 'delete_dashboard_task') {
          const taskId = Number(args.task_id);
          const task = appStore.dashTasks.find((t) => t.id === taskId);
          await apiDeleteTask(taskId);
          appStore.setDashTasks((prev) => prev.filter((t) => t.id !== taskId));
          return { id: call.id, name, result: `Deleted task ${taskId}`, summary: `Deleted "${task?.title ?? taskId}"` };
        }

        if (name === 'add_sublist_to_dash_task' || name === 'add_subitem_to_dash_task' || name === 'link_list_to_dash_task') {
          const taskId = Number(args.task_id);
          const task = appStore.dashTasks.find((t) => t.id === taskId);
          if (!task) return { id: call.id, name, result: `Error: task ${taskId} not found` };

          let linkedListId = task.linkedListId ?? null;
          let sectionId: string | null = null;

          if (name === 'link_list_to_dash_task') {
            linkedListId = args.list_id as string;
            const linkedList = appStore.lists.find((l) => l.id === linkedListId);
            sectionId = linkedList?.sections[0]?.id ?? null;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await apiUpdateTask(taskId, { linkedListId, linkedListType: 'link' } as any);
            appStore.setDashTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, linkedListId: linkedListId!, linkedListType: 'link' } : t));
            const linkedListName = linkedList?.name ?? linkedListId;
            return { id: call.id, name, result: `Linked list "${linkedListName}" to task "${task.title}"`, summary: `Linked "${linkedListName}" → "${task.title}"` };
          }

          // For add_sublist_to_dash_task and add_subitem_to_dash_task: create sublist if needed
          if (!linkedListId) {
            const sublistName = (args.sublist_name as string) || task.title;
            const newListId = `list_${crypto.randomUUID()}`;
            const newSecId = `sec_${crypto.randomUUID()}`;
            const listRes = await apiCreateList({ id: newListId, name: sublistName, color: '#5e4dbb', isPublic: false });
            const actualListId = listRes.list?.id ?? newListId;
            const secRes = await apiCreateSection(actualListId, { id: newSecId, label: 'Tasks' });
            sectionId = secRes.section?.id ?? newSecId;
            linkedListId = actualListId;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await apiUpdateTask(taskId, { linkedListId: actualListId, linkedListType: 'sublist' } as any);
            appStore.setDashTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, linkedListId: actualListId, linkedListType: 'sublist' as const } : t));
            appStore.setLists((prev) => [...prev, { id: actualListId, name: sublistName, sections: [{ id: sectionId!, label: 'Tasks', tasks: [], emoji: undefined, collapsed: false, position: 0 }], folderId: undefined, emoji: undefined, isPublic: false, depth: 1 }]);
          } else {
            const linkedList = appStore.lists.find((l) => l.id === linkedListId);
            sectionId = linkedList?.sections[0]?.id ?? null;
          }

          if (name === 'add_subitem_to_dash_task') {
            if (!sectionId) return { id: call.id, name, result: 'Error: could not find a section in the sublist' };
            const itemTitle = args.sub_item_title as string;
            const res = await apiAddListTask(linkedListId!, sectionId, { title: itemTitle });
            await appStore.loadFromApi();
            return { id: call.id, name, result: `Added sub-item "${itemTitle}" to task "${task.title}"`, summary: `Added "${itemTitle}" to "${task.title}"` };
            void res;
          }

          // add_sublist_to_dash_task (no sub-item to add)
          await appStore.loadFromApi();
          return { id: call.id, name, result: `Created sublist for task "${task.title}" (list_id: ${linkedListId})`, summary: `Created sublist for "${task.title}"` };
        }

        if (name === 'create_list_task') {
          const listId = ctx.listId!;
          const sectionId = args.section_id as string;
          const res = await apiAddListTask(listId, sectionId, {
            title: args.title as string,
            deadline: (args.deadline as string) || undefined,
            priority: args.priority as 'High' | 'Medium' | 'Low' | undefined,
            note: (args.note as string) || undefined,
          });
          appStore.setLists((prev) =>
            prev.map((l) =>
              l.id !== listId
                ? l
                : {
                    ...l,
                    sections: l.sections.map((s) =>
                      s.id !== sectionId
                        ? s
                        : { ...s, tasks: [...s.tasks, { ...res.task, id: Number(res.task.id) }] }
                    ),
                  }
            )
          );
          return { id: call.id, name, result: `Created task "${res.task.title}"`, summary: `Added "${res.task.title}"` };
        }

        // Cross-list task creation — works from any view
        if (name === 'create_task_in_list') {
          const listId = args.list_id as string;
          const sectionId = args.section_id as string;
          const res = await apiAddListTask(listId, sectionId, {
            title: args.title as string,
            deadline: (args.deadline as string) || undefined,
            priority: args.priority as 'High' | 'Medium' | 'Low' | undefined,
            note: (args.note as string) || undefined,
          });
          appStore.setLists((prev) =>
            prev.map((l) =>
              l.id !== listId
                ? l
                : {
                    ...l,
                    sections: l.sections.map((s) =>
                      s.id !== sectionId
                        ? s
                        : { ...s, tasks: [...s.tasks, { ...res.task, id: Number(res.task.id) }] }
                    ),
                  }
            )
          );
          const targetList = appStore.lists.find((l) => l.id === listId);
          return { id: call.id, name, result: `Created task "${res.task.title}" in "${targetList?.name ?? listId}"`, summary: `Added "${res.task.title}" → ${targetList?.name ?? listId}` };
        }

        if (name === 'update_list_task') {
          const listId = ctx.listId!;
          const taskId = Number(args.task_id);
          const updates: Record<string, unknown> = {};
          if (args.title !== undefined) updates.title = args.title;
          if (args.deadline !== undefined) updates.deadline = (args.deadline as string) || null;
          if (args.priority !== undefined) updates.priority = args.priority;
          if (args.note !== undefined) updates.note = args.note;
          if (args.checked !== undefined) updates.checked = args.checked;
          await apiUpdateListTask(listId, taskId, updates as Parameters<typeof apiUpdateListTask>[2]);
          appStore.updateListTask(listId, taskId, updates as Parameters<typeof appStore.updateListTask>[2]);
          return { id: call.id, name, result: `Updated task ${taskId}`, summary: `Updated task #${taskId}` };
        }

        if (name === 'delete_list_task') {
          const listId = ctx.listId!;
          const taskId = Number(args.task_id);
          const task = appStore.lists
            .find((l) => l.id === listId)
            ?.sections.flatMap((s) => s.tasks)
            .find((t) => t.id === taskId);
          await apiDeleteListTask(listId, taskId);
          appStore.deleteListTask(listId, taskId);
          return { id: call.id, name, result: `Deleted task ${taskId}`, summary: `Deleted "${task?.title ?? taskId}"` };
        }

        if (name === 'create_section') {
          const listId = ctx.listId!;
          const res = await apiCreateSection(listId, {
            label: args.label as string,
            emoji: (args.emoji as string) || undefined,
          });
          appStore.setLists((prev) =>
            prev.map((l) =>
              l.id !== listId ? l : { ...l, sections: [...l.sections, { ...res.section, tasks: [] }] }
            )
          );
          return { id: call.id, name, result: `Created section "${res.section.label}"`, summary: `Created section "${res.section.label}"` };
        }

        if (name === 'update_section') {
          const listId = ctx.listId!;
          const sectionId = args.section_id as string;
          const updates: { label?: string; emoji?: string } = {};
          if (args.label) updates.label = args.label as string;
          if (args.emoji) updates.emoji = args.emoji as string;
          await apiUpdateSection(sectionId, updates);
          appStore.setLists((prev) =>
            prev.map((l) =>
              l.id !== listId
                ? l
                : {
                    ...l,
                    sections: l.sections.map((s) =>
                      s.id !== sectionId ? s : { ...s, ...updates }
                    ),
                  }
            )
          );
          return { id: call.id, name, result: `Updated section`, summary: `Updated section "${updates.label ?? sectionId}"` };
        }

        if (name === 'delete_section') {
          const listId = ctx.listId!;
          const sectionId = args.section_id as string;
          const section = appStore.lists.find((l) => l.id === listId)?.sections.find((s) => s.id === sectionId);
          await apiDeleteSection(sectionId);
          appStore.setLists((prev) =>
            prev.map((l) =>
              l.id !== listId ? l : { ...l, sections: l.sections.filter((s) => s.id !== sectionId) }
            )
          );
          return { id: call.id, name, result: `Deleted section`, summary: `Deleted section "${section?.label ?? sectionId}"` };
        }

        if (name === 'schedule_task' || name === 'unschedule_task') {
          const taskId = Number(args.task_id);
          const listId = args.list_id as string | null | undefined;
          const deadline = name === 'schedule_task' ? (args.deadline as string) : undefined;
          const time = name === 'schedule_task' ? (args.time as string | undefined) : undefined;
          const updates: Record<string, unknown> = { deadline: deadline ?? null };
          if (time !== undefined) updates.time = time;

          if (!listId) {
            await apiUpdateTask(taskId, updates as Parameters<typeof apiUpdateTask>[1]);
            appStore.setDashTasks((prev) =>
              prev.map((t) => (t.id === taskId ? { ...t, ...updates } : t))
            );
          } else {
            await apiUpdateListTask(listId, taskId, updates as Parameters<typeof apiUpdateListTask>[2]);
            appStore.updateListTask(listId, taskId, updates as Parameters<typeof appStore.updateListTask>[2]);
          }
          const summary = name === 'schedule_task' ? `Scheduled for ${deadline}` : 'Removed deadline';
          return { id: call.id, name, result: summary, summary };
        }

        // ── Folder management ─────────────────────────────────────
        if (name === 'create_folder') {
          const folderId = `folder_${crypto.randomUUID()}`;
          const res = await apiCreateFolder({
            id: folderId,
            name: args.name as string,
            emoji: (args.emoji as string) || undefined,
            isPublic: args.is_public !== undefined ? (args.is_public as boolean) : true,
            workspaceId: workspaceStore.currentWorkspaceId ?? undefined,
          });
          appStore.setFolders((prev) => [...prev, { ...res.folder, collapsed: false }]);
          return { id: call.id, name, result: `Created folder "${res.folder.name}" (folder_id: ${res.folder.id})`, summary: `Created folder "${res.folder.name}"` };
        }

        if (name === 'update_folder') {
          const folderId = args.folder_id as string;
          const updates: Record<string, unknown> = {};
          if (args.name !== undefined) updates.name = args.name;
          if (args.emoji !== undefined) updates.emoji = args.emoji;
          if (args.is_public !== undefined) updates.isPublic = args.is_public;
          appStore.updateFolder(folderId, updates as Parameters<typeof appStore.updateFolder>[1]);
          const folderName = appStore.folders.find((f) => f.id === folderId)?.name ?? folderId;
          const visNote = args.is_public !== undefined ? ` (${args.is_public ? 'public' : 'private'})` : '';
          return { id: call.id, name, result: `Updated folder "${folderName}"`, summary: `Updated folder "${args.name ?? folderName}"${visNote}` };
        }

        if (name === 'delete_folder') {
          const folderId = args.folder_id as string;
          const folder = appStore.folders.find((f) => f.id === folderId);
          appStore.deleteFolder(folderId);
          return { id: call.id, name, result: `Deleted folder "${folder?.name ?? folderId}"`, summary: `Deleted folder "${folder?.name ?? folderId}"` };
        }

        // ── List management ───────────────────────────────────────
        if (name === 'create_list') {
          const listId = `list_${crypto.randomUUID()}`;
          const res = await apiCreateList({
            id: listId,
            name: args.name as string,
            emoji: (args.emoji as string) || undefined,
            folderId: (args.folder_id as string) || undefined,
            isPublic: args.is_public !== undefined ? (args.is_public as boolean) : false,
            workspaceId: workspaceStore.currentWorkspaceId ?? undefined,
            sections: [],
          });
          // Auto-create a default "Tasks" section so tasks can be added immediately.
          // Wrapped in its own try/catch so a section failure never blocks the list result.
          let defaultSection: { id: string; label: string; tasks: never[] } | null = null;
          try {
            const sectionRes = await apiCreateSection(res.list.id, { label: 'Tasks' });
            defaultSection = { ...sectionRes.section, tasks: [] };
          } catch {
            // Section creation failed — list exists but has no section yet
          }
          appStore.setLists((prev) => [...prev, { ...res.list, sections: defaultSection ? [defaultSection] : [] }]);
          const sectionNote = defaultSection
            ? ` with default section "Tasks" (section_id: ${defaultSection.id})`
            : ' — NOTE: default section creation failed; use create_section tool to add one';
          return { id: call.id, name, result: `Created list "${res.list.name}" (list_id: ${res.list.id})${sectionNote}`, summary: `Created list "${res.list.name}"` };
        }

        if (name === 'update_list') {
          const listId = args.list_id as string;
          const updates: Record<string, unknown> = {};
          if (args.name !== undefined) updates.name = args.name;
          if (args.emoji !== undefined) updates.emoji = args.emoji;
          if (args.is_public !== undefined) updates.isPublic = args.is_public;
          await apiUpdateList(listId, updates as Parameters<typeof apiUpdateList>[1]);
          appStore.updateList(listId, updates as Parameters<typeof appStore.updateList>[1]);
          const listName = appStore.lists.find((l) => l.id === listId)?.name ?? listId;
          const visibilityNote = args.is_public !== undefined
            ? ` (${args.is_public ? 'public' : 'private'})`
            : '';
          return { id: call.id, name, result: `Updated list "${listName}"`, summary: `Updated "${args.name ?? listName}"${visibilityNote}` };
        }

        if (name === 'delete_list') {
          const listId = args.list_id as string;
          const list = appStore.lists.find((l) => l.id === listId);
          await apiDeleteList(listId);
          appStore.deleteList(listId);
          return { id: call.id, name, result: `Deleted list "${list?.name ?? listId}"`, summary: `Deleted list "${list?.name ?? listId}"` };
        }

        if (name === 'move_list_to_folder') {
          const listId = args.list_id as string;
          const folderId = (args.folder_id as string | null | undefined) ?? null;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await apiUpdateList(listId, { folderId } as any);
          appStore.updateList(listId, { folderId: folderId ?? undefined });
          const list = appStore.lists.find((l) => l.id === listId);
          const folder = folderId ? appStore.folders.find((f) => f.id === folderId) : null;
          const summary = folder
            ? `Moved "${list?.name}" to "${folder.name}"`
            : `Removed "${list?.name}" from folder`;
          return { id: call.id, name, result: summary, summary };
        }

        if (name === 'create_sublist') {
          const listId = ctx.listId!;
          const sectionId = args.section_id as string;
          const taskTitle = args.task_title as string;
          const sublistName = args.sublist_name as string;
          const parentList = appStore.lists.find(l => l.id === listId);
          const parentDepth = parentList?.depth ?? 0;
          const res = await apiCreateSublistTask(listId, sectionId, taskTitle, sublistName, parentDepth + 1);
          const savedTask = { ...res.task, id: Number(res.task.id) };
          appStore.setLists(prev => {
            const withTask = prev.map(l =>
              l.id !== listId ? l : {
                ...l,
                sections: l.sections.map(s =>
                  s.id !== sectionId ? s : { ...s, tasks: [...s.tasks, savedTask] }
                ),
              }
            );
            if (res.list) return [...withTask, { ...res.list, sections: [] }];
            return withTask;
          });
          return { id: call.id, name, result: `Created sublist "${sublistName}" linked as "${taskTitle}"`, summary: `Created sublist "${sublistName}"` };
        }

        if (name === 'link_list_as_task') {
          const listId = ctx.listId!;
          const sectionId = args.section_id as string;
          const taskTitle = args.task_title as string;
          const linkedListId = args.linked_list_id as string;
          const res = await apiLinkListAsTask(listId, sectionId, taskTitle, linkedListId);
          const savedTask = { ...res.task, id: Number(res.task.id) };
          appStore.setLists(prev =>
            prev.map(l =>
              l.id !== listId ? l : {
                ...l,
                sections: l.sections.map(s =>
                  s.id !== sectionId ? s : { ...s, tasks: [...s.tasks, savedTask] }
                ),
              }
            )
          );
          const linkedList = appStore.lists.find(l => l.id === linkedListId);
          return { id: call.id, name, result: `Linked "${linkedList?.name ?? linkedListId}" as task "${taskTitle}"`, summary: `Linked "${linkedList?.name ?? linkedListId}"` };
        }

        // ── Task movement and reordering ─────────────────────────
        if (name === 'move_task_to_section') {
          const listId = ctx.listId!;
          const taskId = Number(args.task_id);
          const toSectionId = args.to_section_id as string;
          await apiUpdateListTask(listId, taskId, { sectionId: toSectionId } as Parameters<typeof apiUpdateListTask>[2]);
          appStore.setLists((prev) =>
            prev.map((l) => {
              if (l.id !== listId) return l;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let movedTask: any;
              const withoutTask = l.sections.map((s) => {
                const task = s.tasks.find((t) => t.id === taskId);
                if (task) movedTask = task;
                return { ...s, tasks: s.tasks.filter((t) => t.id !== taskId) };
              });
              return {
                ...l,
                sections: withoutTask.map((s) =>
                  s.id !== toSectionId || !movedTask
                    ? s
                    : { ...s, tasks: [...s.tasks, movedTask] }
                ),
              };
            })
          );
          const toSection = appStore.lists.find((l) => l.id === listId)?.sections.find((s) => s.id === toSectionId);
          return { id: call.id, name, result: `Moved task ${taskId} to section "${toSection?.label ?? toSectionId}"`, summary: `Moved task to "${toSection?.label ?? toSectionId}"` };
        }

        if (name === 'reorder_tasks_in_section') {
          const listId = ctx.listId!;
          const sectionId = args.section_id as string;
          const taskIds = (args.task_ids as number[]).map(Number);
          await apiReorderSectionTasks(listId, sectionId, taskIds);
          appStore.setLists((prev) =>
            prev.map((l) =>
              l.id !== listId
                ? l
                : {
                    ...l,
                    sections: l.sections.map((s) => {
                      if (s.id !== sectionId) return s;
                      const ordered = taskIds
                        .map((id) => s.tasks.find((t) => t.id === id))
                        .filter((t): t is NonNullable<typeof t> => t !== undefined);
                      return { ...s, tasks: ordered };
                    }),
                  }
            )
          );
          return { id: call.id, name, result: `Reordered ${taskIds.length} tasks in section`, summary: `Reordered tasks in section` };
        }

        if (name === 'reorder_sections') {
          const listId = ctx.listId!;
          const sectionIds = args.section_ids as string[];
          await apiReorderListSections(listId, sectionIds);
          appStore.setLists((prev) =>
            prev.map((l) => {
              if (l.id !== listId) return l;
              const ordered = sectionIds
                .map((id) => l.sections.find((s) => s.id === id))
                .filter((s): s is NonNullable<typeof s> => s !== undefined);
              return { ...l, sections: ordered };
            })
          );
          return { id: call.id, name, result: `Reordered ${sectionIds.length} sections`, summary: `Reordered sections` };
        }

        // ── Workspace member management ───────────────────────────
        if (name === 'add_workspace_member') {
          const wsId = workspaceStore.currentWorkspaceId;
          if (!wsId) return { id: call.id, name, result: 'No active workspace' };
          const username = args.username as string;
          const member = await apiAddWorkspaceMember(wsId, username);
          return { id: call.id, name, result: `Added @${username} to workspace`, summary: `Added @${username}` };
          void member;
        }

        if (name === 'remove_workspace_member') {
          const wsId = workspaceStore.currentWorkspaceId;
          if (!wsId) return { id: call.id, name, result: 'No active workspace' };
          const memberId = args.user_id as string;
          await apiRemoveWorkspaceMember(wsId, memberId);
          return { id: call.id, name, result: `Removed member ${memberId} from workspace`, summary: `Removed member` };
        }

        if (name === 'list_workspace_members') {
          const wsId = workspaceStore.currentWorkspaceId;
          if (!wsId) return { id: call.id, name, result: 'No active workspace' };
          const members = await apiGetWorkspaceMembers(wsId);
          const memberList = members.members.map((m) => `@${m.username} (id: ${m.userId}, role: ${m.role})`).join(', ');
          return { id: call.id, name, result: `Members: ${memberList}` };
        }

        return { id: call.id, name, result: `Unknown tool: ${name}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        return { id: call.id, name, result: `Error: ${msg}` };
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appStore, workspaceStore]
  );

  // ── Send message ─────────────────────────────────────────────
  const handleSend = useCallback(
    async (text: string) => {
      if (!settings.enabled) return;

      const sessionId = useAIStore.getState().currentSessionId;
      const currentFiles = useAIStore.getState().uploadedFiles;

      const userMsg: AIChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        createdAt: new Date().toISOString(),
      };
      addMessage(userMsg);
      apiSaveAIMessage('user', text, sessionId).catch(() => {});

      // Clear files after capturing them
      if (currentFiles.length > 0) clearUploadedFiles();

      const thinkingId = crypto.randomUUID();
      thinkingIdRef.current = thinkingId;
      addMessage({ id: thinkingId, role: 'assistant', content: '', isThinking: true, createdAt: new Date().toISOString() });
      setThinking(true);

      try {
        let ctx = buildContext(location.pathname, appStore);
        const wsId = workspaceStore.currentWorkspaceId;
        const wsInfo = workspaceStore.workspaces.map((w) => ({ id: w.id, name: w.name, role: w.role }));
        let tools = buildTools(ctx, wsId);
        const systemPrompt = buildSystemPrompt(ctx, username || 'User', wsInfo, wsId);

        // Build API messages from history (last 20 + current)
        const history = useAIStore
          .getState()
          .messages.filter((m) => !m.isThinking && !m.error && m.id !== thinkingId)
          .slice(-20)
          .map((m) => ({ role: m.role, content: m.content }));

        // Build the current user message — may include file attachments
        type ContentPart =
          | { type: 'text'; text: string }
          | { type: 'image_url'; image_url: { url: string } };

        let userContent: string | ContentPart[];
        if (currentFiles.length > 0) {
          const parts: ContentPart[] = [{ type: 'text', text }];
          for (const f of currentFiles) {
            if (f.isImage && f.contentText) {
              parts.push({ type: 'image_url', image_url: { url: f.contentText } });
            } else if (f.contentText) {
              parts.push({
                type: 'text',
                text: `\n\n---\nAttached file: ${f.filename}\n---\n${f.contentText}`,
              });
            }
          }
          userContent = parts;
        } else {
          userContent = text;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const messages: any[] = [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: userContent }];
        const allResults: Array<{ id: string; name: string; result: string; summary?: string }> = [];
        let finalContent = '';
        const MAX_ROUNDS = 10;

        for (let round = 0; round < MAX_ROUNDS; round++) {
          const response = await apiAIChat(messages, tools.length ? tools : undefined, sessionId);
          const msg = response.choices[0].message;

          if (!msg.tool_calls?.length) {
            finalContent = msg.content ?? '';
            break;
          }

          const results = await Promise.all(msg.tool_calls.map((tc: ToolCall) => executeTool(tc, ctx)));
          allResults.push(...results);

          messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
          results.forEach((r) =>
            messages.push({ role: 'tool', tool_call_id: r.id, name: r.name, content: r.result })
          );

          // Rebuild context with updated store state
          ctx = buildContext(location.pathname, appStore);
          tools = buildTools(ctx, wsId);
        }

        // After tool calls complete, refresh from server and let the AI verify
        // its changes are actually reflected before writing the final response.
        if (allResults.length > 0) {
          await appStore.loadFromApi(wsId ?? undefined);
          const verifiedCtx = buildContext(location.pathname, appStore);
          messages.push({
            role: 'system',
            content: `VERIFICATION — current server state after your operations:\n${JSON.stringify(verifiedCtx.data, null, 2)}\n\nBased on this verified state, write your final response. If something you attempted is not reflected here, acknowledge it instead of claiming success.`,
          });
          const verifyResponse = await apiAIChat(messages, undefined, sessionId);
          finalContent = verifyResponse.choices[0].message.content ?? finalContent;
        }

        const actionSummary = allResults.map((r) => r.summary).filter(Boolean).join(' · ');
        if (!finalContent && allResults.length > 0) {
          finalContent = "I've completed all the operations I could. Let me know if anything needs adjusting!";
        }
        const finalMsg: AIChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: finalContent,
          actionSummary: actionSummary || undefined,
          createdAt: new Date().toISOString(),
        };
        removeMessage(thinkingId);
        addMessage(finalMsg);
        apiSaveAIMessage('assistant', finalContent, sessionId, actionSummary ? { actionSummary } : undefined).catch(() => {});
      } catch (err) {
        removeMessage(thinkingIdRef.current ?? thinkingId);
        const errContent = err instanceof Error && err.message.includes('disabled')
          ? 'The AI assistant has been disabled by your admin.'
          : err instanceof Error && err.message.includes('OPENROUTER')
          ? 'OpenRouter API key is not configured. Please contact your admin.'
          : err instanceof Error && (err.message.includes('timed out') || err.message.includes('504'))
          ? 'The request took too long. Try breaking it into smaller steps or retry.'
          : 'Sorry, something went wrong. Please try again.';
        addMessage({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: errContent,
          error: true,
          createdAt: new Date().toISOString(),
        });
      } finally {
        setThinking(false);
        thinkingIdRef.current = null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.enabled, location.pathname, appStore, username, executeTool, workspaceStore]
  );

  const handleClearHistory = useCallback(async () => {
    clearHistory();
    await apiClearAIHistory().catch(() => {});
  }, [clearHistory]);

  // Load recent sessions when the panel is opened
  const handleShowRecentChats = useCallback(async () => {
    setShowRecentChats(true);
    apiGetAISessions()
      .then((data) => setRecentSessions(data.sessions))
      .catch(() => {});
  }, [setShowRecentChats, setRecentSessions]);

  // Load messages from a past session
  const handleSelectSession = useCallback(async (sessionId: string) => {
    setShowRecentChats(false);
    clearHistory();
    setCurrentSessionId(sessionId);
    apiGetAISessionMessages(sessionId)
      .then((data) => {
        const msgs: AIChatMessage[] = data.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({
            id: String(m.id),
            role: m.role as 'user' | 'assistant',
            content: m.content,
            createdAt: m.createdAt,
            actionSummary: (m.metadata as { actionSummary?: string } | null)?.actionSummary,
          }));
        setMessages(msgs);
      })
      .catch(() => {});
  }, [setShowRecentChats, clearHistory, setCurrentSessionId, setMessages]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    setRecentSessions(recentSessions.filter((s) => s.id !== sessionId));
    await apiDeleteAISession(sessionId).catch(() => {});
  }, [recentSessions, setRecentSessions]);

  // Don't render if AI is disabled
  if (!settings.enabled) return null;

  const ctx = buildContext(location.pathname, appStore);

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 30,
        right: 30,
        zIndex: 9000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
      }}
    >
      {isOpen && (
        <AIChatWindow
          messages={messages}
          isThinking={isThinking}
          contextView={ctx.view}
          onSend={handleSend}
          onClose={() => setOpen(false)}
          onClearHistory={handleClearHistory}
          onShowRecentChats={handleShowRecentChats}
          showRecentChats={showRecentChats}
          recentSessions={recentSessions}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          onCloseRecentChats={() => setShowRecentChats(false)}
          uploadedFiles={uploadedFiles}
          onAddFile={addUploadedFile}
          onRemoveFile={removeUploadedFile}
          sessionId={useAIStore.getState().currentSessionId}
        />
      )}
      <AIBubble isOpen={isOpen} isThinking={isThinking} onClick={handleToggle} />
    </div>
  );
}
