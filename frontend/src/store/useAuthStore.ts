import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiLogin, apiRegister, apiVerifySessionToken } from '../api/client';
import useUserPrefsStore from './useUserPrefsStore';
import useShortcutsStore from './useShortcutsStore';
import useNotificationsStore from './useNotificationsStore';
import useSharedItemsStore from './useSharedItemsStore';
import useAccountsStore from './useAccountsStore';
import { clearAppStore } from './useAppStore';
import { clearWorkspaceStore } from './useWorkspaceStore';
import { clearMarkdownListsStore } from './useMarkdownListsStore';
import { clearKnowledgeBaseStore } from './useKnowledgeBaseStore';
import { clearSyncStore } from './useSyncStore';
import type { AuthState, AuthUser } from '../types';

/**
 * Wipe every PERSISTED store holding data scoped to the signed-in user, plus
 * the sync cursor. Shared by sign-out and account switching.
 *
 * This must clear the persisted stores specifically (`solytiq_app`,
 * `solytiq_workspace`, …): they survive a page load, so without this the next
 * user would rehydrate the previous one's tasks and lists straight out of
 * localStorage.
 */
function resetPerUserState(): void {
  useUserPrefsStore.getState().resetCalendarPrefs();
  useShortcutsStore.getState().reset();
  useNotificationsStore.getState().reset();
  useSharedItemsStore.getState().reset();
  clearAppStore();
  clearWorkspaceStore();
  clearMarkdownListsStore();
  clearKnowledgeBaseStore();
  clearSyncStore();
}

/** Remember a freshly authenticated account in the switcher vault. Only ever
 *  called with a token the server just issued for a real credential login. */
function rememberAccount(token: string, user: AuthUser): void {
  useAccountsStore.getState().remember({
    userId: user.id,
    username: user.username,
    fullName: user.fullName || '',
    email: user.email,
    profileImage: user.profileImage ?? null,
    isAdmin: user.isAdmin ?? false,
    token,
    addedAt: Date.now(),
  });
}

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
        rememberAccount(data.token, data.user as AuthUser);
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
          rememberAccount(data.token, data.user as AuthUser);
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
        rememberAccount(token, user);
      },

      /**
       * Activate an account already present in the switcher vault.
       *
       * The stored token is re-validated against the server FIRST, and the
       * identity applied comes from that response — never from the locally
       * cached label — so a tampered vault entry cannot impersonate anyone. A
       * rejected token (expired, password changed, user deleted) drops the
       * entry and leaves the CURRENT session untouched, so a failed switch can
       * never strand the user signed out.
       */
      switchToAccount: async (userId: string) => {
        const stored = useAccountsStore.getState().usable().find((a) => a.userId === userId);
        if (!stored) return { ok: false, reason: 'missing' as const };
        if (stored.userId === useAuthStore.getState().userId) return { ok: true as const };

        let user: AuthUser;
        try {
          const res = await apiVerifySessionToken(stored.token);
          user = res.user as AuthUser;
        } catch {
          // Only this account's session is dead — forget it, stay signed in as
          // whoever we are now, and let the caller prompt for a fresh login.
          useAccountsStore.getState().forget(userId);
          return { ok: false, reason: 'expired' as const };
        }

        resetPerUserState();
        localStorage.setItem('solytiq_token', stored.token);
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
          token: stored.token,
        });
        useShortcutsStore.getState().hydrate(user.keyboardShortcuts);
        // Refresh the vault entry from the server's answer, correcting any
        // drift (renames, avatar changes) since this account was added.
        rememberAccount(stored.token, user);

        // Hard reload rather than a client-side navigate. Beyond the persisted
        // stores cleared above, plenty of in-memory ones hold per-user data
        // (members, templates, automations, graph, agent, AI, GPS…), and
        // App.tsx's loader effect keys on `currentWorkspaceId`, which a switch
        // doesn't necessarily change — so it wouldn't refire. Reloading gives
        // the new account a genuinely clean process instead of depending on
        // every present AND future store being remembered here.
        window.location.assign('/dashboard');
        return { ok: true as const };
      },

      setTotpEnabled: (enabled: boolean) => {
        set({ totpEnabled: enabled });
      },

      signOut: () => {
        localStorage.removeItem('solytiq_token');
        // Drop this account from the switcher too. Signing out is an explicit
        // "end this session", and when the global 401 handler calls us the
        // token is already dead — either way it must not stay offerable as a
        // switch target. Other stored accounts are left alone.
        const activeId = useAuthStore.getState().userId;
        if (activeId) useAccountsStore.getState().forget(activeId);
        // Forget session-scoped UI preferences (calendar view + filter) and
        // every other per-user slice.
        resetPerUserState();
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
