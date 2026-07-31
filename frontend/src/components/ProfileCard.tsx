import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import Icon from './Icon';
import useAuthStore from '../store/useAuthStore';
import useAccountsStore from '../store/useAccountsStore';
import { apiUpdateProfile, apiUploadProfileImage } from '../api/client';
import UserSettingsModal from '../modals/UserSettingsModal';
import AddAccountModal from '../modals/AddAccountModal';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

interface ProfileCardProps {
  collapsed: boolean;
}

/**
 * The account entry point for the whole app — a small card pinned to the
 * bottom of the Sidebar (avatar + name, or just the avatar when collapsed).
 * Clicking it opens the same account menu the old TopBar avatar used to
 * (editable name/email, Account Settings, Sign Out, photo upload), just
 * anchored above the card and portaled to <body> so it can't be clipped by
 * the sidebar's own overflow/scroll box or capped by its stacking context —
 * the same reason WorkspaceSettingsModal portals itself.
 */
export default function ProfileCard({ collapsed }: ProfileCardProps) {
  const navigate = useNavigate();
  const { userId, username, email, fullName, profileImage, isAdmin, setProfile, signOut } = useAuthStore();
  const switchToAccount = useAuthStore((s) => s.switchToAccount);
  const storedAccounts = useAccountsStore((s) => s.accounts);

  // Account switcher
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [addAccountFor, setAddAccountFor] = useState<{ username?: string } | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const cardRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [avatarHover, setAvatarHover] = useState(false);
  const [uploadAvatarHover, setUploadAvatarHover] = useState(false);

  // Inline field editing
  const [editingField, setEditingField] = useState<'name' | 'email' | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // Account Settings + upload wizard
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [imgSaving, setImgSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const initials = (fullName || username || 'U').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

  const openMenu = () => {
    const rect = cardRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(300, window.innerWidth - 24);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      setMenuPos({ left, bottom: window.innerHeight - rect.top + 8, width });
    }
    setMenuOpen(v => !v);
    setEditingField(null);
  };

  // Global shortcut (dispatched by <KeyboardShortcuts/>, or by the command
  // palette's "Account Settings" result) — open Account Settings from anywhere.
  useEffect(() => {
    const onSettings = () => setSettingsOpen(true);
    window.addEventListener('shortcut:open-settings', onSettings);
    return () => window.removeEventListener('shortcut:open-settings', onSettings);
  }, []);

  // Close menu on outside click — must check both the card trigger and the
  // portaled popover content, since they're no longer DOM siblings.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (cardRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setMenuOpen(false);
      setEditingField(null);
    };
    if (menuOpen) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

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
    setMenuOpen(false);
    signOut();
    navigate('/login');
  };

  /** Activate a stored account. The store re-verifies its token against the
   *  server first; if that account's session has lapsed we keep the current one
   *  active and open the login modal pre-filled for it instead. */
  const handleSwitch = async (accountUserId: string, accountUsername: string) => {
    if (accountUserId === userId || switchingId) return;
    setSwitchingId(accountUserId);
    try {
      const res = await switchToAccount(accountUserId);
      setMenuOpen(false);
      setSwitcherOpen(false);
      // On success the store reloads the page, so there's nothing to do here.
      // On failure that account needs fresh credentials — the current session
      // stays active and we offer a login pre-filled for it.
      if (!res.ok) setAddAccountFor({ username: accountUsername });
    } finally {
      setSwitchingId(null);
    }
  };

  // Every stored account except the one currently active.
  const otherAccounts = storedAccounts.filter((a) => a.userId !== userId);

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

  const avatarBubble = (size: number, fontSize: number) => (
    <div style={{ width: size, height: size, borderRadius: '50%', background: 'linear-gradient(135deg, var(--color-accent-purple-light) 0%, var(--color-primary) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
      {profileImage ? (
        <img src={profileImage} alt="Profile" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: fontSize, fontWeight: 700, color: 'var(--color-white)', lineHeight: 1 }}>{initials}</span>
      )}
    </div>
  );

  return (
    <>
      <button
        ref={cardRef}
        onClick={openMenu}
        title={collapsed ? (fullName || username) : undefined}
        onMouseEnter={() => setAvatarHover(true)}
        onMouseLeave={() => setAvatarHover(false)}
        style={{
          display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 9,
          padding: collapsed ? '8px 0' : '7px 8px', justifyContent: collapsed ? 'center' : 'flex-start',
          borderRadius: 10, cursor: 'pointer', border: `1.5px solid ${menuOpen ? 'var(--color-primary)' : 'transparent'}`,
          background: menuOpen ? 'var(--color-surface-tint)' : (avatarHover ? 'var(--color-surface-tint-3)' : 'transparent'),
          width: '100%', textAlign: 'left', transition: 'all 150ms',
        }}
      >
        {avatarBubble(collapsed ? 30 : 32, collapsed ? 12 : 13)}
        {!collapsed && (
          <>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fullName || username}</span>
                {isAdmin && (
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, fontWeight: 700, color: 'var(--color-primary)', background: 'var(--color-white)', borderRadius: 9999, padding: '1px 6px', textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>Admin</span>
                )}
              </div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>@{username}</div>
            </div>
            <Icon name="unfold_more" size={15} color="var(--color-text-quaternary)" />
          </>
        )}
      </button>

      {/* Account menu — portaled to <body> and anchored above the card so it
          escapes the sidebar's overflow clipping and always opens upward
          regardless of scroll position or collapsed width. */}
      {menuOpen && menuPos && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', left: menuPos.left, bottom: menuPos.bottom, width: menuPos.width, background: 'var(--color-white)', border: '1px solid var(--color-border-alt)', borderRadius: 16, boxShadow: '0 -8px 32px rgba(var(--color-black-rgb), 0.14)', zIndex: 1200, animation: 'menuIn 160ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
        >
          {/* Avatar header */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '22px 20px 16px', background: 'var(--color-surface-tint-3)', borderBottom: '1px solid var(--color-surface-tint-2)', gap: 8 }}>
            <div
              style={{ position: 'relative', width: 64, height: 64, cursor: 'pointer', flexShrink: 0 }}
              onMouseEnter={() => setUploadAvatarHover(true)}
              onMouseLeave={() => setUploadAvatarHover(false)}
              onClick={() => { setMenuOpen(false); setUploadOpen(true); }}
              title="Upload profile photo"
            >
              {avatarBubble(64, 22)}
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

          {/* Switch account — expands to the list of other signed-in accounts */}
          <div style={{ padding: '10px 16px 0' }}>
            <button
              onClick={() => setSwitcherOpen(v => !v)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-secondary)', background: 'transparent', border: 'none', borderRadius: 8, padding: '8px 8px', cursor: 'pointer', textAlign: 'left', transition: 'background 150ms' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint-3)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <Icon name="swap_horiz" size={16} color="var(--color-text-tertiary)" />
              <span style={{ flex: 1 }}>Switch account</span>
              {otherAccounts.length > 0 && (
                <span style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, fontWeight: 700, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', borderRadius: 9999, padding: '1px 7px' }}>{otherAccounts.length}</span>
              )}
              <Icon name={switcherOpen ? 'expand_less' : 'expand_more'} size={16} color="var(--color-text-quaternary)" />
            </button>

            {switcherOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4, animation: 'menuIn 140ms ease both' }}>
                {otherAccounts.map(acct => {
                  const busy = switchingId === acct.userId;
                  return (
                    <button
                      key={acct.userId}
                      onClick={() => handleSwitch(acct.userId, acct.username)}
                      disabled={!!switchingId}
                      style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '7px 8px', borderRadius: 8, border: 'none', background: 'transparent', cursor: switchingId ? 'default' : 'pointer', textAlign: 'left', transition: 'background 150ms' }}
                      onMouseEnter={e => { if (!switchingId) e.currentTarget.style.background = 'var(--color-surface-tint-3)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      {acct.profileImage
                        ? <img src={acct.profileImage} alt="" style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                        : <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg, var(--color-accent-purple-light) 0%, var(--color-primary) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            <span style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, color: 'var(--color-white)' }}>
                              {(acct.fullName || acct.username || 'U').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)}
                            </span>
                          </div>
                      }
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{acct.fullName || acct.username}</div>
                        <div style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>@{acct.username}</div>
                      </div>
                      {busy
                        ? <div style={{ width: 13, height: 13, borderRadius: '50%', border: '2px solid var(--color-accent-purple-soft-alt)', borderTopColor: 'var(--color-primary)', animation: 'spin 600ms linear infinite', flexShrink: 0 }} />
                        : <Icon name="login" size={14} color="var(--color-text-quaternary)" />
                      }
                    </button>
                  );
                })}

                {otherAccounts.length === 0 && (
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-quaternary)', padding: '4px 8px 6px' }}>
                    No other accounts yet. Add one to switch between them.
                  </div>
                )}

                <button
                  onClick={() => { setMenuOpen(false); setSwitcherOpen(false); setAddAccountFor({}); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '7px 8px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', transition: 'background 150ms' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint-3)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <div style={{ width: 28, height: 28, borderRadius: '50%', border: '1.5px dashed var(--color-purple-pale-38)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Icon name="add" size={15} color="var(--color-primary)" />
                  </div>
                  <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-primary)' }}>Add account</span>
                </button>
              </div>
            )}
          </div>

          {/* Account Settings + Sign Out */}
          <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              onClick={() => { setMenuOpen(false); setSettingsOpen(true); }}
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
        </div>,
        document.body
      )}

      {/* User Settings Modal */}
      {settingsOpen && <UserSettingsModal onClose={() => setSettingsOpen(false)} />}

      {/* Add / re-authenticate an account for the switcher */}
      {addAccountFor && (
        <AddAccountModal
          presetUsername={addAccountFor.username}
          onClose={() => setAddAccountFor(null)}
          onAdded={() => setAddAccountFor(null)}
        />
      )}

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
