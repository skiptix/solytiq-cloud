import { create } from 'zustand';
import { apiGetFeatureFlags } from '../api/client';

interface InstalledAppsState {
  installedApps: string[];
  loaded: boolean;
  isInstalled: (appId: string) => boolean;
  setInstalledApps: (ids: string[]) => void;
  load: () => Promise<void>;
}

// Lightweight, unpersisted — which admin-installable apps (Settings → System
// → Discover Apps) are currently switched on. Loaded once per session via the
// feature-flags endpoint (same call the 2FA/MCP/mobile flags already ride on)
// and patched locally by AppsStoreModal after an install/uninstall so the
// sidebar/routes update immediately without a full refetch.
const useInstalledAppsStore = create<InstalledAppsState>()((set, get) => ({
  installedApps: [],
  loaded: false,

  isInstalled: (appId) => get().installedApps.includes(appId),

  setInstalledApps: (ids) => set({ installedApps: ids, loaded: true }),

  load: async () => {
    try {
      const res = await apiGetFeatureFlags();
      set({ installedApps: res.installedApps ?? [], loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
}));

export default useInstalledAppsStore;
