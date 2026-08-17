import type { Task, List, Folder, Timeline, Milestone, Meeting, MeetingRecurrenceRule, UpcomingMilestone, TrashedTask, TrashedFolder, SharedFile, TaskAttachment, MilestoneAttachment, Workspace, WorkspaceMember, AIFile, GpsFile, GpsTrackData, GpsTrackPoint, GpsRouteStateV1, GapMode, NamedPinInput, OverpassPoi, Template, TemplateListNode, TemplateTimelineNode, Automation, AutomationOwnerEntityType, AutomationGraph, AutomationRun, AutomationRunResult, TriggerTypeDef, ActionTypeDef, MarkdownList, MarkdownListContent, TaskChangeLogEntry, EntityLink, ResolvedLink, LinkTypeDef, GraphPayload, GraphCanvas, GraphCanvasLayout, AgentRun, AgentProposal, AgentPolicy, AgentMode, EntityIndexEntry, KnowledgeBase, KnowledgeEntry, KnowledgeSuggestion, KnowledgeLookupResult, AiSkill, AiSkillFile, AiSkillHint, AiMemoryEntry, QuickAddSuggestion } from '../types';

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

function getToken(): string | null {
  return localStorage.getItem('solytiq_token');
}

let _onUnauthorized: (() => void) | undefined;
/** Register a callback invoked on any 401 response (expired/revoked JWT). */
export function setUnauthorizedHandler(fn: () => void): void { _onUnauthorized = fn; }

let _onMutationSettled: (() => void) | undefined;
/** Register a callback invoked after any successful (non-GET) write. Used to
 *  schedule a short-delay delta-sync reconcile so optimistic local state (e.g.
 *  a version bump) is corrected shortly after every write, not just when a
 *  realtime frame happens to arrive. */
export function setMutationSettledHandler(fn: () => void): void { _onMutationSettled = fn; }

// Lightweight save-activity signal (drives the header status dot). Fires the
// request path (e.g. `/lists/abc`) so the consumer can scope which writes it
// cares about — every non-GET request start / success / failure is reported.
let _onSaveStart: ((path: string) => void) | undefined;
let _onSaveSuccess: ((path: string) => void) | undefined;
let _onSaveError: ((path: string) => void) | undefined;
export function setSaveActivityHandlers(h: {
  start: (path: string) => void; success: (path: string) => void; error: (path: string) => void;
}): void { _onSaveStart = h.start; _onSaveSuccess = h.success; _onSaveError = h.error; }

/** Error thrown for any non-2xx response. Carries the HTTP status and the
 *  parsed JSON body (when available) so callers can react to structured errors
 *  such as the visibility-hierarchy 409 conflict. */
export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

// In-flight GET coalescing: identical concurrent GETs share one network call, so
// a store loader and a screen mount that both request the same path only hit the
// backend once. Keyed on `path` (no cache-buster is appended, so the key is stable).
const inflight = new Map<string, Promise<unknown>>();

/**
 * Options for calls that must NOT disturb the ambient session.
 *
 * A 401 normally means "our own token died" and tears the session down. That is
 * exactly wrong for the two multi-account flows, where a 401 is an expected,
 * local outcome about *some other* credential:
 *  - signing a SECOND account in while already signed in (a wrong password
 *    would otherwise sign the first account out), and
 *  - probing a stored account's token before switching to it (a stale stored
 *    token would otherwise kill the session you're currently using).
 * `authToken` overrides which credential is sent; `silent401` suppresses the
 * global unauthorized handler + signOut so the caller handles the failure.
 */
interface AmbientAuthOpts { authToken?: string | null; silent401?: boolean }

/** The raw request. Handles auth headers, a single 429 backoff+retry, and error
 *  normalisation. `apiFetch` wraps this to coalesce duplicate GETs. */
async function rawFetch<T>(path: string, options: RequestInit = {}, retried = false, auth: AmbientAuthOpts = {}): Promise<T> {
  const token = auth.authToken !== undefined ? auth.authToken : getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    ...(options.headers as Record<string, string> ?? {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const finalOptions: RequestInit = {
    ...options,
    headers,
  };
  const res = await fetch(`${BASE_URL}${path}`, finalOptions);

  // Transient rate-limit: a 429 is raised by the limiter middleware BEFORE the
  // route handler runs, so no side effect occurred — retrying once (even a
  // mutation) is safe. Back off by `Retry-After` (seconds) with jitter so a
  // burst of clients doesn't retry in lockstep, then surface latency instead of
  // a broken "Couldn't refresh your data" banner.
  if (res.status === 429 && !retried) {
    const ra = Number(res.headers.get('Retry-After'));
    const baseMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000;
    const waitMs = Math.min(baseMs * (0.5 + Math.random() * 0.5), 8000);
    await new Promise(r => setTimeout(r, waitMs));
    return rawFetch<T>(path, options, true, auth);
  }

  if (!res.ok) {
    if (res.status === 401 && !auth.silent401) _onUnauthorized?.();
    const text = await res.text().catch(() => res.statusText);
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : text; } catch { /* keep raw text */ }
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : (text || `HTTP ${res.status}`);

    if (res.status === 401 && !auth.silent401) {
      import('../store/useAuthStore').then(m => m.default.getState().signOut());
    }
    throw new ApiError(res.status, body, message);
  }
  const ct = res.headers.get('content-type');
  if (ct?.includes('application/json')) return res.json() as Promise<T>;
  return null as unknown as T;
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  // Only dedup idempotent GETs. Mutations always execute.
  if (method === 'GET') {
    const key = path;
    const existing = inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = rawFetch<T>(path, options).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }
  _onSaveStart?.(path);
  try {
    const result = await rawFetch<T>(path, options);
    _onMutationSettled?.();
    _onSaveSuccess?.(path);
    return result;
  } catch (e) {
    _onSaveError?.(path);
    throw e;
  }
}

// ── Visibility hierarchy conflict (Workspace → Folder → List/Timeline) ────────
export interface ConflictAncestor { type: 'workspace' | 'folder'; id: string; name: string; canPromote: boolean; }
export interface ConflictDescendant { type: 'folder' | 'list' | 'timeline'; id: string; name: string; }
export interface VisibilityConflict {
  error: 'visibility_conflict';
  direction: 'promote' | 'restrict';
  entityType: 'workspace' | 'folder' | 'list' | 'timeline';
  entityName: string;
  ancestors?: ConflictAncestor[];
  descendants?: ConflictDescendant[];
  canResolve: boolean;
  blockedReason?: string;
}

/** Returns the conflict payload if `err` is a visibility-hierarchy 409, else null. */
export function asVisibilityConflict(err: unknown): VisibilityConflict | null {
  if (
    err instanceof ApiError &&
    err.body && typeof err.body === 'object' &&
    (err.body as { error?: unknown }).error === 'visibility_conflict'
  ) {
    return err.body as VisibilityConflict;
  }
  return null;
}

// Auth
export const apiCheckSetupRequired = () =>
  apiFetch<{ required: boolean }>('/auth/setup-required');

export const apiRequestSetupToken = () =>
  apiFetch<{ ok: boolean }>('/auth/request-setup-token', { method: 'POST' });

export const apiRegister = (username: string, email: string, password: string, setupToken?: string) =>
  apiFetch<{ token: string; user: { id: string; username: string; email: string; fullName: string; token_version?: number; keyboardShortcuts?: Record<string, { key?: string; enabled?: boolean }>; lastRoute?: string | null } }>(
    '/auth/register', { method: 'POST', body: JSON.stringify({ username, email, password, setupToken }) }
  );

export const apiLogin = (username: string, password: string) =>
  apiFetch<{
    token?: string;
    user?: { id: string; username: string; email: string; fullName: string; isAdmin?: boolean; profileImage?: string | null; totpEnabled?: boolean; keyboardShortcuts?: Record<string, { key?: string; enabled?: boolean }>; lastRoute?: string | null };
    requires2FA?: boolean;
    pendingToken?: string;
  }>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });

// Both /2fa/setup and /2fa/disable now require a fresh `currentPassword`
// step-up (S3) — a valid-but-stolen session token alone is no longer enough
// to overwrite or remove a user's second factor.
export const api2FASetup = (currentPassword: string) =>
  apiFetch<{ secret: string; qrCode: string }>('/auth/2fa/setup', { method: 'POST', body: JSON.stringify({ currentPassword }) });

export const api2FAEnable = (code: string) =>
  apiFetch<{ success: boolean }>('/auth/2fa/enable', { method: 'POST', body: JSON.stringify({ code }) });

export const api2FADisable = (code: string, currentPassword: string) =>
  apiFetch<{ success: boolean }>('/auth/2fa/disable', { method: 'POST', body: JSON.stringify({ code, currentPassword }) });

export const api2FAVerify = (pendingToken: string, code: string) =>
  apiFetch<{ token: string; user: { id: string; username: string; email: string; fullName: string; isAdmin?: boolean; profileImage?: string | null; totpEnabled?: boolean; keyboardShortcuts?: Record<string, { key?: string; enabled?: boolean }>; lastRoute?: string | null } }>(
    '/auth/2fa/verify', { method: 'POST', body: JSON.stringify({ pendingToken, code }) }
  );

export const apiGetMe = () =>
  apiFetch<{ user: { id: string; username: string; email: string; fullName: string } }>('/auth/me');

// ── Multi-account (see CLAUDE.md "Account Switching") ───────────────────────
// These three deliberately bypass `apiFetch`: they must not fire the global
// 401 → signOut path (a 401 here is about a *different* credential, not the
// active session), and the verify probe must not be coalesced with an ambient
// `/auth/me` GET, which is keyed by path alone and would return the wrong
// user's row.

type SessionUserPayload = {
  id: string; username: string; email: string; fullName: string;
  isAdmin?: boolean; profileImage?: string | null; totpEnabled?: boolean;
  keyboardShortcuts?: Record<string, { key?: string; enabled?: boolean }>;
  lastRoute?: string | null;
};

/** Sign in an ADDITIONAL account while one is already active. Same endpoint and
 *  same credential requirements as the normal login — there is no privileged
 *  "switch to user X" path anywhere in the API. */
export const apiLoginAdditional = (username: string, password: string) =>
  rawFetch<{
    token?: string;
    user?: SessionUserPayload;
    requires2FA?: boolean;
    pendingToken?: string;
  }>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }, false,
    { authToken: null, silent401: true });

/** Complete 2FA for an additional account without touching the active session. */
export const api2FAVerifyAdditional = (pendingToken: string, code: string) =>
  rawFetch<{ token: string; user: SessionUserPayload }>(
    '/auth/2fa/verify', { method: 'POST', body: JSON.stringify({ pendingToken, code }) }, false,
    { authToken: null, silent401: true }
  );

/** Re-validate a stored account token server-side and return who it actually
 *  belongs to. The switcher trusts THIS response for identity — never the
 *  locally cached label — so tampering with the stored vault cannot
 *  impersonate anyone. Throws ApiError(401) for an expired/revoked token. */
export const apiVerifySessionToken = (token: string) =>
  rawFetch<{ user: SessionUserPayload }>('/auth/me', {}, false, { authToken: token, silent401: true });

export const apiGetMembers = () =>
  apiFetch<{ members: Array<{ id: string; username: string; email: string; fullName: string | null; profileImage: string | null; isAdmin: boolean }> }>('/auth/members');

// Lightweight members list (no base64 avatars) for the members store. Avatars are
// fetched on demand via apiGetMemberAvatar for members actually shown on screen.
export const apiGetMembersBasic = () =>
  apiFetch<{ members: Array<{ id: string; username: string; email: string; fullName: string | null; hasImage: boolean; isAdmin: boolean }> }>('/auth/members/basic');

