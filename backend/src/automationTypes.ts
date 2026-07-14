// ---------------------------------------------------------------------------
// Automation Hub — node-type registry. THE single source of truth for every
// trigger/action an automation graph can use, mirroring the aiTools.ts
// pattern: each node has (1) a JSON-Schema-ish parameter spec used to render
// the editor's inspector panel and validate saved graphs, and (2) — for
// actions — a server-side handler.
//
// SECURITY: action handlers receive `ctx.workspaceId`/`ctx.automationOwnerId`
// from the verified automation row, never from node params. Any node param
// that names another list (move_task/create_task's targetListId) is
// re-verified at execution time to belong to the SAME workspace as the
// automation (assertListInWorkspace) — defense in depth against a list
// having moved/been deleted since the automation was saved, on top of the
// save-time check in automationGraph.ts.
// ---------------------------------------------------------------------------

import { v4 as uuidv4 } from 'uuid';
import { QueryExec, userCanAccessWorkspace } from './workspaceUtil';
import type { MutationActor } from './automationEngine';
import { createListTask, deleteTaskRow, setListArchived } from './routes/lists';
import { softDeleteListTreeExec, softDeleteFolderExec, collectDescendantListIds } from './trashUtil';

export interface AutomationParamProperty {
  type: 'string' | 'number' | 'boolean';
  label: string;
  description: string;
  optional?: boolean;
  /** UI hints: render a picker instead of a free-text field. */
  isListId?: boolean;
  isFolderId?: boolean;
  isWorkspaceId?: boolean;
  enum?: string[];
}

export interface AutomationParamSchema {
  type: 'object';
  properties: Record<string, AutomationParamProperty>;
}

export interface TriggerContext {
  workspaceId: string;
  task?: { id: string; title: string; listId: string; checked: boolean };
  list?: { id: string; name: string };
}

export interface TriggerDef {
  id: string;
  label: string;
  description: string;
  icon: string;
  paramsSchema: AutomationParamSchema;
  /** Does firing this trigger give downstream actions a concrete task/list to act on? */
  providesTask: boolean;
  providesList: boolean;
  validate: (params: Record<string, unknown>) => string | null;
}

export interface ActionContext {
  exec: QueryExec;
  workspaceId: string;
  automationId: string;
  automationOwnerId: string;
  runId: string;
  actor: MutationActor;
  trigger: TriggerContext;
}

export interface ActionResult {
  ok: boolean;
  summary: string;
  error?: string;
}

export interface ActionDef {
  id: string;
  label: string;
  description: string;
  icon: string;
  paramsSchema: AutomationParamSchema;
  requiresTriggerTask?: boolean;
  requiresTriggerList?: boolean;
  validate: (params: Record<string, unknown>) => string | null;
  execute: (ctx: ActionContext, params: Record<string, unknown>) => Promise<ActionResult>;
}

// ── small helpers ────────────────────────────────────────────────────────

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function ok(summary: string): ActionResult {
  return { ok: true, summary };
}
function fail(error: string): ActionResult {
  return { ok: false, summary: error, error };
}

/** Defense in depth: re-verify a node-param list still belongs to this automation's workspace at execution time. */
async function assertListInWorkspace(exec: QueryExec, listId: string, workspaceId: string): Promise<string | null> {
  const r = await exec('SELECT workspace_id FROM lists WHERE id = $1', [listId]);
  if (r.rows.length === 0) return 'Target list no longer exists';
  if ((r.rows[0] as { workspace_id: string | null }).workspace_id !== workspaceId) {
    return 'Target list is not in this automation\'s workspace';
  }
  return null;
}

/** Same guard as assertListInWorkspace, for a node param naming a folder. */
async function assertFolderInWorkspace(exec: QueryExec, folderId: string, workspaceId: string): Promise<string | null> {
  const r = await exec('SELECT workspace_id FROM folders WHERE id = $1', [folderId]);
  if (r.rows.length === 0) return 'Target folder no longer exists';
  if ((r.rows[0] as { workspace_id: string | null }).workspace_id !== workspaceId) {
    return 'Target folder is not in this automation\'s workspace';
  }
  return null;
}

