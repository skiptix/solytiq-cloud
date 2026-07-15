import { useEffect, useState, useCallback, useRef } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import type { List, Timeline } from './types';
import useAuthStore from './store/useAuthStore';
import useAppStore from './store/useAppStore';
import useSyncStore from './store/useSyncStore';
import useMembersStore from './store/useMembersStore';
import useWorkspaceStore from './store/useWorkspaceStore';
import useInstalledAppsStore from './store/useInstalledAppsStore';
import useMarkdownListsStore from './store/useMarkdownListsStore';
import { apiCheckSetupRequired, connectSSE, disconnectSSE, setUnauthorizedHandler } from './api/client';

// Delta-sync engine is on by default; set VITE_SYNC_ENGINE=0 to fall back to the
// classic full/slice-reload loader (instant rollback without a redeploy).
const SYNC_ENGINE = import.meta.env.VITE_SYNC_ENGINE !== '0';
import { useMobile } from './hooks/useBreakpoint';

import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import AddWizard from './modals/AddWizard';
import CompletedModal from './modals/CompletedModal';
import TrashModal from './modals/TrashModal';
import WorkspaceWizard from './modals/WorkspaceWizard';
import AIAssistant from './components/AIAssistant';
import KeyboardShortcuts from './components/KeyboardShortcuts';

import LoginScreen from './screens/LoginScreen';
import SetupWizard from './screens/SetupWizard';
import NukeScreen from './screens/NukeScreen';
import OAuthConsentScreen from './screens/OAuthConsentScreen';
import DashboardScreen from './screens/DashboardScreen';
import ListScreen from './screens/ListScreen';
import TimelineScreen from './screens/TimelineScreen';
import CalendarScreen from './screens/CalendarScreen';
import FilesScreen from './screens/FilesScreen';
import GPSScreen from './screens/GPSScreen';
import GPSEditScreen from './screens/GPSEditScreen';
import SharePage from './screens/SharePage';
import SharedListPage from './screens/SharedListPage';
import SharedTimelinePage from './screens/SharedTimelinePage';
import SharedMarkdownListPage from './screens/SharedMarkdownListPage';
import SettingsScreen from './screens/SettingsScreen';
import FolderDashboardScreen from './screens/FolderDashboardScreen';
import TemplatesScreen from './screens/TemplatesScreen';
import AutomationsScreen from './screens/AutomationsScreen';
import AutomationEditorScreen from './screens/AutomationEditorScreen';
import MarkdownListScreen from './screens/MarkdownListScreen';
import ArchivedModal from './modals/ArchivedModal';
import AdminPasswordResetScreen from './screens/AdminPasswordResetScreen';

// Sign out on any 401 (expired / revoked JWT) so the user is redirected to
// /login instead of seeing the "no workspace" forced-creation wizard.
setUnauthorizedHandler(() => useAuthStore.getState().signOut());

// Which data slices a given route actually renders. Focus/online revalidation
// only refetches these — never a full 9-request reload — so alt-tabbing between
// windows can't fan out into a request storm that trips the rate limiter. Trash
// is deliberately excluded: it's only needed when the Trash modal opens.
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

