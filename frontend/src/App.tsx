import { useEffect, useState, useCallback } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import type { List } from './types';
import useAuthStore from './store/useAuthStore';
import useAppStore from './store/useAppStore';
import useMembersStore from './store/useMembersStore';
import useWorkspaceStore from './store/useWorkspaceStore';
import { apiCheckSetupRequired, connectSSE, disconnectSSE } from './api/client';

import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import AddListWizard from './modals/AddListWizard';
import CompletedModal from './modals/CompletedModal';
import TrashModal from './modals/TrashModal';
import AIAssistant from './components/AIAssistant';

import LoginScreen from './screens/LoginScreen';
import SetupWizard from './screens/SetupWizard';
import NukeScreen from './screens/NukeScreen';
import DashboardScreen from './screens/DashboardScreen';
import ListScreen from './screens/ListScreen';
import ScheduledScreen from './screens/ScheduledScreen';
import FilesScreen from './screens/FilesScreen';
import SharePage from './screens/SharePage';
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
  const { dashTasks, lists, sidebarWidth, setSidebarWidth, loadFromApi, setLists, setFolders, updateList, moveTaskToList } = useAppStore();
  const [modal, setModal] = useState<'add-list' | 'completed' | 'trash' | null>(null);

  const loadMembers = useMembersStore(s => s.load);
  const { currentWorkspaceId, loadWorkspaces } = useWorkspaceStore();

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

  // Reload data when active workspace changes, clearing stale workspace-scoped data first
  useEffect(() => {
    setLists([]);
    setFolders([]);
    loadFromApi(currentWorkspaceId ?? undefined);
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

  const getActive = (): 'dashboard' | 'scheduled' | 'files' | 'list' | 'settings' | 'folder' => {
    if (location.pathname.startsWith('/folder/')) return 'folder';
    if (location.pathname.startsWith('/list/')) return 'list';
    if (location.pathname.startsWith('/scheduled')) return 'scheduled';
    if (location.pathname.startsWith('/files')) return 'files';
    if (location.pathname.startsWith('/settings')) return 'settings';
    return 'dashboard';
  };

  const activeListId = location.pathname.startsWith('/list/') ? location.pathname.split('/list/')[1] : undefined;
  const activeFolderId = location.pathname.startsWith('/folder/') ? location.pathname.split('/folder/')[1] : undefined;

  const allTasks = [
    ...dashTasks.map(t => ({ ...t, _source: 'dash' as const, _listId: 'dashboard', _listName: 'Dashboard' })),
    ...lists.flatMap(l => l.sections.flatMap(s => s.tasks.map(t => ({ ...t, _source: 'list' as const, _listId: l.id, _listName: l.name })))),
  ];

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar
        active={getActive()}
        activeListId={activeListId}
        activeFolderId={activeFolderId}
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
          <Routes>
            <Route path="/dashboard" element={<DashboardScreen />} />
            <Route path="/folder/:folderId" element={<FolderDashboardScreen />} />
            <Route path="/scheduled" element={<ScheduledScreen />} />
            <Route path="/files" element={<FilesScreen />} />
            <Route path="/list/:listId" element={<ListScreen />} />
            <Route path="/settings" element={<SettingsScreen />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>

          {currentWorkspaceId && lists.length === 0 && getActive() === 'dashboard' && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, zIndex: 10, background: 'rgba(247,242,252,0.90)', backdropFilter: 'blur(10px)', animation: 'backdropIn 220ms ease both' }}>
              <div style={{ width: 72, height: 72, borderRadius: 20, background: '#ede9fe', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 36 }}>📋</span>
              </div>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 22, fontWeight: 700, color: '#1c1b22' }}>No lists yet</div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#787584', textAlign: 'center', maxWidth: 280, lineHeight: 1.6 }}>
                This workspace is empty. Create your first list to get started.
              </div>
              <button
                onClick={() => setModal('add-list')}
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

      {modal === 'add-list' && (
        <AddListWizard onClose={() => setModal(null)} onCreated={(_list: List) => { setModal(null); navigate(`/list/${_list.id}`); }} />
      )}
      {modal === 'completed' && <CompletedModal onClose={() => setModal(null)} />}
      {modal === 'trash' && <TrashModal onClose={() => setModal(null)} />}
      <AIAssistant />
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
      <Route path="/share/:token" element={<SharePage />} />
      <Route path="/login" element={loggedIn ? <Navigate to="/dashboard" replace /> : setupRequired === true ? <Navigate to="/setup" replace /> : <LoginScreen />} />
      <Route path="/setup" element={loggedIn ? <Navigate to="/dashboard" replace /> : <SetupWizard />} />
      <Route path="/nuke" element={loggedIn ? <NukeScreen /> : <Navigate to="/login" replace />} />
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
