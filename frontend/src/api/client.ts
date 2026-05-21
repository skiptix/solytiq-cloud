import type { Task, List, TrashedTask } from '../types';

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
  apiFetch<{ token: string; user: { id: string; username: string; email: string; fullName: string } }>(
    '/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }
  );

export const apiGetMe = () =>
  apiFetch<{ user: { id: string; username: string; email: string; fullName: string } }>('/auth/me');

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

export const apiUpdateListTask = (listId: string, taskId: number, data: Partial<Task>) =>
  apiFetch<{ task: Task }>(`/lists/${listId}/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(data) });

export const apiDeleteListTask = (listId: string, taskId: number) =>
  apiFetch<{ success: boolean }>(`/lists/${listId}/tasks/${taskId}`, { method: 'DELETE' });

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

// Admin
export const apiGetUsers = () =>
  apiFetch<{ users: Array<{ id: string; username: string; email: string; fullName: string | null; profileImage: string | null; isAdmin: boolean; lastOnline: string | null; createdAt: string }> }>('/admin/users');

export const apiCreateUser = (data: { username: string; password: string; email?: string; fullName?: string }) =>
  apiFetch<{ user: { id: string; username: string; email: string; fullName: string | null; profileImage: string | null; isAdmin: boolean; lastOnline: string | null; createdAt: string } }>(
    '/admin/users', { method: 'POST', body: JSON.stringify(data) }
  );
