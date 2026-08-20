import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type CalendarView = 'week' | 'month' | 'year';
export type ListViewMode = 'list' | 'kanban';
/** The three event families the Calendar can show; any can be hidden. */
export type CalendarKind = 'task' | 'milestone' | 'meeting';

interface UserPrefsState {
  timezone: string;
  setTimezone: (tz: string) => void;

  // Layout newly created Boards start in (List or Kanban). Applied client-side
  // at creation time only — existing lists keep whatever view_mode they have.
  defaultListViewMode: ListViewMode;
  setDefaultListViewMode: (v: ListViewMode) => void;

  // Per-list sidebar expand state for lists that have sublists. Absent = the
  // default collapsed state (only the parent list shows); `true` = expanded.
  // Persisted so a list stays open/closed across refreshes.
  sidebarExpandedSublists: Record<string, boolean>;
  toggleSublistExpanded: (listId: string) => void;

  // ── Calendar UI preferences (persisted until logout / cache clear) ──
  calendarView: CalendarView;
  calendarHiddenWorkspaces: string[];
  /** Event families hidden from the Calendar (e.g. ['task','milestone'] = meetings only). */
  calendarHiddenKinds: string[];
  setCalendarView: (v: CalendarView) => void;
  setCalendarHiddenWorkspaces: (ids: string[]) => void;
  setCalendarHiddenKinds: (kinds: string[]) => void;
  resetCalendarPrefs: () => void;

  // Graph Layer: which of Explore / Canvas the Graph screen last showed, kept
  // separately per workspace so a document-heavy workspace can default to a
  // different view than a task-heavy one.
  graphViewByWorkspace: Record<string, 'explore' | 'canvas'>;
  setGraphViewForWorkspace: (workspaceId: string, view: 'explore' | 'canvas') => void;

  // Graph Layer: manual node repositions in the Explore view, layered on top
  // of the auto-computed layout so a node someone dragged out of an overlap
  // stays put on reload — keyed per workspace, per this signed-in browser
  // profile (this store is entirely localStorage-backed, the same as every
  // other pref here; there is no cross-device sync).
  graphNodePositions: Record<string, Record<string, { x: number; y: number }>>;
  setGraphNodePosition: (workspaceId: string, srn: string, x: number, y: number) => void;
  clearGraphNodePositions: (workspaceId: string) => void;

  // Sol / AI Assistant: hides the floating badge trigger (desktop and
  // mobile alike) for a user who doesn't want it on screen. A display
  // preference only — it doesn't touch the feature itself, chat history, or
  // any admin-level enable/disable setting. See Account Settings → AI.
  hideAiBubble: boolean;
  setHideAiBubble: (v: boolean) => void;
}

const CALENDAR_DEFAULTS = {
  calendarView: 'month' as CalendarView,
  calendarHiddenWorkspaces: [] as string[],
  calendarHiddenKinds: [] as string[],
};

const useUserPrefsStore = create<UserPrefsState>()(
  persist(
    (set) => ({
      // Default: browser's local timezone — users get correct behaviour immediately.
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,

      setTimezone: (tz: string) => set({ timezone: tz }),

      defaultListViewMode: 'list',
      setDefaultListViewMode: (v) => set({ defaultListViewMode: v }),

      sidebarExpandedSublists: {},
      toggleSublistExpanded: (listId) => set((s) => ({
        sidebarExpandedSublists: { ...s.sidebarExpandedSublists, [listId]: !(s.sidebarExpandedSublists[listId] ?? false) },
      })),

      ...CALENDAR_DEFAULTS,
      setCalendarView: (v) => set({ calendarView: v }),
      setCalendarHiddenWorkspaces: (ids) => set({ calendarHiddenWorkspaces: ids }),
      setCalendarHiddenKinds: (kinds) => set({ calendarHiddenKinds: kinds }),
      resetCalendarPrefs: () => set({ ...CALENDAR_DEFAULTS }),

      graphViewByWorkspace: {},
      setGraphViewForWorkspace: (workspaceId, view) => set((s) => ({
        graphViewByWorkspace: { ...s.graphViewByWorkspace, [workspaceId]: view },
      })),

      graphNodePositions: {},
      setGraphNodePosition: (workspaceId, srn, x, y) => set((s) => ({
        graphNodePositions: {
          ...s.graphNodePositions,
          [workspaceId]: { ...s.graphNodePositions[workspaceId], [srn]: { x, y } },
        },
      })),
      clearGraphNodePositions: (workspaceId) => set((s) => {
        const next = { ...s.graphNodePositions };
        delete next[workspaceId];
        return { graphNodePositions: next };
      }),

      hideAiBubble: false,
      setHideAiBubble: (v) => set({ hideAiBubble: v }),
    }),
    {
      name: 'solytiq_user_prefs',
    }
  )
);

export default useUserPrefsStore;
