export interface Task {
  id: number;
  creatorId?: string;
  title: string;
  checked: boolean;
  deadline?: string; // YYYY-MM-DD
  time?: string;
  priority?: 'High' | 'Medium' | 'Low';
  badge?: string;
  note?: string;
  _source?: 'dash' | 'list';
  _listId?: string;
  _listName?: string;
}

export interface Section {
  id: string;
  label: string;
  emoji?: string;
  tasks: Task[];
}

export interface List {
  id: string;
  name: string;
  emoji?: string;
  color?: string;
  userId?: string;
  isPublic?: boolean;
  colorBg?: string;
  subtitle?: string;
  folderId?: string;
  position?: number;
  sections: Section[];
}

export interface Folder {
  id: string;
  userId?: string;
  name: string;
  emoji?: string;
  color?: string;
  position: number;
  collapsed: boolean;
  isPublic?: boolean;
}

export interface TrashedTask {
  id: number;
  taskId: number;
  task: Task;
  meta: { src: string; listId?: string; listName?: string };
  deletedAt: string;
}

export interface SharedFile {
  id: string;
  userId: string;
  name: string;
  title?: string | null;
  mimeType: string;
  size: number;
  isPublic: boolean;
  hasPassword: boolean;
  expiresAt: string | null;
  shareToken: string;
  shareUrl: string;
  createdAt: string;
}

export interface AuthState {
  adminRegistered: boolean;
  loggedIn: boolean;
  userId: string | null;
  username: string;
  email: string;
  fullName: string;
  profileImage: string | null;
  isAdmin: boolean;
  token: string | null;
  register: (creds: { username: string; email: string; password: string }) => Promise<void>;
  signIn: (username: string, password: string) => Promise<boolean>;
  signOut: () => void;
  setProfile: (data: { username?: string; email?: string; fullName?: string; profileImage?: string | null }) => void;
}

export interface AppState {
  dashTasks: Task[];
  lists: List[];
  folders: Folder[];
  trashTasks: TrashedTask[];
  sidebarWidth: number;
  setDashTasks: (tasks: Task[] | ((prev: Task[]) => Task[])) => void;
  setLists: (lists: List[] | ((prev: List[]) => List[])) => void;
  setFolders: (folders: Folder[] | ((prev: Folder[]) => Folder[])) => void;
  addFolder: (folder: Folder) => void;
  updateFolder: (id: string, updates: Partial<Folder>) => void;
  deleteFolder: (id: string) => void;
  updateList: (listId: string, updates: Partial<List>) => void;
  deleteList: (listId: string) => void;
  updateDashTask: (taskId: number, updates: Partial<Task>) => void;
  updateListTask: (listId: string, taskId: number, updates: Partial<Task>) => void;
  deleteListTask: (listId: string, taskId: number) => void;
  addToTrash: (task: Task, meta: { src: string; listId?: string; listName?: string }) => void;
  restoreFromTrash: (trashId: number) => void;
  deleteFromTrash: (trashId: number) => void;
  setSidebarWidth: (w: number) => void;
  loadFromApi: () => Promise<void>;
}
