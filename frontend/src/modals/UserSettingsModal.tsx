import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../components/Icon';
import { useMobile } from '../hooks/useBreakpoint';
import useAuthStore from '../store/useAuthStore';
import useUserPrefsStore from '../store/useUserPrefsStore';
import useShortcutsStore from '../store/useShortcutsStore';
import useAiMemoryStore from '../store/useAiMemoryStore';
import { SHORTCUT_DEFS, bindingFor, comboFromEvent, formatCombo, isReservedCombo } from '../shortcuts/registry';
import {
  apiUpdateProfile,
  apiUploadProfileImage,
  apiChangePassword,
  apiGetFeatureFlags,
  api2FASetup,
  api2FAEnable,
  api2FADisable,
  apiGetApiTokens,
  apiDeleteApiToken,
  apiGetMobileConnections,
  apiDeleteMobileConnection,
  apiGetHomescreenConnections,
  apiDeleteHomescreenConnection,
  apiGetCaldavStatus,
  apiGenerateCaldavPassword,
  apiRevokeCaldav,
  type ApiAccessToken,
  type MobileConnection,
  type HomescreenConnection,
  type CaldavStatus,
} from '../api/client';

interface UserSettingsModalProps {
  onClose: () => void;
}

type PwStep = 'idle' | 'current' | 'new' | 'done';

const inputStyle = (focused: boolean): React.CSSProperties => ({
  width: '100%',
  fontFamily: 'var(--font-body)',
  fontSize: 14,
  color: 'var(--color-text-primary)',
  background: 'transparent',
  border: 'none',
  outline: 'none',
  padding: '8px 0',
  borderBottom: `1.5px solid ${focused ? 'var(--color-primary)' : 'var(--color-border-alt)'}`,
  transition: 'border-color 180ms',
});

const sectionLabel = (text: string) => (
  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: 'var(--color-text-quaternary)', marginBottom: 10, paddingLeft: 2 }}>
    {text}
  </div>
);

const card: React.CSSProperties = {
  background: 'var(--color-surface-gray)',
  border: '1px solid var(--color-border-alt)',
  borderRadius: 14,
  overflow: 'hidden',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '14px 18px',
};

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

type SettingsTab = 'profile' | 'preferences' | 'controls' | 'security' | 'connections' | 'mobile' | 'calendar';

