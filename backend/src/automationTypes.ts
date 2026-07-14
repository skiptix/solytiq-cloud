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
import { QueryExec } from './workspaceUtil';
import type { MutationActor } from './automationEngine';
import { createListTask, deleteTaskRow, setListArchived } from './routes/lists';

export interface AutomationParamProperty {
  type: 'string' | 'number' | 'boolean';
  label: string;
  description: string;
  optional?: boolean;
  /** UI hint: render a list picker instead of a free-text field. */
  isListId?: boolean;
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
    id: 'notify',
    label: 'Notify me',
    description: "Sends an in-app notification to this automation's creator.",
    icon: 'notifications',
    paramsSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', label: 'Message', description: 'Notification text.' },
      },
    },
    validate: (params) => {
      const message = str(params.message);
      if (!message) return 'message is required';
      if (message.length > 500) return 'message must be 500 characters or fewer';
      return null;
    },
    execute: async (ctx, params) => {
      const message = str(params.message) ?? 'Automation ran';
      const id = `anotif_${uuidv4()}`;
      await ctx.exec(
        `INSERT INTO automation_notifications (id, user_id, automation_id, run_id, message) VALUES ($1, $2, $3, $4, $5)`,
        [id, ctx.automationOwnerId, ctx.automationId, ctx.runId, message]
      );
      return ok('Notification sent');
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
