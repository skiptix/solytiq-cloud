import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  apiDeletePushDevice,
  apiGetPushDevices,
  apiSendTestPush,
  apiUpdatePushNotificationPrefs,
  apiVerifySessionToken,
  type PushDevice,
} from '../api/client';
import {
  canRequestPush,
  ensureServiceWorker,
  getPushPermission,
  hasLocalSubscription,
  isPushSupported,
  needsHomeScreenInstall,
  requestPushPermission,
  subscribeCurrentDevice,
  unsubscribeCurrentDevice,
  type PushPermission,
} from '../utils/push';
import useAuthStore from './useAuthStore';

// ── Push notification store ───────────────────────────────────────────────────
// Owns three separate things that are easy to conflate but behave differently:
//
//   permission  — the OS-level grant. One-shot on iOS and NOT ours to change:
//                 once denied, only the user can undo it in iOS Settings.
//   subscribed  — whether THIS device currently has a push subscription. Local
//                 to the browser profile; revoking it silences one device.
//   enabled     — the account-level master switch (users.push_enabled). Server
//                 side, applies to every device at once, and survives a
//                 reinstall. This is what Settings → Notifications toggles.
//
// `promptDismissedFor` is persisted per user id so the first-launch pre-prompt
// is asked once per account rather than once per browser — a shared device
// shouldn't hide the prompt from the second person to sign in.

interface PushState {
  supported: boolean;
  /** iOS, but not installed to the Home Screen yet — can't be asked at all. */
  needsInstall: boolean;
  permission: PushPermission;
  subscribed: boolean;
  enabled: boolean;
  prefs: Record<string, boolean>;
  devices: PushDevice[];
  loading: boolean;
  /** True while the OS prompt / subscribe round trip is in flight. */
  busy: boolean;
  promptDismissedFor: Record<string, boolean>;

  init: () => Promise<void>;
  loadSettings: () => Promise<void>;
  loadDevices: () => Promise<void>;
  /** Ask for permission and register this device. Call from a click handler. */
  enablePush: () => Promise<PushPermission>;
  disableThisDevice: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  setPref: (type: string, value: boolean) => Promise<void>;
  removeDevice: (id: string) => Promise<void>;
  sendTest: () => Promise<{ ok: boolean; delivered: number }>;
  dismissPrompt: (userId: string) => void;
  shouldShowPrompt: (userId: string | null | undefined) => boolean;
  reset: () => void;
}