export default function UserSettingsModal({ onClose }: UserSettingsModalProps) {
  const isMobile = useMobile();
  const { username, fullName, email, profileImage, isAdmin, totpEnabled, setProfile, setTotpEnabled } = useAuthStore();
  const { timezone, setTimezone, defaultListViewMode, setDefaultListViewMode } = useUserPrefsStore();

  const [activeTab, setActiveTab] = useState<SettingsTab>('profile');

  // Feature flags
  const [twoFAFeatureEnabled, setTwoFAFeatureEnabled] = useState(true);
  const [mcpEnabled, setMcpEnabled] = useState(true);
  const [mcpInstalled, setMcpInstalled] = useState(false);
  const [mobileEnabled, setMobileEnabled] = useState(true);
  useEffect(() => {
    apiGetFeatureFlags().then(r => {
      setTwoFAFeatureEnabled(r.twoFAEnabled);
      setMcpEnabled(r.mcpEnabled);
      setMcpInstalled(r.installedApps.includes('mcp'));
      setMobileEnabled(r.mobileEnabled);
    }).catch(() => {});
  }, []);
  // Claude MCP needs both: installed (Settings → System → Discover Apps) and
  // not killed instance-wide via the AI tab's "Enable Claude MCP" toggle.
  const mcpVisible = mcpEnabled && mcpInstalled;

  // Profile image upload wizard
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadWizardOpen, setUploadWizardOpen] = useState(false);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [imgFileError, setImgFileError] = useState<string | null>(null);
  const [imgSaving, setImgSaving] = useState(false);
  const [avatarHover, setAvatarHover] = useState(false);
  const [removeLoading, setRemoveLoading] = useState(false);

  const processFile = (file: File) => {
    setImgFileError(null);
    if (!ACCEPTED_TYPES.includes(file.type)) { setImgFileError('Please upload a JPG, PNG, GIF, or WebP image.'); return; }
    if (file.size > MAX_IMAGE_BYTES) { setImgFileError('Image must be 2 MB or smaller.'); return; }
    const reader = new FileReader();
    reader.onload = (e) => setPendingImage(e.target?.result as string);
    reader.readAsDataURL(file);
  };

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
    setUploadWizardOpen(false);
    setPendingImage(null);
    setImgFileError(null);
    setDragOver(false);
  };

  const handleSaveImage = async () => {
    if (!pendingImage) return;
    setImgSaving(true);
    try {
      const res = await apiUploadProfileImage(pendingImage);
      setProfile({ profileImage: res.user.profileImage });
      closeUploadWizard();
    } catch {
      setImgFileError('Failed to save image. Please try again.');
    } finally {
      setImgSaving(false);
    }
  };

  const handleRemoveImage = async () => {
    setRemoveLoading(true);
    try {
      await apiUploadProfileImage(null);
      setProfile({ profileImage: null });
    } catch {
      // silently fail — image stays
    } finally {
      setRemoveLoading(false);
    }
  };

  // Profile editing
  const [nameValue, setNameValue] = useState(fullName || username);
  const [nameFocused, setNameFocused] = useState(false);
  const [nameSaving, setNameSaving] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const [nameError, setNameError] = useState('');

  const handleSaveName = async () => {
    if (!nameValue.trim() || nameValue.trim() === (fullName || username)) return;
    setNameSaving(true);
    setNameError('');
    try {
      await apiUpdateProfile({ fullName: nameValue.trim() });
      setProfile({ fullName: nameValue.trim() });
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2500);
    } catch {
      setNameError('Failed to save. Please try again.');
    } finally {
      setNameSaving(false);
    }
  };

  // Email editing
  const [emailValue, setEmailValue] = useState(email || '');
  const [emailFocused, setEmailFocused] = useState(false);
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailSaved, setEmailSaved] = useState(false);
  const [emailError, setEmailError] = useState('');
  const emailChanged = emailValue.trim() !== (email || '').trim() && emailValue.trim().length > 0;

  const handleSaveEmail = async () => {
    const next = emailValue.trim();
    if (!next || next === (email || '').trim()) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) { setEmailError('Please enter a valid email address.'); return; }
    setEmailSaving(true);
    setEmailError('');
    try {
      const res = await apiUpdateProfile({ email: next });
      setProfile({ email: res.user.email });
      setEmailSaved(true);
      setTimeout(() => setEmailSaved(false), 2500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      setEmailError(msg.includes('already in use') ? 'That email is already in use.' : msg.includes('valid') ? 'Please enter a valid email address.' : 'Failed to save. Please try again.');
    } finally {
      setEmailSaving(false);
    }
  };

  // Password wizard
  const [pwStep, setPwStep] = useState<PwStep>('idle');
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [currentPwFocused, setCurrentPwFocused] = useState(false);
  const [newPwFocused, setNewPwFocused] = useState(false);
  const [confirmPwFocused, setConfirmPwFocused] = useState(false);
  const [currentPwVisible, setCurrentPwVisible] = useState(false);
  const [newPwVisible, setNewPwVisible] = useState(false);
  const [pwError, setPwError] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const currentPwRef = useRef<HTMLInputElement>(null);
  const newPwRef = useRef<HTMLInputElement>(null);

  const resetPwWizard = () => {
    setPwStep('idle');
    setCurrentPw(''); setNewPw(''); setConfirmPw('');
    setPwError(''); setCurrentPwVisible(false); setNewPwVisible(false);
  };

  const handlePwNext = () => {
    if (!currentPw.trim()) { setPwError('Please enter your current password.'); return; }
    setPwError('');
    setPwStep('new');
    setTimeout(() => newPwRef.current?.focus(), 60);
  };

  const handlePwSave = async () => {
    if (newPw.length < 8) { setPwError('New password must be at least 8 characters.'); return; }
    if (newPw !== confirmPw) { setPwError('Passwords do not match.'); return; }
    setPwError('');
    setPwSaving(true);
    try {
      await apiChangePassword(currentPw, newPw);
      setPwStep('done');
      setTimeout(() => resetPwWizard(), 2000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      setPwError(msg.includes('incorrect') ? 'Current password is incorrect.' : msg.length > 0 ? msg : 'Failed to change password. Please try again.');
    } finally {
      setPwSaving(false);
    }
  };

  // 2FA — enable flow (uses TwoFAWizard inline)
  const [twoFAOpen, setTwoFAOpen] = useState(false);

  // 2FA — disable flow
  const [disableOpen, setDisableOpen] = useState(false);
  const [disableOtp, setDisableOtp] = useState(Array(6).fill(''));
  const [disableError, setDisableError] = useState('');
  const [disableLoading, setDisableLoading] = useState(false);
  const [disableShake, setDisableShake] = useState(false);
  const dr0 = useRef<HTMLInputElement>(null);
  const dr1 = useRef<HTMLInputElement>(null);
  const dr2 = useRef<HTMLInputElement>(null);
  const dr3 = useRef<HTMLInputElement>(null);
  const dr4 = useRef<HTMLInputElement>(null);
  const dr5 = useRef<HTMLInputElement>(null);
  const disableRefs = [dr0, dr1, dr2, dr3, dr4, dr5];

  const handleDisableOtpChange = (i: number, raw: string) => {
    const d = raw.replace(/\D/g, '').slice(-1);
    setDisableOtp(prev => { const n = [...prev]; n[i] = d; return n; });
    setDisableError('');
    if (d && i < 5) disableRefs[i + 1].current?.focus();
  };
  const handleDisableOtpKey = (i: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace') {
      if (!disableOtp[i] && i > 0) { setDisableOtp(p => { const n = [...p]; n[i - 1] = ''; return n; }); disableRefs[i - 1].current?.focus(); }
      else setDisableOtp(p => { const n = [...p]; n[i] = ''; return n; });
    } else if (e.key === 'Enter' && disableOtp.every(d => d)) handleDisable2FA();
  };
  const handleDisableOtpPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const digits = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6).split('');
    const next = Array(6).fill('');
    digits.forEach((d, i) => { next[i] = d; });
    setDisableOtp(next);
    disableRefs[Math.min(digits.length, 5)].current?.focus();
  };

  const handleDisable2FA = async () => {
    const code = disableOtp.join('');
    if (code.length !== 6) return;
    setDisableLoading(true);
    setDisableError('');
    try {
      await api2FADisable(code);
      setTotpEnabled(false);
      setDisableOpen(false);
      setDisableOtp(Array(6).fill(''));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      setDisableError(msg.includes('Invalid') ? 'Invalid code — please try again.' : 'Something went wrong.');
      setDisableOtp(Array(6).fill(''));
      setDisableShake(true);
      setTimeout(() => setDisableShake(false), 500);
      setTimeout(() => dr0.current?.focus(), 80);
    } finally {
      setDisableLoading(false);
    }
  };

  const pwChanged = nameValue.trim() !== (fullName || username) && nameValue.trim().length > 0;

  // Closing animation state
  const [closing, setClosing] = useState(false);
  const handleClose = () => { setClosing(true); setTimeout(() => onClose(), 190); };

  // Bottom save bar — commits any pending buffered profile edits (name / email).
  const [savedFlash, setSavedFlash] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const hasPendingEdits = pwChanged || emailChanged;
  const handleSaveAll = async () => {
    setSavingAll(true);
    try {
      const tasks: Promise<void>[] = [];
      if (pwChanged) tasks.push(handleSaveName());
      if (emailChanged) tasks.push(handleSaveEmail());
      await Promise.all(tasks);
    } finally {
      setSavingAll(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    }
  };

  // Controls (keyboard shortcuts), Mobile (device connections), and Calendar Sync
  // (CalDAV) are all about configuring desktop-adjacent workflows that don't
  // apply from a phone already running the mobile web app — hidden on mobile
  // to keep the tab bar short enough to not need horizontal scrolling.
  const TABS: { id: SettingsTab; label: string; icon: string }[] = [
    { id: 'profile',     label: 'Profile',     icon: 'person' },
    { id: 'preferences', label: 'Preferences', icon: 'tune' },
    ...(isMobile ? [] : [{ id: 'controls' as SettingsTab, label: 'Controls', icon: 'keyboard' }]),
    { id: 'security',    label: 'Security',    icon: 'shield_lock' },
    ...(mcpVisible ? [{ id: 'connections' as SettingsTab, label: 'Connections', icon: 'smart_toy' }] : []),
    ...(mobileEnabled && !isMobile ? [{ id: 'mobile' as SettingsTab, label: 'Mobile', icon: 'smartphone' }] : []),
    ...(isMobile ? [] : [{ id: 'calendar' as SettingsTab, label: 'Calendar Sync', icon: 'event_available' }]),
  ];

  // If the viewport crosses into mobile while a now-hidden tab is active
  // (e.g. rotating/resizing mid-session), fall back to Profile rather than
  // stranding the panel on a tab with no corresponding pill to reselect.
  useEffect(() => {
    if (isMobile && (activeTab === 'controls' || activeTab === 'mobile' || activeTab === 'calendar')) {
      setActiveTab('profile');
    }
  }, [isMobile, activeTab]);

  // Portaled to <body>: this modal is opened from ProfileCard, deep inside the
  // fixed-position, z-indexed Sidebar (see Sidebar's own zIndex: 40/60). A
  // position:fixed + z-index element establishes its own stacking context, so
  // without the portal this modal's backdrop (zIndex: 1000) only outranks
  // TopBar (zIndex: 50) *within* Sidebar's stacking context — trapped there,
  // it loses to TopBar in the global stacking order on desktop (Sidebar's
  // zIndex 40 < TopBar's 50), leaving TopBar crisp/unblurred above the
  // backdrop instead of dimmed like the rest of the page.
  return createPortal(
    <>
      {/* Backdrop */}
      <div
        style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.24)', backdropFilter: 'blur(5px)', zIndex: 1000, display: 'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center', padding: isMobile ? 0 : 24, animation: closing ? 'backdropOut 190ms ease both' : 'backdropIn 220ms ease both' }}
        onClick={e => { if (e.target === e.currentTarget) handleClose(); }}
      >
        <div
          style={{ background: 'var(--color-white)', borderRadius: isMobile ? '16px 16px 0 0' : 22, width: '100%', maxWidth: isMobile ? undefined : 1024, boxShadow: '0 20px 60px rgba(var(--color-black-rgb), 0.22)', animation: closing ? 'settingsModalOut 190ms ease-in both' : (isMobile ? 'slideUp 300ms cubic-bezier(0.22,1,0.36,1) both' : 'settingsModalIn 360ms cubic-bezier(0.22,1,0.36,1) both'), overflow: 'hidden', maxHeight: '95vh', display: 'flex', flexDirection: 'column' }}
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '22px 24px 0' }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.01em' }}>Account Settings</div>
            <button
              onClick={handleClose}
              style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--color-surface-tint-2)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 150ms, transform 150ms' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-border)'; e.currentTarget.style.transform = 'scale(1.08)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; e.currentTarget.style.transform = 'scale(1)'; }}
            >
              <Icon name="close" size={15} color="var(--color-text-secondary)" />
            </button>
          </div>

          {/* Tab bar */}
          <div style={{ padding: '16px 24px 0' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, background: 'var(--color-surface-tint)', borderRadius: 14, padding: 4, overflowX: isMobile ? 'auto' : undefined, WebkitOverflowScrolling: 'touch', flexShrink: 0 }}>
              {TABS.map(tab => {
                const active = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600,
                      color: active ? 'var(--color-white)' : 'var(--color-primary)',
                      background: active ? 'var(--color-primary)' : 'transparent',
                      border: 'none', borderRadius: 10, padding: '9px 16px', cursor: 'pointer',
                      transition: 'all 150ms', flex: isMobile ? '0 0 auto' : '1 1 auto', justifyContent: 'center',
                    }}
                    onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--color-surface-tint-4)'; }}
                    onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <Icon name={tab.icon} size={15} color={active ? 'var(--color-white)' : 'var(--color-primary)'} />
                    <span style={{ whiteSpace: 'nowrap' }}>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Scrollable body */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px 28px', display: 'flex', flexDirection: 'column', gap: 24 }}>

            {/* ── PROFILE ── */}
            {activeTab === 'profile' && (
            <div style={{ animation: 'sectionFadeUp 340ms cubic-bezier(0.22,1,0.36,1) both' }}>
              {sectionLabel('Profile')}
              <div style={card}>
                {/* Avatar + identity */}
                <div style={{ padding: '18px 18px', borderBottom: '1px solid var(--color-surface-tint-2)', display: 'flex', alignItems: 'center', gap: 16 }}>
                  {/* Avatar with upload overlay */}
                  <div
                    style={{ position: 'relative', flexShrink: 0, cursor: 'pointer' }}
                    onMouseEnter={() => setAvatarHover(true)}
                    onMouseLeave={() => setAvatarHover(false)}
                    onClick={() => setUploadWizardOpen(true)}
                    title="Upload profile photo"
                  >
                    <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'linear-gradient(135deg, var(--color-accent-purple-light) 0%, var(--color-primary) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0, transition: 'box-shadow 200ms', boxShadow: avatarHover ? '0 0 0 3px rgba(var(--color-primary-rgb), 0.35)' : '0 0 0 0px transparent' }}>
                      {profileImage ? (
                        <img key={profileImage} src={profileImage} alt={username} style={{ width: '100%', height: '100%', objectFit: 'cover', animation: 'avatarSwap 300ms ease both' }} />
                      ) : (
                        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 26, fontWeight: 700, color: 'var(--color-white)' }}>
                          {(fullName || username || 'U').split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2)}
                        </span>
                      )}
                    </div>
                    <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'rgba(var(--color-black-rgb), 0.42)', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: avatarHover ? 1 : 0, transition: 'opacity 180ms', pointerEvents: 'none' }}>
                      <Icon name="add" size={24} color="var(--color-white)" />
                    </div>
                  </div>

                  {/* Name + role + username */}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 3 }}>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {fullName || username}
                      </div>
                      <span style={{ fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 700, color: isAdmin ? 'var(--color-primary)' : 'var(--color-text-tertiary)', background: isAdmin ? 'var(--color-surface-tint)' : 'var(--color-blue-pale-5)', borderRadius: 9999, padding: '2px 8px', textTransform: 'uppercase' as const, letterSpacing: '0.05em', flexShrink: 0 }}>
                        {isAdmin ? 'Admin' : 'Member'}
                      </span>
                    </div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)' }}>@{username}</div>
                    {profileImage && (
                      <button
                        onClick={e => { e.stopPropagation(); handleRemoveImage(); }}
                        disabled={removeLoading}
                        style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)', background: 'none', border: 'none', padding: '4px 0 0', cursor: removeLoading ? 'wait' : 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}
                        onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-red-deep-2)'; }}
                        onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-error)'; }}
                      >{removeLoading ? 'Removing…' : 'Remove photo'}</button>
                    )}
                  </div>
                </div>

                {/* Full Name */}
                <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--color-surface-tint-2)' }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 10, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Full Name</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      value={nameValue}
                      onChange={e => { setNameValue(e.target.value); setNameError(''); setNameSaved(false); }}
                      onFocus={() => setNameFocused(true)}
                      onBlur={() => setNameFocused(false)}
                      onKeyDown={e => { if (e.key === 'Enter') handleSaveName(); if (e.key === 'Escape') setNameValue(fullName || username); }}
                      style={{ ...inputStyle(nameFocused), flex: 1 }}
                      placeholder="Your full name"
                    />
                    {pwChanged && (
                      <button
                        onClick={handleSaveName}
                        disabled={nameSaving}
                        style={{ flexShrink: 0, width: 28, height: 28, borderRadius: 7, background: nameSaved ? 'rgba(var(--color-success-rgb), 0.1)' : 'var(--color-surface-tint)', border: 'none', cursor: nameSaving ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 150ms' }}
                        onMouseEnter={e => { if (!nameSaving && !nameSaved) e.currentTarget.style.background = 'var(--color-surface-tint-4)'; }}
                        onMouseLeave={e => { if (!nameSaving && !nameSaved) e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
                      >
                        <Icon name="check" size={14} color={nameSaved ? 'var(--color-success)' : 'var(--color-primary)'} />
                      </button>
                    )}
                  </div>
                  {nameError && <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-error)', marginTop: 5 }}>{nameError}</div>}
                  {nameSaved && <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-success)', marginTop: 5, animation: 'savedPop 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}>Saved!</div>}
                </div>

                {/* Email */}
                <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--color-surface-tint-2)' }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 10, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Email</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="email"
                      value={emailValue}
                      onChange={e => { setEmailValue(e.target.value); setEmailError(''); setEmailSaved(false); }}
                      onFocus={() => setEmailFocused(true)}
                      onBlur={() => setEmailFocused(false)}
                      onKeyDown={e => { if (e.key === 'Enter') handleSaveEmail(); if (e.key === 'Escape') setEmailValue(email || ''); }}
                      style={{ ...inputStyle(emailFocused), flex: 1 }}
                      placeholder="you@example.com"
                      autoComplete="email"
                    />
                    {emailChanged && (
                      <button
                        onClick={handleSaveEmail}
                        disabled={emailSaving}
                        style={{ flexShrink: 0, width: 28, height: 28, borderRadius: 7, background: emailSaved ? 'rgba(var(--color-success-rgb), 0.1)' : 'var(--color-surface-tint)', border: 'none', cursor: emailSaving ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 150ms' }}
                        onMouseEnter={e => { if (!emailSaving && !emailSaved) e.currentTarget.style.background = 'var(--color-surface-tint-4)'; }}
                        onMouseLeave={e => { if (!emailSaving && !emailSaved) e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
                      >
                        <Icon name="check" size={14} color={emailSaved ? 'var(--color-success)' : 'var(--color-primary)'} />
                      </button>
                    )}
                  </div>
                  {emailError && <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-error)', marginTop: 5 }}>{emailError}</div>}
                  {emailSaved && <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-success)', marginTop: 5, animation: 'savedPop 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}>Saved!</div>}
                  {!emailValue.trim() && !emailError && (
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', marginTop: 5 }}>Add an email address to your account.</div>
                  )}
                </div>

                {/* Handle (read-only) */}
                <div style={{ padding: '14px 18px' }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 10, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Username</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-tertiary)' }}>@{username}</span>
                    <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', background: 'var(--color-purple-pale-11)', borderRadius: 9999, padding: '2px 8px' }}>can't be changed</span>
                  </div>
                </div>
              </div>
            </div>
            )}

            {/* ── PREFERENCES ── */}
            {activeTab === 'preferences' && (
            <div style={{ position: 'relative', zIndex: 10, animation: 'sectionFadeUp 340ms 40ms cubic-bezier(0.22,1,0.36,1) both' }}>
              {sectionLabel('Preferences')}
              <div style={{ ...card, overflow: 'visible' }}>
                <div style={{ padding: '14px 18px' }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 10, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Timezone</div>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 10, lineHeight: 1.5 }}>
                    Affects how deadlines and timeline milestones are evaluated against "today".
                  </div>
                  <TimezoneSelector value={timezone} onChange={setTimezone} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 8 }}>
                    <Icon name="schedule" size={12} color="var(--color-accent-purple-light)" />
                    <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-accent-purple-light)' }}>Current: {timezone}</span>
                  </div>
                </div>
                <div style={{ height: 1, background: 'var(--color-surface-tint-2)' }} />
                <div style={{ padding: '14px 18px' }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 10, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Default Board View</div>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 10, lineHeight: 1.5 }}>
                    Layout new boards start in. Existing boards keep whatever view they're already set to.
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    {(['list', 'kanban'] as const).map(v => (
                      <button key={v} onClick={() => setDefaultListViewMode(v)}
                        style={{ flex: 1, padding: '10px', borderRadius: 10, border: `1.5px solid ${defaultListViewMode === v ? 'var(--color-primary)' : 'var(--color-border-alt)'}`, background: defaultListViewMode === v ? 'var(--color-surface-tint)' : 'var(--color-white)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'all 150ms' }}>
                        <Icon name={v === 'list' ? 'format_list_bulleted' : 'view_kanban'} size={16} color={defaultListViewMode === v ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: defaultListViewMode === v ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }}>{v === 'list' ? 'List' : 'Kanban'}</span>
                        {defaultListViewMode === v && <Icon name="check" size={14} color="var(--color-primary)" />}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ height: 1, background: 'var(--color-surface-tint-2)' }} />
                <MemorySection />
              </div>
            </div>
            )}

            {/* ── CONTROLS (keyboard shortcuts) ── */}
            {activeTab === 'controls' && (
            <div style={{ animation: 'sectionFadeUp 340ms 60ms cubic-bezier(0.22,1,0.36,1) both' }}>
              {sectionLabel('Keyboard Shortcuts')}
              <ShortcutsSection />
            </div>
            )}

            {/* ── SECURITY ── */}
            {activeTab === 'security' && (
            <div style={{ animation: 'sectionFadeUp 340ms 80ms cubic-bezier(0.22,1,0.36,1) both' }}>
              {sectionLabel('Security')}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

                {/* Password card */}
                <div style={card}>
                  {pwStep === 'idle' && (
                    <div style={{ ...rowStyle, animation: 'wizardStepIn 220ms cubic-bezier(0.22,1,0.36,1) both' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <Icon name="lock" size={18} color="var(--color-primary)" />
                        </div>
                        <div>
                          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Password</div>
                          <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 1 }}>Change your account password</div>
                        </div>
                      </div>
                      <button
                        onClick={() => { setPwStep('current'); setTimeout(() => currentPwRef.current?.focus(), 60); }}
                        style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', transition: 'background 150ms' }}
                        onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint-4)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
                      >
                        Change
                        <Icon name="arrow_forward" size={14} color="var(--color-primary)" />
                      </button>
                    </div>
                  )}

                  {pwStep === 'current' && (
                    <div style={{ padding: '18px 18px 16px', animation: 'wizardStepIn 220ms cubic-bezier(0.22,1,0.36,1) both' }}>
                      {/* Progress */}
                      <div style={{ display: 'flex', gap: 5, marginBottom: 16 }}>
                        {[0, 1].map(i => (
                          <div key={i} style={{ height: 3, flex: 1, borderRadius: 99, background: i === 0 ? 'var(--color-primary)' : 'var(--color-border)', transition: 'background 300ms' }} />
                        ))}
                      </div>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 14 }}>Enter your current password</div>
                      <div style={{ position: 'relative' }}>
                        <input
                          ref={currentPwRef}
                          type={currentPwVisible ? 'text' : 'password'}
                          value={currentPw}
                          onChange={e => { setCurrentPw(e.target.value); setPwError(''); }}
                          onFocus={() => setCurrentPwFocused(true)}
                          onBlur={() => setCurrentPwFocused(false)}
                          onKeyDown={e => { if (e.key === 'Enter') handlePwNext(); if (e.key === 'Escape') resetPwWizard(); }}
                          placeholder="Current password"
                          style={{ ...inputStyle(currentPwFocused), paddingRight: 32 }}
                          autoComplete="current-password"
                        />
                        <button
                          type="button"
                          onClick={() => setCurrentPwVisible(v => !v)}
                          style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex' }}
                        >
                          <Icon name={currentPwVisible ? 'visibility_off' : 'visibility'} size={16} color="var(--color-text-quaternary)" />
                        </button>
                      </div>
                      {pwError && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)', marginTop: 8 }}>{pwError}</div>}
                      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                        <button
                          onClick={resetPwWizard}
                          style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer', transition: 'background 150ms' }}
                          onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-border)'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }}
                        >Cancel</button>
                        <button
                          onClick={handlePwNext}
                          disabled={!currentPw}
                          style={{ flex: 2, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: currentPw ? 'var(--color-primary)' : 'var(--color-border-strong)', border: 'none', borderRadius: 8, padding: '10px 0', cursor: currentPw ? 'pointer' : 'not-allowed', transition: 'background 150ms', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                          onMouseEnter={e => { if (currentPw) e.currentTarget.style.background = 'var(--color-purple-mid-11)'; }}
                          onMouseLeave={e => { if (currentPw) e.currentTarget.style.background = 'var(--color-primary)'; }}
                        >
                          Next <Icon name="arrow_forward" size={14} color="var(--color-white)" />
                        </button>
                      </div>
                    </div>
                  )}

                  {pwStep === 'new' && (
                    <div style={{ padding: '18px 18px 16px', animation: 'wizardStepIn 220ms cubic-bezier(0.22,1,0.36,1) both' }}>
                      {/* Progress */}
                      <div style={{ display: 'flex', gap: 5, marginBottom: 16 }}>
                        {[0, 1].map(i => (
                          <div key={i} style={{ height: 3, flex: 1, borderRadius: 99, background: 'var(--color-primary)', transition: 'background 300ms' }} />
                        ))}
                      </div>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 14 }}>Set a new password</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <div style={{ position: 'relative' }}>
                          <input
                            ref={newPwRef}
                            type={newPwVisible ? 'text' : 'password'}
                            value={newPw}
                            onChange={e => { setNewPw(e.target.value); setPwError(''); }}
                            onFocus={() => setNewPwFocused(true)}
                            onBlur={() => setNewPwFocused(false)}
                            onKeyDown={e => { if (e.key === 'Escape') resetPwWizard(); }}
                            placeholder="New password"
                            style={{ ...inputStyle(newPwFocused), paddingRight: 32 }}
                            autoComplete="new-password"
                          />
                          <button
                            type="button"
                            onClick={() => setNewPwVisible(v => !v)}
                            style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex' }}
                          >
                            <Icon name={newPwVisible ? 'visibility_off' : 'visibility'} size={16} color="var(--color-text-quaternary)" />
                          </button>
                        </div>
                        <input
                          type={newPwVisible ? 'text' : 'password'}
                          value={confirmPw}
                          onChange={e => { setConfirmPw(e.target.value); setPwError(''); }}
                          onFocus={() => setConfirmPwFocused(true)}
                          onBlur={() => setConfirmPwFocused(false)}
                          onKeyDown={e => { if (e.key === 'Enter') handlePwSave(); if (e.key === 'Escape') resetPwWizard(); }}
                          placeholder="Confirm new password"
                          style={inputStyle(confirmPwFocused)}
                          autoComplete="new-password"
                        />
                      </div>
                      {newPw.length > 0 && newPw.length < 8 && (
                        <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 6 }}>At least 8 characters required</div>
                      )}
                      {pwError && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)', marginTop: 8 }}>{pwError}</div>}
                      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                        <button
                          onClick={() => { setPwStep('current'); setPwError(''); setNewPw(''); setConfirmPw(''); }}
                          style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer', transition: 'background 150ms' }}
                          onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-border)'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }}
                        >← Back</button>
                        <button
                          onClick={handlePwSave}
                          disabled={pwSaving || !newPw || !confirmPw}
                          style={{ flex: 2, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: pwSaving || !newPw || !confirmPw ? 'var(--color-border-strong)' : 'var(--color-primary)', border: 'none', borderRadius: 8, padding: '10px 0', cursor: pwSaving || !newPw || !confirmPw ? 'not-allowed' : 'pointer', transition: 'background 150ms', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                          onMouseEnter={e => { if (!pwSaving && newPw && confirmPw) e.currentTarget.style.background = 'var(--color-purple-mid-11)'; }}
                          onMouseLeave={e => { if (!pwSaving && newPw && confirmPw) e.currentTarget.style.background = 'var(--color-primary)'; }}
                        >
                          {pwSaving ? 'Saving…' : <><Icon name="lock_reset" size={14} color="var(--color-white)" /> Save Password</>}
                        </button>
                      </div>
                    </div>
                  )}

                  {pwStep === 'done' && (
                    <div style={{ padding: '24px 18px', display: 'flex', alignItems: 'center', gap: 14, animation: 'wizardStepIn 280ms cubic-bezier(0.22,1,0.36,1) both' }}>
                      <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(var(--color-success-rgb), 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, animation: 'scIn 380ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
                        <Icon name="check_circle" size={22} color="var(--color-success)" />
                      </div>
                      <div>
                        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Password changed!</div>
                        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>Your new password is active.</div>
                      </div>
                    </div>
                  )}
                </div>

                {/* 2FA card — only if feature is enabled by admin */}
                {twoFAFeatureEnabled && (
                  <div style={card}>
                    <div style={rowStyle}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                        <div style={{ width: 36, height: 36, borderRadius: 10, background: totpEnabled ? 'linear-gradient(135deg, var(--color-green-pale-2) 0%, var(--color-green-tint-1) 100%)' : 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <Icon name="shield_lock" size={18} color={totpEnabled ? 'var(--color-success)' : 'var(--color-primary)'} />
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Two-Factor Auth</div>
                            <span style={{ fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 700, color: totpEnabled ? 'var(--color-success)' : 'var(--color-text-quaternary)', background: totpEnabled ? 'rgba(var(--color-success-rgb), 0.10)' : 'var(--color-surface-tint-2)', borderRadius: 9999, padding: '2px 8px', textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>
                              {totpEnabled ? 'Enabled' : 'Disabled'}
                            </span>
                          </div>
                          <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                            {totpEnabled ? 'Account protected with authenticator app.' : 'Add an extra layer of security.'}
                          </div>
                        </div>
                      </div>
                      <div style={{ flexShrink: 0 }}>
                        {totpEnabled ? (
                          <button
                            onClick={() => { setDisableOpen(true); setDisableOtp(Array(6).fill('')); setDisableError(''); }}
                            style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-error)', background: 'var(--color-error-bg-alt)', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', transition: 'background 150ms' }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-error-bg)'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-error-bg-alt)'; }}
                          >Disable</button>
                        ) : (
                          <button
                            onClick={() => setTwoFAOpen(true)}
                            style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', transition: 'background 150ms' }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint-4)'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
                          >Enable 2FA</button>
                        )}
                      </div>
                    </div>

                    {/* Disable 2FA OTP entry */}
                    {disableOpen && (
                      <div style={{ padding: '0 18px 18px', borderTop: '1px solid var(--color-surface-tint-2)' }}>
                        <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-secondary)', margin: '14px 0 12px' }}>
                          Enter the 6-digit code from your authenticator app to disable 2FA.
                        </div>
                        <div style={{ display: 'flex', gap: 7, justifyContent: 'center', marginBottom: 8, animation: disableShake ? 'shake 400ms ease-in-out' : undefined }}>
                          {disableOtp.map((digit, i) => (
                            <input
                              key={i}
                              ref={disableRefs[i]}
                              type="text"
                              inputMode="numeric"
                              maxLength={1}
                              value={digit}
                              onChange={e => handleDisableOtpChange(i, e.target.value)}
                              onKeyDown={e => handleDisableOtpKey(i, e)}
                              onPaste={i === 0 ? handleDisableOtpPaste : undefined}
                              style={{
                                width: 40, height: 50, textAlign: 'center',
                                fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700,
                                color: 'var(--color-text-primary)', background: digit ? 'var(--color-surface-tint)' : 'var(--color-surface-gray)',
                                border: `2px solid ${disableError ? 'var(--color-error-bg)' : digit ? 'var(--color-primary)' : 'var(--color-border-alt)'}`,
                                borderRadius: 9, outline: 'none', transition: 'border-color 150ms, background 150ms',
                                caretColor: 'transparent',
                              }}
                            />
                          ))}
                        </div>
                        {disableError && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)', textAlign: 'center', marginBottom: 10 }}>{disableError}</div>}
                        <div style={{ display: 'flex', gap: 8, marginTop: disableError ? 0 : 10 }}>
                          <button
                            onClick={() => { setDisableOpen(false); setDisableOtp(Array(6).fill('')); setDisableError(''); }}
                            style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer' }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-border)'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }}
                          >Cancel</button>
                          <button
                            onClick={handleDisable2FA}
                            disabled={disableLoading || !disableOtp.every(d => d)}
                            style={{ flex: 2, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: disableLoading || !disableOtp.every(d => d) ? 'var(--color-border-strong)' : 'var(--color-error)', border: 'none', borderRadius: 8, padding: '9px 0', cursor: disableLoading || !disableOtp.every(d => d) ? 'not-allowed' : 'pointer', transition: 'background 150ms' }}
                            onMouseEnter={e => { if (!disableLoading && disableOtp.every(d => d)) e.currentTarget.style.background = 'var(--color-red-deep-1)'; }}
                            onMouseLeave={e => { if (!disableLoading && disableOtp.every(d => d)) e.currentTarget.style.background = 'var(--color-error)'; }}
                          >
                            {disableLoading ? 'Disabling…' : 'Confirm Disable'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            )}

            {/* ── CONNECTIONS (Claude MCP) ── */}
            {activeTab === 'connections' && mcpVisible && (
            <div style={{ animation: 'sectionFadeUp 340ms cubic-bezier(0.22,1,0.36,1) both' }}>
              {sectionLabel('Claude MCP')}
              <ClaudeMcpSection />
            </div>
            )}

            {/* ── MOBILE (device connections) ── */}
            {activeTab === 'mobile' && mobileEnabled && (
            <div style={{ animation: 'sectionFadeUp 340ms cubic-bezier(0.22,1,0.36,1) both' }}>
              {sectionLabel('Mobile App')}
              <MobileConnectionsSection />

              <div style={{ marginTop: 28 }}>
                {sectionLabel('iOS Home Screen App')}
                <HomeScreenConnectionsSection />
              </div>
            </div>
            )}

            {/* ── CALENDAR SYNC (CalDAV) ── */}
            {activeTab === 'calendar' && (
            <div style={{ animation: 'sectionFadeUp 340ms cubic-bezier(0.22,1,0.36,1) both' }}>
              {sectionLabel('Calendar Sync (CalDAV)')}
              <CalDavSection />
            </div>
            )}
          </div>

          {/* Footer save bar */}
          <div style={{ flexShrink: 0, borderTop: '1px solid var(--color-surface-tint-2)', padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 14 }}>
            {savedFlash && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, animation: 'savedPop 320ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
                <Icon name="check_circle" size={16} color="var(--color-success)" />
                <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-success)' }}>Saved!</span>
              </div>
            )}
            <button
              onClick={handleSaveAll}
              disabled={savingAll || !hasPendingEdits}
              style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: savingAll || !hasPendingEdits ? 'var(--color-border-strong)' : 'var(--color-primary)', border: 'none', borderRadius: 10, padding: '10px 20px', cursor: savingAll || !hasPendingEdits ? 'not-allowed' : 'pointer', transition: 'background 150ms, transform 100ms' }}
              onMouseEnter={e => { if (!savingAll && hasPendingEdits) { e.currentTarget.style.background = 'var(--color-purple-mid-11)'; e.currentTarget.style.transform = 'translateY(-1px)'; } }}
              onMouseLeave={e => { if (!savingAll && hasPendingEdits) { e.currentTarget.style.background = 'var(--color-primary)'; e.currentTarget.style.transform = 'translateY(0)'; } }}
            >
              <Icon name="check" size={15} color="var(--color-white)" />
              {savingAll ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>

      {/* Profile Image Upload Wizard (nested modal) */}
      {uploadWizardOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.32)', backdropFilter: 'blur(6px)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'backdropIn 200ms ease both' }}
          onClick={e => { if (e.target === e.currentTarget) closeUploadWizard(); }}
        >
          <div
            style={{ background: 'var(--color-white)', borderRadius: 22, width: '100%', maxWidth: 440, boxShadow: '0 20px 60px rgba(var(--color-black-rgb), 0.24)', animation: 'nestedModalIn 320ms cubic-bezier(0.22,1,0.36,1) both', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 0' }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)', transition: 'opacity 200ms' }}>
                {pendingImage ? 'Preview' : 'Upload Profile Photo'}
              </div>
              <button
                onClick={closeUploadWizard}
                style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--color-surface-tint-2)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 150ms, transform 150ms' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-border)'; e.currentTarget.style.transform = 'scale(1.08)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; e.currentTarget.style.transform = 'scale(1)'; }}
              >
                <Icon name="close" size={15} color="var(--color-text-secondary)" />
              </button>
            </div>

            <div style={{ padding: '20px 24px 24px' }}>
              <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" style={{ display: 'none' }} onChange={handleFileInput} />

              {!pendingImage ? (
                <div style={{ animation: 'wizardStepIn 240ms cubic-bezier(0.22,1,0.36,1) both' }}>
                  <div
                    onDrop={handleDrop}
                    onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={e => { e.preventDefault(); setDragOver(false); }}
                    onClick={() => fileInputRef.current?.click()}
                    style={{ border: `2px dashed ${dragOver ? 'var(--color-primary)' : imgFileError ? 'var(--color-error)' : 'var(--color-border)'}`, borderRadius: 16, background: dragOver ? 'var(--color-surface-tint)' : imgFileError ? 'var(--color-error-bg-alt)' : 'var(--color-surface-tint-3)', padding: '36px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, cursor: 'pointer', transition: 'all 200ms', userSelect: 'none' }}
                  >
                    <div style={{ width: 52, height: 52, borderRadius: '50%', background: dragOver ? 'var(--color-surface-tint-4)' : 'var(--color-surface-tint-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 200ms, transform 200ms', transform: dragOver ? 'scale(1.12)' : 'scale(1)' }}>
                      <Icon name="upload" size={24} color={dragOver ? 'var(--color-primary)' : 'var(--color-text-quaternary)'} />
                    </div>
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: dragOver ? 'var(--color-primary)' : 'var(--color-text-secondary)', textAlign: 'center', transition: 'color 200ms' }}>
                      {dragOver ? 'Drop to upload' : 'Drag & drop your photo'}
                    </div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>or</div>
                    <div
                      style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', borderRadius: 9, padding: '8px 22px', transition: 'background 150ms, transform 100ms' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-tint-4)'; (e.currentTarget as HTMLElement).style.transform = 'scale(1.04)'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-tint)'; (e.currentTarget as HTMLElement).style.transform = 'scale(1)'; }}
                    >
                      Select file
                    </div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', marginTop: 2 }}>JPG, PNG, GIF or WebP · Max 2 MB</div>
                  </div>

                  {imgFileError && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, padding: '10px 14px', background: 'var(--color-error-bg-alt)', borderRadius: 8, border: '1px solid var(--color-error-bg)', animation: 'wizardStepIn 180ms ease both' }}>
                      <Icon name="error" size={15} color="var(--color-error)" />
                      <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>{imgFileError}</span>
                    </div>
                  )}

                  <div style={{ marginTop: 20 }}>
                    <button
                      onClick={closeUploadWizard}
                      style={{ width: '100%', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 9, padding: '11px 0', cursor: 'pointer', transition: 'background 150ms' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-border)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ animation: 'wizardStepIn 240ms cubic-bezier(0.22,1,0.36,1) both' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
                    <div style={{ width: 104, height: 104, borderRadius: '50%', overflow: 'hidden', boxShadow: '0 0 0 4px rgba(var(--color-primary-rgb), 0.18), 0 8px 24px rgba(var(--color-primary-rgb), 0.22)', animation: 'previewReveal 380ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
                      <img src={pendingImage} alt="Preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    </div>
                    <div style={{ textAlign: 'center', animation: 'sectionFadeUp 280ms 100ms ease both' }}>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)' }}>Looks good?</div>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 4 }}>This will be your profile photo.</div>
                    </div>
                  </div>

                  {imgFileError && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, padding: '10px 14px', background: 'var(--color-error-bg-alt)', borderRadius: 8, border: '1px solid var(--color-error-bg)', animation: 'wizardStepIn 180ms ease both' }}>
                      <Icon name="error" size={15} color="var(--color-error)" />
                      <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>{imgFileError}</span>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                    <button
                      onClick={() => { setPendingImage(null); setImgFileError(null); }}
                      style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 9, padding: '11px 0', cursor: 'pointer', transition: 'background 150ms' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-border)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }}
                    >
                      Choose different
                    </button>
                    <button
                      onClick={handleSaveImage}
                      disabled={imgSaving}
                      style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: imgSaving ? 'var(--color-border-strong)' : 'var(--color-primary)', border: 'none', borderRadius: 9, padding: '11px 0', cursor: imgSaving ? 'wait' : 'pointer', transition: 'background 150ms, transform 100ms' }}
                      onMouseEnter={e => { if (!imgSaving) { e.currentTarget.style.background = 'var(--color-purple-mid-11)'; e.currentTarget.style.transform = 'scale(1.02)'; } }}
                      onMouseLeave={e => { if (!imgSaving) { e.currentTarget.style.background = 'var(--color-primary)'; e.currentTarget.style.transform = 'scale(1)'; } }}
                    >
                      {imgSaving ? 'Saving…' : 'Save Photo'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 2FA Enable Wizard (nested modal) */}
      {twoFAOpen && <TwoFAWizardInline onClose={() => setTwoFAOpen(false)} onEnabled={() => setTotpEnabled(true)} />}
    </>,
    document.body
  );
}