export const apiGetMemberAvatar = (id: string) =>
  apiFetch<{ profileImage: string | null }>(`/auth/members/${id}/avatar`);

export const apiChangePassword = (currentPassword: string, newPassword: string) =>
  apiFetch<{ success: boolean }>('/auth/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) });

export const apiGetFeatureFlags = () =>
  apiFetch<{ twoFAEnabled: boolean; mcpEnabled: boolean; mobileEnabled: boolean; installedApps: string[] }>('/auth/feature-flags');

// ── Apps (Settings → System → Discover Apps) ──────────────────────────────
export interface AppCatalogEntry {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  accentColor: string;
  installed: boolean;
}

export const apiGetAppsCatalog = () =>
  apiFetch<{ apps: AppCatalogEntry[] }>('/apps');

export const apiInstallApp = (appId: string) =>
  apiFetch<{ ok: boolean }>(`/apps/${appId}/install`, { method: 'POST' });

export const apiUninstallApp = (appId: string) =>
  apiFetch<{ ok: boolean }>(`/apps/${appId}/uninstall`, { method: 'POST' });

// ── Mobile app device connections ───────────────────────────────────────────
export interface MobileConnection {
  id: string;
  deviceName: string;
  deviceModel: string | null;
  osVersion: string | null;
  appVersion: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export const apiGetMobileConnections = () =>
  apiFetch<{ connections: MobileConnection[] }>('/auth/mobile-connections');

export const apiDeleteMobileConnection = (id: string) =>
  apiFetch<{ success: boolean }>(`/auth/mobile-connections/${id}`, { method: 'DELETE' });

// ── iOS Home Screen ("Add to Home Screen") app connections ─────────────────
export interface HomescreenConnection {
  id: string;
  deviceName: string;
  osVersion: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export const apiPingHomescreenConnection = (installId: string, device: { deviceName?: string; osVersion?: string | null }) =>
  apiFetch<{ ok: boolean }>('/auth/homescreen-connections/ping', { method: 'POST', body: JSON.stringify({ installId, device }) });

export const apiGetHomescreenConnections = () =>
  apiFetch<{ connections: HomescreenConnection[] }>('/auth/homescreen-connections');

export const apiDeleteHomescreenConnection = (id: string) =>
  apiFetch<{ success: boolean }>(`/auth/homescreen-connections/${id}`, { method: 'DELETE' });

export const apiAdminPasswordResetRequest = () =>
  apiFetch<{ ok: boolean }>('/auth/admin-password-reset/request', { method: 'POST' });

export const apiAdminPasswordResetConfirm = (code: string, newPassword: string) =>
  apiFetch<{ ok: boolean }>('/auth/admin-password-reset/confirm', { method: 'POST', body: JSON.stringify({ code, newPassword }) });

export const apiUpdateProfile = (data: { fullName?: string; email?: string }) =>
  apiFetch<{ user: { id: string; username: string; email: string; fullName: string } }>(
    '/auth/profile', { method: 'PUT', body: JSON.stringify(data) }
  );

export const apiUpdateShortcuts = (shortcuts: Record<string, { key?: string; enabled?: boolean }>) =>
  apiFetch<{ user: { id: string; username: string; email: string; fullName: string; keyboardShortcuts?: Record<string, { key?: string; enabled?: boolean }> } }>(
    '/auth/shortcuts', { method: 'PUT', body: JSON.stringify({ shortcuts }) }
  );

export const apiUpdateLastRoute = (route: string) =>
  apiFetch<{ ok: boolean }>('/auth/last-route', { method: 'PUT', body: JSON.stringify({ route }) });

export const apiUploadProfileImage = (imageData: string | null) =>
  apiFetch<{ user: { id: string; username: string; email: string; fullName: string; profileImage: string | null } }>(
    '/auth/profile-image', { method: 'PUT', body: JSON.stringify({ imageData }) }
  );

// Dashboard Tasks
export const apiGetTasks = (workspaceId?: string) =>
  apiFetch<{ tasks: Task[] }>(`/tasks${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`);

export const apiCreateTask = (data: Partial<Task> & { title: string; workspaceId?: string }) =>
  apiFetch<{ task: Task }>('/tasks', { method: 'POST', body: JSON.stringify(data) });

export const apiUpdateTask = (id: number, data: Partial<Task>) =>
  apiFetch<{ task: Task }>(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) });

export const apiDeleteTask = (id: number) =>
  apiFetch<{ success: boolean }>(`/tasks/${id}`, { method: 'DELETE' });

/** Move a task to another list (or to the Dashboard when targetListId is
 *  omitted/null), including across workspaces. Preserves the task's id,
 *  attachments and any linked sublist. */
export const apiMoveTask = (id: number, targetListId?: string | null, targetSectionId?: string) =>
  apiFetch<{ task: Task }>(`/tasks/${id}/move`, { method: 'PUT', body: JSON.stringify({ targetListId, targetSectionId }) });

// Lists
export const apiGetLists = (workspaceId?: string) =>
  apiFetch<{ lists: List[] }>(`/lists${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`);

export const apiCreateList = (data: Omit<List, 'sections'> & { sections?: List['sections']; workspaceId?: string }) =>
  apiFetch<{ list: List }>('/lists', { method: 'POST', body: JSON.stringify(data) });

export const apiUpdateList = (id: string, data: Partial<List> & { cascade?: boolean; expectedVersion?: number }) =>
  apiFetch<{ list: List }>(`/lists/${id}`, { method: 'PUT', body: JSON.stringify(data) });

export const apiMoveListWorkspace = (id: string, workspaceId: string, cascade?: boolean) =>
  apiFetch<{ list: List }>(`/lists/${id}/workspace`, { method: 'PUT', body: JSON.stringify({ workspaceId, cascade }) });

export const apiDeleteList = (id: string) =>
  apiFetch<{ success: boolean }>(`/lists/${id}`, { method: 'DELETE' });

// Archived lists (set by the Automation Hub's archive_list action, or
// unarchived manually) — hidden from the normal workspace view.
export const apiGetArchivedLists = (workspaceId?: string) =>
  apiFetch<{ lists: List[] }>(`/lists?archived=true${workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : ''}`);

export const apiUnarchiveList = (id: string) =>
  apiFetch<{ list: List }>(`/lists/${id}/unarchive`, { method: 'PUT' });

// Public link sharing
export interface ShareUpdate {
  enabled?: boolean;
  password?: string | null;   // omit = unchanged, null = clear, value = set
  expiresAt?: string | null;  // omit = unchanged, null = clear, value = set
  subpages?: boolean;         // lists only
  viewMode?: 'list' | 'kanban' | 'timeline';   // lists only — which layout the public page renders
  includeAll?: boolean;       // folders only — share every item vs only already-shared
}
export interface ShareInfo {
  enabled: boolean;
  token: string | null;
  hasPassword: boolean;
  expiresAt: string | null;
  subpages?: boolean;
  viewMode?: 'list' | 'kanban' | 'timeline' | null;
  includeAll?: boolean;       // folders only
}

export const apiUpdateListShare = (id: string, data: ShareUpdate) =>
  apiFetch<{ share: ShareInfo }>(`/lists/${id}/share`, { method: 'PUT', body: JSON.stringify(data) });

export const apiUpdateFolderShare = (id: string, data: ShareUpdate) =>
  apiFetch<{ share: ShareInfo }>(`/folders/${id}/share`, { method: 'PUT', body: JSON.stringify(data) });

export const apiUpdateMarkdownListShare = (id: string, data: ShareUpdate) =>
  apiFetch<{ share: ShareInfo }>(`/markdown-lists/${id}/share`, { method: 'PUT', body: JSON.stringify(data) });

export const apiCreateSection = (listId: string, data: { id?: string; label: string; emoji?: string }) =>
  apiFetch<{ section: { id: string; label: string; emoji?: string; tasks: Task[] } }>(
    `/lists/${listId}/sections`, { method: 'POST', body: JSON.stringify(data) }
  );

export const apiUpdateSection = (sectionId: string, data: { label?: string; emoji?: string }) =>
  apiFetch<{ section: { id: string; label: string; emoji?: string } }>(
    `/lists/sections/${sectionId}`, { method: 'PUT', body: JSON.stringify(data) }
  );

export const apiDeleteSection = (sectionId: string) =>
  apiFetch<{ success: boolean }>(`/lists/sections/${sectionId}`, { method: 'DELETE' });

export const apiReorderListSections = (listId: string, sectionIds: string[]) =>
  apiFetch<{ success: boolean }>(`/lists/${listId}/sections/reorder`, { method: 'PUT', body: JSON.stringify({ section_ids: sectionIds }) });

export const apiReorderSectionTasks = (listId: string, sectionId: string, taskIds: number[]) =>
  apiFetch<{ success: boolean }>(`/lists/${listId}/sections/${sectionId}/tasks/reorder`, { method: 'PUT', body: JSON.stringify({ task_ids: taskIds }) });

export const apiAddListTask = (listId: string, sectionId: string, data: Partial<Task> & { title: string; workspaceId?: string }) =>
  apiFetch<{ task: Task }>(`/lists/${listId}/sections/${sectionId}/tasks`, { method: 'POST', body: JSON.stringify(data) });

export const apiCreateSublistTask = (
  parentListId: string,
  sectionId: string,
  taskTitle: string,
  sublistName: string,
  depth: number,
  workspaceId?: string
) =>
  apiFetch<{ task: Task; list: List }>(`/lists/${parentListId}/sections/${sectionId}/tasks/sublist`, {
    method: 'POST',
    body: JSON.stringify({ title: taskTitle, sublistName, depth, workspaceId }),
  });

export const apiLinkListAsTask = (
  parentListId: string,
  sectionId: string,
  taskTitle: string,
  linkedListId: string,
  workspaceId?: string
) =>
  apiFetch<{ task: Task }>(`/lists/${parentListId}/sections/${sectionId}/tasks/link`, {
    method: 'POST',
    body: JSON.stringify({ title: taskTitle, linkedListId, workspaceId }),
  });

export const apiGetListProgress = (listId: string) =>
  apiFetch<{ total: number; completed: number; percent: number }>(`/lists/${listId}/progress`);

export const apiGetListChangelog = (listId: string) =>
  apiFetch<{ entries: TaskChangeLogEntry[] }>(`/lists/${listId}/changelog`);

export const apiGetTaskChangelog = (listId: string, taskId: number) =>
  apiFetch<{ entries: TaskChangeLogEntry[] }>(`/lists/${listId}/tasks/${taskId}/changelog`);

export const apiUpdateListTask = (listId: string, taskId: number, data: Partial<Task>) =>
  apiFetch<{ task: Task }>(`/lists/${listId}/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(data) });

export const apiDeleteListTask = (listId: string, taskId: number) =>
  apiFetch<{ success: boolean }>(`/lists/${listId}/tasks/${taskId}`, { method: 'DELETE' });

// Quick Add — the staging tray + section prediction (see backend/src/quickAdd/).
// `lexicalOnly` skips the embedding provider round trip: the while-typing hint
// re-predicts on a debounce and must stay local, where the post-add suggestion
// runs once and can afford the semantic channel.
export const apiQuickAddPredict = (listId: string, title: string, lexicalOnly = false) =>
  apiFetch<{ suggestions: QuickAddSuggestion[] }>(`/lists/${listId}/quick-add/predict`, {
    method: 'POST',
    body: JSON.stringify({ title, lexicalOnly }),
  });

export const apiQuickAddItem = (listId: string, data: { title: string; note?: string; deadline?: string; priority?: string; badge?: string }) =>
  apiFetch<{ task: Task; suggestions: QuickAddSuggestion[] }>(`/lists/${listId}/quick-add/items`, {
    method: 'POST',
    body: JSON.stringify(data),
  });

/** Move an item back OUT of every section, into the Quick Add staging tray. */
export const apiStageListTask = (listId: string, taskId: number) =>
  apiFetch<{ task: Task }>(`/lists/${listId}/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify({ stage: true }) });

