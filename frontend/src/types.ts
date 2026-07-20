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
  /** When true, `note` is authored as Markdown and rendered formatted. */
  noteMarkdown?: boolean;
  workspaceId?: string;
  _source?: 'dash' | 'list';
  _listId?: string;
  _listName?: string;
  linkedListId?: string | null;
  linkedListType?: 'sublist' | 'link' | null;
  attachmentCount?: number;
  createdAt?: string;
  /** Set the moment `checked` flips true; cleared when unchecked. Drives the Timeline view's bar end. */
  completedAt?: string | null;
}

/** One row from a task's audit trail — backs the Timeline view's per-task
 *  change markers and TaskDialog's "Change history" panel. Written by the
 *  backend whenever title/note/deadline/priority/badge/section actually
 *  changes (user edit or an Automation Hub action). */
export interface TaskChangeLogEntry {
  id: number;
  taskId: number;
  field: 'title' | 'note' | 'deadline' | 'priority' | 'badge' | 'section';
  oldValue: string | null;
  newValue: string | null;
  actorType: 'user' | 'automation';
  /** User id (actorType 'user') or automation id (actorType 'automation'). */
  actorId: string | null;
  actorName: string | null;
  changedAt: string;
}

export type MeetingRecurrenceFreq = 'daily' | 'weekly' | 'monthly' | 'yearly';

/** Repeat preset for a new meeting series — expanded server-side into one row
 *  per occurrence (all sharing `recurrenceId`) at creation time. */
export interface MeetingRecurrenceRule {
  freq: MeetingRecurrenceFreq;
  interval: number; // e.g. freq=weekly interval=2 -> every 2 weeks
  count: number;     // total occurrences including the first
}

/** A standalone calendar event that belongs to no list/timeline/workspace —
 *  it lives purely on the Calendar, owned by one user who may invite other
 *  instance users onto it (see `attendeeIds`). */
export interface Meeting {
  id: string;
  title: string;
  description?: string | null;
  location?: string | null;
  date: string;              // YYYY-MM-DD
  startTime?: string | null; // HH:MM (24h)
  endTime?: string | null;   // HH:MM (24h)
  allDay?: boolean;
  color?: string | null;
  recurrenceId?: string | null; // shared by every occurrence of a repeating series
  organizerId?: string;      // meeting owner's user id
  isOwner?: boolean;         // true when the requesting user is the organizer
  attendeeIds?: string[];    // other instance users invited onto this meeting
  createdAt?: string;
  updatedAt?: string;
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
  shareViewMode?: 'list' | 'kanban' | 'timeline' | null;   // which layout the public share page renders — null falls back to viewMode
  version?: number;   // optimistic-concurrency token (bumps on every server-side update)
  viewMode?: 'list' | 'kanban' | 'timeline';   // To-Do screen's layout — persisted per list, synced across devices
  isArchived?: boolean;   // hidden from the normal workspace view; see the Archived modal
  archivedAt?: string | null;
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
  /** When true, `description` is authored as Markdown and rendered formatted. */
  descriptionMarkdown?: boolean;
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
  version?: number;   // optimistic-concurrency token (bumps on every server-side update)
  milestones: Milestone[];
}

export interface TrashedTimeline {
  id: number;
  timelineId: string;
  timeline: Timeline;
  deletedAt: string;
  expiresAt: string;
}

