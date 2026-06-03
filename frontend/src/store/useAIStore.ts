import { create } from 'zustand';
import type { AppState, AIFile, Task } from '../types';

export interface AIChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isThinking?: boolean;
  error?: boolean;
  actionSummary?: string;
  createdAt: string;
}

export interface AISettings {
  enabled: boolean;
  model: string;
}

export interface AISession {
  id: string;
  title: string | null;
  created_at: string;
}

interface AIStore {
  isOpen: boolean;
  settings: AISettings;
  messages: AIChatMessage[];
  isThinking: boolean;
  settingsLoaded: boolean;
  currentSessionId: string | null;
  recentSessions: AISession[];
  showRecentChats: boolean;
  uploadedFiles: AIFile[];

  setOpen: (open: boolean) => void;
  toggle: () => void;
  setSettings: (s: AISettings) => void;
  setMessages: (msgs: AIChatMessage[]) => void;
  addMessage: (msg: AIChatMessage) => void;
  replaceMessage: (id: string, msg: AIChatMessage) => void;
  removeMessage: (id: string) => void;
  setThinking: (v: boolean) => void;
  setSettingsLoaded: (v: boolean) => void;
  clearHistory: () => void;
  setCurrentSessionId: (id: string | null) => void;
  setRecentSessions: (sessions: AISession[]) => void;
  setShowRecentChats: (v: boolean) => void;
  addUploadedFile: (file: AIFile) => void;
  removeUploadedFile: (id: string) => void;
  clearUploadedFiles: () => void;
}

const useAIStore = create<AIStore>()((set) => ({
  isOpen: false,
  settings: { enabled: true, model: 'openai/gpt-4o-mini' },
  messages: [],
  isThinking: false,
  settingsLoaded: false,
  currentSessionId: null,
  recentSessions: [],
  showRecentChats: false,
  uploadedFiles: [],

  setOpen: (open) => set({ isOpen: open }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
  setSettings: (settings) => set({ settings }),
  setMessages: (messages) => set({ messages }),
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  replaceMessage: (id, msg) =>
    set((s) => ({ messages: s.messages.map((m) => (m.id === id ? msg : m)) })),
  removeMessage: (id) =>
    set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),
  setThinking: (v) => set({ isThinking: v }),
  setSettingsLoaded: (v) => set({ settingsLoaded: v }),
  clearHistory: () => set({ messages: [], uploadedFiles: [] }),
  setCurrentSessionId: (id) => set({ currentSessionId: id }),
  setRecentSessions: (sessions) => set({ recentSessions: sessions }),
  setShowRecentChats: (v) => set({ showRecentChats: v }),
  addUploadedFile: (file) => set((s) => ({ uploadedFiles: [...s.uploadedFiles, file] })),
  removeUploadedFile: (id) => set((s) => ({ uploadedFiles: s.uploadedFiles.filter((f) => f.id !== id) })),
  clearUploadedFiles: () => set({ uploadedFiles: [] }),
}));

// ── Context building ──────────────────────────────────────────────

export interface AIContext {
  view: string;
  listId?: string;
  data: Record<string, unknown>;
}