// ── Claude MCP (connect Claude via the OAuth-secured MCP server) ───────────────

const CLAUDE_CONNECTORS_URL = 'https://claude.ai/settings/connectors';

function fmtTokenDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function MemorySection() {
  const { entries, loaded, loading, load, remove, clear } = useAiMemoryStore();
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => { if (!loaded) load(); }, [loaded, load]);

  const handleRemove = async (id: string) => {
    setRemovingId(id);
    await remove(id);
    setRemovingId(null);
  };

  const handleClear = async () => {
    setClearing(true);
    await clear();
    setClearing(false);
    setConfirmingClear(false);
  };

  return (
    <div style={{ padding: '14px 18px' }}>
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 10, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Sol's Memory</div>
      <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 10, lineHeight: 1.5 }}>
        Durable facts Sol has saved about you, carried into every chat so you don't have to repeat yourself. Sol saves these on its own — ask it to remember or forget something any time.
      </div>

      {loading && !loaded && (
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', padding: '4px 0' }}>Loading…</div>
      )}
      {loaded && entries.length === 0 && (
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', padding: '4px 0' }}>Nothing saved yet.</div>
      )}

      {entries.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
          {entries.map(e => (
            <div key={e.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRadius: 8, background: 'var(--color-white)', border: '1px solid var(--color-border-alt)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-primary)', lineHeight: 1.5 }}>{e.content}</div>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-text-quaternary)', marginTop: 2 }}>Saved {fmtTokenDate(e.createdAt)}</div>
              </div>
              <button
                onClick={() => handleRemove(e.id)}
                disabled={removingId === e.id}
                title="Forget this"
                style={{ background: 'none', border: 'none', cursor: removingId === e.id ? 'default' : 'pointer', display: 'flex', padding: 2, flexShrink: 0, opacity: removingId === e.id ? 0.5 : 1, marginTop: 1 }}
              >
                <Icon name="close" size={14} color="var(--color-text-quaternary)" />
              </button>
            </div>
          ))}
        </div>
      )}

      {entries.length > 0 && (
        confirmingClear ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-error)' }}>Clear all {entries.length} memories? This cannot be undone.</span>
            <button
              onClick={() => setConfirmingClear(false)}
              style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', flexShrink: 0 }}
            >Cancel</button>
            <button
              onClick={handleClear}
              disabled={clearing}
              style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-error)', border: 'none', borderRadius: 8, padding: '6px 12px', cursor: clearing ? 'not-allowed' : 'pointer', flexShrink: 0 }}
            >{clearing ? 'Clearing…' : 'Confirm'}</button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmingClear(true)}
            style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-error)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 4 }}
          >
            <Icon name="delete_sweep" size={14} color="var(--color-error)" />
            Clear all memory
          </button>
        )
      )}
    </div>
  );
}

