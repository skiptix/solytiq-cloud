import { create } from 'zustand';
import type { AppState, Task } from '../types';

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
  clearHistory: () => set({ messages: [] }),
  setCurrentSessionId: (id) => set({ currentSessionId: id }),
  setRecentSessions: (sessions) => set({ recentSessions: sessions }),
  setShowRecentChats: (v) => set({ showRecentChats: v }),
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
    .map((t) => ({ id: t.id, title: t.title, deadline: t.deadline, priority: t.priority ?? null }));
  const dueToday = appStore.dashTasks
    .filter((t) => !t.checked && t.deadline === today)
    .map((t) => ({ id: t.id, title: t.title, priority: t.priority ?? null }));
  const noDeadline = appStore.dashTasks
    .filter((t) => !t.checked && !t.deadline)
    .slice(0, 15)
    .map((t) => ({ id: t.id, title: t.title, priority: t.priority ?? null }));
  const upcoming = appStore.dashTasks
    .filter((t) => !t.checked && t.deadline && t.deadline > today)
    .slice(0, 10)
    .map((t) => ({ id: t.id, title: t.title, deadline: t.deadline, priority: t.priority ?? null }));

  return {
    view: 'dashboard',
    data: { today, overdue_tasks: overdue, due_today_tasks: dueToday, upcoming_tasks: upcoming, no_deadline_tasks: noDeadline, available_lists: listsSnapshot, available_folders: foldersSnapshot },
  };
}

// ── System prompt ──────────────────────────────────────────────────

export function buildSystemPrompt(ctx: AIContext, username: string): string {
  const today = toIso(new Date());
  const viewDescriptions: Record<string, string> = {
    dashboard: 'Dashboard — personal quick-add task list with deadlines and priorities',
    list: `List — "${(ctx.data.list_name as string) ?? 'unknown'}" with multiple sections containing tasks`,
    scheduled: 'Scheduled — calendar view showing tasks with and without deadlines',
  };

  const contextJson = JSON.stringify(ctx.data, null, 2);

  return `You are Sol, a helpful AI assistant embedded in Solytiq Cloud, a personal productivity and task management app.

Current user: ${username}
Current view: ${viewDescriptions[ctx.view] ?? ctx.view}

Current context data:
${contextJson}

Guidelines:
- Be concise, friendly, and helpful
- When you execute an action using a tool, briefly confirm what you did in your final response
- SECURITY: You may only act on data that belongs to the current user (${username}). Never touch lists, folders, tasks, or sections belonging to other users. The available_lists and available_folders in the context are the only ones you are allowed to modify.
- For delete operations, confirm with the user first before executing unless they explicitly said to delete
- DATE PARSING: Always convert dates to YYYY-MM-DD before using them in tool parameters. Accept any format the user writes: DD.MM.YY (e.g. 11.5.26 → 2026-05-11), DD.MM.YYYY, MM/DD/YYYY, natural language like "tomorrow", "next Monday", "end of month". Use today (${today}) as the reference point for relative dates.
- INTENT: Words like "terminate", "deadline", "due", "schedule for", "set to", "end by" all mean the user wants to set a task deadline.
- Refer to tasks, lists, sections, and folders by their names, not their IDs, when talking to the user
- When creating a list you can optionally assign it to a folder from available_folders
- If the user asks something outside your capabilities, explain politely what you can do instead`;
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

export function buildTools(ctx: AIContext): ToolDef[] {
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

  // List & folder management — available in every view
  const folderList = (ctx.data.available_folders as Array<{ id: string; name: string }> ?? [])
    .map((f) => `"${f.name}" (id: ${f.id})`).join(', ') || 'none';

  tools.push({
    type: 'function',
    function: {
      name: 'create_list',
      description: 'Create a new list for the current user. Optionally place it in a folder.',
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

  return tools;
}

export default useAIStore;