function toIso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function buildContext(pathname: string, appStore: AppState): AIContext {
  const today = toIso(new Date());

  // Always include lists & folders so Sol can manage them from any view
  const listsSnapshot = appStore.lists.map((l) => ({
    id: l.id,
    name: l.name,
    emoji: l.emoji ?? null,
    folder_id: l.folderId ?? null,
    // Include section stubs for cross-list task creation
    sections: l.sections.map((s) => ({ section_id: s.id, label: s.label })),
  }));
  const foldersSnapshot = appStore.folders.map((f) => ({
    id: f.id,
    name: f.name,
    emoji: f.emoji ?? null,
  }));

  if (pathname.startsWith('/list/')) {
    const listId = pathname.split('/list/')[1];
    const list = appStore.lists.find((l) => l.id === listId);
    if (list) {
      return {
        view: 'list',
        listId,
        data: {
          list_id: list.id,
          list_name: list.name,
          sections: list.sections.map((s) => ({
            section_id: s.id,
            label: s.label,
            emoji: s.emoji ?? null,
            tasks: s.tasks.map((t) => ({
              id: t.id,
              title: t.title,
              checked: t.checked,
              deadline: t.deadline ?? null,
              priority: t.priority ?? null,
              note: t.note ?? null,
            })),
          })),
          available_lists: listsSnapshot,
          available_folders: foldersSnapshot,
        },
      };
    }
  }

  if (pathname.startsWith('/scheduled')) {
    const allTasks: (Task & { list_name: string; list_id: string | null })[] = [
      ...appStore.dashTasks.map((t) => ({ ...t, list_name: 'Dashboard', list_id: null })),
      ...appStore.lists.flatMap((l) =>
        l.sections.flatMap((s) => s.tasks.map((t) => ({ ...t, list_name: l.name, list_id: l.id })))
      ),
    ];
    const scheduled = allTasks
      .filter((t) => t.deadline && !t.checked)
      .map((t) => ({ id: t.id, title: t.title, deadline: t.deadline, priority: t.priority ?? null, list_name: t.list_name, list_id: t.list_id }));
    const unscheduled = allTasks
      .filter((t) => !t.deadline && !t.checked)
      .slice(0, 30)
      .map((t) => ({ id: t.id, title: t.title, priority: t.priority ?? null, list_name: t.list_name, list_id: t.list_id }));
    return {
      view: 'scheduled',
      data: { today, scheduled_tasks: scheduled, unscheduled_tasks: unscheduled, available_lists: listsSnapshot, available_folders: foldersSnapshot },
    };
  }

  // Dashboard (default)
  const overdue = appStore.dashTasks
    .filter((t) => !t.checked && t.deadline && t.deadline < today)
    .map((t) => ({ id: t.id, title: t.title, deadline: t.deadline, priority: t.priority ?? null, linked_list_id: t.linkedListId ?? null }));
  const dueToday = appStore.dashTasks
    .filter((t) => !t.checked && t.deadline === today)
    .map((t) => ({ id: t.id, title: t.title, priority: t.priority ?? null, linked_list_id: t.linkedListId ?? null }));
  const noDeadline = appStore.dashTasks
    .filter((t) => !t.checked && !t.deadline)
    .slice(0, 15)
    .map((t) => ({ id: t.id, title: t.title, priority: t.priority ?? null, linked_list_id: t.linkedListId ?? null }));
  const upcoming = appStore.dashTasks
    .filter((t) => !t.checked && t.deadline && t.deadline > today)
    .slice(0, 10)
    .map((t) => ({ id: t.id, title: t.title, deadline: t.deadline, priority: t.priority ?? null, linked_list_id: t.linkedListId ?? null }));

  return {
    view: 'dashboard',
    data: { today, overdue_tasks: overdue, due_today_tasks: dueToday, upcoming_tasks: upcoming, no_deadline_tasks: noDeadline, available_lists: listsSnapshot, available_folders: foldersSnapshot },
  };
}

// ── System prompt ──────────────────────────────────────────────────

