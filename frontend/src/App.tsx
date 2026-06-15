import { useEffect, useState, useCallback, useRef } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import type { List, Timeline } from './types';
import useAuthStore from './store/useAuthStore';
import useAppStore from './store/useAppStore';
import useMembersStore from './store/useMembersStore';
import useWorkspaceStore from './store/useWorkspaceStore';
import { apiCheckSetupRequired, connectSSE, disconnectSSE } from './api/client';

import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import AddWizard from './modals/AddWizard';
import CompletedModal from './modals/CompletedModal';
import TrashModal from './modals/TrashModal';
import WorkspaceWizard from './modals/WorkspaceWizard';
import AIAssistant from './components/AIAssistant';

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
import SettingsScreen from './screens/SettingsScreen';
import FolderDashboardScreen from './screens/FolderDashboardScreen';

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
  const { dashTasks, lists, timelines, listsLoading, sidebarWidth, setSidebarWidth, loadFromApi, setLists, setFolders, updateList, moveTaskToList } = useAppStore();
  const prevWorkspaceRef = useRef<string | null | undefined>(undefined);
  const [modal, setModal] = useState<'add' | 'completed' | 'trash' | null>(null);

  const loadMembers = useMembersStore(s => s.load);
  const { currentWorkspaceId, workspaces, workspacesLoaded, loadWorkspaces } = useWorkspaceStore();

  useEffect(() => {
    const init = async () => {
      await loadWorkspaces();
      loadMembers();
    };
    init();

    let debounce: ReturnType<typeof setTimeout> | null = null;
    connectSSE(() => {
      if (debounce) clearTimeout(debounce);
      const wsId = useWorkspaceStore.getState().currentWorkspaceId;
      debounce = setTimeout(() => { loadFromApi(wsId ?? undefined); }, 500);
    });

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        const wsId = useWorkspaceStore.getState().currentWorkspaceId;
        loadFromApi(wsId ?? undefined);
      }
    };
    const onOnline = () => {
      const wsId = useWorkspaceStore.getState().currentWorkspaceId;
      loadFromApi(wsId ?? undefined);
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);

    return () => {
      if (debounce) clearTimeout(debounce);
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
    const isSwitch = prev !== undefined && prev !== currentWorkspaceId;
    if (isSwitch) {
      setLists([]);
      setFolders([]);
    }

    loadFromApi(currentWorkspaceId);

    // Navigate to dashboard only when the user explicitly switches between two
    // real workspaces (not on initial load, and not on null → first workspace).
    if (isSwitch && prev !== null) {
      navigate('/dashboard');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspaceId]);

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

  const getActive = (): 'dashboard' | 'calendar' | 'files' | 'list' | 'timeline' | 'settings' | 'folder' | 'gps' => {
    if (location.pathname.startsWith('/folder/')) return 'folder';
    if (location.pathname.startsWith('/list/')) return 'list';
    if (location.pathname.startsWith('/timeline/')) return 'timeline';
    if (location.pathname.startsWith('/calendar')) return 'calendar';
    if (location.pathname.startsWith('/files')) return 'files';
    if (location.pathname.startsWith('/settings')) return 'settings';
    if (location.pathname.startsWith('/gps')) return 'gps';
    return 'dashboard';
  };

  const activeListId = location.pathname.startsWith('/list/') ? location.pathname.split('/list/')[1] : undefined;
  const activeTimelineId = location.pathname.startsWith('/timeline/') ? location.pathname.split('/timeline/')[1] : undefined;
  const activeFolderId = location.pathname.startsWith('/folder/') ? location.pathname.split('/folder/')[1] : undefined;
  const activeGpsFileId = location.pathname.startsWith('/gps') ? new URLSearchParams(location.search).get('file') ?? undefined : undefined;

  const allTasks = [
    ...dashTasks.map(t => ({ ...t, _source: 'dash' as const, _listId: 'dashboard', _listName: 'Dashboard' })),
    ...lists.flatMap(l => l.sections.flatMap(s => s.tasks.map(t => ({ ...t, _source: 'list' as const, _listId: l.id, _listName: l.name })))),
  ];

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar
        active={getActive()}
        activeListId={activeListId}
        activeTimelineId={activeTimelineId}
        activeFolderId={activeFolderId}
        activeGpsFileId={activeGpsFileId}
        lists={lists}
        width={sidebarWidth}
        onNavigate={navigate}
        onOpenModal={setModal}
        onReorderLists={handleReorderLists}
        onResizeStart={handleResizeStart}
        onTaskDropToList={moveTaskToList}
      />
      <div style={{ marginLeft: sidebarWidth, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        <TopBar
          tasks={allTasks}
          lists={lists}
          onNavigate={navigate}
        />
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', position: 'relative' }}>
          {/* Keying by pathname re-mounts the screen on navigation, replaying the
              `pageIn` animation for a smooth transition between pages/items. */}
          <div key={location.pathname} className="page-transition" style={{ flex: 1, display: 'flex', minWidth: 0, animation: 'pageIn 300ms cubic-bezier(0.22,1,0.36,1) both' }}>
            <Routes location={location}>
              <Route path="/dashboard" element={<DashboardScreen />} />
              <Route path="/folder/:folderId" element={<FolderDashboardScreen />} />
              <Route path="/calendar" element={<CalendarScreen />} />
              <Route path="/files" element={<FilesScreen />} />
              <Route path="/list/:listId" element={<ListScreen />} />
              <Route path="/timeline/:timelineId" element={<TimelineScreen />} />
              <Route path="/settings" element={<SettingsScreen />} />
              <Route path="/gps" element={<GPSScreen />} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </div>

          {currentWorkspaceId && lists.length === 0 && timelines.length === 0 && !listsLoading && getActive() === 'dashboard' && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, zIndex: 10, background: 'rgba(247,242,252,0.90)', backdropFilter: 'blur(10px)', animation: 'backdropIn 220ms ease both' }}>
              <div style={{ width: 72, height: 72, borderRadius: 20, background: '#ede9fe', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 36 }}>📋</span>
              </div>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 22, fontWeight: 700, color: '#1c1b22' }}>No lists yet</div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#787584', textAlign: 'center', maxWidth: 280, lineHeight: 1.6 }}>
                This workspace is empty. Create your first list to get started.
              </div>
              <button
                onClick={() => setModal('add')}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 24px', borderRadius: 12, border: 'none', background: '#5e4dbb', color: '#fff', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 600, cursor: 'pointer', boxShadow: '0 4px 16px rgba(94,77,187,0.35)', transition: 'all 150ms' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#4d3da8')}
                onMouseLeave={e => (e.currentTarget.style.background = '#5e4dbb')}
              >
                <span style={{ fontSize: 18, lineHeight: 1 }}>+</span>
                Create List
              </button>
            </div>
          )}
        </div>
      </div>

      {modal === 'add' && (
        <AddWizard
          onClose={() => setModal(null)}
          onCreatedList={(_list: List) => { setModal(null); navigate(`/list/${_list.id}`); }}
          onCreatedTimeline={(_t: Timeline) => { setModal(null); navigate(`/timeline/${_t.id}`); }}
        />
      )}
      {modal === 'completed' && <CompletedModal onClose={() => setModal(null)} />}
      {modal === 'trash' && <TrashModal onClose={() => setModal(null)} />}
      <AIAssistant />

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
  const { loggedIn, adminRegistered } = useAuthStore();
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);

  useEffect(() => {
    apiCheckSetupRequired().then(r => setSetupRequired(r.required)).catch(() => setSetupRequired(!adminRegistered));
  }, [adminRegistered]);

  return (
    <Routes>
      <Route path="/share/list/:token" element={<SharedListPage />} />
      <Route path="/share/timeline/:token" element={<SharedTimelinePage />} />
      <Route path="/share/:token" element={<SharePage />} />
      <Route path="/oauth/consent" element={loggedIn ? <OAuthConsentScreen /> : <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />} />
      <Route path="/login" element={loggedIn ? <Navigate to="/dashboard" replace /> : setupRequired === true ? <Navigate to="/setup" replace /> : <LoginScreen />} />
      <Route path="/setup" element={loggedIn ? <Navigate to="/dashboard" replace /> : <SetupWizard />} />
      <Route path="/nuke" element={loggedIn ? <NukeScreen /> : <Navigate to="/login" replace />} />
      <Route path="/gps/:id/edit" element={loggedIn ? <GPSEditScreen /> : <Navigate to="/login" replace />} />
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