export const apiGetQuickAddMemory = (listId: string) =>
  apiFetch<{ remembered: number; events: number; lastLearnedAt: string | null; entryId: string | null }>(
    `/lists/${listId}/quick-add/memory`
  );

// Timelines
export const apiGetTimelines = (workspaceId?: string) =>
  apiFetch<{ timelines: Timeline[] }>(`/timelines${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`);

export const apiGetUpcomingMilestones = (opts?: { workspaceId?: string; folderId?: string; limit?: number }) => {
  const p = new URLSearchParams();
  if (opts?.workspaceId) p.set('workspaceId', opts.workspaceId);
  if (opts?.folderId) p.set('folderId', opts.folderId);
  if (opts?.limit) p.set('limit', String(opts.limit));
  const qs = p.toString();
  return apiFetch<{ milestones: UpcomingMilestone[] }>(`/timelines/upcoming${qs ? `?${qs}` : ''}`);
};

export const apiCreateTimeline = (data: Omit<Timeline, 'milestones'> & { milestones?: Timeline['milestones']; workspaceId?: string }) =>
  apiFetch<{ timeline: Timeline }>('/timelines', { method: 'POST', body: JSON.stringify(data) });

export const apiReorderTimelines = (ids: string[]) =>
  apiFetch<{ success: boolean }>('/timelines/reorder', { method: 'PUT', body: JSON.stringify({ ids }) });

export const apiUpdateTimeline = (id: string, data: Partial<Timeline> & { cascade?: boolean; expectedVersion?: number }) =>
  apiFetch<{ timeline: Timeline }>(`/timelines/${id}`, { method: 'PUT', body: JSON.stringify(data) });

export const apiMoveTimelineWorkspace = (id: string, workspaceId: string, cascade?: boolean) =>
  apiFetch<{ timeline: Timeline }>(`/timelines/${id}/workspace`, { method: 'PUT', body: JSON.stringify({ workspaceId, cascade }) });

export const apiDeleteTimeline = (id: string) =>
  apiFetch<{ success: boolean }>(`/timelines/${id}`, { method: 'DELETE' });

export const apiUpdateTimelineShare = (id: string, data: ShareUpdate) =>
  apiFetch<{ share: ShareInfo }>(`/timelines/${id}/share`, { method: 'PUT', body: JSON.stringify(data) });

export const apiCreateMilestone = (timelineId: string, data: Partial<Milestone> & { title: string }) =>
  apiFetch<{ milestone: Milestone }>(`/timelines/${timelineId}/milestones`, { method: 'POST', body: JSON.stringify(data) });

export const apiUpdateMilestone = (milestoneId: string, data: Partial<Milestone> & { timelineId?: string }) =>
  apiFetch<{ milestone: Milestone }>(`/timelines/milestones/${milestoneId}`, { method: 'PUT', body: JSON.stringify(data) });

export const apiDeleteMilestone = (milestoneId: string) =>
  apiFetch<{ success: boolean }>(`/timelines/milestones/${milestoneId}`, { method: 'DELETE' });

export const apiReorderMilestones = (timelineId: string, milestoneIds: string[]) =>
  apiFetch<{ success: boolean }>(`/timelines/${timelineId}/milestones/reorder`, { method: 'PUT', body: JSON.stringify({ milestone_ids: milestoneIds }) });

export const apiGetTrashTimelines = () =>
  apiFetch<{ trash: Array<{ id: number; timelineId: string; timelineData: Timeline; deletedAt: string; expiresAt: string }> }>('/trash/timelines');

export const apiRestoreTimelineFromTrash = (trashId: number) =>
  apiFetch<{ success: boolean }>(`/trash/timelines/${trashId}/restore`, { method: 'POST' });

export const apiDeleteTimelineFromTrash = (trashId: number) =>
  apiFetch<{ success: boolean }>(`/trash/timelines/${trashId}`, { method: 'DELETE' });

export const apiGetTrashMilestones = () =>
  apiFetch<{ trash: Array<{ id: number; milestoneId: string; timelineId: string; milestoneData: Milestone; deletedAt: string; expiresAt: string }> }>('/trash/milestones');

export const apiRestoreMilestoneFromTrash = (trashId: number) =>
  apiFetch<{ success: boolean }>(`/trash/milestones/${trashId}/restore`, { method: 'POST' });

export const apiDeleteMilestoneFromTrash = (trashId: number) =>
  apiFetch<{ success: boolean }>(`/trash/milestones/${trashId}`, { method: 'DELETE' });

// Calendar meetings (standalone events, user-scoped, no workspace)
export const apiGetMeetings = (opts?: { from?: string; to?: string }) => {
  const p = new URLSearchParams();
  if (opts?.from) p.set('from', opts.from);
  if (opts?.to) p.set('to', opts.to);
  const qs = p.toString();
  return apiFetch<{ meetings: Meeting[] }>(`/meetings${qs ? `?${qs}` : ''}`);
};

export const apiCreateMeeting = (data: Omit<Meeting, 'id' | 'createdAt' | 'updatedAt' | 'recurrenceId' | 'organizerId' | 'isOwner' | 'attendeeIds'> & { id?: string; repeat?: MeetingRecurrenceRule; inviteeIds?: string[] }) =>
  apiFetch<{ meeting: Meeting; meetings: Meeting[] }>('/meetings', { method: 'POST', body: JSON.stringify(data) });

export const apiUpdateMeeting = (id: string, data: Partial<Meeting> & { inviteeIds?: string[] }) =>
  apiFetch<{ meeting: Meeting }>(`/meetings/${id}`, { method: 'PUT', body: JSON.stringify(data) });

export const apiDeleteMeeting = (id: string, opts?: { series?: boolean }) =>
  apiFetch<{ success: boolean; deletedCount: number }>(`/meetings/${id}${opts?.series ? '?series=1' : ''}`, { method: 'DELETE' });

export const apiLeaveMeeting = (id: string) =>
  apiFetch<{ success: boolean }>(`/meetings/${id}/leave`, { method: 'POST' });

// CalDAV connection (Apple Calendar / Thunderbird / … sync)
export interface CaldavStatus {
  connected: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
  username: string;
  serverUrl: string;
}
export const apiGetCaldavStatus = () => apiFetch<CaldavStatus>('/caldav');
export const apiGenerateCaldavPassword = () =>
  apiFetch<{ password: string; username: string; serverUrl: string }>('/caldav/password', { method: 'POST' });
export const apiRevokeCaldav = () =>
  apiFetch<{ success: boolean }>('/caldav', { method: 'DELETE' });

// Folders
export const apiGetFolders = (workspaceId?: string) =>
  apiFetch<{ folders: Folder[] }>(`/folders${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`);

export const apiCreateFolder = (data: { id: string; name: string; emoji?: string; color?: string; isPublic?: boolean; workspaceId?: string }) =>
  apiFetch<{ folder: Folder }>('/folders', { method: 'POST', body: JSON.stringify(data) });

export const apiUpdateFolder = (id: string, data: Partial<Omit<Folder, 'id'>> & { cascade?: boolean }) =>
  apiFetch<{ ok: boolean; folder?: Folder }>(`/folders/${id}`, { method: 'PUT', body: JSON.stringify(data) });

export const apiMoveFolderWorkspace = (id: string, workspaceId: string, cascade?: boolean) =>
  apiFetch<{ ok: boolean; folder: Folder }>(`/folders/${id}/workspace`, { method: 'PUT', body: JSON.stringify({ workspaceId, cascade }) });

export const apiDeleteFolder = (id: string) =>
  apiFetch<{ ok: boolean }>(`/folders/${id}`, { method: 'DELETE' });

// Trash
// The backend serializes each trashed task with `taskData` (not `task`) and
// includes `expiresAt`/`userId` — reflect that real shape here so the mapping
// in useAppStore.loadFromApi reads the right field. (A stale `TrashedTask[]`
// annotation used to hide a `tr.task.id` deref that threw whenever the trash
// was non-empty, surfacing the "Couldn't refresh your data." banner.)
export const apiGetTrash = () =>
  apiFetch<{ trash: Array<{ id: number; taskId: string; userId: string; taskData: Task; meta: TrashedTask['meta'] | null; deletedAt: string; expiresAt: string }> }>('/trash');

export const apiAddToTrash = (taskId: number, taskData: Task, meta: { src: string; listId?: string; listName?: string }) =>
  apiFetch<{ trash: TrashedTask }>('/trash/add', { method: 'POST', body: JSON.stringify({ taskId, taskData, meta }) });

export const apiRestoreFromTrash = (trashId: number) =>
  apiFetch<{ success: boolean }>(`/trash/${trashId}/restore`, { method: 'POST' });

export const apiDeleteFromTrash = (trashId: number) =>
  apiFetch<{ success: boolean }>(`/trash/${trashId}`, { method: 'DELETE' });

export const apiEmptyTrash = () =>
  apiFetch<{ success: boolean }>('/trash/empty', { method: 'DELETE' });

export const apiGetTrashLists = () =>
  apiFetch<{ trash: Array<{ id: number; listId: string; listData: List; deletedAt: string; expiresAt: string }> }>('/trash/lists');

export const apiRestoreListFromTrash = (trashId: number) =>
  apiFetch<{ success: boolean }>(`/trash/lists/${trashId}/restore`, { method: 'POST' });

export const apiDeleteListFromTrash = (trashId: number) =>
  apiFetch<{ success: boolean }>(`/trash/lists/${trashId}`, { method: 'DELETE' });

export const apiGetTrashFolders = () =>
  apiFetch<{ trash: Array<{ id: number; folderId: string; folderData: TrashedFolder['folder']; deletedAt: string; expiresAt: string }> }>('/trash/folders');

export const apiRestoreFolderFromTrash = (trashId: number) =>
  apiFetch<{ success: boolean }>(`/trash/folders/${trashId}/restore`, { method: 'POST' });

export const apiDeleteFolderFromTrash = (trashId: number) =>
  apiFetch<{ success: boolean }>(`/trash/folders/${trashId}`, { method: 'DELETE' });

// Admin

/** Admin API permission scopes — must match ADMIN_API_SCOPES on the backend. */
export type AdminApiScope = 'read' | 'users' | 'workspaces' | 'folders' | 'lists' | 'timelines' | 'meetings';