async function resolveTargetSection(exec: QueryExec, listId: string, requestedSectionId?: string): Promise<string | { error: string }> {
  if (requestedSectionId) {
    const sec = await exec('SELECT id FROM sections WHERE id = $1 AND list_id = $2', [requestedSectionId, listId]);
    if (sec.rows.length === 0) return { error: 'Target section does not belong to the target list' };
    return requestedSectionId;
  }
  const first = await exec('SELECT id FROM sections WHERE list_id = $1 ORDER BY position ASC LIMIT 1', [listId]);
  if (first.rows.length === 0) return { error: 'Target list has no sections' };
  return (first.rows[0] as { id: string }).id;
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export const TRIGGER_REGISTRY: TriggerDef[] = [
  {
    id: 'task_completed',
    label: 'Task completed',
    description: 'Fires when a task is checked off — in a specific list, or any list in this workspace.',
    icon: 'task_alt',
    paramsSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', label: 'List', description: 'Only fire for this list. Leave empty to match any list in the workspace.', optional: true, isListId: true },
      },
    },
    providesTask: true,
    providesList: true,
    validate: (params) => {
      if (params.listId !== undefined && params.listId !== null && typeof params.listId !== 'string') return 'listId must be a string';
      return null;
    },
  },
  {
    id: 'list_all_completed',
    label: 'All tasks in a list completed',
    description: 'Fires once every task in a specific list becomes checked off.',
    icon: 'checklist',
    paramsSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', label: 'List', description: 'The list to watch.', isListId: true },
      },
    },
    providesTask: false,
    providesList: true,
    validate: (params) => (str(params.listId) ? null : 'listId is required'),
  },
  {
    id: 'task_created',
    label: 'Task created',
    description: 'Fires when a new task is added — in a specific list, or any list in this workspace.',
    icon: 'add_task',
    paramsSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', label: 'List', description: 'Only fire for this list. Leave empty to match any list in the workspace.', optional: true, isListId: true },
      },
    },
    providesTask: true,
    providesList: true,
    validate: (params) => {
      if (params.listId !== undefined && params.listId !== null && typeof params.listId !== 'string') return 'listId must be a string';
      return null;
    },
  },
  {
    id: 'schedule',
    label: 'Scheduled',
    description: 'Fires on a recurring daily or weekly schedule.',
    icon: 'schedule',
    paramsSchema: {
      type: 'object',
      properties: {
        freq: { type: 'string', label: 'Frequency', description: 'How often to run.', enum: ['daily', 'weekly'] },
        time: { type: 'string', label: 'Time', description: 'Time of day, 24h HH:MM.' },
        dayOfWeek: { type: 'number', label: 'Day of week', description: '0 (Sunday) – 6 (Saturday). Required for weekly.', optional: true },
      },
    },
    providesTask: false,
    providesList: false,
    validate: (params) => {
      const freq = params.freq;
      if (freq !== 'daily' && freq !== 'weekly') return 'freq must be "daily" or "weekly"';
      const time = params.time;
      if (typeof time !== 'string' || !TIME_RE.test(time)) return 'time must be HH:MM (24h)';
      if (freq === 'weekly') {
        const dow = params.dayOfWeek;
        if (typeof dow !== 'number' || dow < 0 || dow > 6 || !Number.isInteger(dow)) return 'dayOfWeek must be an integer 0-6 for weekly schedules';
      }
      return null;
    },
  },
];

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const ACTION_REGISTRY: ActionDef[] = [
  {
    id: 'delete_task',
    label: 'Delete task',
    description: 'Deletes the task that triggered this automation.',
    icon: 'delete',
    paramsSchema: { type: 'object', properties: {} },
    requiresTriggerTask: true,
    validate: () => null,
    execute: async (ctx) => {
      if (!ctx.trigger.task) return fail('No task in trigger context');
      const deleted = await deleteTaskRow(ctx.exec, ctx.trigger.task.listId, ctx.trigger.task.id);
      return deleted ? ok(`Deleted task "${ctx.trigger.task.title}"`) : fail('Task not found (already deleted?)');
    },
  },
  {
    id: 'archive_list',
    label: 'Archive list',
    description: 'Archives the list that triggered this automation (hides it from the normal workspace view; recoverable anytime from Archived).',
    icon: 'archive',
    paramsSchema: { type: 'object', properties: {} },
    requiresTriggerList: true,
    validate: () => null,
    execute: async (ctx) => {
      if (!ctx.trigger.list) return fail('No list in trigger context');
      const updated = await setListArchived(ctx.exec, ctx.trigger.list.id, true);
      return updated ? ok(`Archived list "${ctx.trigger.list.name}"`) : fail('List not found');
    },
  },
  {
    id: 'move_task',
    label: 'Move task',
    description: 'Moves the task that triggered this automation to a different list (and optionally section).',
    icon: 'drive_file_move',
    paramsSchema: {
      type: 'object',
      properties: {
        targetListId: { type: 'string', label: 'Target list', description: 'List to move the task into.', isListId: true },
        targetSectionId: { type: 'string', label: 'Target section', description: 'Section within the target list. Defaults to its first section.', optional: true },
      },
    },
    requiresTriggerTask: true,
    validate: (params) => (str(params.targetListId) ? null : 'targetListId is required'),
    execute: async (ctx, params) => {
      if (!ctx.trigger.task) return fail('No task in trigger context');
      const targetListId = str(params.targetListId);
      if (!targetListId) return fail('targetListId is required');
      const wsError = await assertListInWorkspace(ctx.exec, targetListId, ctx.workspaceId);
      if (wsError) return fail(wsError);
      const section = await resolveTargetSection(ctx.exec, targetListId, str(params.targetSectionId));
      if (typeof section !== 'string') return fail(section.error);

      const posRes = await ctx.exec('SELECT MAX(position) AS max FROM tasks WHERE section_id = $1', [section]);
      const maxPos = (posRes.rows[0] as { max: string | null }).max;
      const nextPos = maxPos !== null ? parseInt(maxPos, 10) + 1 : 0;
      await ctx.exec(
        `UPDATE tasks SET list_id = $1, section_id = $2, workspace_id = $3, position = $4 WHERE id = $5`,
        [targetListId, section, ctx.workspaceId, nextPos, ctx.trigger.task.id]
      );
      return ok(`Moved task "${ctx.trigger.task.title}" to list ${targetListId}`);
    },
  },
  {
    id: 'create_task',
    label: 'Create task',
    description: 'Creates a new task in a target list.',
    icon: 'playlist_add',
    paramsSchema: {
      type: 'object',
      properties: {
        targetListId: { type: 'string', label: 'Target list', description: 'List to create the task in.', isListId: true },
        targetSectionId: { type: 'string', label: 'Target section', description: 'Section within the target list. Defaults to its first section.', optional: true },
        title: { type: 'string', label: 'Title', description: 'Title for the new task.' },
      },
    },
    validate: (params) => {
      if (!str(params.targetListId)) return 'targetListId is required';
      if (!str(params.title)) return 'title is required';
      return null;
    },
    execute: async (ctx, params) => {
      const targetListId = str(params.targetListId);
      const title = str(params.title);
      if (!targetListId || !title) return fail('targetListId and title are required');
      const wsError = await assertListInWorkspace(ctx.exec, targetListId, ctx.workspaceId);
      if (wsError) return fail(wsError);
      const section = await resolveTargetSection(ctx.exec, targetListId, str(params.targetSectionId));
      if (typeof section !== 'string') return fail(section.error);

      const created = await createListTask(ctx.exec, targetListId, section, ctx.automationOwnerId, { title }, ctx.actor);
      if (!created) return fail('Failed to create task');
      return ok(`Created task "${title}"`);
    },
  },
  {
    id: 'create_list',
    label: 'Create list',
    description: 'Creates a new (empty) list in this workspace.',
    icon: 'playlist_add_circle',
    paramsSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', label: 'Name', description: 'Name for the new list.' },
        targetFolderId: { type: 'string', label: 'Folder', description: 'Folder to create it in. Leave empty for no folder.', optional: true, isFolderId: true },
      },
    },
    validate: (params) => (str(params.name) ? null : 'name is required'),
    execute: async (ctx, params) => {
      const name = str(params.name);
      if (!name) return fail('name is required');
      const targetFolderId = str(params.targetFolderId);
      if (targetFolderId) {
        const err = await assertFolderInWorkspace(ctx.exec, targetFolderId, ctx.workspaceId);
        if (err) return fail(err);
      }
      const listId = `list_${uuidv4()}`;
      const posRes = await ctx.exec('SELECT MAX(position) AS max FROM lists WHERE user_id = $1', [ctx.automationOwnerId]);
      const maxPos = (posRes.rows[0] as { max: string | null }).max;
      const nextPos = maxPos !== null ? parseInt(maxPos, 10) + 1 : 0;
      await ctx.exec(
        `INSERT INTO lists (id, user_id, name, folder_id, position, workspace_id) VALUES ($1, $2, $3, $4, $5, $6)`,
        [listId, ctx.automationOwnerId, name, targetFolderId ?? null, nextPos, ctx.workspaceId]
      );
      return ok(`Created list "${name}"`);
    },
  },
  {
    id: 'create_folder',
    label: 'Create folder',
    description: 'Creates a new (empty) folder in this workspace.',
    icon: 'create_new_folder',
    paramsSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', label: 'Name', description: 'Name for the new folder.' },
      },
    },
    validate: (params) => (str(params.name) ? null : 'name is required'),
    execute: async (ctx, params) => {
      const name = str(params.name);
      if (!name) return fail('name is required');
      const folderId = `folder_${uuidv4()}`;
      const posRes = await ctx.exec('SELECT MAX(position) AS max FROM folders WHERE user_id = $1', [ctx.automationOwnerId]);
      const maxPos = (posRes.rows[0] as { max: string | null }).max;
      const nextPos = maxPos !== null ? parseInt(maxPos, 10) + 1 : 0;
      await ctx.exec(
        `INSERT INTO folders (id, user_id, name, position, workspace_id) VALUES ($1, $2, $3, $4, $5)`,
        [folderId, ctx.automationOwnerId, name, nextPos, ctx.workspaceId]
      );
      return ok(`Created folder "${name}"`);
    },
  },
  {
    id: 'move_list',
    label: 'Move list to folder',
    description: 'Moves the list that triggered this automation into a different folder (within this workspace).',
    icon: 'drive_file_move',
    paramsSchema: {
      type: 'object',
      properties: {
        targetFolderId: { type: 'string', label: 'Folder', description: 'Folder to move the list into. Leave empty to remove it from any folder.', optional: true, isFolderId: true },
      },
    },
    requiresTriggerList: true,
    validate: () => null,
    execute: async (ctx, params) => {
      if (!ctx.trigger.list) return fail('No list in trigger context');
      const targetFolderId = str(params.targetFolderId);
      if (targetFolderId) {
        const err = await assertFolderInWorkspace(ctx.exec, targetFolderId, ctx.workspaceId);
        if (err) return fail(err);
      }
      const result = await ctx.exec('UPDATE lists SET folder_id = $1 WHERE id = $2', [targetFolderId ?? null, ctx.trigger.list.id]);
      if ((result.rowCount ?? 0) === 0) return fail('List no longer exists');
      return ok(`Moved list "${ctx.trigger.list.name}"${targetFolderId ? ' to a folder' : ' out of its folder'}`);
    },
  },
  {
    id: 'move_list_to_workspace',
    label: 'Move list to workspace',
    description: "Moves the list that triggered this automation (with its sublists) into a different workspace this automation's creator has access to.",
    icon: 'move_up',
    paramsSchema: {
      type: 'object',
      properties: {
        targetWorkspaceId: { type: 'string', label: 'Workspace', description: 'Workspace to move the list into.', isWorkspaceId: true },
      },
    },
    requiresTriggerList: true,
    validate: (params) => (str(params.targetWorkspaceId) ? null : 'targetWorkspaceId is required'),
    execute: async (ctx, params) => {
      if (!ctx.trigger.list) return fail('No list in trigger context');
      const targetWorkspaceId = str(params.targetWorkspaceId);
      if (!targetWorkspaceId) return fail('targetWorkspaceId is required');
      if (targetWorkspaceId === ctx.workspaceId) return fail('Target workspace is the same as the current workspace');
      const canAccess = await userCanAccessWorkspace(ctx.automationOwnerId, targetWorkspaceId);
      if (!canAccess) return fail("This automation's creator no longer has access to the target workspace");

      const existing = await ctx.exec('SELECT id FROM lists WHERE id = $1', [ctx.trigger.list.id]);
      if (existing.rows.length === 0) return fail('List no longer exists');

      // Known V1 limitation: unlike the interactive move (PUT /api/lists/:id/workspace),
      // this doesn't run the public/private visibility-hierarchy conflict resolution —
      // that's an interactive, user-facing safety dialog, and automations run headless.
      const descendantIds = await collectDescendantListIds(ctx.exec, ctx.trigger.list.id);
      const allListIds = [ctx.trigger.list.id, ...descendantIds];
      await ctx.exec(`UPDATE lists SET workspace_id = $1, folder_id = NULL WHERE id = ANY($2::varchar[])`, [targetWorkspaceId, allListIds]);
      await ctx.exec(`UPDATE tasks SET workspace_id = $1 WHERE list_id = ANY($2::varchar[])`, [targetWorkspaceId, allListIds]);
      return ok(`Moved list "${ctx.trigger.list.name}" to another workspace`);
    },
  },
  {
    id: 'delete_list',
    label: 'Delete list',
    description: 'Deletes the list that triggered this automation (soft-deleted to Trash, recoverable for 30 days).',
    icon: 'delete_sweep',
    paramsSchema: { type: 'object', properties: {} },
    requiresTriggerList: true,
    validate: () => null,
    execute: async (ctx) => {
      if (!ctx.trigger.list) return fail('No list in trigger context');
      const existing = await ctx.exec('SELECT id FROM lists WHERE id = $1', [ctx.trigger.list.id]);
      if (existing.rows.length === 0) return fail('List no longer exists');
      const removedCount = await softDeleteListTreeExec(ctx.exec, ctx.trigger.list.id);
      return ok(`Deleted list "${ctx.trigger.list.name}"${removedCount > 0 ? ` (+${removedCount} sublist(s))` : ''}`);
    },
  },
  {
    id: 'delete_folder',
    label: 'Delete folder',
    description: 'Deletes a folder (soft-deleted to Trash). Lists inside it are kept, just un-foldered.',
    icon: 'folder_delete',
    paramsSchema: {
      type: 'object',
      properties: {
        targetFolderId: { type: 'string', label: 'Folder', description: 'Folder to delete.', isFolderId: true },
      },
    },
    validate: (params) => (str(params.targetFolderId) ? null : 'targetFolderId is required'),
    execute: async (ctx, params) => {
      const targetFolderId = str(params.targetFolderId);
      if (!targetFolderId) return fail('targetFolderId is required');
      const err = await assertFolderInWorkspace(ctx.exec, targetFolderId, ctx.workspaceId);
      if (err) return fail(err);
      const deleted = await softDeleteFolderExec(ctx.exec, targetFolderId);
      return deleted ? ok('Deleted folder') : fail('Folder not found');
    },
  },
  {
    id: 'rename_task',
    label: 'Rename task',
    description: 'Renames the task that triggered this automation.',
    icon: 'edit',
    paramsSchema: {
      type: 'object',
      properties: {
        newTitle: { type: 'string', label: 'New title', description: 'New title for the task.' },
      },
    },
    requiresTriggerTask: true,
    validate: (params) => (str(params.newTitle) ? null : 'newTitle is required'),
    execute: async (ctx, params) => {
      if (!ctx.trigger.task) return fail('No task in trigger context');
      const newTitle = str(params.newTitle);
      if (!newTitle) return fail('newTitle is required');
      const result = await ctx.exec('UPDATE tasks SET title = $1 WHERE id = $2', [newTitle, ctx.trigger.task.id]);
      if ((result.rowCount ?? 0) === 0) return fail('Task no longer exists');
      return ok(`Renamed task to "${newTitle}"`);
    },
  },
  {
    id: 'rename_list',
    label: 'Rename list',
    description: 'Renames the list that triggered this automation.',
    icon: 'edit',
    paramsSchema: {
      type: 'object',
      properties: {
        newName: { type: 'string', label: 'New name', description: 'New name for the list.' },
      },
    },
    requiresTriggerList: true,
    validate: (params) => (str(params.newName) ? null : 'newName is required'),
    execute: async (ctx, params) => {
      if (!ctx.trigger.list) return fail('No list in trigger context');
      const newName = str(params.newName);
      if (!newName) return fail('newName is required');
      const result = await ctx.exec('UPDATE lists SET name = $1 WHERE id = $2', [newName, ctx.trigger.list.id]);
      if ((result.rowCount ?? 0) === 0) return fail('List no longer exists');
      return ok(`Renamed list to "${newName}"`);
    },
  },
  {
    id: 'rename_folder',
    label: 'Rename folder',
    description: 'Renames a folder.',
    icon: 'edit',
    paramsSchema: {
      type: 'object',
      properties: {
        targetFolderId: { type: 'string', label: 'Folder', description: 'Folder to rename.', isFolderId: true },
        newName: { type: 'string', label: 'New name', description: 'New name for the folder.' },
      },
    },
    validate: (params) => {
      if (!str(params.targetFolderId)) return 'targetFolderId is required';
      if (!str(params.newName)) return 'newName is required';
      return null;
    },
    execute: async (ctx, params) => {
      const targetFolderId = str(params.targetFolderId);
      const newName = str(params.newName);
      if (!targetFolderId || !newName) return fail('targetFolderId and newName are required');
      const err = await assertFolderInWorkspace(ctx.exec, targetFolderId, ctx.workspaceId);
      if (err) return fail(err);
      const result = await ctx.exec('UPDATE folders SET name = $1 WHERE id = $2', [newName, targetFolderId]);
      if ((result.rowCount ?? 0) === 0) return fail('Folder not found');
      return ok(`Renamed folder to "${newName}"`);
    },
  },
];

export function getTriggerDef(id: string): TriggerDef | undefined {
  return TRIGGER_REGISTRY.find((t) => t.id === id);
}
export function getActionDef(id: string): ActionDef | undefined {
  return ACTION_REGISTRY.find((a) => a.id === id);
}

/** UI-safe projection for GET /api/automations/node-types — no execute/validate functions. */
export function getAutomationNodeTypeDefs() {
  return {
    triggers: TRIGGER_REGISTRY.map(({ id, label, description, icon, paramsSchema, providesTask, providesList }) => ({
      id, label, description, icon, paramsSchema, providesTask, providesList,
    })),
    actions: ACTION_REGISTRY.map(({ id, label, description, icon, paramsSchema, requiresTriggerTask, requiresTriggerList }) => ({
      id, label, description, icon, paramsSchema, requiresTriggerTask: !!requiresTriggerTask, requiresTriggerList: !!requiresTriggerList,
    })),
  };
}
