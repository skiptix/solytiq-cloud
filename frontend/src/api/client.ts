import type { Task, List, Folder, TrashedTask, TrashedFolder, SharedFile, Workspace, WorkspaceMember, AIFile, GpsFile, GpsTrackData, GpsTrackPoint, GpsRouteStateV1, GapMode, NamedPinInput, OverpassPoi } from '../types';

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

function getToken(): string | null {
  return localStorage.getItem('solytiq_token');
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> ?? {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `HTTP ${res.status}`);
  }
  const ct = res.headers.get('content-type');
  if (ct?.includes('application/json')) return res.json() as Promise<T>;
  return null as unknown as T;
}

// Auth
export const apiCheckSetupRequired = () =>
  apiFetch<{ required: boolean }>('/auth/setup-required');

export const apiRequestSetupToken = () =>
  apiFetch<{ ok: boolean }>('/auth/request-setup-token', { method: 'POST' });

export const apiRegister = (username: string, email: string, password: string, setupToken?: string) =>
  apiFetch<{ token: string; user: { id: string; username: string; email: string; fullName: string; token_version?: number } }>(
    '/auth/register', { method: 'POST', body: JSON.stringify({ username, email, password, setupToken }) }
  );

export const apiLogin = (username: string, password: string) =>
  apiFetch<{
    token?: string;
    user?: { id: string; username: string; email: string; fullName: string; isAdmin?: boolean; profileImage?: string | null; totpEnabled?: boolean };
    requires2FA?: boolean;
    pendingToken?: string;
  }>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });

export const api2FASetup = () =>
  apiFetch<{ secret: string; qrCode: string }>('/auth/2fa/setup', { method: 'POST', body: JSON.stringify({}) });

export const api2FAEnable = (code: string) =>
  apiFetch<{ success: boolean }>('/auth/2fa/enable', { method: 'POST', body: JSON.stringify({ code }) });

export const api2FADisable = (code: string) =>
  apiFetch<{ success: boolean }>('/auth/2fa/disable', { method: 'POST', body: JSON.stringify({ code }) });

export const api2FAVerify = (pendingToken: string, code: string) =>
  apiFetch<{ token: string; user: { id: string; username: string; email: string; fullName: string; isAdmin?: boolean; profileImage?: string | null; totpEnabled?: boolean } }>(
    '/auth/2fa/verify', { method: 'POST', body: JSON.stringify({ pendingToken, code }) }
  );

export const apiGetMe = () =>
  apiFetch<{ user: { id: string; username: string; email: string; fullName: string } }>('/auth/me');

export const apiGetMembers = () =>
  apiFetch<{ members: Array<{ id: string; username: string; email: string; fullName: string | null; profileImage: string | null; isAdmin: boolean }> }>('/auth/members');