export interface AdminReadApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: AdminApiScope[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export const apiGetAdminReadApiKeys = () =>
  apiFetch<{ keys: AdminReadApiKey[] }>('/admin/api-keys');

export const apiCreateAdminReadApiKey = (name: string, scopes: AdminApiScope[]) =>
  apiFetch<{ key: AdminReadApiKey; secret: string }>('/admin/api-keys', { method: 'POST', body: JSON.stringify({ name, scopes }) });

export const apiRevokeAdminReadApiKey = (id: string) =>
  apiFetch<{ success: boolean }>(`/admin/api-keys/${id}`, { method: 'DELETE' });

export const apiGetUsers = () =>
  apiFetch<{ users: Array<{ id: string; username: string; email: string; fullName: string | null; profileImage: string | null; isAdmin: boolean; lastOnline: string | null; createdAt: string }> }>('/admin/users');

export const apiCreateUser = (data: { username: string; password: string; email?: string; fullName?: string }) =>
  apiFetch<{ user: { id: string; username: string; email: string; fullName: string | null; profileImage: string | null; isAdmin: boolean; lastOnline: string | null; createdAt: string } }>(
    '/admin/users', { method: 'POST', body: JSON.stringify(data) }
  );

export const apiUpdateUser = (id: string, data: { username?: string; password?: string }) =>
  apiFetch<{ user: { id: string; username: string; email: string; fullName: string | null; profileImage: string | null; isAdmin: boolean; lastOnline: string | null; createdAt: string } }>(
    `/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(data) }
  );

export const apiDeleteUser = (id: string) =>
  apiFetch<{ success: boolean }>(`/admin/users/${id}`, { method: 'DELETE' });

export const apiNuke = (password: string) =>
  apiFetch<{ success: boolean }>('/admin/nuke', { method: 'DELETE', body: JSON.stringify({ password }) });

export const apiGetSystemStorage = () =>
  apiFetch<{ total: number; used: number; available: number }>('/admin/system/storage');

export const apiGetAppSettings = () =>
  apiFetch<{ settings: Record<string, string> }>('/admin/settings');

export interface AIUsageDay {
  date: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AIUsageModel {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestCount: number;
}

export interface AIUsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestCount: number;
}

export const apiGetAIUsage = () =>
  apiFetch<{ daily: AIUsageDay[]; byModel: AIUsageModel[]; totals: AIUsageTotals }>('/admin/ai/usage');

export const apiUpdateAppSettings = (data: { storageQuotaPerUser?: number }) =>
  apiFetch<{ settings: Record<string, string> }>('/admin/settings', { method: 'PUT', body: JSON.stringify(data) });

// Files
export const apiGetFiles = () =>
  apiFetch<{ files: SharedFile[] }>('/files');

export const apiGetStorageUsage = () =>
  apiFetch<{ used: number; quota: number | null; isAdmin: boolean }>('/files/storage');

export const apiUpdateFile = (id: string, data: { name?: string; title?: string | null; note?: string | null; isPublic?: boolean; password?: string | null; expiresAt?: string | null }) =>
  apiFetch<{ file: SharedFile }>(`/files/${id}`, { method: 'PUT', body: JSON.stringify(data) });

export const apiDeleteFile = (id: string) =>
  apiFetch<{ success: boolean }>(`/files/${id}`, { method: 'DELETE' });

export const apiPreviewFile = async (id: string): Promise<string> => {
  const token = (await import('../store/useAuthStore')).default.getState().token;
  const res = await fetch(`/api/files/${id}/preview`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('Preview unavailable');
  const blob = await res.blob();
  return URL.createObjectURL(blob);
};

// Task Attachments
export const apiGetTaskAttachments = (taskId: number) =>
  apiFetch<{ attachments: TaskAttachment[] }>(`/tasks/${taskId}/attachments`);

export const apiLinkTaskAttachment = (taskId: number, sharedFileId: string) =>
  apiFetch<{ attachment: TaskAttachment }>(`/tasks/${taskId}/attachments/link`, {
    method: 'POST', body: JSON.stringify({ sharedFileId }),
  });

export const apiDeleteTaskAttachment = (taskId: number, attachmentId: string) =>
  apiFetch<{ success: boolean }>(`/tasks/${taskId}/attachments/${attachmentId}`, { method: 'DELETE' });

export function apiUploadTaskAttachment(
  taskId: number,
  file: File,
  onProgress: (pct: number) => void,
): Promise<TaskAttachment> {
  return new Promise((resolve, reject) => {
    const token = localStorage.getItem('solytiq_token');
    const form = new FormData();
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${(import.meta.env.VITE_API_URL as string | undefined) ?? '/api'}/tasks/${taskId}/attachments`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((JSON.parse(xhr.responseText) as { attachment: TaskAttachment }).attachment);
      } else {
        reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(form);
  });
}

export async function apiDownloadTaskAttachment(taskId: number, attachmentId: string, filename: string): Promise<void> {
  const token = localStorage.getItem('solytiq_token');
  const res = await fetch(`${(import.meta.env.VITE_API_URL as string | undefined) ?? '/api'}/tasks/${taskId}/attachments/${attachmentId}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Fetch an attachment as a Blob for in-app preview (image/pdf/video/audio/text).
// The backend serves non-allowlisted types as `application/octet-stream`, so we
// re-tag the blob with the attachment's known mime type — the bytes are
// identical; only the label the browser renders by changes.
async function fetchAttachmentBlob(url: string, mimeType: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.blob();
  return mimeType && raw.type !== mimeType ? raw.slice(0, raw.size, mimeType) : raw;
}

export const apiTaskAttachmentBlob = (taskId: number, attachmentId: string, mimeType: string) =>
  fetchAttachmentBlob(`${BASE_URL}/tasks/${taskId}/attachments/${attachmentId}/download`, mimeType);

export const apiMilestoneAttachmentBlob = (milestoneId: string, attachmentId: string, mimeType: string) =>
  fetchAttachmentBlob(`${BASE_URL}/timelines/milestones/${milestoneId}/attachments/${attachmentId}/download`, mimeType);

// Milestone attachments — mirrors task attachments (mounted under /timelines/milestones/:id/attachments)
export const apiGetMilestoneAttachments = (milestoneId: string) =>
  apiFetch<{ attachments: MilestoneAttachment[] }>(`/timelines/milestones/${milestoneId}/attachments`);

export const apiLinkMilestoneAttachment = (milestoneId: string, sharedFileId: string) =>
  apiFetch<{ attachment: MilestoneAttachment }>(`/timelines/milestones/${milestoneId}/attachments/link`, {
    method: 'POST', body: JSON.stringify({ sharedFileId }),
  });

export const apiDeleteMilestoneAttachment = (milestoneId: string, attachmentId: string) =>
  apiFetch<{ success: boolean }>(`/timelines/milestones/${milestoneId}/attachments/${attachmentId}`, { method: 'DELETE' });

export function apiUploadMilestoneAttachment(
  milestoneId: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<MilestoneAttachment> {
  return new Promise((resolve, reject) => {
    const token = localStorage.getItem('solytiq_token');
    const form = new FormData();
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${(import.meta.env.VITE_API_URL as string | undefined) ?? '/api'}/timelines/milestones/${milestoneId}/attachments`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((JSON.parse(xhr.responseText) as { attachment: MilestoneAttachment }).attachment);
      } else {
        reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(form);
  });
}

export async function apiDownloadMilestoneAttachment(milestoneId: string, attachmentId: string, filename: string): Promise<void> {
  const token = localStorage.getItem('solytiq_token');
  const res = await fetch(`${(import.meta.env.VITE_API_URL as string | undefined) ?? '/api'}/timelines/milestones/${milestoneId}/attachments/${attachmentId}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// AI Assistant
export const apiGetAISettings = () =>
  apiFetch<{ enabled: boolean; model: string }>('/ai/settings');

export const apiAIChat = (messages: unknown[], tools?: unknown[], sessionId?: string | null) =>
  apiFetch<{
    choices: Array<{
      message: {
        role: string;
        content: string | null;
        tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
      };
    }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }>('/ai/chat', { method: 'POST', body: JSON.stringify({ messages, tools, sessionId }) });

// Shared AI tool registry (single source of truth with the MCP server).
export interface AiToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export const apiGetAiToolDefs = () =>
  apiFetch<{ tools: AiToolDef[] }>('/ai/tools');

export const apiExecuteAiTool = (name: string, args: Record<string, unknown>) =>
  apiFetch<{ ok: boolean; result: string; summary?: string }>('/ai/execute', {
    method: 'POST',
    body: JSON.stringify({ name, arguments: args }),
  });

export const apiSaveAIMessage = (role: string, content: string, sessionId?: string | null, metadata?: Record<string, unknown>) =>
  apiFetch<{ id: number; createdAt: string }>('/ai/history', {
    method: 'POST',
    body: JSON.stringify({ role, content, sessionId, metadata }),
  });

export const apiClearAIHistory = () =>
  apiFetch<{ success: boolean }>('/ai/history', { method: 'DELETE' });

// AI Chat Sessions
export const apiCreateAISession = () =>
  apiFetch<{ session: { id: string; created_at: string; expires_at: string } }>('/ai/sessions', {
    method: 'POST',
    body: JSON.stringify({}),
  });

export const apiGetAISessions = () =>
  apiFetch<{ sessions: Array<{ id: string; title: string | null; created_at: string }> }>('/ai/sessions');

export const apiGetAISessionMessages = (sessionId: string) =>
  apiFetch<{ messages: Array<{ id: number; role: string; content: string; toolCalls: unknown; metadata: unknown; createdAt: string }> }>(`/ai/sessions/${sessionId}`);

export const apiDeleteAISession = (sessionId: string) =>
  apiFetch<{ success: boolean }>(`/ai/sessions/${sessionId}`, { method: 'DELETE' });

// ── AI access tokens (Personal Access Tokens for external MCP agents) ────────
export interface ApiAccessToken {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export const apiGetApiTokens = () =>
  apiFetch<{ tokens: ApiAccessToken[] }>('/tokens');

export const apiDeleteApiToken = (id: string) =>
  apiFetch<{ success: boolean }>(`/tokens/${id}`, { method: 'DELETE' });

// ── Claude MCP OAuth consent ────────────────────────────────────────────────
export interface OAuthApproveParams {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state?: string;
  scope?: string;
  resource?: string;
}

export const apiOAuthApprove = (params: OAuthApproveParams) =>
  apiFetch<{ redirectUrl: string }>('/oauth/approve', {
    method: 'POST',
    body: JSON.stringify(params),
  });

export interface OAuthClientInfo {
  clientName: string;
  redirectHost: string;
  /** Server-computed — true only when redirectHost is on the operator's
   *  trusted-host allowlist. Never trust the client's own claimed name. */
  trusted: boolean;
}

export const apiOAuthClientInfo = (clientId: string, redirectUri: string) =>
  apiFetch<OAuthClientInfo>(`/oauth/client-info?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}`);

// AI File Attachments
export function apiUploadAIFile(
  file: File,
  sessionId: string | null,
  onProgress: (pct: number) => void,
): Promise<AIFile> {
  return new Promise((resolve, reject) => {
    const token = localStorage.getItem('solytiq_token');
    const form = new FormData();
    form.append('file', file);
    if (sessionId) form.append('sessionId', sessionId);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${(import.meta.env.VITE_API_URL as string | undefined) ?? '/api'}/ai/files`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((JSON.parse(xhr.responseText) as { file: AIFile }).file);
      } else {
        reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(form);
  });
}

export const apiDeleteAIFile = (id: string) =>
  apiFetch<{ success: boolean }>(`/ai/files/${id}`, { method: 'DELETE' });

// ── AI Skills (Settings → AI Skills) ────────────────────────────────────────
// Admin-curated, instance-wide context bundles that personalize/extend Sol.
// See types.ts for the shared shapes.

/** The lightweight index any signed-in user can read — feeds Sol's system
 *  prompt via progressive disclosure. See useAiSkillsStore.ts. */
export const apiGetEnabledAiSkills = () =>
  apiFetch<{ skills: AiSkillHint[] }>('/ai/skills');

export const apiListAiSkills = () =>
  apiFetch<{ skills: AiSkill[] }>('/admin/ai-skills');

export const apiGetAiSkill = (id: string) =>
  apiFetch<{ skill: AiSkill; files: AiSkillFile[] }>(`/admin/ai-skills/${id}`);