function ClaudeMcpSection() {
  const [tokens, setTokens] = useState<ApiAccessToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [urlCopied, setUrlCopied] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const mcpUrl = `${window.location.origin}/mcp`;

  useEffect(() => {
    apiGetApiTokens()
      .then(r => setTokens(r.tokens))
      .catch(() => setTokens([]))
      .finally(() => setLoading(false));
  }, []);

  const copyUrl = () => {
    navigator.clipboard.writeText(mcpUrl).then(() => {
      setUrlCopied(true);
      setTimeout(() => setUrlCopied(false), 2000);
    }).catch(() => {});
  };

  const handleConnect = () => {
    copyUrl();
    window.open(CLAUDE_CONNECTORS_URL, '_blank', 'noopener,noreferrer');
  };

  const handleDisconnect = async (id: string) => {
    setRevokingId(id);
    try {
      await apiDeleteApiToken(id);
      setTokens(prev => prev.filter(t => t.id !== id));
    } catch {
      /* keep it in the list on failure */
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Intro / connection info */}
      <div style={{ ...card, padding: '14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="smart_toy" size={19} color="var(--color-primary)" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>
              Connect Claude
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginTop: 3 }}>
              Add Solytiq as a custom connector in Claude using the URL below. Claude signs in securely with your account and can then do anything you can do in Solytiq — nothing more.
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
              <code style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '7px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {mcpUrl}
              </code>
              <button
                onClick={copyUrl}
                title="Copy MCP server URL"
                style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: urlCopied ? 'var(--color-success)' : 'var(--color-primary)', background: urlCopied ? 'rgba(var(--color-success-rgb), 0.1)' : 'var(--color-surface-tint)', border: 'none', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', transition: 'background 150ms, color 150ms' }}
              >
                <Icon name={urlCopied ? 'check' : 'content_copy'} size={13} color={urlCopied ? 'var(--color-success)' : 'var(--color-primary)'} />
                {urlCopied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Connect to Claude */}
      <button
        onClick={handleConnect}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-primary)', border: 'none', borderRadius: 12, padding: '13px 0', cursor: 'pointer', transition: 'background 150ms, transform 100ms' }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-purple-mid-11)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-primary)'; e.currentTarget.style.transform = 'translateY(0)'; }}
      >
        <Icon name="open_in_new" size={16} color="var(--color-white)" />
        Connect to Claude
      </button>
      <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-quaternary)', textAlign: 'center', marginTop: -4 }}>
        Opens Claude connector settings and copies the URL. Paste it into "Add custom connector".
      </div>

      {/* Connected clients */}
      {!loading && tokens.length > 0 && (
        <div style={card}>
          {tokens.map((t, i) => (
            <div key={t.id} style={{ ...rowStyle, borderTop: i === 0 ? 'none' : '1px solid var(--color-surface-tint-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                <div style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Icon name="link" size={16} color="var(--color-primary)" />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 1 }}>
                    Connected {fmtTokenDate(t.createdAt)}
                    {'  ·  '}{t.lastUsedAt ? `Last used ${fmtTokenDate(t.lastUsedAt)}` : 'Never used'}
                  </div>
                </div>
              </div>
              <button
                onClick={() => handleDisconnect(t.id)}
                disabled={revokingId === t.id}
                title="Disconnect"
                style={{ flexShrink: 0, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-error)', background: 'var(--color-error-bg-alt)', border: '1px solid var(--color-error-bg)', borderRadius: 8, padding: '7px 12px', cursor: revokingId === t.id ? 'wait' : 'pointer', transition: 'background 150ms' }}
                onMouseEnter={e => { if (revokingId !== t.id) e.currentTarget.style.background = 'var(--color-red-pale-7)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-error-bg-alt)'; }}
              >
                {revokingId === t.id ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </div>
          ))}
        </div>
      )}

      {!loading && tokens.length === 0 && (
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', textAlign: 'center', padding: '2px 0' }}>
          No connected clients yet.
        </div>
      )}
    </div>
  );
}

// ── Mobile app (connected devices) ─────────────────────────────────────────────

// ── Controls (keyboard shortcuts) ───────────────────────────────────────────

function ShortcutsSection() {
  const overrides = useShortcutsStore(s => s.overrides);
  const setKey = useShortcutsStore(s => s.setKey);
  const setEnabled = useShortcutsStore(s => s.setEnabled);
  const resetOne = useShortcutsStore(s => s.resetOne);
  const resetAll = useShortcutsStore(s => s.resetAll);

  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [recordError, setRecordError] = useState('');

  useEffect(() => {
    if (!recordingId) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setRecordingId(null); setRecordError(''); return; }
      if (['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) return; // wait for a real key
      const combo = comboFromEvent(e);
      if (isReservedCombo(combo)) { setRecordError(`${formatCombo(combo)} is reserved by the browser.`); return; }
      const conflict = SHORTCUT_DEFS.find(d => d.id !== recordingId && bindingFor(overrides, d).enabled && bindingFor(overrides, d).key === combo);
      if (conflict) { setRecordError(`Already used by "${conflict.label}".`); return; }
      setKey(recordingId, combo);
      setRecordingId(null);
      setRecordError('');
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [recordingId, overrides, setKey]);

  const hasAnyOverride = Object.keys(overrides).length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Intro / explainer */}
      <div style={{ ...card, padding: '14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="keyboard" size={19} color="var(--color-primary)" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>
              Shortcuts
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginTop: 3 }}>
              Click a key combo to change it, use the switch to turn a shortcut off, or reset it back to default. Shortcuts never fire while typing in a text field, and your choices are saved to your account.
            </div>
          </div>
        </div>
      </div>

      <div style={card}>
        {SHORTCUT_DEFS.map((def, i) => {
          const binding = bindingFor(overrides, def);
          const isOverridden = Boolean(overrides[def.id]?.key !== undefined || overrides[def.id]?.enabled !== undefined);
          const isRecording = recordingId === def.id;
          return (
            <div key={def.id} style={{ ...rowStyle, flexWrap: 'wrap', borderTop: i === 0 ? 'none' : '1px solid var(--color-surface-tint-2)', opacity: binding.enabled ? 1 : 0.55, transition: 'opacity 150ms' }}>
              <div style={{ minWidth: 0, flex: '1 1 200px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)' }}>{def.label}</span>
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', borderRadius: 9999, padding: '1px 8px', whiteSpace: 'nowrap' }}>{def.scopeLabel}</span>
                </div>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{def.description}</div>
                {isRecording && (
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: recordError ? 'var(--color-error)' : 'var(--color-primary)', marginTop: 4 }}>
                    {recordError || 'Press a key combo… (Esc to cancel)'}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <button
                  onClick={() => { setRecordingId(def.id); setRecordError(''); }}
                  style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: isRecording ? 'var(--color-white)' : 'var(--color-primary)', background: isRecording ? 'var(--color-primary)' : 'var(--color-surface-tint)', border: 'none', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', minWidth: 60, textAlign: 'center', transition: 'background 150ms' }}
                  onMouseEnter={e => { if (!isRecording) e.currentTarget.style.background = 'var(--color-surface-tint-4)'; }}
                  onMouseLeave={e => { if (!isRecording) e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
                >
                  {isRecording ? 'Press key…' : formatCombo(binding.key)}
                </button>
                {isOverridden && (
                  <button
                    onClick={() => resetOne(def.id)}
                    title="Reset to default"
                    style={{ width: 30, height: 30, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-tint-2)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <Icon name="restart_alt" size={16} color="var(--color-purple-mid-6)" />
                  </button>
                )}
                <button
                  onClick={() => setEnabled(def.id, !binding.enabled)}
                  title={binding.enabled ? 'Turn off' : 'Turn on'}
                  style={{ width: 38, height: 22, borderRadius: 9999, border: 'none', background: binding.enabled ? 'var(--color-primary)' : 'var(--color-border-alt)', cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 150ms' }}
                >
                  <div style={{ position: 'absolute', top: 2, left: binding.enabled ? 18 : 2, width: 18, height: 18, borderRadius: '50%', background: 'var(--color-white)', transition: 'left 150ms', boxShadow: '0 1px 3px rgba(var(--color-black-rgb), 0.2)' }} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <button
        onClick={resetAll}
        disabled={!hasAnyOverride}
        style={{ alignSelf: 'flex-start', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: hasAnyOverride ? 'var(--color-text-tertiary)' : 'var(--color-border-strong)', background: 'transparent', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '7px 14px', cursor: hasAnyOverride ? 'pointer' : 'default', transition: 'all 150ms' }}
        onMouseEnter={e => { if (hasAnyOverride) { e.currentTarget.style.background = 'var(--color-surface-tint)'; e.currentTarget.style.color = 'var(--color-primary)'; } }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = hasAnyOverride ? 'var(--color-text-tertiary)' : 'var(--color-border-strong)'; }}
      >
        Reset all to defaults
      </button>
    </div>
  );
}

function MobileConnectionsSection() {
  const [connections, setConnections] = useState<MobileConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    apiGetMobileConnections()
      .then(r => setConnections(r.connections))
      .catch(() => setConnections([]))
      .finally(() => setLoading(false));
  }, []);

  const handleRevoke = async (id: string) => {
    setRevokingId(id);
    try {
      await apiDeleteMobileConnection(id);
      setConnections(prev => prev.filter(c => c.id !== id));
    } catch {
      /* keep it in the list on failure */
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Intro / explainer */}
      <div style={{ ...card, padding: '14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="smartphone" size={19} color="var(--color-primary)" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>
              Solytiq Cloud for iOS
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginTop: 3 }}>
              Devices signed in through the mobile app appear here. In the app, choose <strong>Connect to Server</strong> and enter this instance's address, then sign in with your account. Revoke a device to sign it out immediately.
            </div>
          </div>
        </div>
      </div>

      {loading && (
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', textAlign: 'center', padding: '2px 0' }}>
          Loading connected devices…
        </div>
      )}

      {/* Connected devices */}
      {!loading && connections.length > 0 && (
        <div style={card}>
          {connections.map((c, i) => (
            <div key={c.id} style={{ ...rowStyle, borderTop: i === 0 ? 'none' : '1px solid var(--color-surface-tint-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                <div style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Icon name="smartphone" size={16} color="var(--color-primary)" />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.deviceName}{c.deviceModel && c.deviceModel !== c.deviceName ? ` · ${c.deviceModel}` : ''}
                  </div>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 1 }}>
                    {c.osVersion ? `${c.osVersion}  ·  ` : ''}Connected {fmtTokenDate(c.createdAt)}
                    {'  ·  '}{c.lastSeenAt ? `Last used ${fmtTokenDate(c.lastSeenAt)}` : 'Never used'}
                  </div>
                </div>
              </div>
              <button
                onClick={() => handleRevoke(c.id)}
                disabled={revokingId === c.id}
                title="Revoke"
                style={{ flexShrink: 0, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-error)', background: 'var(--color-error-bg-alt)', border: '1px solid var(--color-error-bg)', borderRadius: 8, padding: '7px 12px', cursor: revokingId === c.id ? 'wait' : 'pointer', transition: 'background 150ms' }}
                onMouseEnter={e => { if (revokingId !== c.id) e.currentTarget.style.background = 'var(--color-red-pale-7)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-error-bg-alt)'; }}
              >
                {revokingId === c.id ? 'Revoking…' : 'Revoke'}
              </button>
            </div>
          ))}
        </div>
      )}

      {!loading && connections.length === 0 && (
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', textAlign: 'center', padding: '2px 0' }}>
          No mobile devices connected yet.
        </div>
      )}
    </div>
  );
}

function HomeScreenConnectionsSection() {
  const [connections, setConnections] = useState<HomescreenConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    apiGetHomescreenConnections()
      .then(r => setConnections(r.connections))
      .catch(() => setConnections([]))
      .finally(() => setLoading(false));
  }, []);

  const handleRemove = async (id: string) => {
    setRemovingId(id);
    try {
      await apiDeleteHomescreenConnection(id);
      setConnections(prev => prev.filter(c => c.id !== id));
    } catch {
      /* keep it in the list on failure */
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Intro / explainer */}
      <div style={{ ...card, padding: '14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="add_to_home_screen" size={19} color="var(--color-primary)" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>
              Solytiq Cloud on your Home Screen
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginTop: 3 }}>
              Devices where you've added this site to your iOS Home Screen (Share → Add to Home Screen) and opened it as a standalone app appear here. This isn't a separate login — removing an entry just forgets it; it'll reappear next time you open that icon.
            </div>
          </div>
        </div>
      </div>

      {loading && (
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', textAlign: 'center', padding: '2px 0' }}>
          Loading Home Screen installs…
        </div>
      )}

      {/* Home Screen installs */}
      {!loading && connections.length > 0 && (
        <div style={card}>
          {connections.map((c, i) => (
            <div key={c.id} style={{ ...rowStyle, borderTop: i === 0 ? 'none' : '1px solid var(--color-surface-tint-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                <div style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Icon name="add_to_home_screen" size={16} color="var(--color-primary)" />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.deviceName}
                  </div>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 1 }}>
                    {c.osVersion ? `${c.osVersion}  ·  ` : ''}Added {fmtTokenDate(c.createdAt)}
                    {'  ·  '}{c.lastSeenAt ? `Last opened ${fmtTokenDate(c.lastSeenAt)}` : 'Never opened'}
                  </div>
                </div>
              </div>
              <button
                onClick={() => handleRemove(c.id)}
                disabled={removingId === c.id}
                title="Remove"
                style={{ flexShrink: 0, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-error)', background: 'var(--color-error-bg-alt)', border: '1px solid var(--color-error-bg)', borderRadius: 8, padding: '7px 12px', cursor: removingId === c.id ? 'wait' : 'pointer', transition: 'background 150ms' }}
                onMouseEnter={e => { if (removingId !== c.id) e.currentTarget.style.background = 'var(--color-red-pale-7)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-error-bg-alt)'; }}
              >
                {removingId === c.id ? 'Removing…' : 'Remove'}
              </button>
            </div>
          ))}
        </div>
      )}

      {!loading && connections.length === 0 && (
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', textAlign: 'center', padding: '2px 0' }}>
          No Home Screen installs detected yet.
        </div>
      )}
    </div>
  );
}

// ── Calendar Sync (CalDAV) ─────────────────────────────────────────────────────

const CALDAV_PW_KEY = 'solytiq_caldav_pw';

function CalDavSection() {
  const [status, setStatus] = useState<CaldavStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [password, setPassword] = useState<string | null>(
    () => sessionStorage.getItem(CALDAV_PW_KEY)
  );
  const [showPassword, setShowPassword] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = () => apiGetCaldavStatus().then(setStatus).catch(() => setStatus(null));
  useEffect(() => { refresh().finally(() => setLoading(false)); }, []);

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(null), 2000); }).catch(() => {});
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const r = await apiGenerateCaldavPassword();
      sessionStorage.setItem(CALDAV_PW_KEY, r.password);
      setPassword(r.password);
      await refresh();
    } catch { /* ignore */ } finally { setGenerating(false); }
  };

  const handleRevoke = async () => {
    setRevoking(true);
    try {
      await apiRevokeCaldav();
      sessionStorage.removeItem(CALDAV_PW_KEY);
      setPassword(null);
      await refresh();
    } catch { /* ignore */ } finally { setRevoking(false); }
  };

  const serverUrl = status?.serverUrl ?? `${window.location.origin}/caldav/`;
  const username = status?.username ?? '';
  const connected = !!status?.connected;

  const copyRow = (label: string, value: string, key: string) => (
    <div>
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <code style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '8px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value || '—'}</code>
        <button onClick={() => copy(value, key)} title={`Copy ${label}`}
          style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: copied === key ? 'var(--color-success)' : 'var(--color-primary)', background: copied === key ? 'rgba(var(--color-success-rgb), 0.1)' : 'var(--color-surface-tint)', border: 'none', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', transition: 'all 150ms' }}>
          <Icon name={copied === key ? 'check' : 'content_copy'} size={13} color={copied === key ? 'var(--color-success)' : 'var(--color-primary)'} />
          {copied === key ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );

  const step = (n: number, text: React.ReactNode) => (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <div style={{ flexShrink: 0, width: 20, height: 20, borderRadius: '50%', background: 'var(--color-primary)', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{n}</div>
      <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.55 }}>{text}</div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Intro */}
      <div style={{ ...card, padding: '14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="event_available" size={19} color="var(--color-primary)" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Connect a calendar app</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginTop: 3 }}>
              Subscribe from Apple Calendar, Thunderbird or any CalDAV app. Everything on your Calendar page — tasks, milestones and meetings across all your workspaces — appears automatically, with each workspace as its own calendar. Meetings stay in two-way sync.
            </div>
          </div>
        </div>
      </div>

      {/* Connection details */}
      <div style={{ ...card, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {copyRow('Server address', serverUrl, 'url')}
        {copyRow('User name', username, 'user')}

        {/* Password area */}
        <div>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>Password</div>
          {password ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <code style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 13.5, fontWeight: 700, letterSpacing: showPassword ? '0.04em' : '0.15em', color: 'var(--color-text-primary)', background: 'var(--color-orange-pale-4)', border: '1px solid var(--color-orange-tint-2)', borderRadius: 8, padding: '8px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {showPassword ? password : '••••••••••••••••'}
                </code>
                <button onClick={() => setShowPassword(v => !v)} title={showPassword ? 'Hide password' : 'Show password'}
                  style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-surface-tint)', border: 'none', borderRadius: 8, padding: '8px 10px', cursor: 'pointer', transition: 'background 150ms' }}>
                  <Icon name={showPassword ? 'visibility_off' : 'visibility'} size={15} color="var(--color-primary)" />
                </button>
                <button onClick={() => copy(password, 'pw')} title="Copy password"
                  style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: copied === 'pw' ? 'var(--color-success)' : 'var(--color-primary)', background: copied === 'pw' ? 'rgba(var(--color-success-rgb), 0.1)' : 'var(--color-surface-tint)', border: 'none', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', transition: 'all 150ms' }}>
                  <Icon name={copied === 'pw' ? 'check' : 'content_copy'} size={13} color={copied === 'pw' ? 'var(--color-success)' : 'var(--color-primary)'} />
                  {copied === 'pw' ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7 }}>
                <Icon name="warning" size={13} color="var(--color-warning)" />
                <span style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-warning)' }}>Copy it now — available in this tab until you close it, then gone for security.</span>
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <code style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 13.5, letterSpacing: '0.15em', color: 'var(--color-text-quaternary)', background: 'var(--color-surface-neutral)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '8px 10px', whiteSpace: 'nowrap' }}>
                ••••••••••••••••
              </code>
              <button disabled title="No password generated yet"
                style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-gray-pale-1)', border: 'none', borderRadius: 8, padding: '8px 10px', cursor: 'not-allowed', opacity: 0.4 }}>
                <Icon name="visibility" size={15} color="var(--color-text-quaternary)" />
              </button>
              <button disabled title="No password generated yet"
                style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-quaternary)', background: 'var(--color-gray-pale-1)', border: 'none', borderRadius: 8, padding: '8px 12px', cursor: 'not-allowed', opacity: 0.4 }}>
                <Icon name="content_copy" size={13} color="var(--color-text-quaternary)" />
                Copy
              </button>
            </div>
          )}
          {!password && (
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-quaternary)', marginTop: 6 }}>
              {connected
                ? `Connected${status?.lastUsedAt ? ` · Last synced ${fmtTokenDate(status.lastUsedAt)}` : ' · Not synced yet'}. Regenerate to get a new copyable password.`
                : 'Generate a password to finish setup.'}
            </div>
          )}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={handleGenerate} disabled={generating}
            style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: generating ? 'var(--color-border-strong)' : 'var(--color-primary)', border: 'none', borderRadius: 10, padding: '10px 18px', cursor: generating ? 'wait' : 'pointer', transition: 'background 150ms' }}>
            <Icon name={connected ? 'autorenew' : 'key'} size={15} color="var(--color-white)" />
            {generating ? 'Generating…' : connected ? 'Regenerate password' : 'Generate password'}
          </button>
          {connected && (
            <button onClick={handleRevoke} disabled={revoking}
              style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-error)', background: 'var(--color-error-bg-alt)', border: '1px solid var(--color-error-bg)', borderRadius: 10, padding: '10px 18px', cursor: revoking ? 'wait' : 'pointer', transition: 'background 150ms' }}>
              {revoking ? 'Disconnecting…' : 'Disconnect'}
            </button>
          )}
        </div>
      </div>

      {/* How-to */}
      {!loading && (
        <div style={{ ...card, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)' }}>Add to Apple Calendar</div>
          {step(1, <>Generate a password above and copy it.</>)}
          {step(2, <>On <b>Mac</b>: Calendar → Settings → Accounts → <b>+</b> → <b>Other CalDAV Account</b>. On <b>iPhone/iPad</b>: Settings → Calendar → Accounts → Add Account → Other → <b>Add CalDAV Account</b>.</>)}
          {step(3, <>Set <b>Account Type</b> to <b>Manual</b>, then enter the <b>Server address</b>, your <b>User name</b> (email) and the generated <b>password</b> from above.</>)}
          {step(4, <>Save. Each workspace appears as its own calendar, plus a <b>Meetings</b> calendar you can add events to.</>)}
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-quaternary)', lineHeight: 1.5, marginTop: 2 }}>
            Tasks appear as to-dos (in Reminders / your to-do view); milestones and meetings appear as events. Tasks &amp; milestones are read-only; meetings sync both ways.
          </div>
        </div>
      )}
    </div>
  );
}

