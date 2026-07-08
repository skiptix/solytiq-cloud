import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiUpdateShortcuts } from '../api/client';
import type { ShortcutOverride } from '../shortcuts/registry';

interface ShortcutsState {
  overrides: Record<string, ShortcutOverride>;
  /** Overwrites local state with the server's copy (called after login/register/2FA). */
  hydrate: (overrides: Record<string, ShortcutOverride> | undefined | null) => void;
  reset: () => void;
  setKey: (id: string, key: string) => void;
  setEnabled: (id: string, enabled: boolean) => void;
  resetOne: (id: string) => void;
  resetAll: () => void;
}

// Best-effort sync — local state is already updated optimistically, so a
// failed request just means the next successful save wins.
const persistToServer = (overrides: Record<string, ShortcutOverride>) => {
  apiUpdateShortcuts(overrides).catch(() => {});
};

const useShortcutsStore = create<ShortcutsState>()(
  persist(
    (set, get) => ({
      overrides: {},

      hydrate: (overrides) => set({ overrides: overrides ?? {} }),

      reset: () => set({ overrides: {} }),

      setKey: (id, key) => {
        const next = { ...get().overrides, [id]: { ...get().overrides[id], key } };
        set({ overrides: next });
        persistToServer(next);
      },

      setEnabled: (id, enabled) => {
        const next = { ...get().overrides, [id]: { ...get().overrides[id], enabled } };
        set({ overrides: next });
        persistToServer(next);
      },

      resetOne: (id) => {
        const next = { ...get().overrides };
        delete next[id];
        set({ overrides: next });
        persistToServer(next);
      },

      resetAll: () => {
        set({ overrides: {} });
        persistToServer({});
      },
    }),
    { name: 'solytiq_shortcuts' }
  )
);

export default useShortcutsStore;