export const apiCreateAiSkill = (data: { name: string; description?: string; content: string }) =>
  apiFetch<{ skill: AiSkill }>('/admin/ai-skills', { method: 'POST', body: JSON.stringify(data) });

export const apiUpdateAiSkill = (id: string, data: { name?: string; description?: string; content?: string; enabled?: boolean }) =>
  apiFetch<{ skill: AiSkill }>(`/admin/ai-skills/${id}`, { method: 'PUT', body: JSON.stringify(data) });

export const apiSetAiSkillEnabled = (id: string, enabled: boolean) =>
  apiUpdateAiSkill(id, { enabled });

export const apiDeleteAiSkill = (id: string) =>
  apiFetch<{ success: boolean }>(`/admin/ai-skills/${id}`, { method: 'DELETE' });

/** Create a new skill from an uploaded SKILL.md file or a .zip bundle. */
export function apiUploadAiSkill(
  file: File,
  overrides: { name?: string; description?: string },
  onProgress: (pct: number) => void,
): Promise<{ skill: AiSkill; skippedFiles: number }> {
  return new Promise((resolve, reject) => {
    const token = localStorage.getItem('solytiq_token');
    const form = new FormData();
    form.append('file', file);
    if (overrides.name) form.append('name', overrides.name);
    if (overrides.description) form.append('description', overrides.description);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${(import.meta.env.VITE_API_URL as string | undefined) ?? '/api'}/admin/ai-skills/upload`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText) as { skill: AiSkill; skippedFiles: number });
      } else {
        let message = `HTTP ${xhr.status}`;
        try { message = (JSON.parse(xhr.responseText) as { error?: string }).error ?? message; } catch { /* keep default */ }
        reject(new Error(message));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(form);
  });
}

/** Replace an existing skill's content + bundled files from a re-uploaded SKILL.md or .zip. */
export function apiReplaceAiSkillBundle(
  id: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<{ skill: AiSkill; files: AiSkillFile[]; skippedFiles: number }> {
  return new Promise((resolve, reject) => {
    const token = localStorage.getItem('solytiq_token');
    const form = new FormData();
    form.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${(import.meta.env.VITE_API_URL as string | undefined) ?? '/api'}/admin/ai-skills/${id}/upload`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText) as { skill: AiSkill; files: AiSkillFile[]; skippedFiles: number });
      } else {
        let message = `HTTP ${xhr.status}`;
        try { message = (JSON.parse(xhr.responseText) as { error?: string }).error ?? message; } catch { /* keep default */ }
        reject(new Error(message));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(form);
  });
}

// ── Sol's long-term memory (Account Settings → Preferences) ────────────────
// Small, durable per-user facts that ride in every chat's system prompt. See
// types.ts's AiMemoryEntry and useAiMemoryStore.ts.

export const apiGetMemory = () =>
  apiFetch<{ memory: AiMemoryEntry[] }>('/ai/memory');

export const apiDeleteMemoryEntry = (id: string) =>
  apiFetch<{ success: boolean }>(`/ai/memory/${id}`, { method: 'DELETE' });

export const apiClearMemory = () =>
  apiFetch<{ success: boolean; cleared: number }>('/ai/memory', { method: 'DELETE' });

export const apiUpdateAppSettingsAI = (data: { aiAssistantEnabled?: boolean; aiModel?: string }) =>
  apiFetch<{ settings: Record<string, string> }>('/admin/settings', {
    method: 'PUT',
    body: JSON.stringify(data),
  });

export const apiUpdateFeatureFlags = (data: { twoFAFeatureEnabled?: boolean }) =>
  apiFetch<{ settings: Record<string, string> }>('/admin/settings', {
    method: 'PUT',
    body: JSON.stringify(data),
  });

export const apiUpdateAppSettingsMcp = (mcpEnabled: boolean) =>
  apiFetch<{ settings: Record<string, string> }>('/admin/settings', {
    method: 'PUT',
    body: JSON.stringify({ mcpEnabled }),
  });

export const apiUpdateAppSettingsMobile = (mobileAppEnabled: boolean) =>
  apiFetch<{ settings: Record<string, string> }>('/admin/settings', {
    method: 'PUT',
    body: JSON.stringify({ mobileAppEnabled }),
  });

export const apiUpdateAppSettingsKnowledge = (data: {
  knowledgeSearchEnabled?: boolean; embeddingBaseUrl?: string; embeddingModel?: string; embeddingMonthlyTokenBudget?: number;
}) =>
  apiFetch<{ settings: Record<string, string> }>('/admin/settings', {
    method: 'PUT',
    body: JSON.stringify(data),
  });

// Workspaces
export const apiGetWorkspaces = () =>
  apiFetch<{ workspaces: Workspace[] }>('/workspaces');

export const apiCreateWorkspace = (data: { name: string; description?: string; emoji?: string; image?: string; visibility?: 'private' | 'public' }) =>
  apiFetch<{ workspace: Workspace }>('/workspaces', { method: 'POST', body: JSON.stringify(data) });

export const apiUpdateWorkspace = (id: string, data: Partial<Pick<Workspace, 'name' | 'description' | 'emoji' | 'image' | 'visibility'>> & { cascade?: boolean }) =>
  apiFetch<{ workspace: Workspace }>(`/workspaces/${id}`, { method: 'PUT', body: JSON.stringify(data) });

export const apiDeleteWorkspace = (id: string) =>
  apiFetch<{ ok: boolean }>(`/workspaces/${id}`, { method: 'DELETE' });

export const apiGetWorkspaceMembers = (id: string) =>
  apiFetch<{ members: WorkspaceMember[] }>(`/workspaces/${id}/members`);

export const apiAddWorkspaceMember = (id: string, username: string) =>
  apiFetch<{ member: WorkspaceMember }>(`/workspaces/${id}/members`, { method: 'POST', body: JSON.stringify({ username }) });

export const apiRemoveWorkspaceMember = (id: string, userId: string) =>
  apiFetch<{ ok: boolean }>(`/workspaces/${id}/members/${userId}`, { method: 'DELETE' });