// ── Timezone Selector ─────────────────────────────────────────────────────────

const COMMON_TIMEZONES: Array<{ label: string; value: string }> = [
  { label: 'Pacific/Honolulu (UTC-10)', value: 'Pacific/Honolulu' },
  { label: 'America/Anchorage (UTC-9)', value: 'America/Anchorage' },
  { label: 'America/Los_Angeles (UTC-8/-7)', value: 'America/Los_Angeles' },
  { label: 'America/Denver (UTC-7/-6)', value: 'America/Denver' },
  { label: 'America/Chicago (UTC-6/-5)', value: 'America/Chicago' },
  { label: 'America/New_York (UTC-5/-4)', value: 'America/New_York' },
  { label: 'America/Sao_Paulo (UTC-3)', value: 'America/Sao_Paulo' },
  { label: 'Atlantic/Azores (UTC-1)', value: 'Atlantic/Azores' },
  { label: 'Europe/London (UTC+0/+1)', value: 'Europe/London' },
  { label: 'Europe/Paris (UTC+1/+2)', value: 'Europe/Paris' },
  { label: 'Europe/Berlin (UTC+1/+2)', value: 'Europe/Berlin' },
  { label: 'Europe/Amsterdam (UTC+1/+2)', value: 'Europe/Amsterdam' },
  { label: 'Europe/Stockholm (UTC+1/+2)', value: 'Europe/Stockholm' },
  { label: 'Europe/Helsinki (UTC+2/+3)', value: 'Europe/Helsinki' },
  { label: 'Europe/Istanbul (UTC+3)', value: 'Europe/Istanbul' },
  { label: 'Asia/Dubai (UTC+4)', value: 'Asia/Dubai' },
  { label: 'Asia/Karachi (UTC+5)', value: 'Asia/Karachi' },
  { label: 'Asia/Kolkata (UTC+5:30)', value: 'Asia/Kolkata' },
  { label: 'Asia/Dhaka (UTC+6)', value: 'Asia/Dhaka' },
  { label: 'Asia/Bangkok (UTC+7)', value: 'Asia/Bangkok' },
  { label: 'Asia/Singapore (UTC+8)', value: 'Asia/Singapore' },
  { label: 'Asia/Shanghai (UTC+8)', value: 'Asia/Shanghai' },
  { label: 'Asia/Tokyo (UTC+9)', value: 'Asia/Tokyo' },
  { label: 'Australia/Sydney (UTC+10/+11)', value: 'Australia/Sydney' },
  { label: 'Pacific/Auckland (UTC+12/+13)', value: 'Pacific/Auckland' },
];

