import { create } from 'zustand';
import { apiGetMembersBasic, apiGetMemberAvatar } from '../api/client';

export interface Member {
  id: string;
  username: string;
  email: string;
  fullName: string | null;
  hasImage: boolean;
  isAdmin: boolean;
}

interface MembersState {
  members: Record<string, Member>;
  // Lazily-loaded, cached avatar data URLs (null = fetched, no image set).
  avatars: Record<string, string | null>;
  loaded: boolean;
  load: () => Promise<void>;
  ensureAvatar: (id: string) => void;
}

// Tracks in-flight avatar fetches so a member rendered many times (e.g. a
// creator bubble on every task) only triggers one request.
const avatarInFlight = new Set<string>();

const useMembersStore = create<MembersState>()((set, get) => ({
  members: {},
  avatars: {},
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    try {
      const res = await apiGetMembersBasic();
      const map: Record<string, Member> = {};
      res.members.forEach(m => { map[m.id] = m; });
      set({ members: map, loaded: true });
    } catch {
      // silently fail — bubble simply won't render
    }
  },
  ensureAvatar: (id: string) => {
    const { avatars, members } = get();
    if (id in avatars || avatarInFlight.has(id)) return; // already loaded / loading
    if (members[id] && !members[id].hasImage) return;    // known to have no image
    avatarInFlight.add(id);
    apiGetMemberAvatar(id)
      .then(res => set(state => ({ avatars: { ...state.avatars, [id]: res.profileImage } })))
      .catch(() => { /* leave uncached — a later render can retry */ })
      .finally(() => { avatarInFlight.delete(id); });
  },
}));

export default useMembersStore;
