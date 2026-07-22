import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiLogin, apiRegister } from '../api/client';
import useUserPrefsStore from './useUserPrefsStore';
import useShortcutsStore from './useShortcutsStore';
import useNotificationsStore from './useNotificationsStore';
import { clearAppStore } from './useAppStore';
import { clearWorkspaceStore } from './useWorkspaceStore';
import type { AuthState, AuthUser } from '../types';

const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      adminRegistered: false,
      loggedIn: false,
      userId: null,
      username: '',
      email: '',
      fullName: '',
      profileImage: null,
      isAdmin: false,
      token: null,
      totpEnabled: false,

      register: async ({ username, email, password, setupToken }) => {
        const data = await apiRegister(username, email, password, setupToken);
        localStorage.setItem('solytiq_token', data.token);
        set({
          adminRegistered: true,
          loggedIn: true,
          userId: data.user.id,
          username: data.user.username,
          email: data.user.email,
          fullName: data.user.fullName || '',
          profileImage: (data.user as { profileImage?: string | null }).profileImage ?? null,
          isAdmin: (data.user as { isAdmin?: boolean }).isAdmin ?? false,
          totpEnabled: false,
          token: data.token,
        });
        useShortcutsStore.getState().hydrate(data.user.keyboardShortcuts);
      },

      signIn: async (username, password) => {
        try {
          const data = await apiLogin(username, password);
          if (data.requires2FA || !data.token || !data.user) return false;
          localStorage.setItem('solytiq_token', data.token);
          set({
            adminRegistered: true,
            loggedIn: true,
            userId: data.user.id,
            username: data.user.username,
            email: data.user.email,
            fullName: data.user.fullName || '',
            profileImage: data.user.profileImage ?? null,
            isAdmin: data.user.isAdmin ?? false,
            totpEnabled: data.user.totpEnabled ?? false,
            token: data.token,
          });
          useShortcutsStore.getState().hydrate(data.user.keyboardShortcuts);
          return true;
        } catch {
          return false;
        }
      },

      setAuthFromToken: (token: string, user: AuthUser) => {
        localStorage.setItem('solytiq_token', token);
        set({
          adminRegistered: true,
          loggedIn: true,
          userId: user.id,
          username: user.username,
          email: user.email,
          fullName: user.fullName || '',
          profileImage: user.profileImage ?? null,
          isAdmin: user.isAdmin ?? false,
          totpEnabled: user.totpEnabled ?? false,
          token,
        });
        useShortcutsStore.getState().hydrate(user.keyboardShortcuts);
      },

      setTotpEnabled: (enabled: boolean) => {
        set({ totpEnabled: enabled });
      },

      signOut: () => {
        localStorage.removeItem('solytiq_token');
        // Forget session-scoped UI preferences (calendar view + filter).
        useUserPrefsStore.getState().resetCalendarPrefs();
        useShortcutsStore.getState().reset();
        useNotificationsStore.getState().reset();
        clearAppStore();
        clearWorkspaceStore();
        set({
          loggedIn: false,
          userId: null,
          username: '',
          email: '',
          fullName: '',
          profileImage: null,
          isAdmin: false,
          totpEnabled: false,
          token: null,
        });
      },

      setProfile: (data) => {
        set((state) => ({
          username: data.username ?? state.username,
          email: data.email ?? state.email,
          fullName: data.fullName ?? state.fullName,
          profileImage: data.profileImage !== undefined ? data.profileImage : state.profileImage,
        }));
      },
    }),
    {
      name: 'solytiq_auth',
    }
  )
);

export default useAuthStore;
