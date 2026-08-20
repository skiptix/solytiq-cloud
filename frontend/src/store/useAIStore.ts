import { create } from 'zustand';
import type { AppState, AIFile, Task, MarkdownBlock, AiMemoryEntry } from '../types';
import useGraphStore from './useGraphStore';
import useWorkspaceStore from './useWorkspaceStore';
import useMarkdownListsStore from './useMarkdownListsStore';

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

interface AIStore {
  isOpen: boolean;
  settings: AISettings;
  messages: AIChatMessage[];
  isThinking: boolean;
  settingsLoaded: boolean;
  currentSessionId: string | null;
  uploadedFiles: AIFile[];
  /** Count of currently-open mobile full-screen dialogs (e.g. the item detail
   *  dialog) that the floating AI bubble would otherwise float on top of.
   *  A counter, not a boolean, so two overlapping dialogs don't let the first
   *  one's close prematurely reveal the bubble while the second is still open. */
  blockingDialogCount: number;

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
  addUploadedFile: (file: AIFile) => void;
  removeUploadedFile: (id: string) => void;
  clearUploadedFiles: () => void;
  openBlockingDialog: () => void;
  closeBlockingDialog: () => void;
}

const useAIStore = create<AIStore>()((set) => ({
  isOpen: false,
  settings: { enabled: true, model: 'openai/gpt-4o-mini' },
  messages: [],
  isThinking: false,
  settingsLoaded: false,
  currentSessionId: null,
  uploadedFiles: [],
  blockingDialogCount: 0,

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
  addUploadedFile: (file) => set((s) => ({ uploadedFiles: [...s.uploadedFiles, file] })),
  removeUploadedFile: (id) => set((s) => ({ uploadedFiles: s.uploadedFiles.filter((f) => f.id !== id) })),
  clearUploadedFiles: () => set({ uploadedFiles: [] }),
  openBlockingDialog: () => set((s) => ({ blockingDialogCount: s.blockingDialogCount + 1 })),
  closeBlockingDialog: () => set((s) => ({ blockingDialogCount: Math.max(0, s.blockingDialogCount - 1) })),
}));

// ── Context building ──────────────────────────────────────────────

export interface AIContext {
  view: string;
  listId?: string;
  timelineId?: string;
  markdownListId?: string;
  data: Record<string, unknown>;
}

function toIso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A compact, tool-argument-shaped summary of one block — mirrors the
 *  {type, text?, level?, checked?, url?, title?, description?, layout?,
 *  columns?, rows?} shape the markdown AI tools already take, so Sol can
 *  read this straight out of context without an extra get_markdown_list
 *  round-trip for the common case of "what does this page say right now". */
function markdownBlockSummary(b: MarkdownBlock): Record<string, unknown> {
  const base = { id: b.id, type: b.type };
  switch (b.type) {
    case 'heading': return { ...base, level: b.level, text: b.text };
    case 'paragraph': case 'bulleted-list-item': case 'numbered-list-item': case 'quote':
      return { ...base, text: b.text };
    case 'todo': return { ...base, text: b.text, checked: b.checked };
    case 'divider': return { ...base, layout: b.layout ?? 'stack' };
    case 'image': return { ...base, image_id: b.imageId, caption: b.caption ?? null };
    case 'link': return { ...base, url: b.url, title: b.title ?? null, description: b.description ?? null };
    case 'table': return { ...base, header_row: b.rows[0]?.cells ?? [], body_rows: b.rows.slice(1).map(r => r.cells), aggregates: b.columns.map(c => c.aggregate ?? null) };
    default: return base;
  }
}

