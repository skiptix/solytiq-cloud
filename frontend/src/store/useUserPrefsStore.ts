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
    }),
    {
      name: 'solytiq_user_prefs',
    }
  )
);

export default useUserPrefsStore;
