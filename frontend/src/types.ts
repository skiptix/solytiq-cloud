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
  linkedListId?: string | null;
  linkedListType?: 'sublist' | 'link' | null;
  attachmentCount?: number;
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
  workspaceId?: string;
  position?: number;
  sections: Section[];
  parentTaskId?: number | null;
  depth?: number;
  // Public read-only link sharing (distinct from the workspace `isPublic` flag).
  shareEnabled?: boolean;
  shareToken?: string | null;
  shareHasPassword?: boolean;
  shareExpiresAt?: string | null;
  shareSubpages?: boolean;
  linkedProgress?: {
    total: number;
    completed: number;
  };
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
  workspaceId?: string;
}

// ─── Timelines ────────────────────────────────────────────────────────────────
export type TimelineLayout = 'vertical' | 'compact' | 'detailed';
export type MilestoneStatus = 'upcoming' | 'in-progress' | 'done';

export interface Milestone {
  id: string;
  timelineId?: string;
  title: string;
  description?: string | null;
  date?: string | null;      // YYYY-MM-DD
  time?: string | null;      // HH:MM
  status: MilestoneStatus;
  emoji?: string | null;
  color?: string | null;
  position?: number;
  attachmentCount?: number;
}

export interface Timeline {
  id: string;
  name: string;
  emoji?: string;
  color?: string;
  colorBg?: string;
  subtitle?: string;
  userId?: string;
  isPublic?: boolean;
  layout: TimelineLayout;
  folderId?: string;
  workspaceId?: string;
  position?: number;
  // Public read-only link sharing.
  shareEnabled?: boolean;
  shareToken?: string | null;
  shareHasPassword?: boolean;
  shareExpiresAt?: string | null;
  milestones: Milestone[];
}

export interface TrashedTimeline {
  id: number;
  timelineId: string;
  timeline: Timeline;
  deletedAt: string;
  expiresAt: string;
}

// A milestone enriched with its parent timeline's context, as returned by the
// /timelines/upcoming endpoint that powers the dashboard "Upcoming" widget.
export interface UpcomingMilestone {
  id: string;
  timelineId: string;
  title: string;
  description?: string | null;
  date?: string | null;      // YYYY-MM-DD
  time?: string | null;      // HH:MM
  status: MilestoneStatus;
  emoji?: string | null;
  color?: string | null;
  timelineName: string;
  timelineEmoji?: string | null;
  timelineColor?: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  description?: string;
  emoji?: string;
  image?: string;
  visibility: 'private' | 'public';
  ownerId: string;
  role: 'owner' | 'member';
  createdAt: string;
  memberCount?: number;
}

export interface WorkspaceMember {
  userId: string;
  username: string;
  fullName?: string;
  profileImage?: string;
  role: 'owner' | 'member';
}

export interface TrashedTask {
  id: number;
  taskId: number;
  task: Task;
  meta: { src: string; listId?: string; listName?: string };
  deletedAt: string;
}

export interface TrashedList {
  id: number;
  listId: string;
  list: List;
  deletedAt: string;
  expiresAt: string;
}

export interface TrashedFolder {
  id: number;
  folderId: string;
  folder: Folder & { listIds?: string[] };
  deletedAt: string;
  expiresAt: string;
}

export interface SharedFile {
  id: string;
  userId: string;
  name: string;
  title?: string | null;
  note?: string | null;
  mimeType: string;
  size: number;
  isPublic: boolean;
  hasPassword: boolean;
  expiresAt: string | null;
  shareToken: string;
  shareUrl: string;
  createdAt: string;
}

export interface TaskAttachment {
  id: string;
  taskId: number;
  attachmentType: 'upload' | 'linked';
  name: string;
  mimeType: string;
  size: number;
  sharedFileId: string | null;
  createdAt: string;
}

export interface MilestoneAttachment {
  id: string;
  milestoneId: string;
  attachmentType: 'upload' | 'linked';
  name: string;
  mimeType: string;
  size: number;
  sharedFileId: string | null;
  createdAt: string;
}

export interface AIFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentText: string | null;
  isImage: boolean;
}

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  fullName: string;
  isAdmin?: boolean;
  profileImage?: string | null;
  totpEnabled?: boolean;
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
  totpEnabled: boolean;
  register: (creds: { username: string; email: string; password: string; setupToken?: string }) => Promise<void>;
  signIn: (username: string, password: string) => Promise<boolean>;
  signOut: () => void;
  setProfile: (data: { username?: string; email?: string; fullName?: string; profileImage?: string | null }) => void;
  setAuthFromToken: (token: string, user: AuthUser) => void;
  setTotpEnabled: (enabled: boolean) => void;
}

// ─── GPS / Workout file types ─────────────────────────────────────────────────
export type GapMode = 'skip' | 'straight';

export interface GpsFileMetadata {
  totalDistance?: number;
  totalElevationGain?: number;
  duration?: number;
  startTime?: string | null;
  pointCount?: number;
}

export interface GpsFile {
  id: string;
  userId: string;
  name: string;
  fileType: 'gpx' | 'fit';
  size: number;
  metadata?: GpsFileMetadata | null;
  createdAt: string;
  smoothed?: boolean;
}

export interface GpsTrackPoint {
  id?: string;
  lat: number;
  lon: number;
  ele: number;
  time?: string;
  hr?: number;
  cadence?: number;
  power?: number;
}

export interface GpsMetricPoint {
  idx: number;
  distance: number;
  value: number | null;
}