export function buildContext(pathname: string, appStore: AppState): AIContext {
  const today = toIso(new Date());

  // Always include lists & folders so Sol can manage them from any view
  const listsSnapshot = appStore.lists.map((l) => ({
    id: l.id,
    name: l.name,
    emoji: l.emoji ?? null,
    folder_id: l.folderId ?? null,
    sections: l.sections.map((s) => ({ section_id: s.id, label: s.label })),
  }));
  const foldersSnapshot = appStore.folders.map((f) => ({
    id: f.id,
    name: f.name,
    emoji: f.emoji ?? null,
  }));
  // Always include timelines stub so Sol can navigate/create milestones from any view
  const timelinesSnapshot = appStore.timelines.map((t) => ({
    id: t.id,
    name: t.name,
    emoji: t.emoji ?? null,
    is_public: t.isPublic ?? false,
    milestone_count: t.milestones.length,
    done_count: t.milestones.filter(m => m.status === 'done').length,
  }));

  if (pathname.startsWith('/timeline/')) {
    const timelineId = pathname.split('/timeline/')[1];
    const tl = appStore.timelines.find((t) => t.id === timelineId);
    if (tl) {
      const total = tl.milestones.length;
      const done = tl.milestones.filter(m => m.status === 'done').length;
      return {
        view: 'timeline',
        timelineId,
        data: {
          timeline_id: tl.id,
          timeline_name: tl.name,
          timeline_subtitle: tl.subtitle ?? null,
          is_public: tl.isPublic ?? false,
          layout: tl.layout,
          progress: { total, done, pct: total > 0 ? Math.round((done / total) * 100) : 0 },
          milestones: tl.milestones.map(m => ({
            id: m.id,
            title: m.title,
            date: m.date ?? null,
            time: m.time ?? null,
            status: m.status,
            emoji: m.emoji ?? null,
            color: m.color ?? null,
            description: m.description ?? null,
            position: m.position ?? 0,
          })),
          available_timelines: timelinesSnapshot,
          available_lists: listsSnapshot,
          available_folders: foldersSnapshot,
        },
      };
    }
  }

  if (pathname.startsWith('/markdown-list/')) {
    const markdownListId = pathname.split('/markdown-list/')[1];
    const md = useMarkdownListsStore.getState().markdownLists.find((m) => m.id === markdownListId);
    if (md) {
      return {
        view: 'markdownList',
        markdownListId,
        data: {
          markdown_list_id: md.id,
          page_name: md.name,
          emoji: md.emoji ?? null,
          subtitle: md.subtitle ?? null,
          is_public: md.isPublic ?? false,
          full_width: md.fullWidth ?? false,
          folder_id: md.folderId ?? null,
          todo_list_id: md.todoListId ?? null,
          blocks: md.content.blocks.map(markdownBlockSummary),
          available_timelines: timelinesSnapshot,
          available_lists: listsSnapshot,
          available_folders: foldersSnapshot,
        },
      };
    }
  }

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
          available_timelines: timelinesSnapshot,
          available_lists: listsSnapshot,
          available_folders: foldersSnapshot,
        },
      };
    }
  }

  if (pathname.startsWith('/gps')) {
    const gpsFiles = (appStore as unknown as { gpsFiles?: Array<{ id: string; name: string; fileType: string; metadata?: { totalDistance?: number; totalElevationGain?: number } }> }).gpsFiles ?? [];
    return {
      view: 'gps',
      data: {
        routes: gpsFiles.map(f => ({
          id: f.id,
          name: f.name,
          fileType: f.fileType,
          distanceKm: f.metadata?.totalDistance != null ? Math.round(f.metadata.totalDistance / 100) / 10 : null,
          elevationGain: f.metadata?.totalElevationGain != null ? Math.round(f.metadata.totalElevationGain) : null,
        })),
        available_timelines: timelinesSnapshot,
      },
    };
  }

  if (pathname.startsWith('/calendar')) {
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
      view: 'calendar',
      data: { today, scheduled_tasks: scheduled, unscheduled_tasks: unscheduled, available_timelines: timelinesSnapshot, available_lists: listsSnapshot, available_folders: foldersSnapshot },
    };
  }

  if (pathname.startsWith('/graph')) {
    const gs = useGraphStore.getState();
    const ws = useWorkspaceStore.getState();
    const workspaceName = ws.workspaces.find((w) => w.id === ws.currentWorkspaceId)?.name ?? null;
    const nodes = gs.allNodes;
    // part_of is a hidden structural mirror superseded by the hierarchy tree itself — not a meaningful "relation" to report.
    const relations = gs.allEdges.filter((e) => e.linkType !== 'part_of');
    const nodesByType: Record<string, number> = {};
    for (const n of nodes) nodesByType[n.type] = (nodesByType[n.type] ?? 0) + 1;
    const topConnected = [...nodes]
      .sort((a, b) => b.pagerank - a.pagerank)
      .slice(0, 10)
      .map((n) => ({ srn: n.srn, title: n.title, type: n.type, relations: n.degree }));
    return {
      view: 'graph',
      data: {
        workspace_name: workspaceName,
        total_items: nodes.length,
        total_relations: relations.length,
        items_by_type: nodesByType,
        most_connected_items: topConnected,
        active_filters: gs.filters,
        available_timelines: timelinesSnapshot,
        available_lists: listsSnapshot,
        available_folders: foldersSnapshot,
      },
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
    data: { today, overdue_tasks: overdue, due_today_tasks: dueToday, upcoming_tasks: upcoming, no_deadline_tasks: noDeadline, available_timelines: timelinesSnapshot, available_lists: listsSnapshot, available_folders: foldersSnapshot },
  };
}