// ── App Layout (authenticated pages) ──────────────────────────
function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { lists, timelines, listsLoading, loadError, sidebarWidth, setSidebarWidth, loadFromApi, setLists, updateList, moveTaskToList } = useAppStore();
  const prevWorkspaceRef = useRef<string | null | undefined>(undefined);
  const [modal, setModal] = useState<'add' | 'completed' | 'trash' | 'archived' | null>(null);
  const [addWizardMode, setAddWizardMode] = useState<'list' | 'timeline' | undefined>(undefined);
  const isMobile = useMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
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
    // Markdown Lists aren't part of the app-store snapshot/delta pipeline (a
    // SIGNAL sync entity, like templates/automations) — load them for the
    // Sidebar directly, scoped to the same workspace.
    void useMarkdownListsStore.getState().load(currentWorkspaceId);

    // Navigate to dashboard only when the user explicitly switches between two
    // real workspaces (not on initial load, and not on null → first workspace).
    if (isSwitch && prev !== null) {
      navigate('/dashboard');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspaceId]);

  // Refetch Markdown Lists when a sync frame signals a change (create/update/
  // delete on any device) — same pattern TemplatesScreen/AutomationsScreen use
  // for their own SIGNAL entity.
  const markdownListRev = useSyncStore(s => s.entityRevisions.markdownList ?? 0);
  useEffect(() => {
    if (markdownListRev === 0) return;
    void useMarkdownListsStore.getState().load(currentWorkspaceId ?? undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdownListRev]);

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

  // Close drawer on route change (mobile)
  useEffect(() => {
    if (isMobile) setDrawerOpen(false);
  }, [location.pathname, isMobile]);

  // Sidebar resize
  const handleResizeStart = useCallback((initialX: number) => {
    const startW = sidebarWidth;
    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - initialX;
      const newW = Math.max(60, Math.min(380, startW + delta));
      setSidebarWidth(newW < 140 ? 60 : newW);
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
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

  const getActive = (): 'dashboard' | 'calendar' | 'files' | 'list' | 'timeline' | 'settings' | 'folder' | 'gps' | 'templates' | 'automations' | 'markdownList' => {
    if (location.pathname.startsWith('/folder/')) return 'folder';
    if (location.pathname.startsWith('/list/')) return 'list';
    if (location.pathname.startsWith('/timeline/')) return 'timeline';
    if (location.pathname.startsWith('/calendar')) return 'calendar';
    if (location.pathname.startsWith('/files')) return 'files';
    if (location.pathname.startsWith('/settings')) return 'settings';
    if (location.pathname.startsWith('/gps')) return 'gps';
    if (location.pathname.startsWith('/templates')) return 'templates';
    if (location.pathname.startsWith('/automations')) return 'automations';
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
      {/* Mobile sidebar backdrop */}
      {isMobile && drawerOpen && (
        <div
          onClick={() => setDrawerOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 39,
            background: 'rgba(0,0,0,0.32)',
            backdropFilter: 'blur(2px)',
            animation: 'backdropIn 180ms ease both',
          }}
        />
      )}
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
      />
      <div style={{ marginLeft: isMobile ? 0 : sidebarWidth, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        <TopBar
          onNavigate={navigate}
          isMobile={isMobile}
          onOpenDrawer={() => setDrawerOpen(true)}
        />
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', position: 'relative' }}>
          {/* Keying by pathname re-mounts the screen on navigation, replaying the
              `pageIn` animation for a smooth transition between pages/items. */}
          <div key={location.pathname} className="page-transition" style={{ flex: 1, display: 'flex', minWidth: 0, animation: 'pageIn 300ms cubic-bezier(0.22,1,0.36,1) both' }}>
            <Routes location={location}>
              <Route path="/dashboard" element={<DashboardScreen />} />
              <Route path="/folder/:folderId" element={<FolderDashboardScreen />} />
              <Route path="/calendar" element={<CalendarScreen />} />
              <Route path="/files" element={!appsLoaded ? null : filesInstalled ? <FilesScreen /> : <Navigate to="/dashboard" replace />} />
              <Route path="/list/:listId" element={<ListScreen />} />
              <Route path="/timeline/:timelineId" element={<TimelineScreen />} />
              <Route path="/settings" element={<SettingsScreen />} />
              <Route path="/templates" element={<TemplatesScreen />} />
              <Route path="/automations" element={!appsLoaded ? null : automationsInstalled ? <AutomationsScreen /> : <Navigate to="/dashboard" replace />} />
              <Route path="/automations/:id" element={!appsLoaded ? null : automationsInstalled ? <AutomationEditorScreen /> : <Navigate to="/dashboard" replace />} />
              <Route path="/gps" element={!appsLoaded ? null : gpsInstalled ? <GPSScreen /> : <Navigate to="/dashboard" replace />} />
              <Route path="/markdown-list/:id" element={<MarkdownListScreen />} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </div>

          {currentWorkspaceId && lists.length === 0 && timelines.length === 0 && !listsLoading && getActive() === 'dashboard' && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, zIndex: 10, background: 'rgba(247,242,252,0.90)', backdropFilter: 'blur(10px)', animation: 'backdropIn 220ms ease both' }}>
              <div style={{ width: 72, height: 72, borderRadius: 20, background: '#ede9fe', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 36 }}>📋</span>
              </div>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 22, fontWeight: 700, color: '#1c1b22' }}>No to-dos yet</div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#787584', textAlign: 'center', maxWidth: 280, lineHeight: 1.6 }}>
                This workspace is empty. Create your first to-do to get started.
              </div>
              <button
                onClick={() => setModal('add')}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 24px', borderRadius: 12, border: 'none', background: '#5e4dbb', color: '#fff', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 600, cursor: 'pointer', boxShadow: '0 4px 16px rgba(94,77,187,0.35)', transition: 'all 150ms' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#4d3da8')}
                onMouseLeave={e => (e.currentTarget.style.background = '#5e4dbb')}
              >
                <span style={{ fontSize: 18, lineHeight: 1 }}>+</span>
                Create To-Do
              </button>
            </div>
          )}
        </div>
      </div>

      {modal === 'add' && (
        <AddWizard
          initialMode={addWizardMode}
          onClose={() => setModal(null)}
          onCreatedList={(_list: List) => { setModal(null); navigate(`/list/${_list.id}`); }}
          onCreatedTimeline={(_t: Timeline) => { setModal(null); navigate(`/timeline/${_t.id}`); }}
          onCreatedMarkdownList={(_md) => { setModal(null); navigate(`/markdown-list/${_md.id}`); }}
        />
      )}
      {modal === 'completed' && <CompletedModal onClose={() => setModal(null)} />}
      {modal === 'trash' && <TrashModal onClose={() => setModal(null)} />}
      {modal === 'archived' && <ArchivedModal onClose={() => setModal(null)} />}
      <AIAssistant />
      <KeyboardShortcuts />

      {/* Data-load failure surface: retries are automatic, but a persistent
          failure must be visible — a silently empty sidebar looks like data
          loss. The previous slices stay rendered while this is shown. */}
      {loadError && (
        <div style={{ position: 'fixed', bottom: 20, left: '50%', marginLeft: -170, width: 340, maxWidth: 'calc(100vw - 32px)', zIndex: 500, display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderRadius: 12, background: '#fff', border: '1px solid #e8e4f0', boxShadow: '0 8px 32px rgba(0,0,0,0.14)', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#1c1b22', animation: 'menuIn 200ms ease both' }}>
          <span style={{ color: '#ba1a1a', fontWeight: 600 }}>Couldn't refresh your data.</span>
          <button
            onClick={() => (SYNC_ENGINE ? useSyncStore.getState().bootstrap(currentWorkspaceId ?? undefined) : loadFromApi(currentWorkspaceId ?? undefined))}
            style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: 8, border: 'none', background: '#5e4dbb', color: '#fff', fontFamily: 'Hanken Grotesk, sans-serif', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#4d3da8')}
            onMouseLeave={e => (e.currentTarget.style.background = '#5e4dbb')}
          >
            Retry
          </button>
        </div>
      )}

      {workspacesLoaded && workspaces.length === 0 && !location.pathname.startsWith('/settings') && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 450, backdropFilter: 'blur(10px)', background: 'rgba(245,243,255,0.65)', pointerEvents: 'all' }} />
          <WorkspaceWizard forced onClose={() => {}} />
        </>
      )}
    </div>
  );
}

