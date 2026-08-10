import { useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { AnimatePresence } from 'motion/react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useMobile } from '../../hooks/useBreakpoint';
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
import useKnowledgeBaseStore from '../../store/useKnowledgeBaseStore';
import useAiSkillsStore from '../../store/useAiSkillsStore';
import useAiMemoryStore from '../../store/useAiMemoryStore';
import useGraphStore from '../../store/useGraphStore';
import useUserPrefsStore from '../../store/useUserPrefsStore';
import type { GraphEntityType } from '../../types';
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
  apiDeleteGpsFile,
  apiRenameGpsFile,
  apiSmoothAndSaveGpsFile,
  apiCombineGpsFiles,
  apiCreateTimeline,
  apiUpdateTimeline,
  apiDeleteTimeline,
  apiCreateMilestone,
  apiUpdateMilestone,
  apiDeleteMilestone,
  apiReorderMilestones,
  apiGetAiToolDefs,
  apiExecuteAiTool,
  type AiToolDef,
} from '../../api/client';
import useGpsStore from '../../store/useGpsStore';
import AIBubble from './AIBubble';
// AIAssistant's own root (this file) is always mounted app-wide as a
// floating bubble; the full chat window (tool-calling UI, session list,
// file uploads, ~1000 lines) is only ever rendered once the user actually
// opens it — lazy-loaded so every page's initial chunk only pays for the
// small always-visible bubble, not the whole chat surface.
const AIChatWindow = lazy(() => import('./AIChatWindow'));

interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

// The data tools (tasks/lists/folders/timelines/milestones/files) live in the
// backend registry — the single source of truth shared with the MCP server.
// We fetch their definitions once and execute them server-side via /api/ai/execute,
// keeping only frontend-coupled tools (navigation, GPS downloads, optimistic
// reorder/sublist/workspace ops) on the client. Cached at module scope so we
// don't refetch on every message.
// Frontend data tools that the backend registry now supersedes. Their client
// definitions are suppressed so the model only sees the shared backend version
// (the old executeTool branches remain as harmless dead code). Tools with no
// backend equivalent — sublists, reorder/move, calendar scheduling, workspaces,
// GPS, navigation — stay on the client.
const SKILL_MUTATION_TOOL_NAMES = new Set(['create_skill', 'update_skill', 'delete_skill', 'set_skill_file', 'remove_skill_file']);
const MEMORY_MUTATION_TOOL_NAMES = new Set(['add_memory', 'remove_memory']);

const SUPERSEDED_CLIENT_TOOLS = new Set([
  'create_dashboard_task', 'update_dashboard_task', 'delete_dashboard_task',
  'create_list_task', 'update_list_task', 'delete_list_task', 'create_task_in_list',
  'create_section', 'create_list', 'update_list', 'delete_list',
  'create_folder', 'update_folder', 'delete_folder',
  'create_timeline', 'update_timeline', 'delete_timeline',
  'add_milestone', 'update_milestone', 'delete_milestone',
]);

let sharedToolDefsCache: AiToolDef[] | null = null;
async function getSharedToolDefs(): Promise<AiToolDef[]> {
  if (sharedToolDefsCache) return sharedToolDefsCache;
  try {
    const { tools } = await apiGetAiToolDefs();
    sharedToolDefsCache = tools;
    return tools;
  } catch {
    return [];
  }
}