// ── System prompt ──────────────────────────────────────────────────

/** One term as carried into Sol's prompt — no body, just enough to know it exists. */
export interface GlossaryHint {
  term: string;
  aliases: string[];
  summary: string | null;
}

/** One AI Skill as carried into Sol's prompt — name + description only. The
 *  full SKILL.md body is pulled on demand via the read_skill tool, the same
 *  progressive-disclosure split lookup_knowledge uses for the Knowledge Base
 *  glossary below. See types.ts's AiSkillHint. */
export interface SkillHint {
  id: string;
  name: string;
  description: string;
}

export function buildSystemPrompt(
  ctx: AIContext,
  username: string,
  workspaces?: Array<{ id: string; name: string; role: string }>,
  currentWorkspaceId?: string | null,
  glossary?: GlossaryHint[],
  skills?: SkillHint[],
  memory?: AiMemoryEntry[]
): string {
  const today = toIso(new Date());
  const tlProgress = ctx.view === 'timeline'
    ? ` — ${(ctx.data.progress as { done: number; total: number } | undefined)?.done ?? 0}/${(ctx.data.progress as { done: number; total: number } | undefined)?.total ?? 0} milestones done`
    : '';
  const viewDescriptions: Record<string, string> = {
    dashboard: 'Dashboard — personal quick-add task list with deadlines and priorities',
    list: `List — "${(ctx.data.list_name as string) ?? 'unknown'}" with multiple sections containing tasks`,
    calendar: 'Calendar — calendar view showing tasks with and without deadlines',
    gps: 'GPS Routes — route/workout file manager for .GPX and .FIT files',
    timeline: `Timeline — "${(ctx.data.timeline_name as string) ?? 'unknown'}"${tlProgress}`,
    graph: `Net — the Graph Layer's visual map of "${(ctx.data.workspace_name as string) ?? 'this workspace'}": every board, page, task, timeline, milestone, and folder rendered as a connected node, always rooted at a central workspace hub. Every item is linked hierarchically up to that hub (task -> section -> board -> folder -> workspace), and items can additionally carry explicit relations (e.g. "blocks", "tracks", "relates_to") drawn as a second, more prominent connection`,
    markdownList: `Markdown Page — "${(ctx.data.page_name as string) ?? 'unknown'}", a freeform document built from blocks (headings, paragraphs, lists, to-dos, quotes, dividers, links, tables)`,
  };

  const contextJson = JSON.stringify(ctx.data, null, 2);

  const sublistNote = ctx.view === 'list'
    ? '\n- SUBLISTS: You can create sublists (nested lists) or link existing lists as task items using create_sublist and link_list_as_task tools.'
    : '\n- SUBLISTS: You can add sub-items to any dashboard task using add_subitem_to_dash_task (creates a linked sublist automatically if needed), or create a sublist first with add_sublist_to_dash_task. Check linked_list_id in the context — tasks that already have a sublist will show it. You can also link an existing list to a dash task with link_list_to_dash_task.';

  const graphNote = ctx.view === 'graph'
    ? '\n- NET VIEW: You are looking at the Graph Layer\'s visual map. `items_by_type`/`total_items` describe everything currently loaded; `most_connected_items` are the highest-pagerank hub nodes; `active_filters` shows the entity-type/completed/relations filters currently applied. Two different kinds of connection exist: the ALWAYS-PRESENT structural hierarchy (task -> section -> board -> folder -> workspace, drawn as thin lines, not a user-editable relation) versus EXPLICIT relations (e.g. blocks/tracks/relates_to, drawn as bold lines) which you manage with search_graph (find an entity by title to get its srn), get_entity_links/get_backlinks (see what\'s connected to something), create_link (add a typed relation between two srns — requires write access to the source), and delete_link (remove one; system-mirrored relations can\'t be deleted this way). Use focus_graph_node(srn) to pan the Net\'s camera onto and select a specific item (opens the Net view if the user isn\'t already there), set_graph_filters to narrow what\'s shown (e.g. only boards and tasks, or hide items with no explicit relation), and reset_graph_view to clear filters and release any nodes the user manually dragged.'
    : '';

  // The workspace's own vocabulary, terms only. This is the single highest-value
  // thing to spend context on: without it the model doesn't know a definition
  // EXISTS, so it guesses instead of calling lookup_knowledge. Bodies stay out —
  // they're what the lookup is for, and carrying them would blow the budget.
  const glossaryNote = glossary?.length
    ? `\n\nThis workspace's Knowledge Base defines these terms. When the user mentions one — or you are about to state anything about it — call lookup_knowledge(workspace_id, term) FIRST and use that definition rather than inferring one. If a term you need is NOT on this list, say you don't have a definition for it instead of guessing; you may offer to define it with create_knowledge_entry.\n${
        glossary.map((g) => `- ${g.term}${g.aliases.length ? ` (aka ${g.aliases.join(', ')})` : ''}${g.summary ? `: ${g.summary}` : ''}`).join('\n')
      }`
    : '';

  const workspaceInfo = workspaces?.length
    ? `\nWorkspaces you can manage: ${workspaces.map((w) => `"${w.name}" (id: ${w.id}, role: ${w.role})`).join(', ')}. Current workspace: ${workspaces.find((w) => w.id === currentWorkspaceId)?.name ?? 'unknown'}.`
    : '';

  // Admin-curated AI Skills, name+description only (progressive disclosure —
  // the full SKILL.md body is pulled via read_skill only once a task actually
  // matches one, so an instance with many/large skills doesn't bloat every
  // single chat's context).
  const skillsNote = skills?.length
    ? `\n\nAI Skills available on this instance (admin-curated context bundles). When the user's request matches one of these, call read_skill(skill_id) FIRST to load its full instructions before proceeding — do not guess at what a skill covers from its description alone.\n${
        skills.map((s) => `- "${s.name}" (id: ${s.id}): ${s.description || 'no description'}`).join('\n')
      }`
    : '';

  // Long-term memory about THIS user — small enough to inline outright (no
  // progressive-disclosure step, unlike skills/glossary above). Use add_memory
  // to save a new durable fact and remove_memory to delete one by the id shown
  // here.
  const memoryNote = memory?.length
    ? `\n\nMEMORY — durable facts you've saved about ${username} that persist across every conversation, not just this one:\n${
        memory.map((m) => `- [${m.id}] ${m.content}`).join('\n')
      }`
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
- BATCH OPERATIONS: When creating multiple independent items of the same type (e.g. "add 3 tasks to this list", "create a folder for each project"), call the relevant tool once per item in the SAME response — all in parallel. DEPENDENCY ORDER IS MANDATORY: always complete parent resources before children. Specifically: (1) create workspace first, wait for its result, THEN (2) create folders in parallel, wait for results, THEN (3) create lists in parallel (using folder IDs from step 2), wait for results, THEN (4) create tasks in parallel (using list/section IDs from step 3). Never mix dependency layers in the same parallel batch — doing so causes failures that silently drop data.
- ERROR HANDLING: After each batch of tool calls, check the results. If any result starts with "Error:", report that failure to the user clearly — do NOT claim success for failed operations. Partial success is OK but must be disclosed.
- DATE PARSING: Always convert dates to YYYY-MM-DD before using them in tool parameters. Accept any format the user writes: DD.MM.YY (e.g. 11.5.26 → 2026-05-11), DD.MM.YYYY, MM/DD/YYYY, natural language like "tomorrow", "next Monday", "end of month". Use today (${today}) as the reference point for relative dates.
- INTENT: Words like "terminate", "deadline", "due", "schedule for", "set to", "end by" all mean the user wants to set a task deadline.
- Refer to tasks, lists, sections, and folders by their names, not their IDs, when talking to the user
- When creating a list you can optionally assign it to a folder from available_folders
- FOLDER IDs: Always use the exact folder ID (e.g. "folder_abc123"), never the folder name. When creating lists inside a NEW folder that doesn't exist yet, you MUST call create_folder first, then use the folder_id returned in the tool result for subsequent create_list calls — never guess or fabricate a folder_id
- NEW LIST SECTIONS: When you create a list with create_list, a default "Tasks" section is automatically created. The tool result contains the section_id (e.g. "section_id: abc123"). Always use that section_id when calling create_task_in_list for that new list — never guess or fabricate a section_id
- CROSS-LIST TASKS: You can create tasks in any list using create_task_in_list — use available_lists to find list IDs and their sections. For newly created lists, use the section_id returned in the create_list tool result
- SORTING/REORDERING: To sort tasks in a section, call reorder_tasks_in_section with all task IDs in the desired order. To move a task to a different section, call move_task_to_section. To reorder sections themselves, call reorder_sections. Always use actual task/section IDs from the context — never guess IDs.
- WORKSPACES: You can create workspaces (create_workspace), rename/update them (update_workspace), or delete them (delete_workspace). ALWAYS ask the user to confirm before deleting a workspace. You can also manage members with add_workspace_member and remove_workspace_member
- WORKSPACE AUTO-MATCH: When the user asks you to create a batch of tasks/lists/folders/timelines (e.g. pastes a to-do list or a set of items from a document) and does NOT say which workspace to use, don't just default to the current workspace by reflex. First check whether the content clearly belongs elsewhere: call list_workspaces (names/descriptions) and list_lists/list_folders/list_timelines (each now shows its workspace_id and workspace name) to see if an existing workspace's theme — its name, or the lists/projects already inside it — is a clearly better match (e.g. the items mention a client, project, or topic that matches another workspace). If so, pass that workspace_id explicitly to create_dashboard_task/create_list/create_folder/create_timeline. If nothing matches clearly better, use the current workspace. Never stop to ask permission first — proceed with your best judgment, then state plainly which workspace you put things in so the user can correct you if you guessed wrong.
- PROACTIVITY / USE YOUR TOOLS FIRST: Before asking the user for information you could look up yourself, use your read tools — list_lists, list_folders, list_timelines, list_workspaces, list_files, list_templates, list_gps_files, list_trash, universal_search — to check. Only ask the user when your tools genuinely can't resolve the ambiguity (e.g. two equally good workspace matches).
- FILES: list_files/read_file read the user's uploaded files. read_file never silently truncates a large document (e.g. a long contract) — if it doesn't fit in one call, the result tells you the total length and the offset to pass on the next read_file call so you can work through the whole document across multiple calls; always do this rather than summarizing from a partial read. You can also toggle a public link with share_file, delete a file with delete_file, and attach/list/remove file attachments on a task with attach_file_to_task/list_task_attachments/remove_task_attachment.
- TEMPLATES: list_templates/create_template/use_template/delete_template manage reusable list/timeline structures (own + shared-by-others). Use create_template to save one of the user's own lists/timelines for reuse, and use_template to instantiate a new list/timeline from one (optionally into a specific workspace_id/folder_id).
- GPS FILES: list_gps_files/rename_gps_file/delete_gps_file work on the user's uploaded GPX/FIT route files from any view (not just the GPS page).
- TRASH: list_trash shows recently deleted tasks/lists/folders/timelines (30-day recovery window) — restoring itself must be done from the Trash view in the app, so point the user there if they want something back.
- TIMELINES: You can create timelines (create_timeline), update/rename them (update_timeline), delete them (delete_timeline — ALWAYS confirm first). Navigate to a specific timeline with navigate_to_timeline using its ID from available_timelines. When on a timeline page you can add milestones (add_milestone), edit them (update_milestone), delete them (delete_milestone — confirm first), and reorder them (reorder_milestones).
- MARKDOWN PAGES: You have full read/write control over Markdown Pages — freeform documents built from blocks (heading, paragraph, bulleted/numbered-list-item, todo, quote, divider, link, table). list_markdown_lists finds pages by name across the workspace; get_markdown_list reads one page's full block-by-block content with block ids. create_markdown_list makes a new page (optionally seeded with blocks); update_markdown_list edits the page's own settings (name/emoji/color/subtitle/visibility/folder — NOT content); delete_markdown_list moves it to Trash (ALWAYS confirm first). For content, use add_markdown_block/add_markdown_blocks to insert, update_markdown_block to edit one, remove_markdown_block to delete one, move_markdown_block/reorder_markdown_blocks to reposition, or set_markdown_content to replace the ENTIRE page in one call (the best choice for "rewrite"/"restructure" requests — but it overwrites everything, so include every block you want kept). When the user is currently viewing a Markdown Page (see Current view/context data above), its blocks are already inlined in context with their ids — you don't need get_markdown_list first unless you need the very latest state after another tool call changed it. A todo block mirrors live into that page's auto-managed Todo list (todo_list_id in context) — you don't need to touch that list separately.
- MILESTONE STATUS: valid values are 'upcoming', 'in-progress', 'done'. Milestone dates use YYYY-MM-DD format. Color can be a hex string (e.g. "var(--color-success)") or null for auto.
- TIMELINE IDs: Always use exact timeline_id strings from available_timelines. Milestone IDs come from the milestones array in the current context.
- LONG-TERM MEMORY: Any MEMORY entries above are durable facts about ${username} that already ride in every conversation — treat them as known, don't ask about them again. Call add_memory when the user tells you to remember something, or a clearly durable preference comes up naturally (keep it to one short fact per call, and don't duplicate one already listed). Call remove_memory(memory_id) when the user says to forget something or a saved fact goes stale. Do NOT save one-off task details already tracked elsewhere (tasks/lists/notes) — memory is only for things that should color every future chat.
- PAST CONVERSATIONS: search_chat_history looks across the user's OTHER past chat sessions (not this one). Call it ONLY when the user explicitly references an earlier conversation — e.g. "what did I ask you before", "did we talk about this already", "what did you tell me last time". Never call it speculatively; most turns have nothing to do with past chats, and it costs extra tokens for no benefit when the answer is already in front of you.
- If the user asks something outside your capabilities, explain politely what you can do instead${sublistNote}${graphNote}${glossaryNote}${skillsNote}${memoryNote}`;
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

export function buildTools(ctx: AIContext, workspaceId?: string | null, workspaces?: Array<{ id: string; name: string; role: string }>): ToolDef[] {
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

  if (ctx.view === 'calendar') {
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

  // ── Workspace CRUD ────────────────────────────────────────────────
  tools.push({
    type: 'function',
    function: {
      name: 'create_workspace',
      description: 'Create a new workspace. After creation the new workspace becomes the active one.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Workspace name' },
          description: { type: 'string', description: 'Optional description' },
          emoji: { type: 'string', description: 'Optional emoji icon (e.g. 🚀)' },
          visibility: { type: 'string', enum: ['private', 'public'], description: 'private (default) or public' },
        },
        required: ['name'],
      },
    },
  });

  if (workspaces?.length) {
    const wsList = workspaces.map((w) => `"${w.name}" (id: ${w.id}, role: ${w.role})`).join(', ');

    tools.push({
      type: 'function',
      function: {
        name: 'update_workspace',
        description: `Rename a workspace, change its emoji, description, or visibility. Available workspaces: ${wsList}`,
        parameters: {
          type: 'object',
          properties: {
            workspace_id: { type: 'string', description: 'Workspace ID from the list above' },
            name: { type: 'string', description: 'New name' },
            description: { type: 'string', description: 'New description' },
            emoji: { type: 'string', description: 'New emoji icon' },
            visibility: { type: 'string', enum: ['private', 'public'] },
          },
          required: ['workspace_id'],
        },
      },
    });

    tools.push({
      type: 'function',
      function: {
        name: 'delete_workspace',
        description: `Permanently delete a workspace and all its data. ALWAYS ask the user for confirmation before calling this. Available workspaces: ${wsList}`,
        parameters: {
          type: 'object',
          properties: {
            workspace_id: { type: 'string', description: 'Workspace ID to delete' },
          },
          required: ['workspace_id'],
        },
      },
    });
  }

  // ── GPS tools (available when on GPS tab) ─────────────────────────────────
  if (ctx.view === 'gps') {
    const routeList = (ctx.data.routes as Array<{ id: string; name: string; fileType: string; distanceKm: number | null; elevationGain: number | null }> ?? [])
      .map(r => `"${r.name}" (id: ${r.id}, type: ${r.fileType}${r.distanceKm != null ? `, ${r.distanceKm} km` : ''}${r.elevationGain != null ? `, ↑${r.elevationGain}m` : ''})`)
      .join('\n  ') || 'none uploaded yet';

    tools.push({
      type: 'function',
      function: {
        name: 'list_gps_routes',
        description: 'List all GPS routes/files the user has uploaded. Returns names, IDs, distances, and elevation gains.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    });

    tools.push({
      type: 'function',
      function: {
        name: 'rename_gps_route',
        description: `Rename a GPS route file.\nAvailable routes:\n  ${routeList}`,
        parameters: {
          type: 'object',
          properties: {
            route_id: { type: 'string', description: 'ID of the route to rename' },
            new_name: { type: 'string', description: 'New filename (without extension if desired)' },
          },
          required: ['route_id', 'new_name'],
        },
      },
    });

    tools.push({
      type: 'function',
      function: {
        name: 'delete_gps_route',
        description: `Delete a GPS route file permanently. ALWAYS confirm with the user before deleting.\nAvailable routes:\n  ${routeList}`,
        parameters: {
          type: 'object',
          properties: {
            route_id: { type: 'string', description: 'ID of the route to delete' },
          },
          required: ['route_id'],
        },
      },
    });

    tools.push({
      type: 'function',
      function: {
        name: 'merge_gps_routes',
        description: `Merge multiple GPS routes into one and save to library.\nAvailable routes:\n  ${routeList}`,
        parameters: {
          type: 'object',
          properties: {
            route_ids: { type: 'array', items: { type: 'string' }, description: 'IDs of routes to merge, in order' },
            output_name: { type: 'string', description: 'Name for the merged route file' },
          },
          required: ['route_ids', 'output_name'],
        },
      },
    });

    tools.push({
      type: 'function',
      function: {
        name: 'smooth_gps_elevation',
        description: `Apply Gaussian elevation smoothing to a GPS route and save the result.\nAvailable routes:\n  ${routeList}`,
        parameters: {
          type: 'object',
          properties: {
            route_id: { type: 'string', description: 'ID of the route to smooth' },
            sigma: { type: 'number', description: 'Smoothing strength 1–30 (1 = no change, 15 = moderate, 30 = heavy)' },
            mode: { type: 'string', enum: ['new', 'replace'], description: '"new" saves a new file, "replace" overwrites the original' },
            output_name: { type: 'string', description: 'Name for the new file (only used when mode = "new")' },
          },
          required: ['route_id', 'sigma', 'mode'],
        },
      },
    });
  }

  // ── Timeline tools (global — available from every view) ──────────────────
  const timelinesForTools = (ctx.data.available_timelines as Array<{ id: string; name: string }> ?? []);
  const timelineListStr = timelinesForTools.map(t => `"${t.name}" (id: ${t.id})`).join(', ') || 'none';

  tools.push({
    type: 'function',
    function: {
      name: 'create_timeline',
      description: 'Create a new timeline to track milestones and project progress.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Timeline name' },
          emoji: { type: 'string', description: 'Optional emoji icon (e.g. 🚀)' },
          subtitle: { type: 'string', description: 'Optional subtitle / description shown below the name' },
          color: { type: 'string', description: 'Accent color hex (e.g. "var(--color-primary)")' },
          layout: { type: 'string', enum: ['vertical', 'compact', 'detailed'], description: 'Display density (default: vertical)' },
          is_public: { type: 'boolean', description: 'true = public, false = private (default: false)' },
          folder_id: { type: 'string', description: `Optional folder ID to place the timeline in. Available folders: ${folderList}` },
        },
        required: ['name'],
      },
    },
  });

  tools.push({
    type: 'function',
    function: {
      name: 'update_timeline',
      description: `Update a timeline's name, emoji, subtitle, color, layout, or visibility. Available timelines: ${timelineListStr}`,
      parameters: {
        type: 'object',
        properties: {
          timeline_id: { type: 'string', description: 'ID of the timeline to update' },
          name: { type: 'string', description: 'New name' },
          emoji: { type: 'string', description: 'New emoji icon' },
          subtitle: { type: 'string', description: 'New subtitle' },
          color: { type: 'string', description: 'New accent color hex' },
          layout: { type: 'string', enum: ['vertical', 'compact', 'detailed'] },
          is_public: { type: 'boolean', description: 'true = public, false = private' },
        },
        required: ['timeline_id'],
      },
    },
  });

  tools.push({
    type: 'function',
    function: {
      name: 'delete_timeline',
      description: `Permanently delete a timeline and all its milestones. ALWAYS ask the user to confirm before calling this. Available timelines: ${timelineListStr}`,
      parameters: {
        type: 'object',
        properties: {
          timeline_id: { type: 'string', description: 'ID of the timeline to delete' },
        },
        required: ['timeline_id'],
      },
    },
  });

  tools.push({
    type: 'function',
    function: {
      name: 'navigate_to_timeline',
      description: `Navigate the app to a specific timeline page. Use this when the user asks to open or go to a timeline. Available timelines: ${timelineListStr}`,
      parameters: {
        type: 'object',
        properties: {
          timeline_id: { type: 'string', description: 'ID of the timeline to navigate to' },
        },
        required: ['timeline_id'],
      },
    },
  });

  // ── Milestone tools (scoped to timeline view) ─────────────────────────────
  if (ctx.view === 'timeline' && ctx.timelineId) {
    const milestoneList = (ctx.data.milestones as Array<{ id: string; title: string; status: string }> ?? [])
      .map(m => `"${m.title}" (id: ${m.id}, status: ${m.status})`).join(', ') || 'none';

    tools.push({
      type: 'function',
      function: {
        name: 'add_milestone',
        description: `Add a new milestone to the current timeline ("${ctx.data.timeline_name as string}").`,
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Milestone title' },
            date: { type: 'string', description: 'Date YYYY-MM-DD (optional)' },
            time: { type: 'string', description: 'Time HH:MM (optional)' },
            status: { type: 'string', enum: ['upcoming', 'in-progress', 'done'], description: 'Default: upcoming' },
            emoji: { type: 'string', description: 'Optional emoji (e.g. 🎯)' },
            color: { type: 'string', description: 'Optional accent color hex or null for auto' },
            description: { type: 'string', description: 'Optional notes / description' },
          },
          required: ['title'],
        },
      },
    });

    tools.push({
      type: 'function',
      function: {
        name: 'update_milestone',
        description: `Edit an existing milestone. Current milestones: ${milestoneList}`,
        parameters: {
          type: 'object',
          properties: {
            milestone_id: { type: 'string', description: 'ID of the milestone to update' },
            title: { type: 'string', description: 'New title' },
            date: { type: 'string', description: 'New date YYYY-MM-DD, or empty string to remove' },
            time: { type: 'string', description: 'New time HH:MM, or empty string to remove' },
            status: { type: 'string', enum: ['upcoming', 'in-progress', 'done'] },
            emoji: { type: 'string', description: 'New emoji, or empty string to remove' },
            color: { type: 'string', description: 'New color hex, or empty string for auto' },
            description: { type: 'string', description: 'New notes' },
          },
          required: ['milestone_id'],
        },
      },
    });

    tools.push({
      type: 'function',
      function: {
        name: 'delete_milestone',
        description: `Delete a milestone. Confirm with the user first. Current milestones: ${milestoneList}`,
        parameters: {
          type: 'object',
          properties: {
            milestone_id: { type: 'string', description: 'ID of the milestone to delete' },
          },
          required: ['milestone_id'],
        },
      },
    });

    tools.push({
      type: 'function',
      function: {
        name: 'reorder_milestones',
        description: `Set the display order of milestones. Pass ALL milestone IDs in the desired order. Current milestones: ${milestoneList}`,
        parameters: {
          type: 'object',
          properties: {
            milestone_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'All milestone IDs in the desired order (first = top)',
            },
          },
          required: ['milestone_ids'],
        },
      },
    });
  }

  if (ctx.view === 'graph') {
    tools.push({
      type: 'function',
      function: {
        name: 'focus_graph_node',
        description: 'Pan and zoom the Net view\'s camera onto a specific item and select it. Opens the Net view first if the user is elsewhere. Get the srn from most_connected_items in the context, or from search_graph.',
        parameters: {
          type: 'object',
          properties: {
            srn: { type: 'string', description: 'The item\'s SRN, e.g. "srn:list:list_abc123"' },
          },
          required: ['srn'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'set_graph_filters',
        description: 'Narrow what the Net view currently displays.',
        parameters: {
          type: 'object',
          properties: {
            entity_types: {
              type: 'array',
              items: { type: 'string', enum: ['task', 'list', 'markdownList', 'timeline', 'milestone', 'meeting', 'folder', 'file', 'section', 'gpsFile'] },
              description: 'Only show these entity types. Omit or pass an empty array to show every type.',
            },
            show_completed: { type: 'boolean', description: 'Whether to include completed (checked) tasks.' },
            show_orphans: { type: 'boolean', description: 'Whether to include items that have no explicit relation — only the structural hierarchy connects them.' },
          },
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'reset_graph_view',
        description: 'Reset the Net view\'s filters to their defaults and release every node the user manually dragged, letting the layout settle back into its automatic hierarchy.',
        parameters: { type: 'object', properties: {} },
      },
    });
  }

  return tools;
}

export default useAIStore;
