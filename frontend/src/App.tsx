import { useEffect, useState, useCallback } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import type { List } from './types';
import useAuthStore from './store/useAuthStore';
import useAppStore from './store/useAppStore';
import useMembersStore from './store/useMembersStore';
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
  const { dashTasks, lists, sidebarWidth, setSidebarWidth, loadFromApi, setLists, updateList, moveTaskToList } = useAppStore();
  const [modal, setModal] = useState<'add-list' | 'completed' | 'trash' | null>(null);

  const loadMembers = useMembersStore(s => s.load);

  useEffect(() => {
    loadFromApi();
    loadMembers();

    let debounce: ReturnType<typeof setTimeout> | null = null;
    connectSSE(() => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { loadFromApi(); }, 500);
    });

    const onVisible = () => {
      if (document.visibilityState === 'visible') loadFromApi();
    };
    const onOnline = () => { loadFromApi(); };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);

    return () => {
      if (debounce) clearTimeout(debounce);
      disconnectSSE();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, []);

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
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
          <Routes>
            <Route path="/dashboard" element={<DashboardScreen />} />
            <Route path="/folder/:folderId" element={<FolderDashboardScreen />} />
            <Route path="/scheduled" element={<ScheduledScreen />} />
            <Route path="/files" element={<FilesScreen />} />
            <Route path="/list/:listId" element={<ListScreen />} />
            <Route path="/settings" element={<SettingsScreen />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
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
      <Route path="/login" element={loggedIn ? <Navigate to="/dashboard" replace /> : <LoginScreen />} />
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