// ─── Notifications ─────────────────────────────────────────────────────────────
export interface NotificationActor {
  id: string;
  username: string | null;
  fullName: string | null;
  hasImage: boolean;
}
export interface AppNotification {
  id: string;
  type: 'workspace_added' | 'item_invite' | 'meeting_invite' | 'item_tagged' | 'mention' | 'automation_run' | 'deadline_overdue' | string;
  actorId: string | null;
  actor: NotificationActor | null;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  workspaceId: string | null;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

export const apiGetNotifications = (opts?: { limit?: number; before?: string }) => {
  const p = new URLSearchParams();
  if (opts?.limit) p.set('limit', String(opts.limit));
  if (opts?.before) p.set('before', opts.before);
  const qs = p.toString();
  return apiFetch<{ notifications: AppNotification[]; unreadCount: number; hasMore: boolean }>(`/notifications${qs ? `?${qs}` : ''}`);
};
export const apiGetNotificationUnreadCount = () =>
  apiFetch<{ unreadCount: number }>('/notifications/unread-count');
export const apiMarkNotificationRead = (id: string) =>
  apiFetch<{ ok: boolean }>(`/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
export const apiMarkAllNotificationsRead = () =>
  apiFetch<{ ok: boolean }>('/notifications/read-all', { method: 'POST' });
export const apiDismissNotification = (id: string) =>
  apiFetch<{ ok: boolean }>(`/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const apiClearNotifications = () =>
  apiFetch<{ ok: boolean }>('/notifications', { method: 'DELETE' });

// ─── Task tags (users tagged onto an item) ─────────────────────────────────────
export interface TaskTag {
  userId: string;
  username: string;
  fullName: string | null;
  hasImage: boolean;
  taggedBy: string | null;
  createdAt: string;
}
export const apiGetTaskTags = (taskId: number | string) =>
  apiFetch<{ tags: TaskTag[] }>(`/tasks/${taskId}/tags`);
export const apiAddTaskTag = (taskId: number | string, userId: string) =>
  apiFetch<{ tags: TaskTag[] }>(`/tasks/${taskId}/tags`, { method: 'POST', body: JSON.stringify({ userId }) });
export const apiRemoveTaskTag = (taskId: number | string, userId: string) =>
  apiFetch<{ tags: TaskTag[] }>(`/tasks/${taskId}/tags/${encodeURIComponent(userId)}`, { method: 'DELETE' });

// ─── Per-item invitations ("Shared with me") ───────────────────────────────────
// Inviting someone to a FOLDER hands them everything inside it — see the
// cascade documented in backend/src/itemShares.ts.
export type SharedItemType = 'list' | 'timeline' | 'markdownList' | 'folder';
export interface ItemMember {
  userId: string;
  username: string;
  fullName: string | null;
  hasImage: boolean;
  invitedBy: string | null;
  createdAt: string;
  /** `direct` = invited to this exact item (removable here); `inherited` = it
   *  came from a container (the folder it sits in, an ancestor board, or the
   *  markdown page it mirrors), and is only revocable on that container. */
  via: 'direct' | 'inherited';
  /** For `via: 'inherited'`, the container that granted access. */
  viaName?: string;
  viaType?: SharedItemType;
}
export const apiGetItemMembers = (type: SharedItemType, itemId: string) =>
  apiFetch<{ ownerId: string; members: ItemMember[] }>(`/item-shares/${type}/${encodeURIComponent(itemId)}/members`);
export const apiAddItemMember = (type: SharedItemType, itemId: string, username: string) =>
  apiFetch<{ members: ItemMember[] }>(`/item-shares/${type}/${encodeURIComponent(itemId)}/members`, { method: 'POST', body: JSON.stringify({ username }) });
export const apiRemoveItemMember = (type: SharedItemType, itemId: string, userId: string) =>
  apiFetch<{ members: ItemMember[] }>(`/item-shares/${type}/${encodeURIComponent(itemId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' });
export const apiGetSharedWithMe = () =>
  apiFetch<{ folders: Folder[]; lists: List[]; timelines: Timeline[]; markdownLists: MarkdownList[] }>('/shared-with-me');

// ─── Delta-sync engine ────────────────────────────────────────────────────────
export interface BootstrapResponse {
  cursor: number;
  workspaceId: string | null;
  tasks: Task[];
  lists: List[];
  folders: Folder[];
  timelines: Timeline[];
}
export interface DeltaChange { entity: string; entityId: string; op: 'upsert' | 'delete'; payload?: unknown; }
export interface DeltaResponse { cursor: number; changes: DeltaChange[]; reset: boolean; }

export const apiSyncBootstrap = (workspaceId?: string) =>
  apiFetch<BootstrapResponse>(`/sync/bootstrap${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`);

export const apiSyncDelta = (since: number, workspaceId?: string) => {
  const p = new URLSearchParams({ since: String(since) });
  if (workspaceId) p.set('workspaceId', workspaceId);
  return apiFetch<DeltaResponse>(`/sync/delta?${p.toString()}`);
};

// A realtime frame is EITHER a cursor-tagged sync frame from the dispatcher, or
// a legacy `{ type }` channel nudge (still emitted by existing handlers). Both
// are just nudges — the receiver pulls the authoritative delta.
export interface SseFrame {
  cursor?: number;
  entities?: Array<{ entity: string; entityId: string; op: 'upsert' | 'delete' }>;
  workspaceId?: string | null;
  type?: string;
}

// SSE — real-time sync
let sseSource: EventSource | null = null;
let sseReconnectDelay = 2000;
const SSE_RECONNECT_MAX = 30000;

// A connect-in-flight guard so overlapping calls (e.g. a rapid reconnect
// while the previous ticket mint is still pending) can't open two streams.
let sseConnecting = false;

/**
 * Open the SSE stream. `onFrame` fires for every realtime frame; `onOpen` fires
 * on each successful (re)connection so the caller can pull deltas and catch up
 * on anything missed while disconnected. Reconnect uses exponential backoff with
 * jitter to avoid a thundering herd after a deploy.
 *
 * SECURITY (S4): the stream authenticates with a short-lived, single-use
 * ticket (assetTickets.ts) minted just-in-time from the caller's normal
 * session, rather than the long-lived session JWT itself riding in the URL.
 */
export function connectSSE(onFrame: (frame: SseFrame) => void, onOpen?: () => void): void {
  if (sseSource || sseConnecting) return;
  const token = getToken();
  if (!token) return;
  sseConnecting = true;
  void openSseWithTicket(onFrame, onOpen).finally(() => { sseConnecting = false; });
}

async function openSseWithTicket(onFrame: (frame: SseFrame) => void, onOpen?: () => void): Promise<void> {
  let ticket: string;
  try {
    ticket = (await mintAssetTicket('sse')).ticket;
  } catch {
    // Couldn't even mint a ticket (e.g. offline, or the session just expired)
    // — fall back to the same backoff-and-retry loop a stream error uses,
    // rather than silently never reconnecting.
    const delay = sseReconnectDelay * (0.5 + Math.random() * 0.5);
    sseReconnectDelay = Math.min(sseReconnectDelay * 2, SSE_RECONNECT_MAX);
    setTimeout(() => connectSSE(onFrame, onOpen), delay);
    return;
  }
  if (sseSource) return; // a concurrent call already won
  const url = `${BASE_URL}/events?ticket=${encodeURIComponent(ticket)}`;
  sseSource = new EventSource(url);
  sseSource.onopen = () => {
    sseReconnectDelay = 2000; // reset backoff on successful connection
    onOpen?.();
  };
  sseSource.addEventListener('sync', (e: MessageEvent) => {
    try {
      onFrame(JSON.parse(e.data) as SseFrame);
    } catch { /* ignore malformed */ }
  });
  // Emergency admin "Nuke Everything" signal — every connected tab of every
  // user drops its cache and bails out to /setup immediately, rather than
  // waiting for its next API call to 401. Handled here (not via `onFrame`) so
  // it fires identically regardless of which loader mode the caller is in.
  sseSource.addEventListener('nuke', () => {
    try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
    window.location.replace('/setup');
  });
  sseSource.onerror = () => {
    sseSource?.close();
    sseSource = null;
    // Exponential backoff with jitter (avoids a thundering herd of reconnects
    // all firing at once after a deploy/restart).
    const delay = sseReconnectDelay * (0.5 + Math.random() * 0.5);
    sseReconnectDelay = Math.min(sseReconnectDelay * 2, SSE_RECONNECT_MAX);
    setTimeout(() => connectSSE(onFrame, onOpen), delay);
  };
}

export function disconnectSSE(): void {
  sseSource?.close();
  sseSource = null;
  sseReconnectDelay = 2000;
}

// ─── Asset tickets (S4 — no long-lived JWTs in URLs) ───────────────────────
//
// SSE and inline `<img>` tags can't attach an Authorization header, so both
// used to carry the caller's full, long-lived session JWT as a `?token=`
// query param instead — a real secret in the URL (browser history, this
// app's own access logs). They now use short-lived, narrowly-scoped tickets
// minted from an already-authenticated POST (assetTickets.ts on the
// backend). Image tickets are scoped per-DOCUMENT (`mdimg:<listId>` /
// `kbimg:<entryId>`, not per-image) and cached here for a few minutes so a
// page with many images only needs ONE mint round trip, and every
// `markdownImageUrl`/`knowledgeEntryImageUrl` call stays synchronous by
// reading whatever is currently cached.
interface CachedTicket { ticket: string; expiresAt: number }
const ticketCache = new Map<string, CachedTicket>();
const TICKET_REFRESH_SKEW_MS = 15 * 1000; // remint slightly before the server-side expiry

async function mintAssetTicket(scope: string): Promise<CachedTicket> {
  const data = await apiFetch<{ ticket: string; expiresAt: number }>('/auth/asset-ticket', {
    method: 'POST',
    body: JSON.stringify({ scope }),
  });
  const cached: CachedTicket = { ticket: data.ticket, expiresAt: data.expiresAt };
  ticketCache.set(scope, cached);
  return cached;
}

/** Ensure a valid ticket for `scope` is cached, minting/refreshing one if
 *  needed. Call this BEFORE rendering anything that reads `cachedTicket()`
 *  synchronously (e.g. once when a markdown page / Knowledge Base entry
 *  finishes loading, alongside its own data fetch). */
export async function ensureAssetTicket(scope: string): Promise<void> {
  const existing = ticketCache.get(scope);
  if (existing && existing.expiresAt - TICKET_REFRESH_SKEW_MS > Date.now()) return;
  await mintAssetTicket(scope);
}

/** Synchronous read of whatever ticket is currently cached for `scope`, or
 *  null if none has been minted yet (caller should have awaited
 *  ensureAssetTicket first) or the cached one has expired. */
function cachedTicket(scope: string): string | null {
  const existing = ticketCache.get(scope);
  if (!existing || existing.expiresAt <= Date.now()) return null;
  return existing.ticket;
}

// ─── GPS API ─────────────────────────────────────────────────────────────────

export async function apiGetGpsFiles(): Promise<GpsFile[]> {
  const data = await apiFetch<{ files: GpsFile[] }>('/gps');
  return data.files;
}

export function apiUploadGpsFile(
  file: File,
  onProgress: (pct: number) => void,
): Promise<GpsFile> {
  return new Promise((resolve, reject) => {
    const token = getToken();
    const form = new FormData();
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE_URL}/gps/upload`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((JSON.parse(xhr.responseText) as { file: GpsFile }).file);
      } else {
        reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(form);
  });
}

export async function apiGetGpsTrackData(id: string): Promise<GpsTrackData> {
  return apiFetch<GpsTrackData>(`/gps/${id}/data`);
}

export async function apiSmoothGpsElevation(id: string, sigma: number): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${BASE_URL}/gps/${id}/smooth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ sigma }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

export async function apiCombineGpsFiles(ids: string[], name: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${BASE_URL}/gps/combine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ ids, name }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

export async function apiMergeGpsFilesDownload(ids: string[], name: string, gapMode: GapMode[]): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${BASE_URL}/gps/combine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ ids, name, gapMode, save: false }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

export async function apiMergeGpsFilesSave(ids: string[], name: string, gapMode: GapMode[]): Promise<GpsFile> {
  const token = getToken();
  const res = await fetch(`${BASE_URL}/gps/combine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ ids, name, gapMode, save: true }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as { file: GpsFile };
  return data.file;
}

export async function apiDownloadGpsFile(id: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${BASE_URL}/gps/${id}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

export async function apiDeleteGpsFile(id: string): Promise<void> {
  await apiFetch<void>(`/gps/${id}`, { method: 'DELETE' });
}

export async function apiCreateNewGpsRoute(name: string): Promise<GpsFile> {
  const data = await apiFetch<{ file: GpsFile }>('/gps/new', { method: 'POST', body: JSON.stringify({ name }) });
  return data.file;
}

export async function apiSmoothAndSaveGpsFile(id: string, sigma: number, mode: 'new' | 'replace', name?: string): Promise<GpsFile> {
  const token = getToken();
  const res = await fetch(`/api/gps/${encodeURIComponent(id)}/smooth-save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ sigma, mode, name }),
  });
  if (!res.ok) throw new Error(`GPS smooth-save failed: ${res.status}`);
  const data = await res.json() as { file: GpsFile };
  return data.file;
}

export async function apiSaveEditedGpsTrack(
  id: string,
  points: GpsTrackPoint[],
  options: {
    saveAs: 'new' | 'replace';
    name?: string;
    waypoints?: NamedPinInput[];
    routeState?: GpsRouteStateV1;
  },
): Promise<GpsFile> {
  const data = await apiFetch<{ file: GpsFile }>(`/gps/${id}/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      points,
      saveAs: options.saveAs,
      name: options.name,
      waypoints: options.waypoints ?? [],
      routeState: options.routeState,
    }),
  });
  return data.file;
}

export async function apiSaveGpsRouteState(id: string, routeState: GpsRouteStateV1): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/gps/${id}/route-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ routeState }),
  });
}

export interface GpsRouteLocation {
  id?: string;
  lat: number;
  lon: number;
  display_lat?: number;
  display_lon?: number;
  type?: 'break' | 'through' | 'via' | 'break_through';
  name?: string;
}

export const apiGpsRoute = (
  body: { locations: GpsRouteLocation[]; costing: string; costing_options?: Record<string, unknown> },
  signal?: AbortSignal,
) => apiFetch<unknown>('/gps/route', { method: 'POST', body: JSON.stringify(body), signal });

export const apiGetGpsPois = (
  body: { bbox: { south: number; west: number; north: number; east: number }; categories: string[]; zoom: number },
  signal?: AbortSignal,
) => apiFetch<{ pois: OverpassPoi[]; truncated: boolean; cached: boolean }>('/gps/pois', { method: 'POST', body: JSON.stringify(body), signal });

export async function apiRenameGpsFile(id: string, name: string): Promise<GpsFile> {
  const token = getToken();
  const res = await fetch(`/api/gps/${encodeURIComponent(id)}/rename`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`GPS rename failed: ${res.status}`);
  const data = await res.json() as { file: GpsFile };
  return data.file;
}

export function apiUploadFilesBundle(
  files: File[],
  opts: { isPublic?: boolean; password?: string; expiresAt?: string; title?: string },
  onProgress: (pct: number) => void,
): Promise<SharedFile> {
  return new Promise((resolve, reject) => {
    const token = localStorage.getItem('solytiq_token');
    const form = new FormData();
    files.forEach(file => form.append('files', file));
    if (opts.isPublic !== undefined) form.append('isPublic', String(opts.isPublic));
    if (opts.password) form.append('password', opts.password);
    if (opts.expiresAt) form.append('expiresAt', opts.expiresAt);
    if (opts.title) form.append('title', opts.title);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${(import.meta.env.VITE_API_URL as string | undefined) ?? '/api'}/files/bundle`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((JSON.parse(xhr.responseText) as { file: SharedFile }).file);
      } else {
        reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(form);
  });
}