export const apiChangePassword = (currentPassword: string, newPassword: string) =>
  apiFetch<{ success: boolean }>('/auth/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) });

export const apiGetFeatureFlags = () =>
  apiFetch<{ twoFAEnabled: boolean }>('/auth/feature-flags');

export const apiUpdateProfile = (data: { fullName?: string; email?: string }) =>
  apiFetch<{ user: { id: string; username: string; email: string; fullName: string } }>(
    '/auth/profile', { method: 'PUT', body: JSON.stringify(data) }
  );

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

// Lists
export const apiGetLists = (workspaceId?: string) =>
  apiFetch<{ lists: List[] }>(`/lists${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`);

export const apiCreateList = (data: Omit<List, 'sections'> & { sections?: List['sections']; workspaceId?: string }) =>
  apiFetch<{ list: List }>('/lists', { method: 'POST', body: JSON.stringify(data) });

export const apiUpdateList = (id: string, data: Partial<List>) =>
  apiFetch<{ list: List }>(`/lists/${id}`, { method: 'PUT', body: JSON.stringify(data) });

export const apiDeleteList = (id: string) =>
  apiFetch<{ success: boolean }>(`/lists/${id}`, { method: 'DELETE' });

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

export const apiUpdateListTask = (listId: string, taskId: number, data: Partial<Task>) =>
  apiFetch<{ task: Task }>(`/lists/${listId}/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(data) });

export const apiDeleteListTask = (listId: string, taskId: number) =>
  apiFetch<{ success: boolean }>(`/lists/${listId}/tasks/${taskId}`, { method: 'DELETE' });

// Folders
export const apiGetFolders = (workspaceId?: string) =>
  apiFetch<{ folders: Folder[] }>(`/folders${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`);

export const apiCreateFolder = (data: { id: string; name: string; emoji?: string; color?: string; isPublic?: boolean; workspaceId?: string }) =>
  apiFetch<{ folder: Folder }>('/folders', { method: 'POST', body: JSON.stringify(data) });

export const apiUpdateFolder = (id: string, data: Partial<Omit<Folder, 'id'>>) =>
  apiFetch<{ ok: boolean; folder?: Folder }>(`/folders/${id}`, { method: 'PUT', body: JSON.stringify(data) });

export const apiDeleteFolder = (id: string) =>
  apiFetch<{ ok: boolean }>(`/folders/${id}`, { method: 'DELETE' });

// Trash
export const apiGetTrash = () =>
  apiFetch<{ trash: TrashedTask[] }>('/trash');

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

// Workspaces
export const apiGetWorkspaces = () =>
  apiFetch<{ workspaces: Workspace[] }>('/workspaces');

export const apiCreateWorkspace = (data: { name: string; description?: string; emoji?: string; image?: string; visibility?: 'private' | 'public' }) =>
  apiFetch<{ workspace: Workspace }>('/workspaces', { method: 'POST', body: JSON.stringify(data) });

export const apiUpdateWorkspace = (id: string, data: Partial<Pick<Workspace, 'name' | 'description' | 'emoji' | 'image' | 'visibility'>>) =>
  apiFetch<{ workspace: Workspace }>(`/workspaces/${id}`, { method: 'PUT', body: JSON.stringify(data) });

export const apiDeleteWorkspace = (id: string) =>
  apiFetch<{ ok: boolean }>(`/workspaces/${id}`, { method: 'DELETE' });

export const apiGetWorkspaceMembers = (id: string) =>
  apiFetch<{ members: WorkspaceMember[] }>(`/workspaces/${id}/members`);

export const apiAddWorkspaceMember = (id: string, username: string) =>
  apiFetch<{ member: WorkspaceMember }>(`/workspaces/${id}/members`, { method: 'POST', body: JSON.stringify({ username }) });

export const apiRemoveWorkspaceMember = (id: string, userId: string) =>
  apiFetch<{ ok: boolean }>(`/workspaces/${id}/members/${userId}`, { method: 'DELETE' });

// SSE — real-time sync
let sseSource: EventSource | null = null;
let sseReconnectDelay = 2000;
const SSE_RECONNECT_MAX = 30000;

export function connectSSE(onSync: (type: string) => void): void {
  if (sseSource) return;
  const token = getToken();
  if (!token) return;
  const url = `${BASE_URL}/events?token=${encodeURIComponent(token)}`;
  sseSource = new EventSource(url);
  sseSource.onopen = () => {
    sseReconnectDelay = 2000; // reset backoff on successful connection
  };
  sseSource.addEventListener('sync', (e: MessageEvent) => {
    try {
      const { type } = JSON.parse(e.data) as { type: string };
      onSync(type);
    } catch { /* ignore malformed */ }
  });
  sseSource.onerror = () => {
    sseSource?.close();
    sseSource = null;
    const delay = sseReconnectDelay;
    sseReconnectDelay = Math.min(sseReconnectDelay * 2, SSE_RECONNECT_MAX);
    setTimeout(() => connectSSE(onSync), delay);
  };
}

export function disconnectSSE(): void {
  sseSource?.close();
  sseSource = null;
  sseReconnectDelay = 2000;
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