interface TimezoneSelectorProps {
  value: string;
  onChange: (tz: string) => void;
}

function TimezoneSelector({ value, onChange }: TimezoneSelectorProps) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const filtered = COMMON_TIMEZONES.filter(tz =>
    tz.label.toLowerCase().includes(search.toLowerCase()) ||
    tz.value.toLowerCase().includes(search.toLowerCase())
  );

  const current = COMMON_TIMEZONES.find(tz => tz.value === value);
  const displayLabel = current?.label ?? value;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => { setOpen(v => !v); setSearch(''); }}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '9px 12px', borderRadius: 8, border: '1.5px solid var(--color-border)', background: 'var(--color-white)', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)', transition: 'border-color 150ms' }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-primary)'; }}
        onMouseLeave={e => { if (!open) e.currentTarget.style.borderColor = 'var(--color-border)'; }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Icon name="public" size={14} color="var(--color-accent-purple-light)" />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>{displayLabel}</span>
        </div>
        <Icon name={open ? 'expand_less' : 'expand_more'} size={16} color="var(--color-text-tertiary)" />
      </button>

      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 200, background: 'var(--color-white)', borderRadius: 10, border: '1.5px solid var(--color-border)', boxShadow: '0 8px 24px rgba(var(--color-black-rgb), 0.13)', overflow: 'hidden', animation: 'wizardStepIn 160ms cubic-bezier(0.22,1,0.36,1) both' }}>
          {/* Search */}
          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--color-surface-tint-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="search" size={14} color="var(--color-text-quaternary)" />
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search timezone…"
              style={{ flex: 1, border: 'none', outline: 'none', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)', background: 'transparent' }}
            />
          </div>
          {/* List */}
          <div style={{ maxHeight: 180, overflowY: 'auto' }}>
            {filtered.length === 0 ? (
              <div style={{ padding: '14px 14px', fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', textAlign: 'center' }}>No matches</div>
            ) : (
              filtered.map(tz => {
                const selected = tz.value === value;
                return (
                  <button
                    key={tz.value}
                    onClick={() => { onChange(tz.value); setOpen(false); }}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 14px', border: 'none', background: selected ? 'var(--color-surface-tint)' : 'transparent', cursor: 'pointer', textAlign: 'left', transition: 'background 100ms' }}
                    onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--color-surface-tint-3)'; }}
                    onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: selected ? 'var(--color-primary)' : 'var(--color-text-primary)', fontWeight: selected ? 600 : 400 }}>{tz.label}</span>
                    {selected && <Icon name="check" size={13} color="var(--color-primary)" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Inline 2FA wizard (same as TwoFAWizard but imported inline to avoid circular deps) ──

interface TwoFAWizardInlineProps {
  onClose: () => void;
  onEnabled: () => void;
}

function TwoFAWizardInline({ onClose, onEnabled }: TwoFAWizardInlineProps) {
  const [step, setStep] = useState<'intro' | 'scan' | 'verify' | 'done'>('intro');
  const [qrCode, setQrCode] = useState('');
  const [secret, setSecret] = useState('');
  const [loadingSetup, setLoadingSetup] = useState(false);
  const [copied, setCopied] = useState(false);
  const [otp, setOtp] = useState(Array(6).fill(''));
  const [otpError, setOtpError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [shake, setShake] = useState(false);

  const r0 = useRef<HTMLInputElement>(null);
  const r1 = useRef<HTMLInputElement>(null);
  const r2 = useRef<HTMLInputElement>(null);
  const r3 = useRef<HTMLInputElement>(null);
  const r4 = useRef<HTMLInputElement>(null);
  const r5 = useRef<HTMLInputElement>(null);
  const otpRefs = [r0, r1, r2, r3, r4, r5];
  const otpComplete = otp.every(d => d !== '');

  useEffect(() => {
    if (step !== 'scan' || qrCode) return;
    setLoadingSetup(true);
    api2FASetup()
      .then(data => { setQrCode(data.qrCode); setSecret(data.secret); })
      .catch(() => setOtpError('Failed to generate QR code. Please try again.'))
      .finally(() => setLoadingSetup(false));
  }, [step]);

  useEffect(() => {
    if (step !== 'done') return;
    const t = setTimeout(() => { onEnabled(); onClose(); }, 1600);
    return () => clearTimeout(t);
  }, [step]);

  const handleOtpChange = (i: number, raw: string) => {
    const digit = raw.replace(/\D/g, '').slice(-1);
    setOtp(prev => { const next = [...prev]; next[i] = digit; return next; });
    setOtpError('');
    if (digit && i < 5) otpRefs[i + 1].current?.focus();
  };
  const handleOtpKey = (i: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace') {
      if (!otp[i] && i > 0) { setOtp(prev => { const n = [...prev]; n[i - 1] = ''; return n; }); otpRefs[i - 1].current?.focus(); }
      else setOtp(prev => { const n = [...prev]; n[i] = ''; return n; });
    } else if (e.key === 'Enter' && otpComplete) handleVerify();
  };
  const handleOtpPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const digits = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6).split('');
    const next = Array(6).fill('');
    digits.forEach((d, i) => { next[i] = d; });
    setOtp(next);
    otpRefs[Math.min(digits.length, 5)].current?.focus();
  };
  const copySecret = () => {
    navigator.clipboard.writeText(secret).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };
  const handleVerify = async () => {
    const code = otp.join('');
    if (code.length !== 6) return;
    setVerifying(true);
    setOtpError('');
    try {
      await api2FAEnable(code);
      setStep('done');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      setOtpError(msg.includes('Invalid') ? 'Invalid code — please try again.' : 'Something went wrong.');
      setOtp(Array(6).fill(''));
      setShake(true); setTimeout(() => setShake(false), 500);
      setTimeout(() => r0.current?.focus(), 80);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.32)', backdropFilter: 'blur(6px)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'backdropIn 200ms ease both' }}
      onClick={e => { if (e.target === e.currentTarget && step !== 'done') onClose(); }}
    >
      <div
        style={{ background: 'var(--color-white)', borderRadius: 22, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(var(--color-black-rgb), 0.24)', animation: 'nestedModalIn 320ms cubic-bezier(0.22,1,0.36,1) both', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}
      >
        {step === 'intro' && (
          <div style={{ padding: '36px 32px 32px', display: 'flex', flexDirection: 'column', gap: 0, animation: 'wizardStepIn 240ms cubic-bezier(0.22,1,0.36,1) both' }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
              <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }} onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                <Icon name="close" size={18} color="var(--color-text-quaternary)" />
              </button>
            </div>
            <div style={{ width: 64, height: 64, borderRadius: 20, background: 'linear-gradient(135deg, var(--color-surface-tint) 0%, var(--color-purple-pale-38) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
              <Icon name="shield_lock" size={30} color="var(--color-primary)" />
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.02em', marginBottom: 8 }}>Enable Two-Factor Auth</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-tertiary)', lineHeight: 1.6, marginBottom: 28 }}>
              Add an extra layer of security. Each login will require a one-time code from your authenticator app.
            </div>
            <div style={{ background: 'var(--color-surface-gray)', borderRadius: 12, padding: '14px 16px', marginBottom: 28, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: 'var(--color-text-quaternary)', marginBottom: 2 }}>You'll need</div>
              {[{ icon: 'smartphone', text: 'An authenticator app (Google Authenticator, Authy, 1Password…)' }, { icon: 'qr_code_scanner', text: 'A few seconds to scan a QR code' }].map(item => (
                <div key={item.icon} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
                    <Icon name={item.icon} size={14} color="var(--color-primary)" />
                  </div>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5, paddingTop: 5 }}>{item.text}</div>
                </div>
              ))}
            </div>
            <button onClick={() => setStep('scan')}
              style={{ width: '100%', background: 'var(--color-primary)', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, padding: '13px 0', borderRadius: 12, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'background 150ms' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-purple-mid-10)'; }} onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-primary)'; }}>
              Get Started <Icon name="arrow_forward" size={16} color="var(--color-white)" />
            </button>
          </div>
        )}

        {step === 'scan' && (
          <div style={{ padding: '28px 32px 32px', display: 'flex', flexDirection: 'column', gap: 0, animation: 'wizardStepIn 240ms cubic-bezier(0.22,1,0.36,1) both' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {[0, 1].map(i => (<div key={i} style={{ width: i === 0 ? 20 : 8, height: 8, borderRadius: 4, background: i === 0 ? 'var(--color-primary)' : 'var(--color-border)', transition: 'all 300ms' }} />))}
              </div>
              <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }} onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                <Icon name="close" size={18} color="var(--color-text-quaternary)" />
              </button>
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 6 }}>Scan the QR code</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginBottom: 24 }}>Open your authenticator app and scan this code. Or enter the setup key manually.</div>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
              {loadingSetup ? (
                <div style={{ width: 180, height: 180, background: 'var(--color-surface-gray)', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--color-border-alt)' }}>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>Generating…</div>
                </div>
              ) : qrCode ? (
                <div style={{ padding: 12, background: 'var(--color-white)', border: '1.5px solid var(--color-border)', borderRadius: 14, boxShadow: '0 2px 12px rgba(var(--color-primary-rgb), 0.08)' }}>
                  <img src={qrCode} alt="2FA QR Code" style={{ width: 164, height: 164, display: 'block', borderRadius: 4 }} />
                </div>
              ) : (
                <div style={{ width: 180, height: 180, background: 'var(--color-error-bg-alt)', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--color-error-bg)' }}>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-error)', textAlign: 'center', padding: '0 12px' }}>Failed to load QR code</div>
                </div>
              )}
            </div>
            {secret && (
              <div style={{ background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 10, padding: '10px 12px', marginBottom: 24, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.06em', color: 'var(--color-text-quaternary)', marginBottom: 3 }}>Setup key</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-text-primary)', letterSpacing: '0.1em', wordBreak: 'break-all' as const }}>{secret.match(/.{1,4}/g)?.join(' ')}</div>
                </div>
                <button onClick={copySecret} title="Copy setup key"
                  style={{ flexShrink: 0, width: 32, height: 32, borderRadius: 8, border: 'none', background: copied ? 'rgba(var(--color-success-rgb), 0.1)' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 150ms' }}
                  onMouseEnter={e => { if (!copied) e.currentTarget.style.background = 'var(--color-surface-tint)'; }} onMouseLeave={e => { if (!copied) e.currentTarget.style.background = 'transparent'; }}>
                  <Icon name={copied ? 'check' : 'content_copy'} size={15} color={copied ? 'var(--color-success)' : 'var(--color-text-tertiary)'} />
                </button>
              </div>
            )}
            <button onClick={() => { setStep('verify'); setTimeout(() => r0.current?.focus(), 80); }} disabled={loadingSetup || !qrCode}
              style={{ width: '100%', background: loadingSetup || !qrCode ? 'var(--color-border-strong)' : 'var(--color-primary)', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, padding: '13px 0', borderRadius: 12, border: 'none', cursor: loadingSetup || !qrCode ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'background 150ms' }}
              onMouseEnter={e => { if (!loadingSetup && qrCode) e.currentTarget.style.background = 'var(--color-purple-mid-10)'; }} onMouseLeave={e => { if (!loadingSetup && qrCode) e.currentTarget.style.background = 'var(--color-primary)'; }}>
              I've scanned it <Icon name="arrow_forward" size={16} color="var(--color-white)" />
            </button>
          </div>
        )}

        {step === 'verify' && (
          <div style={{ padding: '28px 32px 32px', display: 'flex', flexDirection: 'column', gap: 0, animation: 'wizardStepIn 240ms cubic-bezier(0.22,1,0.36,1) both' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {[0, 1].map(i => (<div key={i} style={{ width: i === 1 ? 20 : 8, height: 8, borderRadius: 4, background: i === 1 ? 'var(--color-primary)' : 'var(--color-border)', transition: 'all 300ms' }} />))}
              </div>
              <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }} onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                <Icon name="close" size={18} color="var(--color-text-quaternary)" />
              </button>
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 6 }}>Confirm setup</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginBottom: 28 }}>Enter the 6-digit code from your authenticator app to confirm setup.</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 8, animation: shake ? 'shake 400ms ease-in-out' : undefined }}>
              {otp.map((digit, i) => (
                <input key={i} ref={otpRefs[i]} type="text" inputMode="numeric" maxLength={1} value={digit}
                  onChange={e => handleOtpChange(i, e.target.value)} onKeyDown={e => handleOtpKey(i, e)}
                  onPaste={i === 0 ? handleOtpPaste : undefined}
                  style={{ width: 46, height: 56, textAlign: 'center', fontFamily: 'var(--font-heading)', fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)', background: digit ? 'var(--color-surface-tint)' : 'var(--color-surface-gray)', border: `2px solid ${otpError ? 'var(--color-error-bg)' : digit ? 'var(--color-primary)' : 'var(--color-border-alt)'}`, borderRadius: 10, outline: 'none', transition: 'border-color 150ms, background 150ms', caretColor: 'transparent' }}
                />
              ))}
            </div>
            {otpError && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)', textAlign: 'center', marginBottom: 16, marginTop: 4 }}>{otpError}</div>}
            {!otpError && <div style={{ height: 20, marginBottom: 16 }} />}
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => { setStep('scan'); setOtp(Array(6).fill('')); setOtpError(''); }}
                style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)', background: 'var(--color-surface-gray)', border: '1.5px solid var(--color-border-alt)', borderRadius: 12, padding: '12px 0', cursor: 'pointer', transition: 'background 150ms' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }} onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface-gray)'; }}>
                ← Back
              </button>
              <button onClick={handleVerify} disabled={verifying || !otpComplete}
                style={{ flex: 2, background: verifying || !otpComplete ? 'var(--color-border-strong)' : 'var(--color-primary)', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, padding: '12px 0', borderRadius: 12, border: 'none', cursor: verifying || !otpComplete ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, transition: 'background 150ms' }}
                onMouseEnter={e => { if (!verifying && otpComplete) e.currentTarget.style.background = 'var(--color-purple-mid-10)'; }} onMouseLeave={e => { if (!verifying && otpComplete) e.currentTarget.style.background = 'var(--color-primary)'; }}>
                {verifying ? 'Activating…' : <><Icon name="shield_lock" size={15} color="var(--color-white)" />Activate 2FA</>}
              </button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div style={{ padding: '48px 32px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, animation: 'wizardStepIn 280ms cubic-bezier(0.22,1,0.36,1) both' }}>
            <div style={{ width: 68, height: 68, borderRadius: '50%', background: 'rgba(var(--color-success-rgb), 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'scIn 400ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
              <Icon name="check_circle" size={36} color="var(--color-success)" />
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', textAlign: 'center' }}>2FA Enabled!</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-tertiary)', textAlign: 'center', lineHeight: 1.5 }}>Your account is now protected with two-factor authentication.</div>
          </div>
        )}
      </div>
    </div>
  );
}