export function apiUploadFile(
  file: File,
  opts: { isPublic?: boolean; password?: string; expiresAt?: string; title?: string },
  onProgress: (pct: number) => void,
): Promise<SharedFile> {
  return new Promise((resolve, reject) => {
    const token = localStorage.getItem('solytiq_token');
    const form  = new FormData();
    form.append('file', file);
    if (opts.isPublic !== undefined) form.append('isPublic', String(opts.isPublic));
    if (opts.password)  form.append('password',  opts.password);
    if (opts.expiresAt) form.append('expiresAt', opts.expiresAt);
    if (opts.title)     form.append('title',     opts.title);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${(import.meta.env.VITE_API_URL as string | undefined) ?? '/api'}/files`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((JSON.parse(xhr.responseText) as { file: SharedFile }).file);
      } else {
        reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(form);
  });
}

// ── Global Search ─────────────────────────────────────────────────────────

export interface GlobalSearchResult {
  type: 'task' | 'list' | 'timeline' | 'milestone' | 'meeting' | 'workspace';
  id: string;
  label: string;
  sub?: string;
  path: string;
  icon?: string;
}

export const apiGlobalSearch = (q: string, signal?: AbortSignal) =>
  apiFetch<{ results: GlobalSearchResult[] }>(`/search?q=${encodeURIComponent(q)}`, { signal });

// ── Templates ──────────────────────────────────────────────────────────────

export const apiGetTemplates = (type?: 'list' | 'timeline') =>
  apiFetch<{ templates: Template[] }>(`/templates${type ? `?type=${type}` : ''}`);

export const apiCreateTemplate = (data: { type: 'list' | 'timeline'; sourceId: string; name?: string; description?: string; isShared?: boolean }) =>
  apiFetch<{ template: Template }>('/templates', { method: 'POST', body: JSON.stringify(data) });

export const apiUpdateTemplate = (id: string, data: Partial<Pick<Template, 'name' | 'description' | 'emoji' | 'color' | 'colorBg' | 'isShared'>>) =>
  apiFetch<{ template: Template }>(`/templates/${id}`, { method: 'PUT', body: JSON.stringify(data) });

export const apiDeleteTemplate = (id: string) =>
  apiFetch<{ success: boolean }>(`/templates/${id}`, { method: 'DELETE' });

export const apiUseTemplate = (id: string, data: { name?: string; isPublic?: boolean; workspaceId?: string; folderId?: string }) =>
  apiFetch<{ list?: List; timeline?: Timeline }>(`/templates/${id}/use`, { method: 'POST', body: JSON.stringify(data) });

// Full structure (owner/admin only) — powers the structure editor.
export const apiGetTemplateStructure = (id: string) =>
  apiFetch<{ type: 'list' | 'timeline'; structure: TemplateListNode | TemplateTimelineNode }>(`/templates/${id}/structure`);

export const apiUpdateTemplateStructure = (id: string, structure: TemplateListNode | TemplateTimelineNode) =>
  apiFetch<{ template: Template }>(`/templates/${id}/structure`, { method: 'PUT', body: JSON.stringify({ structure }) });

// ── Automation Hub ───────────────────────────────────────────────────────────

export const apiGetAutomationNodeTypes = () =>
  apiFetch<{ triggers: TriggerTypeDef[]; actions: ActionTypeDef[] }>('/automations/node-types');

export const apiGetAutomations = (ownerEntityType: AutomationOwnerEntityType, ownerEntityId: string) =>
  apiFetch<{ automations: Automation[] }>(`/automations?ownerType=${encodeURIComponent(ownerEntityType)}&ownerId=${encodeURIComponent(ownerEntityId)}`);

export const apiGetAutomation = (id: string) =>
  apiFetch<{ automation: Automation }>(`/automations/${id}`);

export const apiCreateAutomation = (data: { ownerEntityType: AutomationOwnerEntityType; ownerEntityId: string; name: string; description?: string; graph: AutomationGraph }) =>
  apiFetch<{ automation: Automation }>('/automations', { method: 'POST', body: JSON.stringify(data) });

export const apiUpdateAutomation = (id: string, data: { name?: string; description?: string | null; graph?: AutomationGraph; expectedVersion?: number }) =>
  apiFetch<{ automation: Automation }>(`/automations/${id}`, { method: 'PUT', body: JSON.stringify(data) });

export const apiSetAutomationEnabled = (id: string, enabled: boolean) =>
  apiFetch<{ automation: Automation }>(`/automations/${id}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled }) });

export const apiDeleteAutomation = (id: string) =>
  apiFetch<{ success: boolean }>(`/automations/${id}`, { method: 'DELETE' });

export const apiGetAutomationRuns = (id: string, limit?: number) =>
  apiFetch<{ runs: AutomationRun[] }>(`/automations/${id}/runs${limit ? `?limit=${limit}` : ''}`);

/** Manually runs a saved automation's trigger (and, optionally, the action
 *  chain up to `nodeId`) for real against real, auto-picked data. Omit
 *  `nodeId` (or pass the trigger node's own id) to test just the trigger. */
export const apiTestAutomationNode = (id: string, nodeId?: string) =>
  apiFetch<{ result: AutomationRunResult }>(`/automations/${id}/test`, { method: 'POST', body: JSON.stringify({ nodeId }) });

// ── Markdown Pages ────────────────────────────────────────────────────────

export const apiGetMarkdownLists = (workspaceId?: string) =>
  apiFetch<{ markdownLists: MarkdownList[] }>(`/markdown-lists${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`);

export const apiGetMarkdownList = (id: string) =>
  apiFetch<{ markdownList: MarkdownList }>(`/markdown-lists/${id}`);

export const apiCreateMarkdownList = (data: { id?: string; name: string; emoji?: string; color?: string; colorBg?: string; subtitle?: string; isPublic?: boolean; folderId?: string; workspaceId?: string }) =>
  apiFetch<{ markdownList: MarkdownList }>('/markdown-lists', { method: 'POST', body: JSON.stringify(data) });

export const apiUpdateMarkdownList = (id: string, data: Partial<Pick<MarkdownList, 'name' | 'emoji' | 'color' | 'colorBg' | 'subtitle' | 'isPublic' | 'fullWidth' | 'position'>> & { folderId?: string | null; content?: MarkdownListContent; expectedVersion?: number; cascade?: boolean }) =>
  apiFetch<{ markdownList: MarkdownList }>(`/markdown-lists/${id}`, { method: 'PUT', body: JSON.stringify(data) });

// Persist the order of markdown pages by id (positions are global per user).
export const apiReorderMarkdownLists = (ids: string[]) =>
  apiFetch<{ success: boolean }>('/markdown-lists/reorder', { method: 'PUT', body: JSON.stringify({ ids }) });

// Move a markdown page (and its auto-managed Todo list) into another workspace.
export const apiMoveMarkdownListWorkspace = (id: string, workspaceId: string, cascade?: boolean) =>
  apiFetch<{ markdownList: MarkdownList }>(`/markdown-lists/${id}/workspace`, { method: 'PUT', body: JSON.stringify({ workspaceId, cascade }) });

export const apiDeleteMarkdownList = (id: string) =>
  apiFetch<{ success: boolean }>(`/markdown-lists/${id}`, { method: 'DELETE' });

/** Resolves an `/image` block's `imageId` to a fetchable URL, with a
 *  short-lived per-document ticket attached as a query param (S4 —
 *  `<img>` tags can't set an Authorization header, and this replaces what
 *  used to be the caller's own long-lived session JWT in the URL). The
 *  screen that owns this document must call
 *  `ensureAssetTicket('mdimg:' + markdownListId)` once (in parallel with
 *  loading the document itself — see MarkdownListScreen.tsx) before
 *  rendering any block that calls this; without a cached ticket yet, this
 *  returns a URL with no ticket, which 401s until one is minted. */
export const markdownImageUrl = (markdownListId: string, imageId: string): string => {
  const base = `${BASE_URL}/markdown-lists/${markdownListId}/images/${imageId}`;
  const ticket = cachedTicket(`mdimg:${markdownListId}`);
  return ticket ? `${base}?ticket=${encodeURIComponent(ticket)}` : base;
};

