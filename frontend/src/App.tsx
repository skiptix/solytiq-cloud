import { useEffect, useState, useCallback, useRef, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import type { List, Timeline } from './types';
import useAuthStore from './store/useAuthStore';
import useAppStore from './store/useAppStore';
import useSyncStore from './store/useSyncStore';
import useMembersStore from './store/useMembersStore';
import useWorkspaceStore from './store/useWorkspaceStore';
import useInstalledAppsStore from './store/useInstalledAppsStore';
import useAiSkillsStore from './store/useAiSkillsStore';
import useAiMemoryStore from './store/useAiMemoryStore';
import useMarkdownListsStore from './store/useMarkdownListsStore';
import useKnowledgeBaseStore from './store/useKnowledgeBaseStore';
import useNotificationsStore from './store/useNotificationsStore';
import useSharedItemsStore from './store/useSharedItemsStore';
import { apiCheckSetupRequired, apiPingHomescreenConnection, connectSSE, disconnectSSE, setUnauthorizedHandler } from './api/client';
import { isHomeScreenApp, getOrCreateInstallId, detectHomeScreenDevice } from './utils/homescreen';

// Delta-sync engine is on by default; set VITE_SYNC_ENGINE=0 to fall back to the
// classic full/slice-reload loader (instant rollback without a redeploy).
const SYNC_ENGINE = import.meta.env.VITE_SYNC_ENGINE !== '0';
import { useMobile } from './hooks/useBreakpoint';

import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
// AddWizard/WorkspaceWizard are only ever rendered behind a boolean gate
// (opened from the sidebar's "Add" button, or the forced no-workspace
// state) — ideal, low-risk lazy-load candidates ("schwere bedarfsabhängige
// Features/Modals lazy laden").
const AddWizard = lazy(() => import('./modals/AddWizard'));
const WorkspaceWizard = lazy(() => import('./modals/WorkspaceWizard'));
import AIAssistant from './components/AIAssistant';
import KeyboardShortcuts from './components/KeyboardShortcuts';

import RouteFallback from './components/RouteFallback';
import RouteErrorBoundary from './components/RouteErrorBoundary';
import PopIn from './components/animate-ui/PopIn';
import PageIn from './components/animate-ui/PageIn';
import { EASE_STANDARD } from './components/animate-ui/motionTokens';
import MotionIn from './components/animate-ui/MotionIn';
import MotionButton from './components/animate-ui/MotionButton';
import { motion } from './components/animate-ui/motion';
import { EASE_SETTLE } from './components/animate-ui/motionTokens';

// Sprint 03, Phase 2 — "Alle Route-Screens ... lazy laden": every screen
// mounted by a <Route> below is its own chunk, fetched on first navigation
// rather than bundled into the initial app chunk. This is what brings the
// eager entry chunk from ~600kB gzip (every screen, including GPS/Leaflet,
// the Automation Hub's React Flow canvas, and every share page, all
// pre-bundled) down under the 250kB gzip budget. Combined with a shared
// <Suspense fallback={<RouteFallback />}> + <RouteErrorBoundary> around each
// <Routes> block (see AppLayout/App below) so a chunk fetch is never a blank
// screen and a chunk-load failure is recoverable instead of a white-screen
// crash.
const LoginScreen = lazy(() => import('./screens/LoginScreen'));
const SetupWizard = lazy(() => import('./screens/SetupWizard'));
const NukeScreen = lazy(() => import('./screens/NukeScreen'));
const OAuthConsentScreen = lazy(() => import('./screens/OAuthConsentScreen'));
const DashboardScreen = lazy(() => import('./screens/DashboardScreen'));
const ListScreen = lazy(() => import('./screens/ListScreen'));
const TimelineScreen = lazy(() => import('./screens/TimelineScreen'));
const CalendarScreen = lazy(() => import('./screens/CalendarScreen'));
const FilesScreen = lazy(() => import('./screens/FilesScreen'));
// GPS screens pull in Leaflet (~150kB) — must never be in the initial chunk.
const GPSScreen = lazy(() => import('./screens/GPSScreen'));
const GPSEditScreen = lazy(() => import('./screens/GPSEditScreen'));
const SharePage = lazy(() => import('./screens/SharePage'));
const SharedListPage = lazy(() => import('./screens/SharedListPage'));
const SharedTimelinePage = lazy(() => import('./screens/SharedTimelinePage'));
const SharedMarkdownListPage = lazy(() => import('./screens/SharedMarkdownListPage'));
const SharedFolderPage = lazy(() => import('./screens/SharedFolderPage'));
const SettingsScreen = lazy(() => import('./screens/SettingsScreen'));
const FolderDashboardScreen = lazy(() => import('./screens/FolderDashboardScreen'));
const TemplatesScreen = lazy(() => import('./screens/TemplatesScreen'));
const AutomationsScreen = lazy(() => import('./screens/AutomationsScreen'));
// The Graph screen pulls in sigma/graphology (~180kB gzip) — lazy-loaded so
// the primary dashboard bundle is unaffected (a hard requirement, not an
// optimization; see CLAUDE.md's Graph Layer section).
const GraphScreen = lazy(() => import('./screens/GraphScreen'));
const KnowledgeScreen = lazy(() => import('./screens/KnowledgeScreen'));
// The Automation Hub editor pulls in @xyflow/react (~90kB) — must never be
// in the initial chunk either.
const AutomationEditorScreen = lazy(() => import('./screens/AutomationEditorScreen'));
const MarkdownListScreen = lazy(() => import('./screens/MarkdownListScreen'));
const AdminPasswordResetScreen = lazy(() => import('./screens/AdminPasswordResetScreen'));
const AcceptInviteScreen = lazy(() => import('./screens/AcceptInviteScreen'));
const NotFoundScreen = lazy(() => import('./screens/NotFoundScreen'));

// Sign out on any 401 (expired / revoked JWT) so the user is redirected to
// /login instead of seeing the "no workspace" forced-creation wizard.
setUnauthorizedHandler(() => useAuthStore.getState().signOut());

// Which data slices a given route actually renders. Focus/online revalidation
// only refetches these — never a full 9-request reload — so alt-tabbing between
// windows can't fan out into a request storm that trips the rate limiter. Trash
// is deliberately excluded: it's only needed when the Trash tab (in Workspace
// Settings) opens.
function slicesForRoute(pathname: string): Array<'tasks' | 'lists' | 'folders' | 'timelines'> {
  if (pathname.startsWith('/list/')) return ['lists', 'tasks'];
  if (pathname.startsWith('/timeline/')) return ['timelines'];
  if (pathname.startsWith('/folder/')) return ['folders', 'lists', 'timelines'];
  if (pathname.startsWith('/calendar')) return ['tasks', 'lists', 'timelines'];
  if (pathname.startsWith('/dashboard')) return ['tasks', 'lists', 'timelines'];
  return ['lists'];
}

// ── Protected route wrapper ────────────────────────────────────
function Protected({ children }: { children: React.ReactNode }) {
  const { loggedIn } = useAuthStore();
  if (!loggedIn) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// Routes that live outside AppLayout (or aren't a real "screen" to resume
// on) — a persisted lastRoute is never allowed to point at one of these, so
// a stale/malformed value can't create a redirect loop or land the user
// somewhere unexpected.
const NON_RESUMABLE_ROUTE_PREFIXES = ['/login', '/setup', '/admin-reset', '/nuke', '/share', '/oauth', '/invite'];

/** The path to send an already-logged-in user to when they land on a
 *  "front door" route (app root, /login, /setup, …) — their last visited
 *  in-app screen when we have one, the dashboard otherwise. Used so opening
 *  the app in a new tab (desktop or mobile) resumes where they left off. */
function resolveHomeRoute(lastRoute: string | null | undefined): string {
  if (
    lastRoute &&
    lastRoute.startsWith('/') &&
    !lastRoute.startsWith('//') &&
    !NON_RESUMABLE_ROUTE_PREFIXES.some((p) => lastRoute.startsWith(p))
  ) {
    return lastRoute;
  }
  return '/dashboard';
}

// ── App Layout (authenticated pages) ──────────────────────────
function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { lists, loadError, sidebarWidth, setSidebarWidth, loadFromApi, setLists, updateList, moveTaskToList } = useAppStore();
  const prevWorkspaceRef = useRef<string | null | undefined>(undefined);
  const [modal, setModal] = useState<'add' | null>(null);
  const [addWizardMode, setAddWizardMode] = useState<'list' | 'timeline' | undefined>(undefined);
  const isMobile = useMobile();
  // The mobile drawer remembers WHICH navigation it was opened on, so a route
  // change closes it by derivation rather than by an effect reaching in and
  // setting it — the same key-vs-value trick useAsyncData plays (see the
  // former "Close drawer on route change" effect below, and its Sprint 03
  // note about why the ref-during-render pattern was not available here).
  // location.key, not pathname: it is React Router's identity for a history
  // entry, so opening the drawer, navigating away and navigating BACK by link
  // gives a new key and leaves it closed. Going back through history returns
  // to the same entry and restores it, which is the same thing scroll
  // restoration does and is not a bug.
  const [drawer, setDrawer] = useState<{ open: boolean; navKey: string }>({ open: false, navKey: '' });
  // Suppresses the sidebar/content width transition while the resize handle is
  // being dragged (so it tracks the cursor 1:1), while still animating smoothly
  // on a collapse/expand toggle (click or keyboard shortcut).
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const { installedApps, loaded: appsLoaded } = useInstalledAppsStore();
  const gpsInstalled = installedApps.includes('gps');
  const filesInstalled = installedApps.includes('files');
  const automationsInstalled = installedApps.includes('automations');

  // "New list" shortcut — jumps straight into list creation instead of the
  // chooser the sidebar's "Add" button opens.
  useEffect(() => {
    const onCreateList = () => { setAddWizardMode('list'); setModal('add'); };
    window.addEventListener('shortcut:create-list', onCreateList);
    return () => window.removeEventListener('shortcut:create-list', onCreateList);
  }, []);

  // "Open Knowledge" — a plain navigation, so it lives here rather than on the
  // screen itself (which isn't mounted when the shortcut is most useful).
  useEffect(() => {
    const onOpenKnowledge = () => navigate('/knowledge');
    window.addEventListener('shortcut:open-knowledge', onOpenKnowledge);
    return () => window.removeEventListener('shortcut:open-knowledge', onOpenKnowledge);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMembers = useMembersStore(s => s.load);
  const { currentWorkspaceId, workspaces, workspacesLoaded, loadWorkspaces } = useWorkspaceStore();

  useEffect(() => {
    const init = async () => {
      await loadWorkspaces();
      loadMembers();
    };
    init();

    let debounce: ReturnType<typeof setTimeout> | null = null;

    if (SYNC_ENGINE) {
      // Delta engine: every realtime frame is a nudge → pull the authoritative
      // delta (coalesced). On each (re)connect, pull once to catch up on anything
      // missed while disconnected — this is what makes reconnects bulletproof.
      connectSSE(
        (frame) => useSyncStore.getState().applyFrame(frame),
        () => { if (useSyncStore.getState().status === 'live') void useSyncStore.getState().pullDelta(); },
      );
    } else {
      // Legacy: coarse slice-refetch on channel nudges. Each `{type}` names the
      // data that changed, so we only refetch the affected slices.
      const SSE_SLICES: Record<string, Array<'tasks' | 'lists' | 'folders' | 'timelines' | 'trash'>> = {
        tasks:     ['tasks'],
        lists:     ['lists', 'tasks'],
        folders:   ['folders', 'lists'],
        timelines: ['timelines'],
        trash:     ['trash'],
      };
      let pendingSlices = new Set<'tasks' | 'lists' | 'folders' | 'timelines' | 'trash'>();
      connectSSE((frame) => {
        const type = frame.type;
        if (!type) return; // cursor frames are engine-only
        if (type === 'workspaces') {
          useWorkspaceStore.getState().loadWorkspaces();
          (['tasks', 'lists', 'folders', 'timelines', 'trash'] as const).forEach(s => pendingSlices.add(s));
        } else if (SSE_SLICES[type]) {
          SSE_SLICES[type].forEach(s => pendingSlices.add(s));
        } else {
          return; // 'files' / 'meetings' — handled by their own screens
        }
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          const slices = Array.from(pendingSlices);
          pendingSlices = new Set();
          const wsId = useWorkspaceStore.getState().currentWorkspaceId;
          loadFromApi(wsId ?? undefined, { only: slices });
        }, 500);
      });
    }

    // Regaining tab focus (or coming back online) must NOT trigger a full
    // multi-request reload — that was the single biggest driver of the reported
    // "navigating between tabs" 429 storm. With the engine on it's a single
    // coalesced delta pull; otherwise a throttled, route-scoped slice reload.
    let lastRevalidate = 0;
    const revalidate = () => {
      const now = Date.now();
      if (now - lastRevalidate < 10_000) return; // throttle: at most once / 10s
      lastRevalidate = now;
      if (SYNC_ENGINE) { void useSyncStore.getState().pullDelta(); return; }
      const wsId = useWorkspaceStore.getState().currentWorkspaceId;
      loadFromApi(wsId ?? undefined, { only: slicesForRoute(window.location.pathname) });
    };
    const onVisible = () => { if (document.visibilityState === 'visible') revalidate(); };
    const onOnline = () => revalidate();

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);

    // Belt-and-suspenders steady-state reconcile (engine only), paused while the
    // tab is hidden so a background tab is silent.
    const sweep = SYNC_ENGINE
      ? setInterval(() => {
          if (document.visibilityState === 'visible' && useSyncStore.getState().status === 'live') {
            void useSyncStore.getState().pullDelta();
          }
        }, 30000)
      : null;

    return () => {
      if (debounce) clearTimeout(debounce);
      if (sweep) clearInterval(sweep);
      disconnectSSE();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  // Reload data when the active workspace changes.
  useEffect(() => {
    // currentWorkspaceId is null when the workspace store hasn't loaded yet (e.g.
    // after cache clear). Skip and wait — loadWorkspaces() will set a real ID which
    // re-fires this effect. Calling loadFromApi(undefined) here then having it
    // preempted by the subsequent real-workspace load creates a race that discards
    // the real results and leaves lists empty.
    if (currentWorkspaceId === null) return;

    const prev = prevWorkspaceRef.current;
    prevWorkspaceRef.current = currentWorkspaceId;

    // Only treat this as a real workspace SWITCH when we already had a workspace
    // and it changed. On the initial mount / page refresh (prev === undefined)
    // we keep the persisted lists & folders visible and just revalidate them in
    // the background (stale-while-revalidate). Blanking them here caused folder
    // and list routes to momentarily see empty data and redirect to the
    // dashboard — the "folder disappears on refresh" bug.
    //
    // We no longer blank the store on a switch either: `loadFromApi` fully
    // replaces each slice on success and its load-ID/workspace guards discard
    // stale writes, so the previous workspace's data stays visible (under the
    // `listsLoading` indicator) until the new data lands. If the reload fails
    // (e.g. a 429), the old data therefore remains instead of a blank sidebar
    // that reads as data loss. Navigating to /dashboard below avoids showing a
    // stale list/folder route from the previous workspace during the swap.
    const isSwitch = prev !== undefined && prev !== currentWorkspaceId;

    if (SYNC_ENGINE) {
      // Bootstrap loads the full scoped state + resets the cursor for this view.
      void useSyncStore.getState().bootstrap(currentWorkspaceId);
    } else {
      loadFromApi(currentWorkspaceId);
    }
    // Markdown Pages aren't part of the app-store snapshot/delta pipeline (a
    // SIGNAL sync entity, like templates/automations) — load them for the
    // Sidebar directly, scoped to the same workspace.
    void useMarkdownListsStore.getState().load(currentWorkspaceId);
    // Same for the workspace's Knowledge Base — a SIGNAL entity too, and the
    // Sidebar's pinned row needs to know whether one exists before /knowledge
    // is ever opened.
    void useKnowledgeBaseStore.getState().load(currentWorkspaceId);

    // Navigate to dashboard only when the user explicitly switches between two
    // real workspaces (not on initial load, and not on null → first workspace).
    if (isSwitch && prev !== null) {
      navigate('/dashboard');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspaceId]);

  // Refetch Markdown Pages when a sync frame signals a change (create/update/
  // delete on any device) — same pattern TemplatesScreen/AutomationsScreen use
  // for their own SIGNAL entity.
  const markdownListRev = useSyncStore(s => s.entityRevisions.markdownList ?? 0);
  useEffect(() => {
    if (markdownListRev === 0) return;
    void useMarkdownListsStore.getState().load(currentWorkspaceId ?? undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdownListRev]);

  // Refresh the notification feed/badge on a `notification` sync signal — the
  // recipient's own devices are nudged when a notification is created (see the
  // sync_log trigger in the backend). Refreshes the badge always, and the
  // loaded feed when the panel is open.
  // One `knowledgeBase` signal covers base and entry mutations alike — a base
  // is small enough that a second refetch path would buy nothing.
  const knowledgeBaseRev = useSyncStore(s => s.entityRevisions.knowledgeBase ?? 0);
  useEffect(() => {
    if (knowledgeBaseRev === 0) return;
    void useKnowledgeBaseStore.getState().syncRefresh();
  }, [knowledgeBaseRev]);

  const notificationRev = useSyncStore(s => s.entityRevisions.notification ?? 0);
  useEffect(() => {
    if (notificationRev === 0) return;
    void useNotificationsStore.getState().syncRefresh();
    // A notification may be an invite to a new item — refresh "Shared with me".
    void useSharedItemsStore.getState().load();
  }, [notificationRev]);

  // Load items other users have shared with me (independent of the active
  // workspace). Refreshed on invite notifications (above) and on reconnect.
  useEffect(() => { void useSharedItemsStore.getState().load(); }, []);

  // Self-heal after a load failure. The automatic recovery paths above
  // (workspace switch, SSE, tab visibility, the browser 'online' event) only
  // fire on their own triggers — none of them are guaranteed to happen again,
  // so a transient failure could otherwise leave the "Couldn't refresh your
  // data" banner up indefinitely even once the network/server is fine again.
  // While the error is showing, keep quietly retrying in the background so
  // the app recovers on its own instead of requiring the user to notice the
  // banner and tap Retry.
  useEffect(() => {
    if (!loadError) return;
    const id = setInterval(() => {
      const wsId = useWorkspaceStore.getState().currentWorkspaceId;
      if (SYNC_ENGINE) void useSyncStore.getState().bootstrap(wsId ?? undefined);
      else loadFromApi(wsId ?? undefined);
    }, 20000);
    return () => clearInterval(id);
  }, [loadError, loadFromApi]);

  // Closing the drawer on a route change (mobile) used to be an effect that
  // called setDrawerOpen(false) — see the state declaration above for the
  // derivation that replaced it. Desktop keeps the old semantics exactly: the
  // route never closed it there, because nothing opens it there either.
  const drawerOpen = drawer.open && (!isMobile || drawer.navKey === location.key);
  const setDrawerOpen = useCallback(
    (open: boolean) => setDrawer({ open, navKey: open ? location.key : '' }),
    [location.key]
  );

  // Remember the current screen as the "resume here" target for this user's
  // next new tab / reload (desktop and mobile alike) — see resolveHomeRoute()
  // and useAuthStore's setLastRoute. Every route this effect can ever see is
  // already inside AppLayout's own <Routes>, so no further filtering is
  // needed here — see NON_RESUMABLE_ROUTE_PREFIXES for the routes outside it.
  const setLastRoute = useAuthStore((s) => s.setLastRoute);
  useEffect(() => {
    setLastRoute(location.pathname + location.search);
  }, [location.pathname, location.search, setLastRoute]);

  // Sidebar resize
  const handleResizeStart = useCallback((initialX: number) => {
    const startW = sidebarWidth;
    setSidebarResizing(true);
    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - initialX;
      const newW = Math.max(60, Math.min(380, startW + delta));
      setSidebarWidth(newW < 140 ? 60 : newW);
    };
    const onUp = () => { setSidebarResizing(false); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [sidebarWidth, setSidebarWidth]);

  const handleReorderLists = useCallback((fromId: string, toId: string) => {
    const arr = [...lists];
    const from = arr.findIndex(l => l.id === fromId);
    const to = arr.findIndex(l => l.id === toId);
    if (from === -1 || to === -1) return;
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    setLists(arr);
    // Persist new positions for all lists in the same folder
    const folderId = moved.folderId;
    arr.filter(l => l.folderId === folderId).forEach((l, i) => updateList(l.id, { position: i }));
  }, [lists, setLists, updateList]);

  const getActive = (): 'dashboard' | 'calendar' | 'files' | 'list' | 'timeline' | 'settings' | 'folder' | 'gps' | 'templates' | 'automations' | 'markdownList' | 'graph' | 'knowledge' => {
    if (location.pathname.startsWith('/folder/')) return 'folder';
    if (location.pathname.startsWith('/list/')) return 'list';
    if (location.pathname.startsWith('/timeline/')) return 'timeline';
    if (location.pathname.startsWith('/calendar')) return 'calendar';
    if (location.pathname.startsWith('/files')) return 'files';
    if (location.pathname.startsWith('/settings')) return 'settings';
    if (location.pathname.startsWith('/gps')) return 'gps';
    if (location.pathname.startsWith('/templates')) return 'templates';
    if (location.pathname.startsWith('/automations')) return 'automations';
    if (location.pathname.startsWith('/graph')) return 'graph';
    if (location.pathname.startsWith('/knowledge')) return 'knowledge';
    if (location.pathname.startsWith('/markdown-list/')) return 'markdownList';
    return 'dashboard';
  };

  const activeListId = location.pathname.startsWith('/list/') ? location.pathname.split('/list/')[1] : undefined;
  const activeTimelineId = location.pathname.startsWith('/timeline/') ? location.pathname.split('/timeline/')[1] : undefined;
  const activeFolderId = location.pathname.startsWith('/folder/') ? location.pathname.split('/folder/')[1] : undefined;
  const activeGpsFileId = location.pathname.startsWith('/gps') ? new URLSearchParams(location.search).get('file') ?? undefined : undefined;
  const activeMarkdownListId = location.pathname.startsWith('/markdown-list/') ? location.pathname.split('/markdown-list/')[1] : undefined;

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* Sprint 03, Phase 3 — skip link. The very first focusable element in
          the whole authenticated app: a keyboard/screen-reader user landing
          on any page can jump straight past the sidebar + top bar to
          `#main-content` without tabbing through every nav item first.
          Visually hidden until focused (standard skip-link pattern — off
          canvas by default, slides into view on :focus so a sighted keyboard
          user can also see where focus went). */}
      <motion.a
        href="#main-content"
        transition={{ duration: 0.15 }} style={{
          position: 'fixed',
          top: -60,
          left: 12,
          zIndex: 10000,
          background: 'var(--color-primary)',
          color: 'var(--color-white)',
          padding: '10px 16px',
          borderRadius: 8,
          fontFamily: 'var(--font-heading)',
          fontSize: 13,
          fontWeight: 600,
          textDecoration: 'none',
        }}
        onFocus={(e) => { e.currentTarget.style.top = '12px'; }}
        onBlur={(e) => { e.currentTarget.style.top = '-60px'; }}
      >
        Skip to main content
      </motion.a>
      {/* Mobile sidebar backdrop */}
      {isMobile && drawerOpen && (
        <MotionIn
          onClick={() => setDrawerOpen(false)}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18, ease: EASE_STANDARD }} style={{
            position: 'fixed', inset: 0, zIndex: 39,
            background: 'rgba(var(--color-black-rgb), 0.32)',
            backdropFilter: 'blur(2px)',
          }}
        />
      )}
      {/* `<nav>` landmark around the whole sidebar — Sidebar.tsx itself
          renders plain `<div>`s internally (it's a large, pre-existing
          component; see Sprint 03 handoff for the deeper aria-current sweep
          left for Sprint 04), so the landmark is added at this call site
          instead of touching its internals. */}
      <nav aria-label="Primary">
        <Sidebar
          active={getActive()}
          activeListId={activeListId}
          activeTimelineId={activeTimelineId}
          activeFolderId={activeFolderId}
          activeGpsFileId={activeGpsFileId}
          activeMarkdownListId={activeMarkdownListId}
          lists={lists}
          width={sidebarWidth}
          onNavigate={navigate}
          onOpenModal={(m) => { setAddWizardMode(undefined); setModal(m); }}
          onReorderLists={handleReorderLists}
          onResizeStart={handleResizeStart}
          onTaskDropToList={moveTaskToList}
          isMobile={isMobile}
          drawerOpen={drawerOpen}
          resizing={sidebarResizing}
        />
      </nav>
      <motion.div
        animate={{ marginLeft: isMobile ? 0 : sidebarWidth }}
        // No tween while the user is actively dragging the resize handle, or
        // the shell would lag behind the cursor — same condition the CSS
        // transition was suppressed under.
        transition={isMobile || sidebarResizing ? { duration: 0 } : { duration: 0.24, ease: EASE_SETTLE }}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        <TopBar
          onNavigate={navigate}
          isMobile={isMobile}
          onOpenDrawer={() => setDrawerOpen(true)}
        />
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', position: 'relative' }}>
          {/* Keying by pathname re-mounts the screen on navigation, replaying
              PageIn's entrance for a smooth transition between pages/items. */}
          <PageIn
            id="main-content"
            key={location.pathname}
            className="page-transition"
            duration={300}
            // -1 so the skip link's focus() call above lands here even
            // though a plain <main> isn't natively focusable, without adding
            // it to the normal Tab order.
            tabIndex={-1}
            style={{ flex: 1, display: 'flex', minWidth: 0, outline: 'none' }}
          >
            <RouteErrorBoundary label="This page">
              <Suspense fallback={<RouteFallback />}>
                <Routes location={location}>
                  <Route path="/dashboard" element={<DashboardScreen />} />
                  <Route path="/folder/:folderId" element={<FolderDashboardScreen />} />
                  <Route path="/calendar" element={<CalendarScreen />} />
                  <Route path="/files" element={!appsLoaded ? <RouteFallback /> : filesInstalled ? <FilesScreen /> : <Navigate to="/dashboard" replace />} />
                  <Route path="/list/:listId" element={<ListScreen />} />
                  <Route path="/timeline/:timelineId" element={<TimelineScreen />} />
                  <Route path="/settings" element={<SettingsScreen />} />
                  <Route path="/templates" element={<TemplatesScreen />} />
                  <Route path="/automations" element={!appsLoaded ? <RouteFallback /> : automationsInstalled ? <AutomationsScreen /> : <Navigate to="/dashboard" replace />} />
                  <Route path="/graph" element={<GraphScreen />} />
                  <Route path="/knowledge" element={<KnowledgeScreen />} />
                  <Route path="/automations/:id" element={!appsLoaded ? <RouteFallback /> : automationsInstalled ? <AutomationEditorScreen /> : <Navigate to="/dashboard" replace />} />
                  <Route path="/gps" element={!appsLoaded ? <RouteFallback /> : gpsInstalled ? <GPSScreen /> : <Navigate to="/dashboard" replace />} />
                  <Route path="/markdown-list/:id" element={<MarkdownListScreen />} />
                  <Route path="*" element={<NotFoundScreen standalone={false} />} />
                </Routes>
              </Suspense>
            </RouteErrorBoundary>
          </PageIn>
        </div>
      </motion.div>

      {modal === 'add' && (
        <Suspense fallback={<RouteFallback label="Loading…" />}>
          <AddWizard
            initialMode={addWizardMode}
            onClose={() => setModal(null)}
            onCreatedList={(_list: List) => { setModal(null); navigate(`/list/${_list.id}`); }}
            onCreatedTimeline={(_t: Timeline) => { setModal(null); navigate(`/timeline/${_t.id}`); }}
            onCreatedMarkdownList={(_md) => { setModal(null); navigate(`/markdown-list/${_md.id}`); }}
            onCreatedKnowledgeBase={() => { setModal(null); navigate('/knowledge'); }}
          />
        </Suspense>
      )}
      <AIAssistant />
      <KeyboardShortcuts />

      {/* Data-load failure surface: retries are automatic, but a persistent
          failure must be visible — a silently empty sidebar looks like data
          loss. The previous slices stay rendered while this is shown. */}
      {loadError && (
        <PopIn duration={200} style={{ position: 'fixed', bottom: 20, left: '50%', marginLeft: -170, width: 340, maxWidth: 'calc(100vw - 32px)', zIndex: 500, display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderRadius: 12, background: 'var(--color-white)', border: '1px solid var(--color-border)', boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.14)', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)' }}>
          <span style={{ color: 'var(--color-error)', fontWeight: 600 }}>Couldn't refresh your data.</span>
          <MotionButton
            onClick={() => (SYNC_ENGINE ? useSyncStore.getState().bootstrap(currentWorkspaceId ?? undefined) : loadFromApi(currentWorkspaceId ?? undefined))}
            style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: 8, border: 'none', background: 'var(--color-primary)', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
            whileHover={{ background: 'var(--color-purple-mid-11)' }}
            transition={{ duration: 0.15 }}
          >
            Retry
          </MotionButton>
        </PopIn>
      )}

      {workspacesLoaded && workspaces.length === 0 && !location.pathname.startsWith('/settings') && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 450, backdropFilter: 'blur(10px)', background: 'rgba(var(--color-surface-tint-rgb), 0.65)', pointerEvents: 'all' }} />
          <Suspense fallback={<RouteFallback label="Loading…" />}>
            <WorkspaceWizard forced onClose={() => {}} />
          </Suspense>
        </>
      )}
    </div>
  );
}