// ── Root App ───────────────────────────────────────────────────
export default function App() {
  const { loggedIn, adminRegistered, isAdmin } = useAuthStore();
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

  const gpsInstalled = installedApps.includes('gps');

  return (
    <Routes>
      <Route path="/share/list/:token" element={<SharedListPage />} />
      <Route path="/share/timeline/:token" element={<SharedTimelinePage />} />
      <Route path="/share/markdown-list/:token" element={<SharedMarkdownListPage />} />
      <Route path="/share/:token" element={<SharePage />} />
      <Route path="/oauth/consent" element={loggedIn ? <OAuthConsentScreen /> : <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />} />
      <Route path="/login" element={loggedIn ? <Navigate to="/dashboard" replace /> : setupRequired === true ? <Navigate to="/setup" replace /> : <LoginScreen />} />
      <Route path="/setup" element={loggedIn ? <Navigate to="/dashboard" replace /> : <SetupWizard />} />
      <Route path="/admin-reset" element={loggedIn ? <Navigate to="/dashboard" replace /> : <AdminPasswordResetScreen />} />
      <Route path="/nuke" element={loggedIn && isAdmin ? <NukeScreen /> : <Navigate to={loggedIn ? '/dashboard' : '/login'} replace />} />
      <Route path="/gps/:id/edit" element={
        !loggedIn ? <Navigate to="/login" replace /> :
        !appsLoaded ? null :
        gpsInstalled ? <GPSEditScreen /> : <Navigate to="/dashboard" replace />
      } />
      <Route path="/*" element={
        <Protected>
          <AppLayout />
        </Protected>
      } />
      <Route path="/" element={
        loggedIn ? <Navigate to="/dashboard" replace /> :
        (setupRequired === null ? null : setupRequired ? <Navigate to="/setup" replace /> : <Navigate to="/login" replace />)
      } />
    </Routes>
  );
}
