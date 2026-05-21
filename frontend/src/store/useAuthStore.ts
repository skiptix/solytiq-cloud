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
      profileImage: null,
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
          profileImage: (data.user as { profileImage?: string | null }).profileImage ?? null,
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
            profileImage: (data.user as { profileImage?: string | null }).profileImage ?? null,
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
          profileImage: null,
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
