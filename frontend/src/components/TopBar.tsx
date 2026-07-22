import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from './Icon';
import useAuthStore from '../store/useAuthStore';
import useShortcutsStore from '../store/useShortcutsStore';
import useInstalledAppsStore from '../store/useInstalledAppsStore';
import { apiUpdateProfile, apiUploadProfileImage, apiUploadFile } from '../api/client';
import UserSettingsModal from '../modals/UserSettingsModal';
import CommandPalette from './CommandPalette';
import NotificationBell from './NotificationBell';
import { SHORTCUT_DEFS, bindingFor, formatCombo } from '../shortcuts/registry';

const focusSearchDef = SHORTCUT_DEFS.find(d => d.id === 'focus-search')!;

interface TopBarProps {
  onNavigate: (path: string) => void;
  isMobile?: boolean;
  onOpenDrawer?: () => void;
}

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export default function TopBar({ onNavigate, isMobile, onOpenDrawer }: TopBarProps) {
  const navigate = useNavigate();

  // Command palette (search) state — the palette itself owns the query/results
  // logic; the topbar just owns whether it's open.
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Profile state
  const { username, email, fullName, profileImage, isAdmin, setProfile, signOut } = useAuthStore();
  const installedApps = useInstalledAppsStore(s => s.installedApps);
  const gpsInstalled = installedApps.includes('gps');
  const filesInstalled = installedApps.includes('files');
  const [profileOpen, setProfileOpen] = useState(false);
  const profileDropRef = useRef<HTMLDivElement>(null);
  const [avatarHover, setAvatarHover] = useState(false);
  const [uploadAvatarHover, setUploadAvatarHover] = useState(false);

  // Inline field editing
  const [editingField, setEditingField] = useState<'name' | 'email' | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // Upload wizard state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [imgSaving, setImgSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const initials = (fullName || username || 'U').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

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

  // Close profile dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (profileDropRef.current && !profileDropRef.current.contains(e.target as Node)) {
        setProfileOpen(false);
        setEditingField(null);
      }
    };
    if (profileOpen) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [profileOpen]);

  // Global shortcuts (dispatched by <KeyboardShortcuts/>, customizable in
  // Account Settings → Controls) — open search / account settings from anywhere.
  useEffect(() => {
    const onSearch = () => setPaletteOpen(true);
    const onSettings = () => setSettingsOpen(true);
    window.addEventListener('shortcut:focus-search', onSearch);
    window.addEventListener('shortcut:open-settings', onSettings);
    return () => {
      window.removeEventListener('shortcut:focus-search', onSearch);
      window.removeEventListener('shortcut:open-settings', onSettings);
    };
  }, []);

  const searchShortcutOverrides = useShortcutsStore(s => s.overrides);
  const searchShortcutHint = useMemo(() => formatCombo(bindingFor(searchShortcutOverrides, focusSearchDef).key), [searchShortcutOverrides]);

  // Inline edit handlers
  const startEdit = (field: 'name' | 'email') => {
    setEditingField(field);
    setEditValue(field === 'name' ? (fullName || username) : email);
  };

  const cancelEdit = () => {
    setEditingField(null);
    setEditValue('');
  };

  const commitEdit = async () => {
    if (!editingField || !editValue.trim()) return;
    setEditSaving(true);
    try {
      const updates = editingField === 'name'
        ? { fullName: editValue.trim() }
        : { email: editValue.trim() };
      await apiUpdateProfile(updates);
      setProfile(updates);
      setEditingField(null);
    } catch (e) {
      console.error('profile save failed', e);
    } finally {
      setEditSaving(false);
    }
  };

  const handleFieldKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
    if (e.key === 'Escape') cancelEdit();
  };

  // Upload wizard handlers
  const processFile = useCallback((file: File) => {
    setFileError(null);
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setFileError('Please upload a JPG, PNG, GIF, or WebP image.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setFileError('Image must be 2 MB or smaller.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => setPendingImage(e.target?.result as string);
    reader.readAsDataURL(file);
  }, []);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  };

  const closeUploadWizard = () => {
    setUploadOpen(false);
    setPendingImage(null);
    setFileError(null);
    setDragOver(false);
  };

  const handleSaveImage = async () => {
    if (!pendingImage) return;
    setImgSaving(true);
    try {
      const res = await apiUploadProfileImage(pendingImage);
      setProfile({ profileImage: res.user.profileImage });
      closeUploadWizard();
    } catch (e) {
      console.error('image upload failed', e);
      setFileError('Failed to save image. Please try again.');
    } finally {
      setImgSaving(false);
    }
  };

  const handleSignOut = () => {
    setProfileOpen(false);
    signOut();
    navigate('/login');
  };

  const iconBtn = {
    width: 26, height: 26, borderRadius: 6,
    background: 'transparent', border: 'none', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, transition: 'background 120ms',
  };

  const renderField = (label: string, field: 'name' | 'email', displayValue: string, inputType = 'text') => (
    <div style={{ padding: '11px 0', borderBottom: '1px solid var(--color-surface-tint-2)' }}>
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 10, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: 5 }}>{label}</div>
      {editingField === field ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            autoFocus
            type={inputType}
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={handleFieldKey}
            style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)', background: 'transparent', border: 'none', outline: 'none', padding: '1px 0', borderBottom: '1.5px solid var(--color-primary)' }}
          />
          <button
            onClick={commitEdit}
            disabled={editSaving || !editValue.trim()}
            style={{ ...iconBtn, color: 'var(--color-success)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(var(--color-success-rgb), 0.10)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <Icon name="check" size={15} color={editSaving ? 'var(--color-text-quaternary)' : 'var(--color-success)'} />
          </button>
          <button
            onClick={cancelEdit}
            style={iconBtn}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <Icon name="close" size={15} color="var(--color-text-quaternary)" />
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayValue}</span>
          <button
            onClick={() => startEdit(field)}
            style={iconBtn}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <Icon name="edit" size={14} color="var(--color-text-quaternary)" />
          </button>
        </div>
      )}
    </div>
  );

  return (
    <>
      <header style={{ position: 'sticky', top: 0, zIndex: 50, background: 'rgba(var(--color-page-bg-rgb), 0.92)', backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 16, padding: isMobile ? '10px 16px' : '10px 24px', height: 56 }}>
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
            centered regardless of how wide the profile/icon cluster is. */}
        {isMobile ? (
          <button
            data-touch
            onClick={() => setPaletteOpen(true)}
            style={{ width: 40, height: 40, borderRadius: 10, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
          >
            <Icon name="search" size={20} color="var(--color-text-tertiary)" />
          </button>
        ) : (
          <button
            onClick={() => setPaletteOpen(true)}
            style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', width: 'min(440px, 40vw)', display: 'flex', alignItems: 'center', gap: 10, background: 'var(--color-purple-pale-11)', borderRadius: 9999, border: '1.5px solid transparent', padding: '8px 14px', cursor: 'pointer', transition: 'all 200ms', textAlign: 'left' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-purple-pale-38)'; e.currentTarget.style.background = 'var(--color-white)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.background = 'var(--color-purple-pale-11)'; }}
          >
            <Icon name="search" size={16} color="var(--color-text-tertiary)" />
            <span style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-purple-mid-6)' }}>Search tasks, lists…</span>
            <span style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-quaternary)', background: 'var(--color-white)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '2px 6px', flexShrink: 0 }}>{searchShortcutHint}</span>
          </button>
        )}

        {/* Right controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 6 : 10, marginLeft: 'auto' }}>
          {/* Admin settings button — admins only, desktop only */}
          {isAdmin && !isMobile && (
            <button
              onClick={() => { setProfileOpen(false); onNavigate('/settings'); }}
              title="Admin Settings"
              style={{ width: 32, height: 32, borderRadius: '50%', background: 'transparent', border: '1px solid var(--color-border)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint)'; e.currentTarget.style.borderColor = 'var(--color-accent-purple-soft)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'var(--color-border)'; }}
            >
              <Icon name="admin_panel_settings" size={17} color="var(--color-text-tertiary)" />
            </button>
          )}

          {/* GPS Routes button — desktop only, hidden until an admin installs the app */}
          {!isMobile && gpsInstalled && (
            <button
              onClick={() => onNavigate('/gps')}
              title="GPS Routes"
              style={{ width: 32, height: 32, borderRadius: '50%', background: 'transparent', border: '1px solid var(--color-border)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint)'; e.currentTarget.style.borderColor = 'var(--color-accent-purple-soft)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'var(--color-border)'; }}
            >
              <Icon name="route" size={17} color="var(--color-text-tertiary)" />
            </button>
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
            <button
              onClick={() => onNavigate('/files')}
              title="Files"
              style={{
                width: 32, height: 32, borderRadius: '50%', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 200ms',
                background: fileDropHover ? 'var(--color-surface-tint-4)' : (fileDragActive ? 'var(--color-surface-tint)' : 'transparent'),
                border: fileDropHover ? '1.5px solid var(--color-primary)' : (fileDragActive ? '1px solid var(--color-accent-purple-soft)' : '1px solid var(--color-border)'),
                boxShadow: fileDropHover ? '0 0 0 3px rgba(var(--color-primary-rgb), 0.18)' : 'none',
                animation: fileDragActive && !fileDropHover ? 'filesBtnPulse 1.4s ease infinite' : undefined,
              }}
              onMouseEnter={e => { if (!fileDragActive) { e.currentTarget.style.background = 'var(--color-surface-tint)'; e.currentTarget.style.borderColor = 'var(--color-accent-purple-soft)'; } }}
              onMouseLeave={e => { if (!fileDragActive) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'var(--color-border)'; } }}
            >
              <Icon name="folder_shared" size={17} color={fileDropHover || fileDragActive ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
            </button>

            {fileDropHover && (
              <div style={{ position: 'absolute', top: 'calc(100% + 10px)', right: 0, width: 220, background: 'var(--color-white)', borderRadius: 14, boxShadow: '0 8px 32px rgba(var(--color-primary-rgb), 0.18)', border: '1.5px solid var(--color-accent-purple-soft)', zIndex: 400, animation: 'fileDropPanelIn 220ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}>
                {fileUploadProgress === null ? (
                  <div style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 46, height: 46, borderRadius: 13, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'fileDropIconFloat 1.6s ease infinite' }}>
                      <Icon name="cloud_upload" size={24} color="var(--color-primary)" />
                    </div>
                    <div>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 700, color: 'var(--color-text-primary)', textAlign: 'center' }}>Drop to upload</div>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-purple-mid-6)', textAlign: 'center', marginTop: 3 }}>Adds file to your Files</div>
                    </div>
                  </div>
                ) : fileUploadDone ? (
                  <div style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 46, height: 46, borderRadius: 13, background: 'var(--color-green-pale-4)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'fileUploadDone 380ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
                      <Icon name="check" size={22} color="var(--color-green-deep-1)" />
                    </div>
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)' }}>Uploaded!</div>
                  </div>
                ) : (
                  <div style={{ padding: '16px' }}>
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 8 }}>Uploading…</div>
                    <div style={{ height: 5, borderRadius: 9999, background: 'var(--color-divider)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${fileUploadProgress}%`, background: 'linear-gradient(90deg, var(--color-accent-purple-light), var(--color-primary))', borderRadius: 9999, transition: 'width 150ms ease' }} />
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
              </div>
            )}
          </div>}

          {/* Notification bell — left of the profile avatar */}
          <NotificationBell isMobile={isMobile} onNavigate={onNavigate} />

          {/* Profile avatar + dropdown */}
          <div ref={profileDropRef} style={{ position: 'relative' }}>
            <button
              onClick={() => { setProfileOpen(v => !v); setEditingField(null); }}
              onMouseEnter={() => setAvatarHover(true)}
              onMouseLeave={() => setAvatarHover(false)}
              style={{ width: 34, height: 34, borderRadius: '50%', border: profileOpen ? '2px solid var(--color-primary)' : '2px solid transparent', cursor: 'pointer', padding: 0, background: 'none', transition: 'border-color 150ms', flexShrink: 0, position: 'relative', overflow: 'hidden' }}
              title="Profile"
            >
              <div style={{ width: '100%', height: '100%', borderRadius: '50%', background: 'linear-gradient(135deg, var(--color-accent-purple-light) 0%, var(--color-primary) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                {profileImage ? (
                  <img src={profileImage} alt="Profile" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 700, color: 'var(--color-white)', lineHeight: 1 }}>{initials}</span>
                )}
              </div>
              <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'rgba(var(--color-black-rgb), 0.12)', opacity: avatarHover && !profileOpen ? 1 : 0, transition: 'opacity 150ms', pointerEvents: 'none' }} />
            </button>

            {/* Profile dropdown */}
            {profileOpen && (
              <div style={{ position: 'absolute', top: 'calc(100% + 10px)', right: 0, width: Math.min(300, window.innerWidth - 24), background: 'var(--color-white)', border: '1px solid var(--color-border-alt)', borderRadius: 16, boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.14)', zIndex: 200, animation: 'menuIn 160ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}>

                {/* Avatar header */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '22px 20px 16px', background: 'var(--color-surface-tint-3)', borderBottom: '1px solid var(--color-surface-tint-2)', gap: 8 }}>
                  <div
                    style={{ position: 'relative', width: 64, height: 64, cursor: 'pointer', flexShrink: 0 }}
                    onMouseEnter={() => setUploadAvatarHover(true)}
                    onMouseLeave={() => setUploadAvatarHover(false)}
                    onClick={() => { setProfileOpen(false); setUploadOpen(true); }}
                    title="Upload profile photo"
                  >
                    <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'linear-gradient(135deg, var(--color-accent-purple-light) 0%, var(--color-primary) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                      {profileImage ? (
                        <img src={profileImage} alt="Profile" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
                      ) : (
                        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 22, fontWeight: 700, color: 'var(--color-white)' }}>{initials}</span>
                      )}
                    </div>
                    <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'rgba(var(--color-black-rgb), 0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: uploadAvatarHover ? 1 : 0, transition: 'opacity 180ms', pointerEvents: 'none' }}>
                      <Icon name="add" size={22} color="var(--color-white)" />
                    </div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                      <span style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)' }}>{fullName || username}</span>
                      {isAdmin && (
                        <span style={{ fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 700, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', borderRadius: 9999, padding: '2px 8px', textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>Admin</span>
                      )}
                    </div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>@{username}</div>
                  </div>
                </div>

                {/* Editable fields */}
                <div style={{ padding: '0 16px' }}>
                  {renderField('Full Name', 'name', fullName || username)}
                  {renderField('Email Address', 'email', email, 'email')}
                </div>

                {/* Account Settings + Sign Out */}
                <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button
                    onClick={() => { setProfileOpen(false); setSettingsOpen(true); }}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', border: '1.5px solid var(--color-purple-pale-38)', borderRadius: 8, padding: '9px 0', cursor: 'pointer', transition: 'all 150ms' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint-4)'; e.currentTarget.style.borderColor = 'var(--color-accent-purple-soft)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface-tint)'; e.currentTarget.style.borderColor = 'var(--color-purple-pale-38)'; }}
                  >
                    <Icon name="manage_accounts" size={15} color="var(--color-primary)" />
                    Account Settings
                  </button>
                  <button
                    onClick={handleSignOut}
                    style={{ width: '100%', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-error)', background: 'var(--color-error-bg-alt)', border: '1.5px solid var(--color-error-bg)', borderRadius: 8, padding: '9px 0', cursor: 'pointer', transition: 'all 150ms' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-error)'; e.currentTarget.style.color = 'var(--color-white)'; e.currentTarget.style.borderColor = 'var(--color-error)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-error-bg-alt)'; e.currentTarget.style.color = 'var(--color-error)'; e.currentTarget.style.borderColor = 'var(--color-error-bg)'; }}
                  >
                    Sign Out
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Command palette (search) */}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} onNavigate={onNavigate} onOpenAccountSettings={() => setSettingsOpen(true)} />}

      {/* User Settings Modal */}
      {settingsOpen && <UserSettingsModal onClose={() => setSettingsOpen(false)} />}

      {/* Profile Image Upload Wizard */}
      {uploadOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) closeUploadWizard(); }}
        >
          <div
            style={{ background: 'var(--color-white)', borderRadius: 20, width: '100%', maxWidth: 440, boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 0' }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)' }}>
                {pendingImage ? 'Preview' : 'Upload Profile Photo'}
              </div>
              <button
                onClick={closeUploadWizard}
                style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--color-surface-tint-2)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-border)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }}
              >
                <Icon name="close" size={15} color="var(--color-text-secondary)" />
              </button>
            </div>

            <div style={{ padding: '20px 24px 24px' }}>
              {!pendingImage ? (
                <>
                  <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" style={{ display: 'none' }} onChange={handleFileInput} />
                  <div
                    onDrop={handleDrop}
                    onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={e => { e.preventDefault(); setDragOver(false); }}
                    onClick={() => fileInputRef.current?.click()}
                    style={{ border: `2px dashed ${dragOver ? 'var(--color-primary)' : fileError ? 'var(--color-error)' : 'var(--color-border)'}`, borderRadius: 14, background: dragOver ? 'var(--color-surface-tint)' : fileError ? 'var(--color-error-bg-alt)' : 'var(--color-surface-tint-3)', padding: '36px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, cursor: 'pointer', transition: 'all 200ms', userSelect: 'none' }}
                  >
                    <div style={{ width: 48, height: 48, borderRadius: '50%', background: dragOver ? 'var(--color-surface-tint-4)' : 'var(--color-surface-tint-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 200ms' }}>
                      <Icon name="upload" size={24} color={dragOver ? 'var(--color-primary)' : 'var(--color-text-quaternary)'} />
                    </div>
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: dragOver ? 'var(--color-primary)' : 'var(--color-text-secondary)', textAlign: 'center' }}>
                      {dragOver ? 'Drop to upload' : 'Drag & drop your photo'}
                    </div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>or</div>
                    <div
                      style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', borderRadius: 8, padding: '8px 20px' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-tint-4)'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-tint)'; }}
                    >
                      Select file
                    </div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', marginTop: 2 }}>JPG, PNG, GIF or WebP · Max 2 MB</div>
                  </div>

                  {fileError && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, padding: '10px 14px', background: 'var(--color-error-bg-alt)', borderRadius: 8, border: '1px solid var(--color-error-bg)' }}>
                      <Icon name="error" size={15} color="var(--color-error)" />
                      <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>{fileError}</span>
                    </div>
                  )}

                  <div style={{ marginTop: 20 }}>
                    <button
                      onClick={closeUploadWizard}
                      style={{ width: '100%', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 8, padding: '11px 0', cursor: 'pointer' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-border)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
                    <div style={{ width: 96, height: 96, borderRadius: '50%', overflow: 'hidden', boxShadow: '0 4px 16px rgba(var(--color-primary-rgb), 0.25)' }}>
                      <img src={pendingImage} alt="Preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Looks good?</div>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 3 }}>This will be your profile photo.</div>
                    </div>
                  </div>

                  {fileError && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, padding: '10px 14px', background: 'var(--color-error-bg-alt)', borderRadius: 8, border: '1px solid var(--color-error-bg)' }}>
                      <Icon name="error" size={15} color="var(--color-error)" />
                      <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>{fileError}</span>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                    <button
                      onClick={() => { setPendingImage(null); setFileError(null); }}
                      style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 8, padding: '11px 0', cursor: 'pointer' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-border)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }}
                    >
                      Choose different
                    </button>
                    <button
                      onClick={handleSaveImage}
                      disabled={imgSaving}
                      style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: imgSaving ? 'var(--color-border-strong)' : 'var(--color-primary)', border: 'none', borderRadius: 8, padding: '11px 0', cursor: imgSaving ? 'wait' : 'pointer' }}
                      onMouseEnter={e => { if (!imgSaving) e.currentTarget.style.background = 'var(--color-purple-mid-11)'; }}
                      onMouseLeave={e => { if (!imgSaving) e.currentTarget.style.background = 'var(--color-primary)'; }}
                    >
                      {imgSaving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
