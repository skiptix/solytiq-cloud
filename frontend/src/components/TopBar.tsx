import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';
import { useLocation } from 'react-router-dom';
import Icon from './Icon';
import useInstalledAppsStore from '../store/useInstalledAppsStore';
import useAuthStore from '../store/useAuthStore';
import useShortcutsStore from '../store/useShortcutsStore';
import { apiUploadFile } from '../api/client';
// Only ever rendered while the search overlay is open — lazy-loaded so its
// entity-search/keyboard-nav logic isn't in every page's initial chunk.
const CommandPalette = lazy(() => import('./CommandPalette'));
import RouteFallback from './RouteFallback';
import NotificationBell from './NotificationBell';
import { SHORTCUT_DEFS, bindingFor, formatCombo } from '../shortcuts/registry';
import MotionButton from './animate-ui/MotionButton';
import MotionIn from './animate-ui/MotionIn';
import { EASE_SPRING } from './animate-ui/motionTokens';

const focusSearchDef = SHORTCUT_DEFS.find(d => d.id === 'focus-search')!;

interface TopBarProps {
  onNavigate: (path: string) => void;
  isMobile?: boolean;
  onOpenDrawer?: () => void;
}

export default function TopBar({ onNavigate, isMobile, onOpenDrawer }: TopBarProps) {
  // Command palette (search) state — the palette itself owns the query/results
  // logic; the topbar just owns whether it's open.
  const [paletteOpen, setPaletteOpen] = useState(false);

  const { isAdmin } = useAuthStore();
  const isCalendarActive = useLocation().pathname === '/calendar';
  const installedApps = useInstalledAppsStore(s => s.installedApps);
  const gpsInstalled = installedApps.includes('gps');
  const filesInstalled = installedApps.includes('files');

  // File drag-to-upload state
  const [fileDragActive, setFileDragActive] = useState(false);
  const [fileDropHover, setFileDropHover] = useState(false);
  const [fileUploadProgress, setFileUploadProgress] = useState<number | null>(null);
  const [fileUploadDone, setFileUploadDone] = useState(false);

  useEffect(() => {
    const onEnter = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) setFileDragActive(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!e.relatedTarget) setFileDragActive(false);
    };
    const onEnd = () => setFileDragActive(false);
    document.addEventListener('dragenter', onEnter);
    document.addEventListener('dragleave', onLeave);
    document.addEventListener('drop', onEnd);
    document.addEventListener('dragend', onEnd);
    return () => {
      document.removeEventListener('dragenter', onEnter);
      document.removeEventListener('dragleave', onLeave);
      document.removeEventListener('drop', onEnd);
      document.removeEventListener('dragend', onEnd);
    };
  }, []);

  const handleFileAreaDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setFileDragActive(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    setFileUploadProgress(0);
    try {
      await apiUploadFile(file, { isPublic: false }, pct => setFileUploadProgress(pct));
      setFileUploadDone(true);
      setTimeout(() => {
        setFileUploadProgress(null);
        setFileUploadDone(false);
        setFileDropHover(false);
        onNavigate('/files');
      }, 900);
    } catch {
      setFileUploadProgress(null);
      setFileDropHover(false);
    }
  }, [onNavigate]);

  // Global shortcut (dispatched by <KeyboardShortcuts/>, customizable in
  // Account Settings → Controls) — open search from anywhere.
  useEffect(() => {
    const onSearch = () => setPaletteOpen(true);
    window.addEventListener('shortcut:focus-search', onSearch);
    return () => window.removeEventListener('shortcut:focus-search', onSearch);
  }, []);

  const searchShortcutOverrides = useShortcutsStore(s => s.overrides);
  const searchShortcutHint = useMemo(() => formatCombo(bindingFor(searchShortcutOverrides, focusSearchDef).key), [searchShortcutOverrides]);

  return (
    <>
      <header style={{ position: 'sticky', top: 0, zIndex: 50, background: 'rgba(var(--color-page-bg-rgb), 0.92)', backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 16, padding: isMobile ? 'calc(env(safe-area-inset-top, 0px) + 16px) 16px 12px' : '10px 24px', height: isMobile ? 'auto' : 56, minHeight: isMobile ? 56 : undefined }}>
        {/* Hamburger — mobile only */}
        {isMobile && (
          <button
            data-touch
            onClick={onOpenDrawer}
            style={{ width: 40, height: 40, borderRadius: 10, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
          >
            <Icon name="menu" size={22} color="var(--color-text-secondary)" />
          </button>
        )}

        {/* Search trigger — opens the CommandPalette overlay. Absolutely
            centered on the header itself (not just within the leftover flex
            space next to the right-hand controls), so it stays visually
            centered regardless of how wide the icon cluster is. */}
        {isMobile ? (
          <button
            data-touch
            onClick={() => setPaletteOpen(true)}
            style={{ width: 40, height: 40, borderRadius: 10, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
          >
            <Icon name="search" size={20} color="var(--color-text-tertiary)" />
          </button>
        ) : (
          <MotionButton
            onClick={() => setPaletteOpen(true)}
            style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', width: 'min(308px, 28vw)', display: 'flex', alignItems: 'center', gap: 10, background: 'var(--color-purple-pale-11)', borderRadius: 9999, border: '1.5px solid transparent', padding: '8px 14px', cursor: 'pointer', textAlign: 'left' }}
            whileHover={{ borderColor: 'var(--color-purple-pale-38)', background: 'var(--color-white)' }}
            transition={{ duration: 0.2 }}
          >
            <Icon name="search" size={16} color="var(--color-text-tertiary)" />
            <span style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-purple-mid-6)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Search tasks, lists…</span>
            <span style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-quaternary)', background: 'var(--color-white)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '2px 6px', flexShrink: 0 }}>{searchShortcutHint}</span>
          </MotionButton>
        )}

        {/* Right controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 6 : 10, marginLeft: 'auto' }}>
          {/* Admin settings button — admins only, desktop only */}
          {isAdmin && !isMobile && (
            <MotionButton
              onClick={() => onNavigate('/settings')}
              title="Admin Settings"
              style={{ width: 32, height: 32, borderRadius: '50%', background: 'transparent', border: '1px solid var(--color-border)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              whileHover={{ background: 'var(--color-surface-tint)', borderColor: 'var(--color-accent-purple-soft)' }}
              transition={{ duration: 0.15 }}
            >
              <Icon name="admin_panel_settings" size={17} color="var(--color-text-tertiary)" />
            </MotionButton>
          )}

          {/* GPS Routes button — desktop only, hidden until an admin installs the app */}
          {!isMobile && gpsInstalled && (
            <MotionButton
              onClick={() => onNavigate('/gps')}
              title="GPS Routes"
              style={{ width: 32, height: 32, borderRadius: '50%', background: 'transparent', border: '1px solid var(--color-border)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              whileHover={{ background: 'var(--color-surface-tint)', borderColor: 'var(--color-accent-purple-soft)' }}
              transition={{ duration: 0.15 }}
            >
              <Icon name="route" size={17} color="var(--color-text-tertiary)" />
            </MotionButton>
          )}

          {/* Files button + drag-to-upload — desktop only, hidden until an admin installs the app */}
          {!isMobile && filesInstalled && <div
            style={{ position: 'relative' }}
            onDragEnter={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setFileDropHover(true); } }}
            onDragLeave={e => {
              if (fileUploadProgress !== null) return;
              if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setFileDropHover(false);
            }}
            onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
            onDrop={handleFileAreaDrop}
          >
            <MotionButton
              onClick={() => onNavigate('/files')}
              title="Files"
              style={{
                width: 32, height: 32, borderRadius: '50%', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: fileDropHover ? '1.5px solid var(--color-primary)' : (fileDragActive ? '1px solid var(--color-accent-purple-soft)' : '1px solid var(--color-border)'),
              }}
              animate={
                fileDropHover
                  ? { background: 'var(--color-surface-tint-4)', boxShadow: '0 0 0 3px rgba(var(--color-primary-rgb), 0.18)' }
                  : fileDragActive
                    ? { background: 'var(--color-surface-tint)', boxShadow: ['0 0 0 0px rgba(var(--color-primary-rgb), 0.25)', '0 0 0 5px rgba(var(--color-primary-rgb), 0.15)', '0 0 0 0px rgba(var(--color-primary-rgb), 0.25)'] }
                    : { background: 'transparent', boxShadow: '0 0 0 0px rgba(var(--color-primary-rgb), 0)' }
              }
              transition={fileDragActive && !fileDropHover ? { duration: 1.4, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.2 }}
              whileHover={!fileDragActive ? { background: 'var(--color-surface-tint)', borderColor: 'var(--color-accent-purple-soft)' } : undefined}
            >
              <Icon name="folder_shared" size={17} color={fileDropHover || fileDragActive ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
            </MotionButton>

            {fileDropHover && (
              <MotionIn
                initial={{ opacity: 0, scale: 0.9, y: -6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ duration: 0.22, ease: EASE_SPRING }}
                style={{ position: 'absolute', top: 'calc(100% + 10px)', right: 0, width: 220, background: 'var(--color-white)', borderRadius: 14, boxShadow: '0 8px 32px rgba(var(--color-primary-rgb), 0.18)', border: '1.5px solid var(--color-accent-purple-soft)', zIndex: 400, transformOrigin: 'top right', overflow: 'hidden' }}
              >
                {fileUploadProgress === null ? (
                  <div style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                    <MotionIn
                      animate={{ y: [0, -5, 0] }}
                      transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
                      style={{ width: 46, height: 46, borderRadius: 13, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Icon name="cloud_upload" size={24} color="var(--color-primary)" />
                    </MotionIn>
                    <div>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 700, color: 'var(--color-text-primary)', textAlign: 'center' }}>Drop to upload</div>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-purple-mid-6)', textAlign: 'center', marginTop: 3 }}>Adds file to your Files</div>
                    </div>
                  </div>
                ) : fileUploadDone ? (
                  <div style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                    <MotionIn
                      initial={{ opacity: 0, scale: 0.6 }}
                      animate={{ opacity: [0, 1, 1], scale: [0.6, 1.15, 1] }}
                      transition={{ duration: 0.38, times: [0, 0.6, 1], ease: EASE_SPRING }}
                      style={{ width: 46, height: 46, borderRadius: 13, background: 'var(--color-green-pale-4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Icon name="check" size={22} color="var(--color-green-deep-1)" />
                    </MotionIn>
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)' }}>Uploaded!</div>
                  </div>
                ) : (
                  <div style={{ padding: '16px' }}>
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 8 }}>Uploading…</div>
                    <div style={{ height: 5, borderRadius: 9999, background: 'var(--color-divider)', overflow: 'hidden' }}>
                      <MotionIn animate={{ width: `${fileUploadProgress}%` }} transition={{ duration: 0.15, ease: 'easeOut' }} style={{ height: '100%', background: 'linear-gradient(90deg, var(--color-accent-purple-light), var(--color-primary))', borderRadius: 9999 }} />
                    </div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-purple-mid-6)', marginTop: 5, textAlign: 'right' }}>{fileUploadProgress}%</div>
                  </div>
                )}
                {fileUploadProgress === null && (
                  <div style={{ borderTop: '1px solid var(--color-divider)', padding: '8px 12px' }}>
                    <button
                      onClick={() => { setFileDropHover(false); onNavigate('/files'); }}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', background: 'transparent', border: 'none', cursor: 'pointer', padding: '3px 0' }}
                    >
                      <Icon name="open_in_new" size={12} color="var(--color-primary)" />
                      Open Files
                    </button>
                  </div>
                )}
              </MotionIn>
            )}
          </div>}

          {/* Calendar button — left of the notification bell; highlighted while on /calendar */}
          <MotionButton
            onClick={() => onNavigate('/calendar')}
            title="Calendar"
            style={{ width: isMobile ? 40 : 32, height: isMobile ? 40 : 32, borderRadius: '50%', background: isCalendarActive ? 'var(--color-surface-tint)' : 'transparent', border: isMobile ? 'none' : `1px solid ${isCalendarActive ? 'var(--color-accent-purple-soft)' : 'var(--color-border)'}`, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
            whileHover={!isCalendarActive && !isMobile ? { background: 'var(--color-surface-tint)', borderColor: 'var(--color-accent-purple-soft)' } : undefined}
            transition={{ duration: 0.15 }}
          >
            <Icon name="calendar_month" size={isMobile ? 20 : 17} color={isCalendarActive ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
          </MotionButton>

          {/* Notification bell */}
          <NotificationBell isMobile={isMobile} onNavigate={onNavigate} />
        </div>
      </header>

      {/* Command palette (search) */}
      {paletteOpen && (
        <Suspense fallback={<RouteFallback label="Loading search…" />}>
          <CommandPalette onClose={() => setPaletteOpen(false)} onNavigate={onNavigate} onOpenAccountSettings={() => window.dispatchEvent(new CustomEvent('shortcut:open-settings'))} />
        </Suspense>
      )}
    </>
  );
}
