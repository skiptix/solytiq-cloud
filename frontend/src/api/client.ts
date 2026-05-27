import type { Task, List, Folder, TrashedTask, TrashedFolder, SharedFile } from '../types';

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

export const apiRegister = (username: string, email: string, password: string) =>
  apiFetch<{ token: string; user: { id: string; username: string; email: string; fullName: string } }>(
    '/auth/register', { method: 'POST', body: JSON.stringify({ username, email, password }) }
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

export const apiUpdateProfile = (data: { fullName?: string; email?: string }) =>
  apiFetch<{ user: { id: string; username: string; email: string; fullName: string } }>(
    '/auth/profile', { method: 'PUT', body: JSON.stringify(data) }
  );

export const apiUploadProfileImage = (imageData: string | null) =>
  apiFetch<{ user: { id: string; username: string; email: string; fullName: string; profileImage: string | null } }>(
    '/auth/profile-image', { method: 'PUT', body: JSON.stringify({ imageData }) }
  );

// Dashboard Tasks
export const apiGetTasks = () =>
  apiFetch<{ tasks: Task[] }>('/tasks');

export const apiCreateTask = (data: Partial<Task> & { title: string }) =>
  apiFetch<{ task: Task }>('/tasks', { method: 'POST', body: JSON.stringify(data) });

export const apiUpdateTask = (id: number, data: Partial<Task>) =>
  apiFetch<{ task: Task }>(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) });

export const apiDeleteTask = (id: number) =>
  apiFetch<{ success: boolean }>(`/tasks/${id}`, { method: 'DELETE' });

// Lists
export const apiGetLists = () =>
  apiFetch<{ lists: List[] }>('/lists');

export const apiCreateList = (data: Omit<List, 'sections'> & { sections?: List['sections'] }) =>
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

export const apiAddListTask = (listId: string, sectionId: string, data: Partial<Task> & { title: string }) =>
  apiFetch<{ task: Task }>(`/lists/${listId}/sections/${sectionId}/tasks`, { method: 'POST', body: JSON.stringify(data) });

export const apiCreateSublistTask = (
  parentListId: string,
  sectionId: string,
  taskTitle: string,
  sublistName: string,
  depth: number
) =>
  apiFetch<{ task: Task; list: List }>(`/lists/${parentListId}/sections/${sectionId}/tasks/sublist`, {
    method: 'POST',
    body: JSON.stringify({ title: taskTitle, sublistName, depth }),
  });

export const apiLinkListAsTask = (
  parentListId: string,
  sectionId: string,
  taskTitle: string,
  linkedListId: string
) =>
  apiFetch<{ task: Task }>(`/lists/${parentListId}/sections/${sectionId}/tasks/link`, {
    method: 'POST',
    body: JSON.stringify({ title: taskTitle, linkedListId }),
  });

export const apiGetListProgress = (listId: string) =>
  apiFetch<{ total: number; completed: number; percent: number }>(`/lists/${listId}/progress`);

export const apiUpdateListTask = (listId: string, taskId: number, data: Partial<Task>) =>
  apiFetch<{ task: Task }>(`/lists/${listId}/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(data) });

export const apiDeleteListTask = (listId: string, taskId: number) =>
  apiFetch<{ success: boolean }>(`/lists/${listId}/tasks/${taskId}`, { method: 'DELETE' });

// Folders
export const apiGetFolders = () =>
  apiFetch<{ folders: Folder[] }>('/folders');

export const apiCreateFolder = (data: { id: string; name: string; emoji?: string; color?: string; isPublic?: boolean }) =>
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

export const apiUpdateAppSettings = (data: { storageQuotaPerUser?: number }) =>
  apiFetch<{ settings: Record<string, string> }>('/admin/settings', { method: 'PUT', body: JSON.stringify(data) });

// Files
export const apiGetFiles = () =>
  apiFetch<{ files: SharedFile[] }>('/files');

export const apiGetStorageUsage = () =>
  apiFetch<{ used: number; quota: number | null; isAdmin: boolean }>('/files/storage');

export const apiUpdateFile = (id: string, data: { name?: string; title?: string | null; isPublic?: boolean; password?: string | null; expiresAt?: string | null }) =>
  apiFetch<{ file: SharedFile }>(`/files/${id}`, { method: 'PUT', body: JSON.stringify(data) });

export const apiDeleteFile = (id: string) =>
  apiFetch<{ success: boolean }>(`/files/${id}`, { method: 'DELETE' });

// AI Assistant
export const apiGetAISettings = () =>
  apiFetch<{ enabled: boolean; model: string }>('/ai/settings');

export const apiAIChat = (messages: unknown[], tools?: unknown[]) =>
  apiFetch<{
    choices: Array<{
      message: {
        role: string;
        content: string | null;
        tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
      };
    }>;
  }>('/ai/chat', { method: 'POST', body: JSON.stringify({ messages, tools }) });

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

export const apiUpdateAppSettingsAI = (data: { aiAssistantEnabled?: boolean; aiModel?: string }) =>
  apiFetch<{ settings: Record<string, string> }>('/admin/settings', {
    method: 'PUT',
    body: JSON.stringify(data),
  });

// SSE — real-time sync
let sseSource: EventSource | null = null;

export function connectSSE(onSync: (type: string) => void): void {
  if (sseSource) return;
  const token = getToken();
  if (!token) return;
  const url = `${BASE_URL}/events?token=${encodeURIComponent(token)}`;
  sseSource = new EventSource(url);
  sseSource.addEventListener('sync', (e: MessageEvent) => {
    try {
      const { type } = JSON.parse(e.data) as { type: string };
      onSync(type);
    } catch { /* ignore malformed */ }
  });
  sseSource.onerror = () => {
    sseSource?.close();
    sseSource = null;
    // Browser's EventSource auto-reconnects; we clear our ref so it re-creates cleanly
    setTimeout(() => connectSSE(onSync), 5000);
  };
}

export function disconnectSSE(): void {
  sseSource?.close();
  sseSource = null;
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