export interface TrashedMilestone {
  id: number;
  milestoneId: string;
  timelineId: string;
  milestone: Milestone;
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
  bundleId?: string | null;
  bundleName?: string | null;
  bundleCount?: number;
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

// ─── Templates ─────────────────────────────────────────────────────────────
// User-owned, workspace-agnostic snapshots of a list's or timeline's full
// structure, reusable to create new lists/timelines. `isShared` makes a
// template visible (read-only for non-owners) to every other user of this
// instance. The captured structure itself isn't sent to the client except
// when instantiating server-side — the gallery only needs `summary` counts.
export interface Template {
  id: string;
  type: 'list' | 'timeline';
  name: string;
  description?: string | null;
  emoji?: string | null;
  color?: string | null;
  colorBg?: string | null;
  isShared: boolean;
  isOwner: boolean;
  ownerName?: string | null;
  createdAt: string;
  updatedAt: string;
  summary: { sectionCount?: number; taskCount?: number; milestoneCount?: number };
}

// Full captured tree — only fetched when editing a template's structure
// (GET/PUT /api/templates/:id/structure), never included in the gallery list.
// Dates are day-offsets relative to "today", not absolute — see backend
// templateUtil.ts.
export interface TemplateAttachmentRef {
  sharedFileId: string;
  title: string;
}

export interface TemplateTaskNode {
  title: string;
  note: string | null;
  noteMarkdown?: boolean;
  priority: string | null;
  badge: string | null;
  position: number;
  deadlineOffsetDays: number | null;
  timeVal: string | null;
  attachments: TemplateAttachmentRef[];
  sublist?: TemplateListNode;
}

export interface TemplateSectionNode {
  label: string;
  emoji: string | null;
  position: number;
  tasks: TemplateTaskNode[];
}

export interface TemplateListNode {
  version: 1;
  name: string;
  emoji: string | null;
  color: string | null;
  colorBg: string | null;
  isPublic: boolean;
  sections: TemplateSectionNode[];
}

export interface TemplateMilestoneNode {
  title: string;
  description: string | null;
  descriptionMarkdown?: boolean;
  status: string;
  emoji: string | null;
  color: string | null;
  position: number;
  dateOffsetDays: number | null;
  timeVal: string | null;
  attachments: TemplateAttachmentRef[];
}

export interface TemplateTimelineNode {
  version: 1;
  name: string;
  emoji: string | null;
  color: string | null;
  colorBg: string | null;
  isPublic: boolean;
  layout: string;
  milestones: TemplateMilestoneNode[];
}

// ---------------------------------------------------------------------------
// Automation Hub — per-workspace, flow-chart-style automations. V1 graphs are
// linear (one trigger node feeding one or more chained action nodes, no
// branching); the shape mirrors what @xyflow/react expects (nodes + edges +
// canvas position), validated server-side by automationGraph.ts. Every node
// produces a JSON `output` (AutomationRunStep.output); a later node's string
// params can reference an earlier one via {{trigger.x}}/{{$json.x}}/
// {{nodes.<id>.x}} tokens, resolved server-side before that node runs.
// ---------------------------------------------------------------------------

export interface AutomationParamProperty {
  type: 'string' | 'number' | 'boolean';
  label: string;
  description: string;
  optional?: boolean;
  isListId?: boolean;
  isFolderId?: boolean;
  isWorkspaceId?: boolean;
  /** Dropdown of sections belonging to whatever list `sectionListParam` (default 'targetListId') currently names — populated from the already-loaded list's own `sections`, no extra fetch. */
  isSectionId?: boolean;
  sectionListParam?: string;
  enum?: string[];
  /** Repeatable {key, value} row editor (HTTP node headers/query params). Stored as Array<{key,value}>. */
  isKeyValue?: boolean;
  /** Multi-line textarea, still a template string (expression-substituted like any other string param). */
  isLongText?: boolean;
  /** Multi-line textarea holding raw source, NOT expression-substituted (the Code action's script). */
  isCode?: boolean;
  /** Labels for a `type: 'boolean'` field's two-button toggle (defaults to Yes/No). */
  trueLabel?: string;
  falseLabel?: string;
  /** This field only renders when a sibling param equals one of the given values. */
  showIf?: { param: string; equals: string | string[] };
}

export interface AutomationParamSchema {
  type: 'object';
  properties: Record<string, AutomationParamProperty>;
}

export interface TriggerTypeDef {
  id: string;
  label: string;
  description: string;
  icon: string;
  paramsSchema: AutomationParamSchema;
  providesTask: boolean;
  providesList: boolean;
}

export interface ActionTypeDef {
  id: string;
  label: string;
  description: string;
  icon: string;
  paramsSchema: AutomationParamSchema;
  requiresTriggerTask: boolean;
  requiresTriggerList: boolean;
  /** Superseded by a consolidated Task/List/Folder node — kept resolvable (existing saved automations still use it) but hidden from the "add action" picker. */
  hidden?: boolean;
}

export interface AutomationNode {
  id: string;
  kind: 'trigger' | 'action';
  type: string;
  position: { x: number; y: number };
  params: Record<string, unknown>;
}

export interface AutomationEdge {
  id: string;
  source: string;
  target: string;
}

export interface AutomationGraph {
  version: 1;
  nodes: AutomationNode[];
  edges: AutomationEdge[];
}

export interface Automation {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  graph: AutomationGraph;
  triggerType: string;
  isOwner: boolean;
  ownerId: string;
  ownerName: string | null;
  version: number;
  nextFireAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRunStep {
  nodeId: string;
  actionType: string;
  ok: boolean;
  summary: string;
  error?: string;
  /** JSON this node produced — feeds {{$json...}}/{{nodes.<id>...}} in later nodes and the editor's Output viewer. The trigger itself appears as steps[0]. */
  output?: unknown;
}

export interface AutomationRun {
  id: string;
  triggerType: string;
  status: 'running' | 'success' | 'failed';
  steps: AutomationRunStep[];
  error: string | null;
  isTest: boolean;
  startedAt: string;
  finishedAt: string | null;
}

/** Result of a manual per-node test run (POST /api/automations/:id/test) — a
 *  real run, same shape as a persisted AutomationRun minus timestamps. */
export interface AutomationRunResult {
  runId: string;
  status: 'success' | 'failed';
  steps: AutomationRunStep[];
  error: string | null;
}

// ─── Markdown Lists ─────────────────────────────────────────────────────────
// A block-based document type authored via `/` slash commands (headings,
// paragraphs, bulleted/numbered list items, quotes, dividers, images, links,
// and checkable todo items) — a top-level entity parallel to List/Timeline,
// not a mode of List. `content` is a versioned ordered block array. Every
// `/todo` block optionally mirrors a real task in an auto-managed Todo list
// (`todoListId`) — see backend/src/routes/markdownLists.ts — so its `checked`
// state stays in sync with that list and the block can be checked off from
// either surface.
export type MarkdownBlockType =
  | 'heading'
  | 'paragraph'
  | 'bulleted-list-item'
  | 'numbered-list-item'
  | 'todo'
  | 'quote'
  | 'divider'
  | 'image'
  | 'link';

interface MarkdownBlockBase {
  id: string;
  type: MarkdownBlockType;
}

export interface MarkdownHeadingBlock extends MarkdownBlockBase {
  type: 'heading';
  level: 1 | 2 | 3;
  text: string;
}

export interface MarkdownParagraphBlock extends MarkdownBlockBase {
  type: 'paragraph';
  text: string;
}

export interface MarkdownBulletListItemBlock extends MarkdownBlockBase {
  type: 'bulleted-list-item';
  text: string;
}

export interface MarkdownNumberedListItemBlock extends MarkdownBlockBase {
  type: 'numbered-list-item';
  text: string;
}

export interface MarkdownTodoBlock extends MarkdownBlockBase {
  type: 'todo';
  text: string;
  checked: boolean;
  /** The mirrored task's id in the auto-managed Todo list, once one exists. */
  taskId: string | null;
}

export interface MarkdownQuoteBlock extends MarkdownBlockBase {
  type: 'quote';
  text: string;
}

export interface MarkdownDividerBlock extends MarkdownBlockBase {
  type: 'divider';
}

export interface MarkdownImageBlock extends MarkdownBlockBase {
  type: 'image';
  /** Resolved against `/api/markdown-lists/:markdownListId/images/:imageId` — see api/client.ts's `markdownImageUrl`. */
  imageId: string;
  caption?: string;
}

export interface MarkdownLinkBlock extends MarkdownBlockBase {
  type: 'link';
  url: string;
  title?: string;
  description?: string;
}

export type MarkdownBlock =
  | MarkdownHeadingBlock
  | MarkdownParagraphBlock
  | MarkdownBulletListItemBlock
  | MarkdownNumberedListItemBlock
  | MarkdownTodoBlock
  | MarkdownQuoteBlock
  | MarkdownDividerBlock
  | MarkdownImageBlock
  | MarkdownLinkBlock;

export interface MarkdownListContent {
  version: 1;
  blocks: MarkdownBlock[];
}

export interface MarkdownList {
  id: string;
  userId?: string;
  name: string;
  emoji?: string;
  color?: string;
  colorBg?: string;
  subtitle?: string;
  isPublic?: boolean;
  folderId?: string;
  workspaceId?: string;
  position?: number;
  content: MarkdownListContent;
  /** The auto-managed Todo list mirroring every `/todo` block, once one exists. */
  todoListId?: string | null;
  version?: number;
  // Public read-only link sharing (distinct from the workspace `isPublic` flag).
  shareEnabled?: boolean;
  shareToken?: string | null;
  shareHasPassword?: boolean;
  shareExpiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
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
  keyboardShortcuts?: Record<string, { key?: string; enabled?: boolean }>;
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
  loadError: boolean;
  trashTasks: TrashedTask[];
  trashLists: TrashedList[];
  trashFolders: TrashedFolder[];
  trashTimelines: TrashedTimeline[];
  trashMilestones: TrashedMilestone[];
  sidebarWidth: number;
  setDashTasks: (tasks: Task[] | ((prev: Task[]) => Task[])) => void;
  setLists: (lists: List[] | ((prev: List[]) => List[])) => void;
  setFolders: (folders: Folder[] | ((prev: Folder[]) => Folder[])) => void;
  setTimelines: (timelines: Timeline[] | ((prev: Timeline[]) => Timeline[])) => void;
  updateTimeline: (timelineId: string, updates: Partial<Timeline>) => void;
  deleteTimeline: (timelineId: string) => void;
  restoreTimelineFromTrash: (trashId: number) => void;
  deleteTimelineFromTrash: (trashId: number) => void;
  restoreMilestoneFromTrash: (trashId: number) => void;
  deleteMilestoneFromTrash: (trashId: number) => void;
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
  moveTaskToList: (taskId: number, targetListId: string, targetSectionId?: string) => void;
  moveTaskToDashboard: (taskId: number) => void;
  loadFromApi: (
    workspaceId?: string,
    opts?: { only?: Array<'tasks' | 'lists' | 'folders' | 'timelines' | 'trash'>; attempt?: number }
  ) => Promise<void>;
  // ── Delta-sync engine reducers ──────────────────────────────────────────────
  // Replace the four core slices wholesale from a bootstrap payload.
  hydrateFromSnapshot: (snap: { tasks: Task[]; lists: List[]; folders: Folder[]; timelines: Timeline[] }) => void;
  // Apply a batch of per-entity deltas in place (no refetch): upsert/remove the
  // single entity in the right slice by id.
  applyDeltas: (changes: Array<{ entity: string; entityId: string; op: 'upsert' | 'delete'; payload?: unknown }>) => void;
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