// ── Root App ───────────────────────────────────────────────────
export default function App() {
  const { loggedIn, adminRegistered, isAdmin, lastRoute } = useAuthStore();
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  const { installedApps, loaded: appsLoaded, load: loadInstalledApps } = useInstalledAppsStore();

  useEffect(() => {
    apiCheckSetupRequired().then(r => setSetupRequired(r.required)).catch(() => setSetupRequired(!adminRegistered));
  }, [adminRegistered]);

  // Loaded once per session as soon as the user is signed in — every route
  // that gates on an app's installed state reads from this store rather than
  // fetching its own copy (including the un-nested /gps/:id/edit route below,
  // which sits outside AppLayout).
  useEffect(() => {
    if (loggedIn) loadInstalledApps();
  }, [loggedIn, loadInstalledApps]);

  // Enabled AI Skills' name+description — feeds Sol's system prompt via
  // progressive disclosure (see buildSystemPrompt in useAIStore.ts).
  const loadEnabledSkills = useAiSkillsStore((s) => s.loadEnabled);
  useEffect(() => {
    if (loggedIn) loadEnabledSkills();
  }, [loggedIn, loadEnabledSkills]);

  // Sol's long-term memory — also feeds the system prompt directly (see
  // buildSystemPrompt in useAIStore.ts) and backs the Account Settings
  // Memory list, so it's loaded once here the same way.
  const loadMemory = useAiMemoryStore((s) => s.load);
  useEffect(() => {
    if (loggedIn) loadMemory();
  }, [loggedIn, loadMemory]);

  // iOS "Add to Home Screen" tracking — ping once on launch when running in
  // standalone display mode, then again whenever the tab regains visibility
  // (covers the Home Screen icon being reopened after being backgrounded), so
  // Account Settings → Mobile can list these installs alongside native app
  // devices. A no-op on a regular browser tab.
  useEffect(() => {
    if (!loggedIn || !isHomeScreenApp()) return;
    const installId = getOrCreateInstallId();
    const device = detectHomeScreenDevice();
    const ping = () => { apiPingHomescreenConnection(installId, device).catch(() => {}); };
    ping();
    const onVisible = () => { if (document.visibilityState === 'visible') ping(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loggedIn]);

  const gpsInstalled = installedApps.includes('gps');

  return (
    <RouteErrorBoundary label="Solytiq Cloud">
      <Suspense fallback={<RouteFallback label="Loading Solytiq Cloud…" />}>
        <Routes>
          <Route path="/share/list/:token" element={<SharedListPage />} />
          <Route path="/share/timeline/:token" element={<SharedTimelinePage />} />
          <Route path="/share/markdown-list/:token" element={<SharedMarkdownListPage />} />
          <Route path="/share/folder/:token" element={<SharedFolderPage />} />
          <Route path="/share/:token" element={<SharePage />} />
          <Route path="/oauth/consent" element={loggedIn ? <OAuthConsentScreen /> : <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />} />
          <Route path="/login" element={loggedIn ? <Navigate to={resolveHomeRoute(lastRoute)} replace /> : setupRequired === true ? <Navigate to="/setup" replace /> : setupRequired === null ? <RouteFallback /> : <LoginScreen />} />
          <Route path="/setup" element={loggedIn ? <Navigate to={resolveHomeRoute(lastRoute)} replace /> : <SetupWizard />} />
          <Route path="/admin-reset" element={loggedIn ? <Navigate to={resolveHomeRoute(lastRoute)} replace /> : <AdminPasswordResetScreen />} />
          <Route path="/invite/:token" element={<AcceptInviteScreen />} />
          <Route path="/nuke" element={loggedIn && isAdmin ? <NukeScreen /> : <Navigate to={loggedIn ? '/dashboard' : '/login'} replace />} />
          <Route path="/gps/:id/edit" element={
            !loggedIn ? <Navigate to="/login" replace /> :
            !appsLoaded ? <RouteFallback /> :
            gpsInstalled ? <GPSEditScreen /> : <Navigate to="/dashboard" replace />
          } />
          <Route path="/*" element={
            <Protected>
              <AppLayout />
            </Protected>
          } />
          <Route path="/" element={
            loggedIn ? <Navigate to={resolveHomeRoute(lastRoute)} replace /> :
            (setupRequired === null ? <RouteFallback /> : setupRequired ? <Navigate to="/setup" replace /> : <Navigate to="/login" replace />)
          } />
        </Routes>
      </Suspense>
    </RouteErrorBoundary>
  );
}
