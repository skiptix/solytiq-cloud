import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiLogin, apiRegister } from '../api/client';
import type { AuthState } from '../types';

const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      adminRegistered: false,
      loggedIn: false,
      userId: null,
      username: '',
      email: '',
      fullName: '',
      token: null,

      register: async ({ username, email, password }) => {
        const data = await apiRegister(username, email, password);
        localStorage.setItem('solytiq_token', data.token);
        set({
          adminRegistered: true,
          loggedIn: true,
          userId: data.user.id,
          username: data.user.username,
          email: data.user.email,
          fullName: data.user.fullName || '',
          token: data.token,
        });
      },

      signIn: async (username, password) => {
        try {
          const data = await apiLogin(username, password);
          localStorage.setItem('solytiq_token', data.token);
          set({
            adminRegistered: true,
            loggedIn: true,
            userId: data.user.id,
            username: data.user.username,
            email: data.user.email,
            fullName: data.user.fullName || '',
            token: data.token,
          });
          return true;
        } catch {
          return false;
        }
      },

      signOut: () => {
        localStorage.removeItem('solytiq_token');
        set({
          loggedIn: false,
          userId: null,
          username: '',
          email: '',
          fullName: '',
          token: null,
        });
      },

      setProfile: (data) => {
        set((state) => ({
          username: data.username ?? state.username,
          email: data.email ?? state.email,
          fullName: data.fullName ?? state.fullName,
        }));
      },
    }),
    {
      name: 'solytiq_auth',
    }
  )
);

export default useAuthStore;
