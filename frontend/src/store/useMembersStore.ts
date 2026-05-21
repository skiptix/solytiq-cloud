import { create } from 'zustand';
import { apiGetMembers } from '../api/client';

export interface Member {
  id: string;
  username: string;
  email: string;
  fullName: string | null;
  profileImage: string | null;
  isAdmin: boolean;
}

interface MembersState {
  members: Record<string, Member>;
  loaded: boolean;
  load: () => Promise<void>;
}

const useMembersStore = create<MembersState>()((set, get) => ({
  members: {},
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    try {
      const res = await apiGetMembers();
      const map: Record<string, Member> = {};
      res.members.forEach(m => { map[m.id] = m; });
      set({ members: map, loaded: true });
    } catch {
      // silently fail — bubble simply won't render
    }
  },
}));

export default useMembersStore;