export function buildSystemPrompt(ctx: AIContext, username: string, workspaces?: Array<{ id: string; name: string; role: string }>, currentWorkspaceId?: string | null): string {
  const today = toIso(new Date());
  const viewDescriptions: Record<string, string> = {
    dashboard: 'Dashboard — personal quick-add task list with deadlines and priorities',
    list: `List — "${(ctx.data.list_name as string) ?? 'unknown'}" with multiple sections containing tasks`,
    scheduled: 'Scheduled — calendar view showing tasks with and without deadlines',
  };

  const contextJson = JSON.stringify(ctx.data, null, 2);

  const sublistNote = ctx.view === 'list'
    ? '\n- SUBLISTS: You can create sublists (nested lists) or link existing lists as task items using create_sublist and link_list_as_task tools.'
    : '\n- SUBLISTS: You can add sub-items to any dashboard task using add_subitem_to_dash_task (creates a linked sublist automatically if needed), or create a sublist first with add_sublist_to_dash_task. Check linked_list_id in the context — tasks that already have a sublist will show it. You can also link an existing list to a dash task with link_list_to_dash_task.';

  const workspaceInfo = workspaces?.length
    ? `\nWorkspaces you can manage: ${workspaces.map((w) => `"${w.name}" (id: ${w.id}, role: ${w.role})`).join(', ')}. Current workspace: ${workspaces.find((w) => w.id === currentWorkspaceId)?.name ?? 'unknown'}.`
    : '';

  return `You are Sol, a helpful AI assistant embedded in Solytiq Cloud, a personal productivity and task management app.

Current user: ${username}
Current view: ${viewDescriptions[ctx.view] ?? ctx.view}${workspaceInfo}

Current context data:
${contextJson}

Guidelines:
- Be concise, friendly, and helpful
- When you execute an action using a tool, briefly confirm what you did in your final response
- SECURITY: You may only act on data that belongs to the current user (${username}). Never touch lists, folders, tasks, or sections belonging to other users. The available_lists and available_folders in the context are the only ones you are allowed to modify.
- For delete operations, confirm with the user first before executing unless they explicitly said to delete
- BATCH OPERATIONS: When the user asks you to create or modify multiple items (e.g. "a list for every day of the week", "add 3 tasks", "create folders for each project"), call the relevant tool once per item in the SAME response — all in parallel. Never loop across multiple turns. For example, "a list for every day of the week" = 7 simultaneous create_list calls in one response.
- DATE PARSING: Always convert dates to YYYY-MM-DD before using them in tool parameters. Accept any format the user writes: DD.MM.YY (e.g. 11.5.26 → 2026-05-11), DD.MM.YYYY, MM/DD/YYYY, natural language like "tomorrow", "next Monday", "end of month". Use today (${today}) as the reference point for relative dates.
- INTENT: Words like "terminate", "deadline", "due", "schedule for", "set to", "end by" all mean the user wants to set a task deadline.
- Refer to tasks, lists, sections, and folders by their names, not their IDs, when talking to the user
- When creating a list you can optionally assign it to a folder from available_folders
- FOLDER IDs: Always use the exact folder ID (e.g. "folder_abc123"), never the folder name. When creating lists inside a NEW folder that doesn't exist yet, you MUST call create_folder first, then use the folder_id returned in the tool result for subsequent create_list calls — never guess or fabricate a folder_id
- NEW LIST SECTIONS: When you create a list with create_list, a default "Tasks" section is automatically created. The tool result contains the section_id (e.g. "section_id: abc123"). Always use that section_id when calling create_task_in_list for that new list — never guess or fabricate a section_id
- CROSS-LIST TASKS: You can create tasks in any list using create_task_in_list — use available_lists to find list IDs and their sections. For newly created lists, use the section_id returned in the create_list tool result
- SORTING/REORDERING: To sort tasks in a section, call reorder_tasks_in_section with all task IDs in the desired order. To move a task to a different section, call move_task_to_section. To reorder sections themselves, call reorder_sections. Always use actual task/section IDs from the context — never guess IDs.
- WORKSPACE MEMBERS: You can add or remove members from workspaces using add_workspace_member and remove_workspace_member
- If the user asks something outside your capabilities, explain politely what you can do instead${sublistNote}`;
}

// ── Tool definitions ────────────────────────────────────────────────