export interface GpsTrackData {
  points: GpsTrackPoint[];
  waypoints: NamedPin[];
  routeState: GpsRouteStateV1 | null;
  elevationProfile: Array<{ distance: number; elevation: number; idx: number }>;
  metadata: GpsFileMetadata | null;
  metricsAvailable: { hr: boolean; cadence: boolean; power: boolean };
  hrProfile: GpsMetricPoint[] | null;
  cadenceProfile: GpsMetricPoint[] | null;
  powerProfile: GpsMetricPoint[] | null;
}

// ─── Route Planner State v1 ───────────────────────────────────────────────────
export type RouteControlKind =
  | 'start'
  | 'destination'
  | 'stop'
  | 'via'
  | 'through'
  | 'offgrid';

export type RouteProfile = 'road' | 'gravel' | 'mtb' | 'hike';

export interface TrackPoint {
  id: string;
  lat: number;
  lon: number;
  ele: number;
  time?: string;
  hr?: number;
  cadence?: number;
  power?: number;
  distanceM?: number;
}

export interface RouteControlPoint {
  id: string;
  order: number;
  kind: RouteControlKind;
  profile: RouteProfile;
  originalLat: number;
  originalLon: number;
  snappedLat?: number;
  snappedLon?: number;
  followWays: boolean;
  linkedPoiId?: string | null;
  spanBeforeId?: string | null;
  spanAfterId?: string | null;
}

export interface PoiMarker {
  id: string;
  source: 'custom' | 'osm' | 'imported_gpx' | 'search';
  sourceId?: string;
  lat: number;
  lon: number;
  ele?: number;
  name: string;
  description?: string;
  category: 'food' | 'fuel' | 'bicycle' | 'shopping' | 'kiosk' | 'flag' | 'generic';
  highlighted: boolean;
  addedToRoute: boolean;
  linkedControlPointId?: string | null;
  showLabel?: boolean;
}

export interface RouteSpan {
  id: string;
  fromControlId: string;
  toControlId: string;
  profile: RouteProfile;
  followWays: boolean;
  status: 'routed' | 'offgrid' | 'failed';
  points: TrackPoint[];
  distanceM: number;
  elevationGainM: number;
  error?: string;
}

export interface CoursePoint {
  id: string;
  poiId?: string;
  controlPointId?: string;
  distanceAlongRouteM: number;
  snappedTrackPointId?: string;
  name: string;
  category: string;
}

export interface GpsRouteStateV1 {
  version: 1;
  trackPoints: TrackPoint[];
  routeControls: RouteControlPoint[];
  routeSpans: RouteSpan[];
  poiMarkers: PoiMarker[];
  coursePoints: CoursePoint[];
  metadata: {
    totalDistance?: number;
    totalElevationGain?: number;
    duration?: number | null;
    pointCount?: number;
  };
}

export interface AppState {
  dashTasks: Task[];
  lists: List[];
  folders: Folder[];
  timelines: Timeline[];
  listsLoading: boolean;
  trashTasks: TrashedTask[];
  trashLists: TrashedList[];
  trashFolders: TrashedFolder[];
  trashTimelines: TrashedTimeline[];
  sidebarWidth: number;
  setDashTasks: (tasks: Task[] | ((prev: Task[]) => Task[])) => void;
  setLists: (lists: List[] | ((prev: List[]) => List[])) => void;
  setFolders: (folders: Folder[] | ((prev: Folder[]) => Folder[])) => void;
  setTimelines: (timelines: Timeline[] | ((prev: Timeline[]) => Timeline[])) => void;
  updateTimeline: (timelineId: string, updates: Partial<Timeline>) => void;
  deleteTimeline: (timelineId: string) => void;
  restoreTimelineFromTrash: (trashId: number) => void;
  deleteTimelineFromTrash: (trashId: number) => void;
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
  restoreListFromTrash: (trashId: number) => void;
  deleteListFromTrash: (trashId: number) => void;
  restoreFolderFromTrash: (trashId: number) => void;
  deleteFolderFromTrash: (trashId: number) => void;
  setSidebarWidth: (w: number) => void;
  moveTaskToList: (taskId: number, targetListId: string) => void;
  loadFromApi: (workspaceId?: string) => Promise<void>;
}

// ─── POI / Waypoint Types ─────────────────────────────────────────────────────
export type PoiCategory = 'food' | 'fuel' | 'bicycle' | 'shopping' | 'kiosk';

export interface OverpassPoi {
  id: string;
  lat: number;
  lon: number;
  category: PoiCategory;
  name: string;
  tags: Record<string, string>;
}

export interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  type: string;
  address?: {
    road?: string;
    city?: string;
    town?: string;
    village?: string;
    country?: string;
    postcode?: string;
  };
}

export interface NamedPin {
  id: string;
  lat: number;
  lon: number;
  ele?: number;
  name: string;
  description?: string;
  sym: PoiCategory | 'flag' | 'generic';
  highlighted: boolean;
  addedToRoute: boolean;
  offRoad?: boolean;
  pointId?: string | null;
  originalLat?: number;
  originalLon?: number;
  linkedControlPointId?: string | null;
  distanceAlongRouteM?: number;
}

export interface NamedPinInput {
  id?: string;
  lat: number;
  lon: number;
  ele?: number;
  name: string;
  description?: string;
  sym: string;
  highlighted?: boolean;
  addedToRoute?: boolean;
  offRoad?: boolean;
  pointId?: string | null;
  originalLat?: number;
  originalLon?: number;
  linkedControlPointId?: string | null;
  distanceAlongRouteM?: number;
}