const usePushStore = create<PushState>()(
  persist(
    (set, get) => ({
      supported: false,
      needsInstall: false,
      permission: 'default',
      subscribed: false,
      enabled: true,
      prefs: {},
      devices: [],
      loading: false,
      busy: false,
      promptDismissedFor: {},

      /**
       * Called once after login. Registers the worker and — when permission is
       * ALREADY granted — silently re-subscribes.
       *
       * That re-subscribe is not redundant: a browser can rotate a push
       * subscription on its own, and an instance that regenerated its VAPID
       * keypair invalidates every subscription bound to the old one. Both leave
       * a device that looks subscribed but can never receive anything, and the
       * upsert here is what repairs them. It never asks for permission — that
       * needs a user gesture (see utils/push.ts).
       */
      init: async () => {
        const supported = isPushSupported();
        set({
          supported,
          needsInstall: needsHomeScreenInstall(),
          permission: getPushPermission(),
        });
        if (!supported) return;
        await ensureServiceWorker();
        if (getPushPermission() === 'granted') {
          const result = await subscribeCurrentDevice();
          set({ subscribed: result.ok, permission: result.permission });
        } else {
          set({ subscribed: await hasLocalSubscription() });
        }
      },

      loadSettings: async () => {
        const token = useAuthStore.getState().token;
        if (!token) return;
        set({ loading: true });
        try {
          const r = await apiVerifySessionToken(token);
          set({
            enabled: r.user.pushEnabled ?? true,
            prefs: r.user.pushNotificationPrefs ?? {},
          });
        } catch {
          // Leave whatever we had; the settings panel shows the last-known state
          // rather than flipping every toggle to a default that isn't the truth.
        } finally {
          set({ loading: false });
        }
      },

      loadDevices: async () => {
        try {
          const r = await apiGetPushDevices();
          set({ devices: r.subscriptions });
        } catch {
          set({ devices: [] });
        }
      },

      enablePush: async () => {
        set({ busy: true });
        try {
          if (!canRequestPush()) {
            const permission = getPushPermission();
            set({ permission, needsInstall: needsHomeScreenInstall() });
            return permission;
          }
          // requestPermission FIRST and with nothing awaited before it — iOS
          // ties the prompt to the user gesture that led here, and an
          // intervening await can lose it.
          const permission = await requestPushPermission();
          set({ permission });
          if (permission !== 'granted') return permission;

          const result = await subscribeCurrentDevice();
          set({ subscribed: result.ok });
          // A device that just opted in should also have the master switch on —
          // otherwise granting permission appears to do nothing, which reads as
          // a bug rather than as a setting they turned off some time ago.
          if (result.ok && !get().enabled) await get().setEnabled(true);
          if (result.ok) await get().loadDevices();
          return permission;
        } finally {
          set({ busy: false });
        }
      },

      disableThisDevice: async () => {
        await unsubscribeCurrentDevice();
        set({ subscribed: false });
        await get().loadDevices();
      },

      setEnabled: async (enabled) => {
        const previous = get().enabled;
        set({ enabled });
        try {
          await apiUpdatePushNotificationPrefs({ enabled });
        } catch {
          set({ enabled: previous });
        }
      },

      setPref: async (type, value) => {
        const previous = get().prefs;
        // The server REPLACES the whole map (same as the email prefs and
        // /shortcuts), so the already-merged map must be sent — sending just the
        // changed key would wipe every other preference.
        const next = { ...previous, [type]: value };
        set({ prefs: next });
        try {
          await apiUpdatePushNotificationPrefs({ prefs: next });
        } catch {
          set({ prefs: previous });
        }
      },

      removeDevice: async (id) => {
        const previous = get().devices;
        set({ devices: previous.filter((d) => d.id !== id) });
        try {
          await apiDeletePushDevice(id);
        } catch {
          set({ devices: previous });
        }
        // Revoking the row for the device you're holding leaves the browser
        // subscription orphaned, so drop that too and let the UI offer to
        // re-enable rather than silently pretending it's still on.
        set({ subscribed: await hasLocalSubscription() });
      },

      sendTest: async () => {
        try {
          return await apiSendTestPush();
        } catch {
          return { ok: false, delivered: 0 };
        }
      },

      dismissPrompt: (userId) =>
        set((s) => ({ promptDismissedFor: { ...s.promptDismissedFor, [userId]: true } })),

      /**
       * Show the first-launch pre-prompt only when it can actually lead
       * somewhere: push is supported, this platform can be asked right now, the
       * OS hasn't already answered (granted OR denied — a denial is final and
       * re-asking would just nag), and this account hasn't dismissed it.
       */
      shouldShowPrompt: (userId) => {
        const s = get();
        if (!userId || !s.supported || s.needsInstall) return false;
        if (s.permission !== 'default') return false;
        return !s.promptDismissedFor[userId];
      },

      reset: () => set({ subscribed: false, devices: [], prefs: {}, enabled: true }),
    }),
    {
      name: 'solytiq_push',
      // Only the dismissal record is worth persisting. Everything else is
      // re-derived from the browser and the server on init(), and a cached
      // `permission`/`subscribed` would go stale the moment the user changed
      // something in iOS Settings — the one place we can't observe.
      partialize: (s) => ({ promptDismissedFor: s.promptDismissedFor }),
    }
  )
);

export default usePushStore;
