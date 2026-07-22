import { create } from 'zustand';
import {
  apiGetNotifications,
  apiGetNotificationUnreadCount,
  apiMarkNotificationRead,
  apiMarkAllNotificationsRead,
  apiDismissNotification,
  apiClearNotifications,
  type AppNotification,
} from '../api/client';

// ── Notification feed store ───────────────────────────────────────────────────
// Backs both the TopBar bell (unread badge + slide-in panel) and the Dashboard
// feed. Live updates ride the existing sync pipeline: App.tsx bumps
// `entityRevisions.notification` on an SSE signal and calls `syncRefresh()` here,
// which refreshes the badge count (always) and the loaded feed (if it's shown).
// Mutations are optimistic — the UI updates immediately and only rolls back the
// count via a fresh server count if the request fails.

const PAGE_SIZE = 30;

interface NotificationsState {
  items: AppNotification[];
  unreadCount: number;
  loaded: boolean;
  loading: boolean;
  hasMore: boolean;
  panelOpen: boolean;

  setPanelOpen: (open: boolean) => void;
  load: () => Promise<void>;
  loadMore: () => Promise<void>;
  refreshCount: () => Promise<void>;
  syncRefresh: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
  reset: () => void;
}

const useNotificationsStore = create<NotificationsState>()((set, get) => ({
  items: [],
  unreadCount: 0,
  loaded: false,
  loading: false,
  hasMore: false,
  panelOpen: false,

  setPanelOpen: (open) => {
    set({ panelOpen: open });
    if (open) void get().load();
  },

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const res = await apiGetNotifications({ limit: PAGE_SIZE });
      set({ items: res.notifications, unreadCount: res.unreadCount, hasMore: res.hasMore, loaded: true });
    } catch {
      /* transient — the next signal / open retries */
    } finally {
      set({ loading: false });
    }
  },

  loadMore: async () => {
    const { items, loading, hasMore } = get();
    if (loading || !hasMore || items.length === 0) return;
    set({ loading: true });
    try {
      const before = items[items.length - 1].createdAt;
      const res = await apiGetNotifications({ limit: PAGE_SIZE, before });
      set((s) => ({ items: [...s.items, ...res.notifications], unreadCount: res.unreadCount, hasMore: res.hasMore }));
    } catch {
      /* ignore */
    } finally {
      set({ loading: false });
    }
  },

  refreshCount: async () => {
    try {
      const res = await apiGetNotificationUnreadCount();
      set({ unreadCount: res.unreadCount });
    } catch {
      /* ignore */
    }
  },

  // Called on an SSE `notification` signal. Once any surface has loaded the feed
  // (the panel or the Dashboard block), keep it fresh; otherwise just refresh the
  // cheap badge count.
  syncRefresh: async () => {
    if (get().panelOpen || get().loaded) await get().load();
    else await get().refreshCount();
  },

  markRead: async (id) => {
    const target = get().items.find((n) => n.id === id);
    if (!target || target.read) return;
    set((s) => ({
      items: s.items.map((n) => (n.id === id ? { ...n, read: true } : n)),
      unreadCount: Math.max(0, s.unreadCount - 1),
    }));
    try {
      await apiMarkNotificationRead(id);
    } catch {
      void get().refreshCount();
    }
  },

  markAllRead: async () => {
    set((s) => ({ items: s.items.map((n) => ({ ...n, read: true })), unreadCount: 0 }));
    try {
      await apiMarkAllNotificationsRead();
    } catch {
      void get().refreshCount();
    }
  },

  dismiss: async (id) => {
    const target = get().items.find((n) => n.id === id);
    set((s) => ({
      items: s.items.filter((n) => n.id !== id),
      unreadCount: target && !target.read ? Math.max(0, s.unreadCount - 1) : s.unreadCount,
    }));
    try {
      await apiDismissNotification(id);
    } catch {
      void get().load();
    }
  },

  clearAll: async () => {
    set({ items: [], unreadCount: 0, hasMore: false });
    try {
      await apiClearNotifications();
    } catch {
      void get().load();
    }
  },

  reset: () => set({ items: [], unreadCount: 0, loaded: false, loading: false, hasMore: false, panelOpen: false }),
}));

export default useNotificationsStore;
