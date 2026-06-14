import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UserPrefsState {
  timezone: string;
  setTimezone: (tz: string) => void;
}

const useUserPrefsStore = create<UserPrefsState>()(
  persist(
    (set) => ({
      // Default: browser's local timezone — users get correct behaviour immediately.
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,

      setTimezone: (tz: string) => set({ timezone: tz }),
    }),
    {
      name: 'solytiq_user_prefs',
    }
  )
);

export default useUserPrefsStore;
