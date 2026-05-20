export interface Task {
  id: number;
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
  colorBg?: string;
  subtitle?: string;
  sections: Section[];
}

export interface TrashedTask {
  id: number;
  taskId: number;
  task: Task;
  meta: { src: string; listId?: string; listName?: string };
  deletedAt: string;
}

export interface AuthState {
  adminRegistered: boolean;
  loggedIn: boolean;
  userId: string | null;
  username: string;
  email: string;
  fullName: string;
  token: string | null;
  register: (creds: { username: string; email: string; password: string }) => Promise<void>;
  signIn: (username: string, password: string) => Promise<boolean>;
  signOut: () => void;
  setProfile: (data: { username?: string; email?: string; fullName?: string }) => void;
}

export interface AppState {
  dashTasks: Task[];
  lists: List[];
  trashTasks: TrashedTask[];
  sidebarWidth: number;
  synced: boolean;
  lastSynced: string | null;
  setDashTasks: (tasks: Task[] | ((prev: Task[]) => Task[])) => void;
  setLists: (lists: List[] | ((prev: List[]) => List[])) => void;
  updateListTask: (listId: string, taskId: number, updates: Partial<Task>) => void;
  deleteListTask: (listId: string, taskId: number) => void;
  addToTrash: (task: Task, meta: { src: string; listId?: string; listName?: string }) => void;
  restoreFromTrash: (trashId: number) => void;
  deleteFromTrash: (trashId: number) => void;
  setSidebarWidth: (w: number) => void;
  setSynced: (synced: boolean, time?: string) => void;
  loadFromApi: () => Promise<void>;
}