export function apiUploadMarkdownImage(
  markdownListId: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<{ id: string; name: string; mimeType: string; size: number; url: string }> {
  return new Promise((resolve, reject) => {
    const token = getToken();
    const form = new FormData();
    form.append('image', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE_URL}/markdown-lists/${markdownListId}/images`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((JSON.parse(xhr.responseText) as { image: { id: string; name: string; mimeType: string; size: number; url: string } }).image);
      } else {
        reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(form);
  });
}

// ── Markdown Page trash ──────────────────────────────────────────────────

export const apiGetTrashMarkdownLists = () =>
  apiFetch<{ trash: Array<{ id: number; markdownListId: string; markdownListData: MarkdownList; deletedAt: string; expiresAt: string }> }>('/trash/markdown-lists');
export const apiRestoreTrashMarkdownList = (trashId: number) =>
  apiFetch<{ success: boolean }>(`/trash/markdown-lists/${trashId}/restore`, { method: 'POST' });
export const apiDeleteTrashMarkdownList = (trashId: number) =>
  apiFetch<{ success: boolean }>(`/trash/markdown-lists/${trashId}`, { method: 'DELETE' });

// ── Graph Layer: links ────────────────────────────────────────────────────

export const apiGetEntityLinks = (type: string, id: string) =>
  apiFetch<{ srn: string; linksByType: Record<string, ResolvedLink[]> }>(`/links/entity/${type}/${id}`);
export const apiGetBacklinks = (type: string, id: string) =>
  apiFetch<{ backlinks: ResolvedLink[] }>(`/links/entity/${type}/${id}/backlinks`);
export const apiGetUnlinkedMentions = (type: string, id: string, limit = 20) =>
  apiFetch<{ candidates: EntityIndexEntry[] }>(`/links/entity/${type}/${id}/unlinked?limit=${limit}`);
export const apiGetLinksBetween = (src: string, dst: string) =>
  apiFetch<{ links: EntityLink[] }>(`/links?src=${encodeURIComponent(src)}&dst=${encodeURIComponent(dst)}`);
export const apiCreateLink = (body: { src: string; dst: string; linkType: string; props?: Record<string, unknown>; sourceBlockId?: string | null }) =>
  apiFetch<{ link: EntityLink }>('/links', { method: 'POST', body: JSON.stringify(body) });
export const apiCreateLinksBatch = (links: Array<{ src: string; dst: string; linkType: string; props?: Record<string, unknown>; sourceBlockId?: string | null }>) =>
  apiFetch<{ links: EntityLink[] }>('/links/batch', { method: 'POST', body: JSON.stringify({ links }) });
export const apiUpdateLink = (id: string, body: { props?: Record<string, unknown>; weight?: number }) =>
  apiFetch<{ link: EntityLink | null }>(`/links/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const apiDeleteLink = (id: string) =>
  apiFetch<void>(`/links/${id}`, { method: 'DELETE' });
export const apiSearchEntities = (q: string, opts: { types?: string[]; workspaceId?: string; limit?: number; signal?: AbortSignal } = {}) => {
  const params = new URLSearchParams({ q });
  if (opts.types?.length) params.set('types', opts.types.join(','));
  if (opts.workspaceId) params.set('workspaceId', opts.workspaceId);
  if (opts.limit) params.set('limit', String(opts.limit));
  return apiFetch<{ results: EntityIndexEntry[] }>(`/links/search?${params.toString()}`, { signal: opts.signal });
};
export const apiGetLinkTypes = (workspaceId?: string) =>
  apiFetch<{ types: LinkTypeDef[] }>(`/links/types${workspaceId ? `?workspaceId=${workspaceId}` : ''}`);
export const apiCreateLinkType = (body: {
  workspaceId: string; key: string; label: string; inverseKey: string; inverseLabel: string;
  symmetric?: boolean; color?: string; edgeStyle?: string; allowedSrc?: string[]; allowedDst?: string[];
}) => apiFetch<{ type: LinkTypeDef }>('/links/types', { method: 'POST', body: JSON.stringify(body) });
export const apiDeleteLinkType = (id: string) =>
  apiFetch<void>(`/links/types/${id}`, { method: 'DELETE' });

// ── Graph Layer: graph queries ───────────────────────────────────────────

export const apiGetWorkspaceGraph = (workspaceId: string, opts: { types?: string[]; linkTypes?: string[]; includeTrashed?: boolean; minDegree?: number; limit?: number } = {}) => {
  const params = new URLSearchParams();
  if (opts.types?.length) params.set('types', opts.types.join(','));
  if (opts.linkTypes?.length) params.set('linkTypes', opts.linkTypes.join(','));
  if (opts.includeTrashed) params.set('includeTrashed', 'true');
  if (opts.minDegree) params.set('minDegree', String(opts.minDegree));
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return apiFetch<GraphPayload>(`/graph/workspace/${workspaceId}${qs ? `?${qs}` : ''}`);
};
export const apiGetLocalGraph = (type: string, id: string, depth = 2, linkTypes?: string[]) => {
  const params = new URLSearchParams({ depth: String(depth) });
  if (linkTypes?.length) params.set('linkTypes', linkTypes.join(','));
  return apiFetch<GraphPayload>(`/graph/local/${type}/${id}?${params.toString()}`);
};
export const apiGetGraphPath = (from: string, to: string, maxDepth = 6) =>
  apiFetch<{ path: string[] | null; found: boolean }>(`/graph/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&maxDepth=${maxDepth}`);
export const apiGetGraphOrphans = (workspaceId: string, limit = 100) =>
  apiFetch<{ orphans: Array<{ srn: string; type: string; id: string }> }>(`/graph/orphans/${workspaceId}?limit=${limit}`);
export const apiGetGraphHubs = (workspaceId: string, limit = 20) =>
  apiFetch<{ hubs: Array<{ srn: string; type: string; id: string; title: string; pagerank: number; degree: number }> }>(`/graph/hubs/${workspaceId}?limit=${limit}`);
export const apiGetGraphStats = (workspaceId: string) =>
  apiFetch<{ nodesByType: Record<string, number>; edgesByType: Record<string, number>; nodeTotal: number; edgeTotal: number; density: number; metricsComputedAt: string | null }>(`/graph/stats/${workspaceId}`);
export const apiRecomputeGraphMetrics = (workspaceId: string) =>
  apiFetch<{ ok: boolean; computedAt: string }>(`/graph/recompute/${workspaceId}`, { method: 'POST' });

// ── Graph Layer: canvases ────────────────────────────────────────────────

export const apiGetCanvases = (workspaceId: string) =>
  apiFetch<{ canvases: GraphCanvas[] }>(`/canvases?workspaceId=${workspaceId}`);
export const apiGetCanvas = (id: string) =>
  apiFetch<{ canvas: GraphCanvas }>(`/canvases/${id}`);
export const apiCreateCanvas = (body: { workspaceId: string; name: string; emoji?: string }) =>
  apiFetch<{ canvas: GraphCanvas }>('/canvases', { method: 'POST', body: JSON.stringify(body) });
export const apiUpdateCanvas = (id: string, body: { name?: string; emoji?: string; layout?: GraphCanvasLayout; isPublic?: boolean; version: number }) =>
  apiFetch<{ canvas: GraphCanvas }>(`/canvases/${id}`, { method: 'PUT', body: JSON.stringify(body) });
export const apiDeleteCanvas = (id: string) =>
  apiFetch<void>(`/canvases/${id}`, { method: 'DELETE' });

// ── Agent Runtime ────────────────────────────────────────────────────────

export const apiGetAgentRuns = (workspaceId: string, status?: string) =>
  apiFetch<{ runs: AgentRun[] }>(`/agent/runs?workspaceId=${workspaceId}${status ? `&status=${status}` : ''}`);
export const apiGetAgentRun = (id: string) =>
  apiFetch<{ run: AgentRun }>(`/agent/runs/${id}`);
export const apiStartAgentRun = (body: { workspaceId: string; goal: string; triggerType?: string; context?: Record<string, unknown> }) =>
  apiFetch<{ run: AgentRun }>('/agent/runs', { method: 'POST', body: JSON.stringify(body) });
export const apiCancelAgentRun = (id: string) =>
  apiFetch<{ run: AgentRun }>(`/agent/runs/${id}/cancel`, { method: 'POST' });
export const apiRevertAgentRun = (id: string) =>
  apiFetch<{ reverted: number; failed: number; skipped: number }>(`/agent/runs/${id}/revert`, { method: 'POST' });
export const apiGetAgentProposals = (workspaceId: string, status = 'pending') =>
  apiFetch<{ proposals: AgentProposal[] }>(`/agent/proposals?workspaceId=${workspaceId}&status=${status}`);
export const apiAcceptAgentProposal = (id: string) =>
  apiFetch<{ proposal: AgentProposal; result: string }>(`/agent/proposals/${id}/accept`, { method: 'POST' });
export const apiRejectAgentProposal = (id: string, reason?: string) =>
  apiFetch<{ proposal: AgentProposal }>(`/agent/proposals/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
export const apiSetWorkspaceAgent = (workspaceId: string, body: { agentMode?: AgentMode; agentPolicy?: AgentPolicy }) =>
  apiFetch<{ agentMode: AgentMode; agentPolicy: AgentPolicy }>(`/workspaces/${workspaceId}/agent`, { method: 'PATCH', body: JSON.stringify(body) });
export const apiAssignTaskToAgent = (taskId: number | string) =>
  apiFetch<{ run: AgentRun }>(`/tasks/${taskId}/assign-agent`, { method: 'POST' });

// ── Knowledge Layer ───────────────────────────────────────────────────────

export interface KnowledgeSearchResult {
  entity: EntityIndexEntry;
  chunkContent: string;
  chunkIndex: number;
  score: number;
}
export const apiKnowledgeSearch = (body: { q: string; workspaceId?: string; entityTypes?: string[]; limit?: number }) =>
  apiFetch<{ results: KnowledgeSearchResult[] }>('/knowledge/search', { method: 'POST', body: JSON.stringify(body) });
export interface KnowledgeStatus {
  pgvectorAvailable: boolean;
  providerConfigured: boolean;
  searchEnabled: boolean;
  queue: { pending: number; processing: number; done: number; failed: number; skippedBudget: number };
  budget: { monthlyLimit: number; usedThisMonth: number };
}
export const apiGetKnowledgeStatus = () =>
  apiFetch<KnowledgeStatus>('/knowledge/status');
export const apiKnowledgeReindex = () =>
  apiFetch<{ enqueued: number }>('/knowledge/reindex', { method: 'POST' });

// ── Knowledge Base ────────────────────────────────────────────────────────
// The per-workspace curated dictionary. Distinct from the Knowledge Layer
// above (hybrid search) — see CLAUDE.md's "Knowledge Base" section.

export const apiGetKnowledgeBase = (workspaceId: string) =>
  apiFetch<{ knowledgeBase: KnowledgeBase | null; entries: KnowledgeEntry[]; canWrite?: boolean }>(
    `/knowledge-base?workspaceId=${encodeURIComponent(workspaceId)}`
  );

export const apiCreateKnowledgeBase = (body: { workspaceId: string; name?: string; emoji?: string | null; color?: string | null; description?: string | null }) =>
  apiFetch<{ knowledgeBase: KnowledgeBase; created: boolean }>('/knowledge-base', { method: 'POST', body: JSON.stringify(body) });

export const apiUpdateKnowledgeBase = (id: string, body: { name?: string; emoji?: string | null; color?: string | null; description?: string | null }) =>
  apiFetch<{ knowledgeBase: KnowledgeBase }>(`/knowledge-base/${id}`, { method: 'PUT', body: JSON.stringify(body) });

export const apiDeleteKnowledgeBase = (id: string) =>
  apiFetch<{ success: boolean }>(`/knowledge-base/${id}`, { method: 'DELETE' });

export const apiCreateKnowledgeEntry = (kbId: string, body: Partial<Pick<KnowledgeEntry, 'term' | 'aliases' | 'entryType' | 'summary' | 'properties' | 'emoji' | 'color'>> & { blocks?: unknown[] }) =>
  apiFetch<{ entry: KnowledgeEntry }>(`/knowledge-base/${kbId}/entries`, { method: 'POST', body: JSON.stringify(body) });

export const apiUpdateKnowledgeEntry = (id: string, body: Partial<Pick<KnowledgeEntry, 'term' | 'aliases' | 'entryType' | 'summary' | 'properties' | 'emoji' | 'color' | 'position'>>) =>
  apiFetch<{ entry: KnowledgeEntry }>(`/knowledge-base/entries/${id}`, { method: 'PUT', body: JSON.stringify(body) });

export const apiUpdateKnowledgeEntryContent = (id: string, blocks: unknown[]) =>
  apiFetch<{ entry: KnowledgeEntry }>(`/knowledge-base/entries/${id}/content`, { method: 'PUT', body: JSON.stringify({ blocks }) });

export const apiDeleteKnowledgeEntry = (id: string) =>
  apiFetch<{ success: boolean }>(`/knowledge-base/entries/${id}`, { method: 'DELETE' });

export const apiCreateKnowledgeRelation = (entryId: string, body: { targetType: string; targetId: string; linkType?: string }) =>
  apiFetch<{ success: boolean }>(`/knowledge-base/entries/${entryId}/relations`, { method: 'POST', body: JSON.stringify(body) });

export const apiDeleteKnowledgeRelation = (entryId: string, params: { targetType: string; targetId: string; linkType?: string }) => {
  const q = new URLSearchParams({ targetType: params.targetType, targetId: params.targetId, ...(params.linkType ? { linkType: params.linkType } : {}) });
  return apiFetch<{ success: boolean }>(`/knowledge-base/entries/${entryId}/relations?${q}`, { method: 'DELETE' });
};

export const apiKnowledgeLookup = (workspaceId: string, term: string) =>
  apiFetch<KnowledgeLookupResult>(`/knowledge-base/lookup?workspaceId=${encodeURIComponent(workspaceId)}&term=${encodeURIComponent(term)}`);

export const apiGetKnowledgeGlossary = (workspaceId: string) =>
  apiFetch<{ terms: Array<{ id: string; term: string; aliases: string[]; entryType: string; summary: string | null }> }>(
    `/knowledge-base/glossary?workspaceId=${encodeURIComponent(workspaceId)}`
  );

export const apiScanKnowledgeConcepts = (kbId: string) =>
  apiFetch<{ scanned: number; proposed: number; alreadyDefined: number }>(`/knowledge-base/${kbId}/scan`, { method: 'POST' });

export const apiGetKnowledgeSuggestions = (kbId: string) =>
  apiFetch<{ suggestions: KnowledgeSuggestion[] }>(`/knowledge-base/${kbId}/suggestions`);

export const apiDecideKnowledgeSuggestion = (suggestionId: string, accept: boolean) =>
  apiFetch<{ entry: KnowledgeEntry | null }>(`/knowledge-base/suggestions/${suggestionId}`, { method: 'POST', body: JSON.stringify({ accept }) });

/** Resolves a Knowledge Base entry image to a fetchable URL via a short-lived
 *  per-entry ticket (same S4 mechanism as markdownImageUrl — see its
 *  comment). The caller must have already called
 *  `ensureAssetTicket('kbimg:' + entryId)` (see EntryInspector.tsx). */
export const knowledgeEntryImageUrl = (entryId: string, imageId: string): string => {
  const base = `${BASE_URL}/knowledge-base/entries/${entryId}/images/${imageId}`;
  const ticket = cachedTicket(`kbimg:${entryId}`);
  return ticket ? `${base}?ticket=${encodeURIComponent(ticket)}` : base;
};

export function apiUploadKnowledgeEntryImage(
  entryId: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<{ id: string; name: string; mimeType: string; size: number }> {
  return new Promise((resolve, reject) => {
    const token = getToken();
    const form = new FormData();
    form.append('image', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE_URL}/knowledge-base/entries/${entryId}/images`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((JSON.parse(xhr.responseText) as { image: { id: string; name: string; mimeType: string; size: number } }).image);
      } else {
        reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(form);
  });
}