type ToolDef = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export function buildTools(ctx: AIContext, workspaceId?: string | null): ToolDef[] {
  const tools: ToolDef[] = [];

  if (ctx.view === 'dashboard') {
    tools.push({
      type: 'function',
      function: {
        name: 'create_dashboard_task',
        description: 'Create a new task in the Dashboard',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Task title' },
            deadline: { type: 'string', description: 'Due date YYYY-MM-DD (optional)' },
            priority: { type: 'string', enum: ['High', 'Medium', 'Low'] },
            note: { type: 'string', description: 'Optional notes' },
          },
          required: ['title'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'update_dashboard_task',
        description: 'Update an existing Dashboard task',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'number', description: 'Task ID from the context' },
            title: { type: 'string' },
            deadline: { type: 'string', description: 'YYYY-MM-DD or empty string to remove deadline' },
            priority: { type: 'string', enum: ['High', 'Medium', 'Low'] },
            note: { type: 'string' },
            checked: { type: 'boolean', description: 'Mark as complete (true) or incomplete (false)' },
          },
          required: ['task_id'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'delete_dashboard_task',
        description: 'Delete a Dashboard task permanently',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'number' },
          },
          required: ['task_id'],
        },
      },
    });

    tools.push({
      type: 'function',
      function: {
        name: 'add_subitem_to_dash_task',
        description: 'Add a sub-item to a dashboard task. If the task has no sublist yet (linked_list_id is null in context), one is created automatically. The task checkbox converts to a ring progress chart.',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'number', description: 'Dashboard task ID' },
            sub_item_title: { type: 'string', description: 'Title of the sub-item to add' },
            sublist_name: { type: 'string', description: 'Name of the sublist to create (only used if task has no sublist yet; defaults to the task title)' },
          },
          required: ['task_id', 'sub_item_title'],
        },
      },
    });

    tools.push({
      type: 'function',
      function: {
        name: 'add_sublist_to_dash_task',
        description: 'Create a new sublist (linked list) for a dashboard task that has no sub-items yet. The task checkbox converts to a ring progress chart. Use add_subitem_to_dash_task to add items to it afterward.',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'number', description: 'Dashboard task ID' },
            sublist_name: { type: 'string', description: 'Name of the new sublist to create' },
          },
          required: ['task_id', 'sublist_name'],
        },
      },
    });

    tools.push({
      type: 'function',
      function: {
        name: 'link_list_to_dash_task',
        description: 'Link an existing list as a sublist to a dashboard task. The task checkbox converts to a ring progress chart.',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'number', description: 'Dashboard task ID' },
            list_id: { type: 'string', description: 'ID of the existing list to link. Find IDs in available_lists.' },
          },
          required: ['task_id', 'list_id'],
        },
      },
    });
  }

  if (ctx.view === 'list' && ctx.listId) {
    const sectionList = (ctx.data.sections as Array<{ section_id: string; label: string }> ?? [])
      .map((s) => `"${s.label}" (id: ${s.section_id})`)
      .join(', ');

    tools.push({
      type: 'function',
      function: {
        name: 'create_list_task',
        description: `Create a new task in the current list. Available sections: ${sectionList}`,
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Task title' },
            section_id: { type: 'string', description: 'ID of the section to add the task to' },
            deadline: { type: 'string', description: 'YYYY-MM-DD (optional)' },
            priority: { type: 'string', enum: ['High', 'Medium', 'Low'] },
            note: { type: 'string' },
          },
          required: ['title', 'section_id'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'update_list_task',
        description: 'Update an existing task in the current list',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'number' },
            title: { type: 'string' },
            deadline: { type: 'string', description: 'YYYY-MM-DD or empty string to remove' },
            priority: { type: 'string', enum: ['High', 'Medium', 'Low'] },
            note: { type: 'string' },
            checked: { type: 'boolean' },
          },
          required: ['task_id'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'delete_list_task',
        description: 'Delete a task from the current list',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'number' },
          },
          required: ['task_id'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'create_section',
        description: 'Create a new section in the current list',
        parameters: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Section name' },
            emoji: { type: 'string', description: 'Optional emoji for the section' },
          },
          required: ['label'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'update_section',
        description: 'Rename or update a section in the current list',
        parameters: {
          type: 'object',
          properties: {
            section_id: { type: 'string' },
            label: { type: 'string' },
            emoji: { type: 'string' },
          },
          required: ['section_id'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'delete_section',
        description: 'Delete a section (and all its tasks) from the current list',
        parameters: {
          type: 'object',
          properties: {
            section_id: { type: 'string' },
          },
          required: ['section_id'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'move_task_to_section',
        description: `Move a task from one section to another within the current list. Available sections: ${sectionList}`,
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'number', description: 'ID of the task to move' },
            to_section_id: { type: 'string', description: 'ID of the destination section' },
          },
          required: ['task_id', 'to_section_id'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'reorder_tasks_in_section',
        description: 'Set the display order of all tasks within a section. Pass ALL task IDs for that section in the desired order — any omitted task IDs will not be moved.',
        parameters: {
          type: 'object',
          properties: {
            section_id: { type: 'string', description: 'Section whose tasks should be reordered' },
            task_ids: {
              type: 'array',
              items: { type: 'number' },
              description: 'All task IDs in the section, in the desired display order (first = top)',
            },
          },
          required: ['section_id', 'task_ids'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'reorder_sections',
        description: `Set the display order of sections within the current list. Pass ALL section IDs in the desired order. Current sections: ${sectionList}`,
        parameters: {
          type: 'object',
          properties: {
            section_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'All section IDs in the desired display order (first = top)',
            },
          },
          required: ['section_ids'],
        },
      },
    });
  }

  if (ctx.view === 'scheduled') {
    tools.push({
      type: 'function',
      function: {
        name: 'schedule_task',
        description: 'Set or update the deadline (and optionally time) for a task',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'number' },
            list_id: { type: 'string', description: 'List ID from context, or null for dashboard tasks' },
            deadline: { type: 'string', description: 'YYYY-MM-DD' },
            time: { type: 'string', description: 'HH:MM (24h, optional)' },
          },
          required: ['task_id', 'deadline'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'unschedule_task',
        description: 'Remove the deadline from a task',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'number' },
            list_id: { type: 'string', description: 'List ID or null for dashboard tasks' },
          },
          required: ['task_id'],
        },
      },
    });
  }

  // Cross-list task creation — available from any view
  const allListsWithSections = (ctx.data.available_lists as Array<{ id: string; name: string; sections?: Array<{ section_id: string; label: string }> }> ?? [])
    .map((l) => `"${l.name}" (id: ${l.id}, sections: [${(l.sections ?? []).map((s) => `"${s.label}" id:${s.section_id}`).join('; ')}])`).join('\n  ');

  tools.push({
    type: 'function',
    function: {
      name: 'create_task_in_list',
      description: `Create a task in any of the user's lists — use this when the user is not currently viewing that list.\nAvailable lists:\n  ${allListsWithSections}`,
      parameters: {
        type: 'object',
        properties: {
          list_id: { type: 'string', description: 'ID of the target list' },
          section_id: { type: 'string', description: 'ID of the section within that list' },
          title: { type: 'string', description: 'Task title' },
          deadline: { type: 'string', description: 'YYYY-MM-DD (optional)' },
          priority: { type: 'string', enum: ['High', 'Medium', 'Low'] },
          note: { type: 'string' },
        },
        required: ['list_id', 'section_id', 'title'],
      },
    },
  });

  // List & folder management — available in every view
  const folderList = (ctx.data.available_folders as Array<{ id: string; name: string }> ?? [])
    .map((f) => `"${f.name}" (id: ${f.id})`).join(', ') || 'none';

  // ── Folder tools ─────────────────────────────────────────────────
  tools.push({
    type: 'function',
    function: {
      name: 'create_folder',
      description: 'Create a new folder to organise lists.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Folder name' },
          emoji: { type: 'string', description: 'Optional emoji icon' },
          is_public: { type: 'boolean', description: 'true = public, false = private (default: true)' },
        },
        required: ['name'],
      },
    },
  });

  tools.push({
    type: 'function',
    function: {
      name: 'update_folder',
      description: "Rename a folder, change its emoji, or toggle its visibility. Only works on the current user's own folders.",
      parameters: {
        type: 'object',
        properties: {
          folder_id: { type: 'string', description: `Folder ID from available_folders: ${folderList}` },
          name: { type: 'string', description: 'New folder name' },
          emoji: { type: 'string', description: 'New emoji icon' },
          is_public: { type: 'boolean', description: 'true = public, false = private' },
        },
        required: ['folder_id'],
      },
    },
  });

  tools.push({
    type: 'function',
    function: {
      name: 'delete_folder',
      description: "Delete a folder. Lists inside it are moved out but not deleted. Only works on the current user's own folders.",
      parameters: {
        type: 'object',
        properties: {
          folder_id: { type: 'string', description: `Folder ID from available_folders: ${folderList}` },
        },
        required: ['folder_id'],
      },
    },
  });

  // ── List tools ────────────────────────────────────────────────────
  tools.push({
    type: 'function',
    function: {
      name: 'create_list',
      description: 'Create a new list. Automatically creates a default "Tasks" section — the tool result includes the section_id. Use that section_id for subsequent create_task_in_list calls targeting this new list.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'List name' },
          emoji: { type: 'string', description: 'Optional emoji icon' },
          folder_id: { type: 'string', description: `Optional folder ID to place the list in. Available folders: ${folderList}` },
        },
        required: ['name'],
      },
    },
  });

  tools.push({
    type: 'function',
    function: {
      name: 'update_list',
      description: "Rename a list, change its emoji, or toggle its visibility. Only works on the current user's own lists.",
      parameters: {
        type: 'object',
        properties: {
          list_id: { type: 'string', description: 'List ID from available_lists' },
          name: { type: 'string', description: 'New name' },
          emoji: { type: 'string', description: 'New emoji icon' },
          is_public: { type: 'boolean', description: 'true = public (anyone with the link can view), false = private (only you)' },
        },
        required: ['list_id'],
      },
    },
  });

  tools.push({
    type: 'function',
    function: {
      name: 'delete_list',
      description: "Permanently delete a list and all its tasks. Only works on the current user's own lists.",
      parameters: {
        type: 'object',
        properties: {
          list_id: { type: 'string', description: 'List ID from available_lists' },
        },
        required: ['list_id'],
      },
    },
  });

  tools.push({
    type: 'function',
    function: {
      name: 'move_list_to_folder',
      description: `Move a list into a folder, or remove it from its current folder. Available folders: ${folderList}`,
      parameters: {
        type: 'object',
        properties: {
          list_id: { type: 'string', description: 'List ID from available_lists' },
          folder_id: { type: 'string', description: 'Folder ID to move into, or null to remove from any folder' },
        },
        required: ['list_id'],
      },
    },
  });

  // Sublist tools — available in list view
  if (ctx.view === 'list' && ctx.listId) {
    const sectionList = (ctx.data.sections as Array<{ section_id: string; label: string }> ?? [])
      .map((s) => `"${s.label}" (id: ${s.section_id})`)
      .join(', ');

    tools.push({
      type: 'function',
      function: {
        name: 'create_sublist',
        description: 'Create a new sublist task under a section in the current list',
        parameters: {
          type: 'object',
          properties: {
            section_id: { type: 'string', description: `Section ID. Available: ${sectionList}` },
            task_title: { type: 'string', description: 'Title shown in the parent list for this sublist item' },
            sublist_name: { type: 'string', description: 'Name of the new sublist to create' },
          },
          required: ['section_id', 'task_title', 'sublist_name'],
        },
      },
    });

    tools.push({
      type: 'function',
      function: {
        name: 'link_list_as_task',
        description: 'Link an existing list as a task item in a section of the current list',
        parameters: {
          type: 'object',
          properties: {
            section_id: { type: 'string', description: `Section ID. Available: ${sectionList}` },
            task_title: { type: 'string', description: 'Title shown for the linked list task' },
            linked_list_id: { type: 'string', description: 'ID of the existing list to link' },
          },
          required: ['section_id', 'task_title', 'linked_list_id'],
        },
      },
    });
  }

  // ── Workspace member management ───────────────────────────────────
  if (workspaceId) {
    tools.push({
      type: 'function',
      function: {
        name: 'add_workspace_member',
        description: 'Add a user to the current workspace by their username. Only the workspace owner can do this.',
        parameters: {
          type: 'object',
          properties: {
            username: { type: 'string', description: 'Username of the person to add' },
          },
          required: ['username'],
        },
      },
    });

    tools.push({
      type: 'function',
      function: {
        name: 'remove_workspace_member',
        description: 'Remove a member from the current workspace by their user ID.',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: 'User ID of the member to remove' },
          },
          required: ['user_id'],
        },
      },
    });

    tools.push({
      type: 'function',
      function: {
        name: 'list_workspace_members',
        description: 'List all members of the current workspace.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    });
  }

  return tools;
}

export default useAIStore;
