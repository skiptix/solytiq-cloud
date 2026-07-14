import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type CalendarView = 'week' | 'month' | 'year';
export type ListViewMode = 'list' | 'kanban';

interface UserPrefsState {
  timezone: string;
  setTimezone: (tz: string) => void;

  // Layout newly created To-Dos start in (List or Kanban). Applied client-side
  // at creation time only — existing lists keep whatever view_mode they have.
  defaultListViewMode: ListViewMode;
  setDefaultListViewMode: (v: ListViewMode) => void;

  // ── Calendar UI preferences (persisted until logout / cache clear) ──
  calendarView: CalendarView;
  calendarHiddenWorkspaces: string[];
  setCalendarView: (v: CalendarView) => void;
  setCalendarHiddenWorkspaces: (ids: string[]) => void;
  resetCalendarPrefs: () => void;
}

const CALENDAR_DEFAULTS = {
  calendarView: 'month' as CalendarView,
  calendarHiddenWorkspaces: [] as string[],
};

const useUserPrefsStore = create<UserPrefsState>()(
  persist(
    (set) => ({
      // Default: browser's local timezone — users get correct behaviour immediately.
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,

      setTimezone: (tz: string) => set({ timezone: tz }),

      defaultListViewMode: 'list',
      setDefaultListViewMode: (v) => set({ defaultListViewMode: v }),

      ...CALENDAR_DEFAULTS,
      setCalendarView: (v) => set({ calendarView: v }),
      setCalendarHiddenWorkspaces: (ids) => set({ calendarHiddenWorkspaces: ids }),
      resetCalendarPrefs: () => set({ ...CALENDAR_DEFAULTS }),
    }),
    {
      name: 'solytiq_user_prefs',
    }
  )
);

export default useUserPrefsStore;