export default function AIAssistant() {
  const isMobile = useMobile();
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
    blockingDialogCount,
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
  const navigate = useNavigate();
  const thinkingIdRef = useRef<string | null>(null);
  // Names of tools handled by the shared backend registry (executed via /api/ai/execute).
  const backendToolNamesRef = useRef<Set<string>>(new Set());

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
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        return { id: call.id, name, result: 'Error: invalid arguments' };
      }

      // Shared registry tools run on the backend (same code path as the MCP
      // server). The server reloads the store afterwards so the UI updates.
      if (backendToolNamesRef.current.has(name)) {
        try {
          const r = await apiExecuteAiTool(name, args);
          return { id: call.id, name, result: r.result, summary: r.ok ? r.summary : undefined };
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          return { id: call.id, name, result: `Error: ${msg}` };
        }
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
            const listRes = await apiCreateList({ id: newListId, name: sublistName, color: 'var(--color-primary)', isPublic: false });
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

        // ── Workspace CRUD ────────────────────────────────────────
        if (name === 'create_workspace') {
          const ws = await workspaceStore.createWorkspace({
            name: args.name as string,
            description: (args.description as string) || undefined,
            emoji: (args.emoji as string) || undefined,
            visibility: (args.visibility as 'private' | 'public') || 'private',
          });
          workspaceStore.setCurrentWorkspace(ws.id);
          return { id: call.id, name, result: `Created workspace "${ws.name}" (id: ${ws.id})`, summary: `Created workspace "${ws.name}"` };
        }

        if (name === 'update_workspace') {
          const targetId = args.workspace_id as string;
          const updates: Partial<{ name: string; description: string; emoji: string; visibility: 'private' | 'public' }> = {};
          if (args.name !== undefined) updates.name = args.name as string;
          if (args.description !== undefined) updates.description = args.description as string;
          if (args.emoji !== undefined) updates.emoji = args.emoji as string;
          if (args.visibility !== undefined) updates.visibility = args.visibility as 'private' | 'public';
          const prevName = workspaceStore.workspaces.find((w) => w.id === targetId)?.name ?? targetId;
          await workspaceStore.updateWorkspace(targetId, updates);
          return { id: call.id, name, result: `Updated workspace "${prevName}"`, summary: `Updated workspace "${updates.name ?? prevName}"` };
        }

        if (name === 'delete_workspace') {
          const targetId = args.workspace_id as string;
          const prevName = workspaceStore.workspaces.find((w) => w.id === targetId)?.name ?? targetId;
          await workspaceStore.deleteWorkspace(targetId);
          return { id: call.id, name, result: `Deleted workspace "${prevName}"`, summary: `Deleted workspace "${prevName}"` };
        }

        // ── GPS tools ─────────────────────────────────────────────
        if (name === 'list_gps_routes') {
          const gpsFiles = useGpsStore.getState().files;
          const list = gpsFiles.map(f => {
            const dist = f.metadata?.totalDistance != null ? ` ${(f.metadata.totalDistance / 1000).toFixed(1)} km` : '';
            const elev = f.metadata?.totalElevationGain != null ? ` ↑${Math.round(f.metadata.totalElevationGain)}m` : '';
            return `• ${f.name} (id: ${f.id}, ${f.fileType.toUpperCase()}${dist}${elev})`;
          }).join('\n') || 'No routes uploaded yet.';
          return { id: call.id, name, result: list };
        }

        if (name === 'rename_gps_route') {
          const { route_id, new_name } = args as { route_id: string; new_name: string };
          try {
            const file = await apiRenameGpsFile(route_id, new_name);
            useGpsStore.getState().setFiles(prev => prev.map(f => f.id === route_id ? file : f));
            window.dispatchEvent(new CustomEvent('gps-files-changed'));
            return { id: call.id, name, result: `Renamed to "${file.name}"` };
          } catch (e) { return { id: call.id, name, result: `Error: ${e}` }; }
        }

        if (name === 'delete_gps_route') {
          const { route_id } = args as { route_id: string };
          try {
            await apiDeleteGpsFile(route_id);
            useGpsStore.getState().setFiles(prev => prev.filter(f => f.id !== route_id));
            window.dispatchEvent(new CustomEvent('gps-files-changed'));
            return { id: call.id, name, result: 'Route deleted successfully.' };
          } catch (e) { return { id: call.id, name, result: `Error: ${e}` }; }
        }

        if (name === 'merge_gps_routes') {
          const { route_ids, output_name } = args as { route_ids: string[]; output_name: string };
          try {
            const blob = await apiCombineGpsFiles(route_ids, output_name);
            // trigger download since save endpoint handled separately
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = `${output_name}.gpx`; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
            window.dispatchEvent(new CustomEvent('gps-files-changed'));
            return { id: call.id, name, result: `Merged ${route_ids.length} routes into "${output_name}" — download started.` };
          } catch (e) { return { id: call.id, name, result: `Error: ${e}` }; }
        }

        if (name === 'smooth_gps_elevation') {
          const { route_id, sigma, mode, output_name } = args as { route_id: string; sigma: number; mode: 'new' | 'replace'; output_name?: string };
          try {
            const file = await apiSmoothAndSaveGpsFile(route_id, sigma, mode, output_name);
            if (mode === 'new') {
              useGpsStore.getState().setFiles(prev => [file, ...prev]);
            } else {
              useGpsStore.getState().setFiles(prev => prev.map(f => f.id === route_id ? file : f));
            }
            window.dispatchEvent(new CustomEvent('gps-files-changed'));
            return { id: call.id, name, result: `Smoothed (σ=${sigma}) and ${mode === 'new' ? `saved as "${file.name}"` : 'replaced original'}.` };
          } catch (e) { return { id: call.id, name, result: `Error: ${e}` }; }
        }

        // ── Timeline management ───────────────────────────────────
        if (name === 'create_timeline') {
          const timelineId = `timeline_${crypto.randomUUID()}`;
          const res = await apiCreateTimeline({
            id: timelineId,
            name: args.name as string,
            emoji: (args.emoji as string) || undefined,
            subtitle: (args.subtitle as string) || undefined,
            color: (args.color as string) || undefined,
            layout: (args.layout as 'vertical' | 'compact' | 'detailed') || 'vertical',
            isPublic: args.is_public !== undefined ? (args.is_public as boolean) : false,
            folderId: (args.folder_id as string) || undefined,
            workspaceId: workspaceStore.currentWorkspaceId ?? undefined,
            milestones: [],
          });
          appStore.setTimelines((prev) => [...prev, res.timeline]);
          return { id: call.id, name, result: `Created timeline "${res.timeline.name}" (timeline_id: ${res.timeline.id})`, summary: `Created timeline "${res.timeline.name}"` };
        }

        if (name === 'update_timeline') {
          const timelineId = args.timeline_id as string;
          const updates: Record<string, unknown> = {};
          if (args.name !== undefined) updates.name = args.name;
          if (args.emoji !== undefined) updates.emoji = args.emoji;
          if (args.subtitle !== undefined) updates.subtitle = args.subtitle;
          if (args.color !== undefined) updates.color = args.color;
          if (args.layout !== undefined) updates.layout = args.layout;
          if (args.is_public !== undefined) updates.isPublic = args.is_public;
          const res = await apiUpdateTimeline(timelineId, updates as Parameters<typeof apiUpdateTimeline>[1]);
          appStore.updateTimeline(timelineId, updates as Parameters<typeof appStore.updateTimeline>[1]);
          const tlName = appStore.timelines.find(t => t.id === timelineId)?.name ?? timelineId;
          return { id: call.id, name, result: `Updated timeline "${res.timeline.name}"`, summary: `Updated timeline "${args.name ?? tlName}"` };
        }

        if (name === 'delete_timeline') {
          const timelineId = args.timeline_id as string;
          const tl = appStore.timelines.find(t => t.id === timelineId);
          await apiDeleteTimeline(timelineId);
          appStore.deleteTimeline(timelineId);
          return { id: call.id, name, result: `Deleted timeline "${tl?.name ?? timelineId}"`, summary: `Deleted timeline "${tl?.name ?? timelineId}"` };
        }

        if (name === 'navigate_to_timeline') {
          const timelineId = args.timeline_id as string;
          const tl = appStore.timelines.find(t => t.id === timelineId);
          if (!tl) return { id: call.id, name, result: `Error: timeline ${timelineId} not found` };
          navigate(`/timeline/${timelineId}`);
          return { id: call.id, name, result: `Navigated to timeline "${tl.name}"`, summary: `Opened "${tl.name}"` };
        }

        // ── Milestone management ──────────────────────────────────
        if (name === 'add_milestone') {
          const timelineId = ctx.timelineId!;
          const milestoneId = `milestone_${crypto.randomUUID()}`;
          const res = await apiCreateMilestone(timelineId, {
            id: milestoneId,
            title: args.title as string,
            date: (args.date as string) || null,
            time: (args.time as string) || null,
            status: (args.status as 'upcoming' | 'in-progress' | 'done') || 'upcoming',
            emoji: (args.emoji as string) || null,
            color: (args.color as string) || null,
            description: (args.description as string) || null,
          });
          appStore.setTimelines((prev) =>
            prev.map(t =>
              t.id !== timelineId ? t : { ...t, milestones: [...t.milestones, res.milestone] }
            )
          );
          return { id: call.id, name, result: `Added milestone "${res.milestone.title}" (id: ${res.milestone.id})`, summary: `Added milestone "${res.milestone.title}"` };
        }

        if (name === 'update_milestone') {
          const milestoneId = args.milestone_id as string;
          const timelineId = ctx.timelineId!;
          const updates: Record<string, unknown> = {};
          if (args.title !== undefined) updates.title = args.title;
          if (args.date !== undefined) updates.date = (args.date as string) || null;
          if (args.time !== undefined) updates.time = (args.time as string) || null;
          if (args.status !== undefined) updates.status = args.status;
          if (args.emoji !== undefined) updates.emoji = (args.emoji as string) || null;
          if (args.color !== undefined) updates.color = (args.color as string) || null;
          if (args.description !== undefined) updates.description = args.description;
          await apiUpdateMilestone(milestoneId, updates as Parameters<typeof apiUpdateMilestone>[1]);
          appStore.setTimelines((prev) =>
            prev.map(t =>
              t.id !== timelineId ? t :
              { ...t, milestones: t.milestones.map(m => m.id === milestoneId ? { ...m, ...updates } : m) }
            )
          );
          const m = appStore.timelines.find(t => t.id === timelineId)?.milestones.find(m => m.id === milestoneId);
          return { id: call.id, name, result: `Updated milestone "${m?.title ?? milestoneId}"`, summary: `Updated milestone "${updates.title ?? m?.title ?? milestoneId}"` };
        }

        if (name === 'delete_milestone') {
          const milestoneId = args.milestone_id as string;
          const timelineId = ctx.timelineId!;
          const m = appStore.timelines.find(t => t.id === timelineId)?.milestones.find(m => m.id === milestoneId);
          await apiDeleteMilestone(milestoneId);
          appStore.setTimelines((prev) =>
            prev.map(t =>
              t.id !== timelineId ? t : { ...t, milestones: t.milestones.filter(m => m.id !== milestoneId) }
            )
          );
          return { id: call.id, name, result: `Deleted milestone "${m?.title ?? milestoneId}"`, summary: `Deleted milestone "${m?.title ?? milestoneId}"` };
        }

        if (name === 'reorder_milestones') {
          const timelineId = ctx.timelineId!;
          const milestoneIds = args.milestone_ids as string[];
          await apiReorderMilestones(timelineId, milestoneIds);
          appStore.setTimelines((prev) =>
            prev.map(t => {
              if (t.id !== timelineId) return t;
              const ordered = milestoneIds
                .map(id => t.milestones.find(m => m.id === id))
                .filter((m): m is NonNullable<typeof m> => m !== undefined);
              return { ...t, milestones: ordered };
            })
          );
          return { id: call.id, name, result: `Reordered ${milestoneIds.length} milestones`, summary: `Reordered milestones` };
        }

        // ── Net (Graph Layer) view ─────────────────────────────────
        if (name === 'focus_graph_node') {
          const srn = args.srn as string;
          useGraphStore.getState().focusNode(srn);
          if (location.pathname !== '/graph') navigate('/graph');
          return { id: call.id, name, result: `Focused ${srn} in the Net view`, summary: `Focused the Net on ${srn}` };
        }

        if (name === 'set_graph_filters') {
          const gs = useGraphStore.getState();
          if (Array.isArray(args.entity_types)) gs.setFilter('entityTypes', args.entity_types as GraphEntityType[]);
          if (typeof args.show_completed === 'boolean') gs.setFilter('showCompleted', args.show_completed);
          if (typeof args.show_orphans === 'boolean') gs.setFilter('showOrphans', args.show_orphans);
          return { id: call.id, name, result: 'Updated Net view filters', summary: 'Updated Net filters' };
        }

        if (name === 'reset_graph_view') {
          useGraphStore.getState().resetFilters();
          const wsId = workspaceStore.currentWorkspaceId;
          if (wsId) useUserPrefsStore.getState().clearGraphNodePositions(wsId);
          return { id: call.id, name, result: 'Reset Net view filters and released any manually-pinned nodes', summary: 'Reset the Net view' };
        }

        return { id: call.id, name, result: `Unknown tool: ${name}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        return { id: call.id, name, result: `Error: ${msg}` };
      }
    },
    [appStore, workspaceStore, navigate, location.pathname]
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

        // Pull the shared backend tool definitions (single source of truth) and
        // record their names so executeTool routes them to /api/ai/execute. The
        // tool list sent to the model = client-only tools + shared backend tools,
        // de-duplicated by name so the backend definitions always win.
        const sharedDefs = await getSharedToolDefs();
        backendToolNamesRef.current = new Set(sharedDefs.map((d) => d.function.name));
        const composeTools = (clientTools: ReturnType<typeof buildTools>) => [
          ...clientTools.filter(
            (t) => !backendToolNamesRef.current.has(t.function.name) && !SUPERSEDED_CLIENT_TOOLS.has(t.function.name)
          ),
          ...sharedDefs,
        ];

        let tools = composeTools(buildTools(ctx, wsId, wsInfo));
        const glossary = useKnowledgeBaseStore.getState().entries.map(e => ({ term: e.term, aliases: e.aliases, summary: e.summary }));
        const skills = useAiSkillsStore.getState().enabledSkills;
        const memory = useAiMemoryStore.getState().entries;
        const systemPrompt = buildSystemPrompt(ctx, username || 'User', wsInfo, wsId, glossary, skills, memory);

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
        const MAX_ROUNDS = 100;

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

          // Backend-executed tools mutate the DB without optimistic store
          // updates, so refresh from the server before rebuilding context to
          // keep the next round's tool list and IDs accurate.
          if (results.some((r) => backendToolNamesRef.current.has(r.name))) {
            await appStore.loadFromApi(workspaceStore.currentWorkspaceId ?? undefined);
          }
          // AI Skill mutations aren't part of the workspace-scoped app store
          // above — refresh the enabled index separately so a skill created/
          // edited/deleted mid-conversation is reflected immediately (both for
          // the rest of this chat and for Settings → AI Skills, if open).
          if (results.some((r) => SKILL_MUTATION_TOOL_NAMES.has(r.name))) {
            useAiSkillsStore.getState().loadEnabled();
          }
          // Same reasoning for long-term memory: a fact added/removed via a
          // tool call refreshes the store immediately, so the NEXT message in
          // this chat (and the Settings → Preferences list, if open) reflects
          // it — the system prompt for the CURRENT round is already sent and
          // isn't rebuilt mid-loop, same as skills above.
          if (results.some((r) => MEMORY_MUTATION_TOOL_NAMES.has(r.name))) {
            useAiMemoryStore.getState().load();
          }

          // Rebuild context with updated store state
          ctx = buildContext(location.pathname, appStore);
          tools = composeTools(buildTools(ctx, wsId, workspaceStore.workspaces.map((w) => ({ id: w.id, name: w.name, role: w.role }))));
        }

        // After tool calls complete, refresh from server and let the AI verify
        // its changes are actually reflected before writing the final response.
        // Re-read currentWorkspaceId from the store — tool calls (e.g. create_workspace)
        // may have changed it, and using the stale captured wsId would fetch the wrong workspace.
        if (allResults.length > 0) {
          await appStore.loadFromApi(workspaceStore.currentWorkspaceId ?? undefined);
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
        bottom: isMobile ? 'calc(env(safe-area-inset-bottom, 0px) + 60px)' : 30,
        right: isMobile ? 14 : 30,
        zIndex: 9000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
      }}
    >
      <AnimatePresence>
        {isOpen && (
          <Suspense
            fallback={
              <div
                role="status"
                aria-live="polite"
                style={{
                  width: isMobile ? '100vw' : 380,
                  height: isMobile ? '100dvh' : 560,
                  maxHeight: 'calc(100dvh - 40px)',
                  borderRadius: isMobile ? 0 : 20,
                  background: 'var(--color-white)',
                  boxShadow: '0 8px 40px rgba(94,77,187,0.10)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <div style={{ width: 28, height: 28, border: '3px solid var(--color-border)', borderTopColor: 'var(--color-primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} aria-hidden="true" />
                <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>Loading Sol…</span>
              </div>
            }
          >
            <AIChatWindow
              key="ai-chat-window"
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
              isMobile={isMobile}
            />
          </Suspense>
        )}
      </AnimatePresence>
      {/* On mobile the open chat is a full-screen bottom sheet with its own
          close button — the floating bubble would just sit uselessly under it.
          Same story while a mobile full-screen dialog (e.g. the item detail
          dialog) is open — the bubble's high z-index would otherwise float on
          top of it, overlapping its content. The Calendar page is dense
          enough on mobile (see CalendarScreen) that the bubble is dropped
          there entirely rather than just repositioned. */}
      {!(isMobile && (isOpen || blockingDialogCount > 0 || location.pathname.startsWith('/calendar'))) && (
        <AIBubble isOpen={isOpen} isThinking={isThinking} onClick={handleToggle} size={isMobile ? 44 : 52} />
      )}
    </div>
  );
}
