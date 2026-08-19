import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../components/Icon';
import { motion } from '../components/animate-ui/motion';
import MotionIn from '../components/animate-ui/MotionIn';
import MotionButton from '../components/animate-ui/MotionButton';
import { EASE_SETTLE, EASE_SPRING, EASE_STANDARD } from '../components/animate-ui/motionTokens';
import { useMobile } from '../hooks/useBreakpoint';
import useAsyncData from '../hooks/useAsyncData';
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
  apiUpdateEmailNotificationPrefs,
  apiVerifySessionToken,
  type ApiAccessToken,
  type MobileConnection,
  type HomescreenConnection,
  type CaldavStatus,
} from '../api/client';

interface UserSettingsModalProps {
  onClose: () => void;
}

type PwStep = 'idle' | 'current' | 'new' | 'done';

// Static part only — the focus-driven border color is animated separately
// via `inputBorderAnimate`/`motion.input`'s `animate` prop, not a raw CSS
// `transition`.
const inputStyle: React.CSSProperties = {
  width: '100%',
  fontFamily: 'var(--font-body)',
  fontSize: 14,
  color: 'var(--color-text-primary)',
  background: 'transparent',
  border: 'none',
  outline: 'none',
  padding: '8px 0',
  borderBottomWidth: 1.5,
  borderBottomStyle: 'solid',
};

const inputBorderAnimate = (focused: boolean) => ({
  borderBottomColor: focused ? 'var(--color-primary)' : 'var(--color-border-alt)',
});
const inputBorderTransition = { duration: 0.18, ease: EASE_STANDARD };

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

type SettingsTab = 'profile' | 'preferences' | 'notifications' | 'controls' | 'security' | 'connections' | 'mobile' | 'calendar';

/** Tabs with no pill on the mobile layout — see the clamp in the component. */
const MOBILE_HIDDEN_TABS = new Set<SettingsTab>(['controls', 'mobile', 'calendar']);

export default function UserSettingsModal({ onClose }: UserSettingsModalProps) {
  const isMobile = useMobile();
  const { username, fullName, email, profileImage, isAdmin, totpEnabled, setProfile, setTotpEnabled } = useAuthStore();
  const { timezone, setTimezone, defaultListViewMode, setDefaultListViewMode } = useUserPrefsStore();

  const [rawActiveTab, setActiveTab] = useState<SettingsTab>('profile');

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

  // 2FA — disable flow. `disablePassword` is a fresh step-up re-check (S3) —
  // a valid-but-stolen session token alone must not be enough to turn off a
  // user's second factor, so the account password is required in addition
  // to a valid TOTP code.
  const [disableOpen, setDisableOpen] = useState(false);
  const [disableOtp, setDisableOtp] = useState(Array(6).fill(''));
  const [disablePassword, setDisablePassword] = useState('');
  const [disablePasswordVisible, setDisablePasswordVisible] = useState(false);
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
    if (code.length !== 6 || !disablePassword) return;
    setDisableLoading(true);
    setDisableError('');
    try {
      await api2FADisable(code, disablePassword);
      setTotpEnabled(false);
      setDisableOpen(false);
      setDisableOtp(Array(6).fill(''));
      setDisablePassword('');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      setDisableError(
        msg.includes('password') ? 'Incorrect password.'
        : msg.includes('Invalid') ? 'Invalid code — please try again.'
        : 'Something went wrong.'
      );
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
    { id: 'profile',       label: 'Profile',       icon: 'person' },
    { id: 'preferences',   label: 'Preferences',   icon: 'tune' },
    { id: 'notifications', label: 'Notifications', icon: 'mail' },
    ...(isMobile ? [] : [{ id: 'controls' as SettingsTab, label: 'Controls', icon: 'keyboard' }]),
    { id: 'security',    label: 'Security',    icon: 'shield_lock' },
    ...(mcpVisible ? [{ id: 'connections' as SettingsTab, label: 'Connections', icon: 'smart_toy' }] : []),
    ...(mobileEnabled && !isMobile ? [{ id: 'mobile' as SettingsTab, label: 'Mobile', icon: 'smartphone' }] : []),
    ...(isMobile ? [] : [{ id: 'calendar' as SettingsTab, label: 'Calendar Sync', icon: 'event_available' }]),
  ];

  // If the viewport crosses into mobile while a now-hidden tab is active
  // (e.g. rotating/resizing mid-session), fall back to Profile rather than
  // stranding the panel on a tab with no corresponding pill to reselect.
  // Clamped at render rather than corrected by an effect: the effect version
  // painted one frame on the now-invalid tab before snapping back.
  const activeTab = isMobile && MOBILE_HIDDEN_TABS.has(rawActiveTab) ? 'profile' : rawActiveTab;

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
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: closing ? 0 : 1 }}
        transition={{ duration: closing ? 0.19 : 0.22, ease: EASE_STANDARD }}
        style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.24)', backdropFilter: 'blur(5px)', zIndex: 1000, display: 'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center', padding: isMobile ? 0 : 24 }}
        onClick={e => { if (e.target === e.currentTarget) handleClose(); }}
      >
        <motion.div
          initial={isMobile ? { opacity: 0.6, y: '100%' } : { opacity: 0, y: 22, scale: 0.96 }}
          animate={closing ? { opacity: 0, y: 14, scale: 0.97 } : { opacity: 1, y: 0, scale: 1 }}
          transition={closing ? { duration: 0.19, ease: 'easeIn' } : { duration: isMobile ? 0.3 : 0.36, ease: EASE_SETTLE }}
          style={{ background: 'var(--color-white)', borderRadius: isMobile ? '16px 16px 0 0' : 22, width: '100%', maxWidth: isMobile ? undefined : 1024, boxShadow: '0 20px 60px rgba(var(--color-black-rgb), 0.22)', overflow: 'hidden', maxHeight: '95vh', display: 'flex', flexDirection: 'column' }}
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '22px 24px 0' }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.01em' }}>Account Settings</div>
            <MotionButton
              onClick={handleClose}
              style={{ width: 30, height: 30, borderRadius: '50%', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              animate={{ background: 'var(--color-surface-tint-2)', scale: 1 }}
              whileHover={{ background: 'var(--color-border)', scale: 1.08 }}
              transition={{ duration: 0.15 }}
            >
              <Icon name="close" size={15} color="var(--color-text-secondary)" />
            </MotionButton>
          </div>

          {/* Tab bar */}
          <div style={{ padding: '16px 24px 0' }}>
            <div style={{ display: 'flex', flexWrap: isMobile ? 'nowrap' : 'wrap', gap: 4, background: 'var(--color-surface-tint)', borderRadius: 14, padding: 4, overflowX: isMobile ? 'auto' : undefined, WebkitOverflowScrolling: 'touch', flexShrink: 0 }}>
              {TABS.map(tab => {
                const active = activeTab === tab.id;
                return (
                  <MotionButton
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    title={isMobile ? tab.label : undefined}
                    animate={{
                      color: active ? 'var(--color-white)' : 'var(--color-primary)',
                      background: active ? 'var(--color-primary)' : 'transparent',
                    }}
                    whileHover={!active ? { background: 'var(--color-surface-tint-4)' } : undefined}
                    transition={{ duration: 0.15 }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: isMobile ? 0 : 6,
                      fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600,
                      border: 'none', borderRadius: 10, padding: isMobile ? '9px 14px' : '9px 16px', cursor: 'pointer',
                      flex: isMobile ? '1 1 0' : '1 1 auto', justifyContent: 'center',
                    }}
                  >
                    <Icon name={tab.icon} size={isMobile ? 19 : 15} color={active ? 'var(--color-white)' : 'var(--color-primary)'} />
                    {!isMobile && <span style={{ whiteSpace: 'nowrap' }}>{tab.label}</span>}
                  </MotionButton>
                );
              })}
            </div>
          </div>

          {/* Scrollable body */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px 28px', display: 'flex', flexDirection: 'column', gap: 24 }}>

            {/* ── PROFILE ── */}
            {activeTab === 'profile' && (
            <MotionIn initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.34, ease: EASE_SETTLE }}>
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
                    <MotionIn
                      animate={{ boxShadow: avatarHover ? '0 0 0 3px rgba(var(--color-primary-rgb), 0.35)' : '0 0 0 0px transparent' }}
                      transition={{ duration: 0.2 }}
                      style={{ width: 72, height: 72, borderRadius: '50%', background: 'linear-gradient(135deg, var(--color-accent-purple-light) 0%, var(--color-primary) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}
                    >
                      {profileImage ? (
                        <motion.img
                          key={profileImage}
                          src={profileImage}
                          alt={username}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ duration: 0.3, ease: EASE_STANDARD }}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        />
                      ) : (
                        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 26, fontWeight: 700, color: 'var(--color-white)' }}>
                          {(fullName || username || 'U').split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2)}
                        </span>
                      )}
                    </MotionIn>
                    <MotionIn
                      animate={{ opacity: avatarHover ? 1 : 0 }}
                      transition={{ duration: 0.18 }}
                      style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'rgba(var(--color-black-rgb), 0.42)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}
                    >
                      <Icon name="add" size={24} color="var(--color-white)" />
                    </MotionIn>
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
                    <motion.input
                      value={nameValue}
                      onChange={e => { setNameValue(e.target.value); setNameError(''); setNameSaved(false); }}
                      onFocus={() => setNameFocused(true)}
                      onBlur={() => setNameFocused(false)}
                      onKeyDown={e => { if (e.key === 'Enter') handleSaveName(); if (e.key === 'Escape') setNameValue(fullName || username); }}
                      animate={inputBorderAnimate(nameFocused)}
                      transition={inputBorderTransition}
                      style={{ ...inputStyle, flex: 1 }}
                      placeholder="Your full name"
                    />
                    {pwChanged && (
                      <MotionButton
                        onClick={handleSaveName}
                        disabled={nameSaving}
                        style={{ flexShrink: 0, width: 28, height: 28, borderRadius: 7, border: 'none', cursor: nameSaving ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        animate={{ background: nameSaved ? 'rgba(var(--color-success-rgb), 0.1)' : 'var(--color-surface-tint)' }}
                        whileHover={!nameSaving && !nameSaved ? { background: 'var(--color-surface-tint-4)' } : undefined}
                        transition={{ duration: 0.15 }}
                      >
                        <Icon name="check" size={14} color={nameSaved ? 'var(--color-success)' : 'var(--color-primary)'} />
                      </MotionButton>
                    )}
                  </div>
                  {nameError && <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-error)', marginTop: 5 }}>{nameError}</div>}
                  {nameSaved && (
                    <MotionIn
                      initial={{ opacity: 0, scale: 0.7 }}
                      animate={{ opacity: [0, 1, 1], scale: [0.7, 1.15, 1] }}
                      transition={{ duration: 0.28, times: [0, 0.6, 1], ease: EASE_SPRING }}
                      style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-success)', marginTop: 5 }}
                    >Saved!</MotionIn>
                  )}
                </div>

                {/* Email */}
                <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--color-surface-tint-2)' }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 10, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Email</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <motion.input
                      type="email"
                      value={emailValue}
                      onChange={e => { setEmailValue(e.target.value); setEmailError(''); setEmailSaved(false); }}
                      onFocus={() => setEmailFocused(true)}
                      onBlur={() => setEmailFocused(false)}
                      onKeyDown={e => { if (e.key === 'Enter') handleSaveEmail(); if (e.key === 'Escape') setEmailValue(email || ''); }}
                      animate={inputBorderAnimate(emailFocused)}
                      transition={inputBorderTransition}
                      style={{ ...inputStyle, flex: 1 }}
                      placeholder="you@example.com"
                      autoComplete="email"
                    />
                    {emailChanged && (
                      <MotionButton
                        onClick={handleSaveEmail}
                        disabled={emailSaving}
                        style={{ flexShrink: 0, width: 28, height: 28, borderRadius: 7, border: 'none', cursor: emailSaving ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        animate={{ background: emailSaved ? 'rgba(var(--color-success-rgb), 0.1)' : 'var(--color-surface-tint)' }}
                        whileHover={!emailSaving && !emailSaved ? { background: 'var(--color-surface-tint-4)' } : undefined}
                        transition={{ duration: 0.15 }}
                      >
                        <Icon name="check" size={14} color={emailSaved ? 'var(--color-success)' : 'var(--color-primary)'} />
                      </MotionButton>
                    )}
                  </div>
                  {emailError && <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-error)', marginTop: 5 }}>{emailError}</div>}
                  {emailSaved && (
                    <MotionIn
                      initial={{ opacity: 0, scale: 0.7 }}
                      animate={{ opacity: [0, 1, 1], scale: [0.7, 1.15, 1] }}
                      transition={{ duration: 0.28, times: [0, 0.6, 1], ease: EASE_SPRING }}
                      style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-success)', marginTop: 5 }}
                    >Saved!</MotionIn>
                  )}
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
            </MotionIn>
            )}

            {/* ── PREFERENCES ── */}
            {activeTab === 'preferences' && (
            <MotionIn style={{ position: 'relative', zIndex: 10 }} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.34, delay: 0.04, ease: EASE_SETTLE }}>
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
                      <MotionButton key={v} onClick={() => setDefaultListViewMode(v)}
                        animate={{
                          borderColor: defaultListViewMode === v ? 'var(--color-primary)' : 'var(--color-border-alt)',
                          background: defaultListViewMode === v ? 'var(--color-surface-tint)' : 'var(--color-white)',
                        }}
                        transition={{ duration: 0.15 }}
                        style={{ flex: 1, padding: '10px', borderRadius: 10, borderWidth: 1.5, borderStyle: 'solid', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                        <Icon name={v === 'list' ? 'format_list_bulleted' : 'view_kanban'} size={16} color={defaultListViewMode === v ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: defaultListViewMode === v ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }}>{v === 'list' ? 'List' : 'Kanban'}</span>
                        {defaultListViewMode === v && <Icon name="check" size={14} color="var(--color-primary)" />}
                      </MotionButton>
                    ))}
                  </div>
                </div>
                <div style={{ height: 1, background: 'var(--color-surface-tint-2)' }} />
                <MemorySection />
              </div>
            </MotionIn>
            )}

            {/* ── NOTIFICATIONS (email) ── */}
            {activeTab === 'notifications' && (
            <MotionIn initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.34, delay: 0.05, ease: EASE_SETTLE }}>
              {sectionLabel('Email Notifications')}
              <EmailNotificationsSection />
            </MotionIn>
            )}

            {/* ── CONTROLS (keyboard shortcuts) ── */}
            {activeTab === 'controls' && (
            <MotionIn initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.34, delay: 0.06, ease: EASE_SETTLE }}>
              {sectionLabel('Keyboard Shortcuts')}
              <ShortcutsSection />
            </MotionIn>
            )}

            {/* ── SECURITY ── */}
            {activeTab === 'security' && (
            <MotionIn initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.34, delay: 0.08, ease: EASE_SETTLE }}>
              {sectionLabel('Security')}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

                {/* Password card */}
                <div style={card}>
                  {pwStep === 'idle' && (
                    <MotionIn style={rowStyle} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: EASE_SETTLE }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <Icon name="lock" size={18} color="var(--color-primary)" />
                        </div>
                        <div>
                          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Password</div>
                          <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 1 }}>Change your account password</div>
                        </div>
                      </div>
                      <MotionButton
                        onClick={() => { setPwStep('current'); setTimeout(() => currentPwRef.current?.focus(), 60); }}
                        style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-primary)', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer' }}
                        animate={{ background: 'var(--color-surface-tint)' }}
                        whileHover={{ background: 'var(--color-surface-tint-4)' }}
                        transition={{ duration: 0.15 }}
                      >
                        Change
                        <Icon name="arrow_forward" size={14} color="var(--color-primary)" />
                      </MotionButton>
                    </MotionIn>
                  )}

                  {pwStep === 'current' && (
                    <MotionIn style={{ padding: '18px 18px 16px' }} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: EASE_SETTLE }}>
                      {/* Progress */}
                      <div style={{ display: 'flex', gap: 5, marginBottom: 16 }}>
                        {[0, 1].map(i => (
                          <MotionIn key={i} animate={{ background: i === 0 ? 'var(--color-primary)' : 'var(--color-border)' }} transition={{ duration: 0.3 }} style={{ height: 3, flex: 1, borderRadius: 99 }} />
                        ))}
                      </div>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 14 }}>Enter your current password</div>
                      <div style={{ position: 'relative' }}>
                        <motion.input
                          ref={currentPwRef}
                          type={currentPwVisible ? 'text' : 'password'}
                          value={currentPw}
                          onChange={e => { setCurrentPw(e.target.value); setPwError(''); }}
                          onFocus={() => setCurrentPwFocused(true)}
                          onBlur={() => setCurrentPwFocused(false)}
                          onKeyDown={e => { if (e.key === 'Enter') handlePwNext(); if (e.key === 'Escape') resetPwWizard(); }}
                          placeholder="Current password"
                          animate={inputBorderAnimate(currentPwFocused)}
                          transition={inputBorderTransition}
                          style={{ ...inputStyle, paddingRight: 32 }}
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
                        <MotionButton
                          onClick={resetPwWizard}
                          style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer' }}
                          animate={{ background: 'var(--color-surface-tint-2)' }}
                          whileHover={{ background: 'var(--color-border)' }}
                          transition={{ duration: 0.15 }}
                        >Cancel</MotionButton>
                        <MotionButton
                          onClick={handlePwNext}
                          disabled={!currentPw}
                          style={{ flex: 2, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', border: 'none', borderRadius: 8, padding: '10px 0', cursor: currentPw ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                          animate={{ background: currentPw ? 'var(--color-primary)' : 'var(--color-border-strong)' }}
                          whileHover={currentPw ? { background: 'var(--color-purple-mid-11)' } : undefined}
                          transition={{ duration: 0.15 }}
                        >
                          Next <Icon name="arrow_forward" size={14} color="var(--color-white)" />
                        </MotionButton>
                      </div>
                    </MotionIn>
                  )}

                  {pwStep === 'new' && (
                    <MotionIn style={{ padding: '18px 18px 16px' }} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: EASE_SETTLE }}>
                      {/* Progress */}
                      <div style={{ display: 'flex', gap: 5, marginBottom: 16 }}>
                        {[0, 1].map(i => (
                          <div key={i} style={{ height: 3, flex: 1, borderRadius: 99, background: 'var(--color-primary)' }} />
                        ))}
                      </div>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 14 }}>Set a new password</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <div style={{ position: 'relative' }}>
                          <motion.input
                            ref={newPwRef}
                            type={newPwVisible ? 'text' : 'password'}
                            value={newPw}
                            onChange={e => { setNewPw(e.target.value); setPwError(''); }}
                            onFocus={() => setNewPwFocused(true)}
                            onBlur={() => setNewPwFocused(false)}
                            onKeyDown={e => { if (e.key === 'Escape') resetPwWizard(); }}
                            placeholder="New password"
                            animate={inputBorderAnimate(newPwFocused)}
                            transition={inputBorderTransition}
                            style={{ ...inputStyle, paddingRight: 32 }}
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
                        <motion.input
                          type={newPwVisible ? 'text' : 'password'}
                          value={confirmPw}
                          onChange={e => { setConfirmPw(e.target.value); setPwError(''); }}
                          onFocus={() => setConfirmPwFocused(true)}
                          onBlur={() => setConfirmPwFocused(false)}
                          onKeyDown={e => { if (e.key === 'Enter') handlePwSave(); if (e.key === 'Escape') resetPwWizard(); }}
                          placeholder="Confirm new password"
                          animate={inputBorderAnimate(confirmPwFocused)}
                          transition={inputBorderTransition}
                          style={inputStyle}
                          autoComplete="new-password"
                        />
                      </div>
                      {newPw.length > 0 && newPw.length < 8 && (
                        <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 6 }}>At least 8 characters required</div>
                      )}
                      {pwError && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)', marginTop: 8 }}>{pwError}</div>}
                      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                        <MotionButton
                          onClick={() => { setPwStep('current'); setPwError(''); setNewPw(''); setConfirmPw(''); }}
                          style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer' }}
                          animate={{ background: 'var(--color-surface-tint-2)' }}
                          whileHover={{ background: 'var(--color-border)' }}
                          transition={{ duration: 0.15 }}
                        >← Back</MotionButton>
                        <MotionButton
                          onClick={handlePwSave}
                          disabled={pwSaving || !newPw || !confirmPw}
                          style={{ flex: 2, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', border: 'none', borderRadius: 8, padding: '10px 0', cursor: pwSaving || !newPw || !confirmPw ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                          animate={{ background: pwSaving || !newPw || !confirmPw ? 'var(--color-border-strong)' : 'var(--color-primary)' }}
                          whileHover={!pwSaving && newPw && confirmPw ? { background: 'var(--color-purple-mid-11)' } : undefined}
                          transition={{ duration: 0.15 }}
                        >
                          {pwSaving ? 'Saving…' : <><Icon name="lock_reset" size={14} color="var(--color-white)" /> Save Password</>}
                        </MotionButton>
                      </div>
                    </MotionIn>
                  )}

                  {pwStep === 'done' && (
                    <MotionIn style={{ padding: '24px 18px', display: 'flex', alignItems: 'center', gap: 14 }} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: EASE_SETTLE }}>
                      <MotionIn
                        initial={{ opacity: 0, scale: 0 }}
                        animate={{ opacity: [0, 1, 1], scale: [0, 1.1, 1] }}
                        transition={{ duration: 0.38, times: [0, 0.6, 1], ease: EASE_SPRING }}
                        style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(var(--color-success-rgb), 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                      >
                        <Icon name="check_circle" size={22} color="var(--color-success)" />
                      </MotionIn>
                      <div>
                        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Password changed!</div>
                        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>Your new password is active.</div>
                      </div>
                    </MotionIn>
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
                          <MotionButton
                            onClick={() => { setDisableOpen(true); setDisableOtp(Array(6).fill('')); setDisablePassword(''); setDisableError(''); }}
                            style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-error)', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer' }}
                            animate={{ background: 'var(--color-error-bg-alt)' }}
                            whileHover={{ background: 'var(--color-error-bg)' }}
                            transition={{ duration: 0.15 }}
                          >Disable</MotionButton>
                        ) : (
                          <MotionButton
                            onClick={() => setTwoFAOpen(true)}
                            style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-primary)', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer' }}
                            animate={{ background: 'var(--color-surface-tint)' }}
                            whileHover={{ background: 'var(--color-surface-tint-4)' }}
                            transition={{ duration: 0.15 }}
                          >Enable 2FA</MotionButton>
                        )}
                      </div>
                    </div>

                    {/* Disable 2FA — password step-up + OTP entry */}
                    {disableOpen && (
                      <div style={{ padding: '0 18px 18px', borderTop: '1px solid var(--color-surface-tint-2)' }}>
                        <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-secondary)', margin: '14px 0 12px' }}>
                          Confirm your password and enter the 6-digit code from your authenticator app to disable 2FA.
                        </div>
                        <div style={{ position: 'relative', marginBottom: 10 }}>
                          <input
                            type={disablePasswordVisible ? 'text' : 'password'}
                            value={disablePassword}
                            onChange={e => { setDisablePassword(e.target.value); setDisableError(''); }}
                            onKeyDown={e => { if (e.key === 'Enter' && disablePassword && disableOtp.every(d => d)) handleDisable2FA(); }}
                            placeholder="Current password"
                            style={{ ...inputStyle, paddingRight: 32 }}
                            autoComplete="current-password"
                          />
                          <button
                            type="button"
                            onClick={() => setDisablePasswordVisible(v => !v)}
                            style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex' }}
                          >
                            <Icon name={disablePasswordVisible ? 'visibility_off' : 'visibility'} size={16} color="var(--color-text-quaternary)" />
                          </button>
                        </div>
                        <MotionIn
                          style={{ display: 'flex', gap: 7, justifyContent: 'center', marginBottom: 8 }}
                          animate={{ x: disableShake ? [0, -8, 8, 0] : 0 }}
                          transition={{ duration: 0.4, times: disableShake ? [0, 0.25, 0.75, 1] : undefined, ease: 'easeInOut' }}
                        >
                          {disableOtp.map((digit, i) => (
                            <motion.input
                              key={i}
                              ref={disableRefs[i]}
                              type="text"
                              inputMode="numeric"
                              maxLength={1}
                              value={digit}
                              onChange={e => handleDisableOtpChange(i, e.target.value)}
                              onKeyDown={e => handleDisableOtpKey(i, e)}
                              onPaste={i === 0 ? handleDisableOtpPaste : undefined}
                              animate={{
                                background: digit ? 'var(--color-surface-tint)' : 'var(--color-surface-gray)',
                                borderColor: disableError ? 'var(--color-error-bg)' : digit ? 'var(--color-primary)' : 'var(--color-border-alt)',
                              }}
                              transition={{ duration: 0.15 }}
                              style={{
                                width: 40, height: 50, textAlign: 'center',
                                fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700,
                                color: 'var(--color-text-primary)',
                                borderWidth: 2, borderStyle: 'solid',
                                borderRadius: 9, outline: 'none',
                                caretColor: 'transparent',
                              }}
                            />
                          ))}
                        </MotionIn>
                        {disableError && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)', textAlign: 'center', marginBottom: 10 }}>{disableError}</div>}
                        <div style={{ display: 'flex', gap: 8, marginTop: disableError ? 0 : 10 }}>
                          <button
                            onClick={() => { setDisableOpen(false); setDisableOtp(Array(6).fill('')); setDisablePassword(''); setDisableError(''); }}
                            style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer' }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-border)'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }}
                          >Cancel</button>
                          <MotionButton
                            onClick={handleDisable2FA}
                            disabled={disableLoading || !disablePassword || !disableOtp.every(d => d)}
                            style={{ flex: 2, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', border: 'none', borderRadius: 8, padding: '9px 0', cursor: disableLoading || !disablePassword || !disableOtp.every(d => d) ? 'not-allowed' : 'pointer' }}
                            animate={{ background: disableLoading || !disablePassword || !disableOtp.every(d => d) ? 'var(--color-border-strong)' : 'var(--color-error)' }}
                            whileHover={!disableLoading && disablePassword && disableOtp.every(d => d) ? { background: 'var(--color-red-deep-1)' } : undefined}
                            transition={{ duration: 0.15 }}
                          >
                            {disableLoading ? 'Disabling…' : 'Confirm Disable'}
                          </MotionButton>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </MotionIn>
            )}

            {/* ── CONNECTIONS (Claude MCP) ── */}
            {activeTab === 'connections' && mcpVisible && (
            <MotionIn initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.34, ease: EASE_SETTLE }}>
              {sectionLabel('Claude MCP')}
              <ClaudeMcpSection />
            </MotionIn>
            )}

            {/* ── MOBILE (device connections) ── */}
            {activeTab === 'mobile' && mobileEnabled && (
            <MotionIn initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.34, ease: EASE_SETTLE }}>
              {sectionLabel('Mobile App')}
              <MobileConnectionsSection />

              <div style={{ marginTop: 28 }}>
                {sectionLabel('iOS Home Screen App')}
                <HomeScreenConnectionsSection />
              </div>
            </MotionIn>
            )}

            {/* ── CALENDAR SYNC (CalDAV) ── */}
            {activeTab === 'calendar' && (
            <MotionIn initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.34, ease: EASE_SETTLE }}>
              {sectionLabel('Calendar Sync (CalDAV)')}
              <CalDavSection />
            </MotionIn>
            )}
          </div>

          {/* Footer save bar */}
          <div style={{ flexShrink: 0, borderTop: '1px solid var(--color-surface-tint-2)', padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 14 }}>
            {savedFlash && (
              <MotionIn
                initial={{ opacity: 0, scale: 0.7 }}
                animate={{ opacity: [0, 1, 1], scale: [0.7, 1.15, 1] }}
                transition={{ duration: 0.32, times: [0, 0.6, 1], ease: EASE_SPRING }}
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <Icon name="check_circle" size={16} color="var(--color-success)" />
                <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-success)' }}>Saved!</span>
              </MotionIn>
            )}
            <MotionButton
              onClick={handleSaveAll}
              disabled={savingAll || !hasPendingEdits}
              style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', border: 'none', borderRadius: 10, padding: '10px 20px', cursor: savingAll || !hasPendingEdits ? 'not-allowed' : 'pointer' }}
              animate={{ background: savingAll || !hasPendingEdits ? 'var(--color-border-strong)' : 'var(--color-primary)', y: 0 }}
              whileHover={!savingAll && hasPendingEdits ? { background: 'var(--color-purple-mid-11)', y: -1 } : undefined}
              transition={{ duration: 0.1 }}
            >
              <Icon name="check" size={15} color="var(--color-white)" />
              {savingAll ? 'Saving…' : 'Save changes'}
            </MotionButton>
          </div>
        </motion.div>
      </motion.div>

      {/* Profile Image Upload Wizard (nested modal) */}
      {uploadWizardOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2, ease: EASE_STANDARD }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.32)', backdropFilter: 'blur(6px)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) closeUploadWizard(); }}
        >
          <MotionIn
            initial={{ opacity: 0, scale: 0.92, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.32, ease: EASE_SETTLE }}
            style={{ background: 'var(--color-white)', borderRadius: 22, width: '100%', maxWidth: 440, boxShadow: '0 20px 60px rgba(var(--color-black-rgb), 0.24)', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 0' }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)' }}>
                {pendingImage ? 'Preview' : 'Upload Profile Photo'}
              </div>
              <MotionButton
                onClick={closeUploadWizard}
                style={{ width: 30, height: 30, borderRadius: '50%', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                animate={{ background: 'var(--color-surface-tint-2)', scale: 1 }}
                whileHover={{ background: 'var(--color-border)', scale: 1.08 }}
                transition={{ duration: 0.15 }}
              >
                <Icon name="close" size={15} color="var(--color-text-secondary)" />
              </MotionButton>
            </div>

            <div style={{ padding: '20px 24px 24px' }}>
              <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" style={{ display: 'none' }} onChange={handleFileInput} />

              {!pendingImage ? (
                <MotionIn initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, ease: EASE_SETTLE }}>
                  <MotionIn
                    onDrop={handleDrop}
                    onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={e => { e.preventDefault(); setDragOver(false); }}
                    onClick={() => fileInputRef.current?.click()}
                    animate={{
                      borderColor: dragOver ? 'var(--color-primary)' : imgFileError ? 'var(--color-error)' : 'var(--color-border)',
                      background: dragOver ? 'var(--color-surface-tint)' : imgFileError ? 'var(--color-error-bg-alt)' : 'var(--color-surface-tint-3)',
                    }}
                    transition={{ duration: 0.2 }}
                    style={{ borderWidth: 2, borderStyle: 'dashed', borderRadius: 16, padding: '36px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none' }}
                  >
                    <MotionIn
                      animate={{ background: dragOver ? 'var(--color-surface-tint-4)' : 'var(--color-surface-tint-2)', scale: dragOver ? 1.12 : 1 }}
                      transition={{ duration: 0.2 }}
                      style={{ width: 52, height: 52, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Icon name="upload" size={24} color={dragOver ? 'var(--color-primary)' : 'var(--color-text-quaternary)'} />
                    </MotionIn>
                    <MotionIn
                      animate={{ color: dragOver ? 'var(--color-primary)' : 'var(--color-text-secondary)' }}
                      transition={{ duration: 0.2 }}
                      style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, textAlign: 'center' }}
                    >
                      {dragOver ? 'Drop to upload' : 'Drag & drop your photo'}
                    </MotionIn>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>or</div>
                    <MotionIn
                      animate={{ background: 'var(--color-surface-tint)', scale: 1 }}
                      whileHover={{ background: 'var(--color-surface-tint-4)', scale: 1.04 }}
                      transition={{ duration: 0.1 }}
                      style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-primary)', borderRadius: 9, padding: '8px 22px' }}
                    >
                      Select file
                    </MotionIn>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', marginTop: 2 }}>JPG, PNG, GIF or WebP · Max 2 MB</div>
                  </MotionIn>

                  {imgFileError && (
                    <MotionIn initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: EASE_STANDARD }} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, padding: '10px 14px', background: 'var(--color-error-bg-alt)', borderRadius: 8, border: '1px solid var(--color-error-bg)' }}>
                      <Icon name="error" size={15} color="var(--color-error)" />
                      <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>{imgFileError}</span>
                    </MotionIn>
                  )}

                  <div style={{ marginTop: 20 }}>
                    <MotionButton
                      onClick={closeUploadWizard}
                      style={{ width: '100%', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', border: 'none', borderRadius: 9, padding: '11px 0', cursor: 'pointer' }}
                      animate={{ background: 'var(--color-surface-tint-2)' }}
                      whileHover={{ background: 'var(--color-border)' }}
                      transition={{ duration: 0.15 }}
                    >
                      Cancel
                    </MotionButton>
                  </div>
                </MotionIn>
              ) : (
                <MotionIn initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, ease: EASE_SETTLE }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
                    <MotionIn
                      initial={{ opacity: 0, scale: 0.7 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.38, ease: EASE_SPRING }}
                      style={{ width: 104, height: 104, borderRadius: '50%', overflow: 'hidden', boxShadow: '0 0 0 4px rgba(var(--color-primary-rgb), 0.18), 0 8px 24px rgba(var(--color-primary-rgb), 0.22)' }}
                    >
                      <img src={pendingImage} alt="Preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    </MotionIn>
                    <MotionIn initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, delay: 0.1, ease: EASE_STANDARD }} style={{ textAlign: 'center' }}>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)' }}>Looks good?</div>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 4 }}>This will be your profile photo.</div>
                    </MotionIn>
                  </div>

                  {imgFileError && (
                    <MotionIn initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: EASE_STANDARD }} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, padding: '10px 14px', background: 'var(--color-error-bg-alt)', borderRadius: 8, border: '1px solid var(--color-error-bg)' }}>
                      <Icon name="error" size={15} color="var(--color-error)" />
                      <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>{imgFileError}</span>
                    </MotionIn>
                  )}

                  <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                    <MotionButton
                      onClick={() => { setPendingImage(null); setImgFileError(null); }}
                      style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', border: 'none', borderRadius: 9, padding: '11px 0', cursor: 'pointer' }}
                      animate={{ background: 'var(--color-surface-tint-2)' }}
                      whileHover={{ background: 'var(--color-border)' }}
                      transition={{ duration: 0.15 }}
                    >
                      Choose different
                    </MotionButton>
                    <MotionButton
                      onClick={handleSaveImage}
                      disabled={imgSaving}
                      style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', border: 'none', borderRadius: 9, padding: '11px 0', cursor: imgSaving ? 'wait' : 'pointer' }}
                      animate={{ background: imgSaving ? 'var(--color-border-strong)' : 'var(--color-primary)', scale: 1 }}
                      whileHover={!imgSaving ? { background: 'var(--color-purple-mid-11)', scale: 1.02 } : undefined}
                      transition={{ duration: 0.15 }}
                    >
                      {imgSaving ? 'Saving…' : 'Save Photo'}
                    </MotionButton>
                  </div>
                </MotionIn>
              )}
            </div>
          </MotionIn>
        </motion.div>
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
              <MotionButton
                onClick={copyUrl}
                title="Copy MCP server URL"
                style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 8, padding: '8px 12px', cursor: 'pointer' }}
                animate={{ color: urlCopied ? 'var(--color-success)' : 'var(--color-primary)', background: urlCopied ? 'rgba(var(--color-success-rgb), 0.1)' : 'var(--color-surface-tint)' }}
                transition={{ duration: 0.15 }}
              >
                <Icon name={urlCopied ? 'check' : 'content_copy'} size={13} color={urlCopied ? 'var(--color-success)' : 'var(--color-primary)'} />
                {urlCopied ? 'Copied' : 'Copy'}
              </MotionButton>
            </div>
          </div>
        </div>
      </div>

      {/* Connect to Claude */}
      <MotionButton
        onClick={handleConnect}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', border: 'none', borderRadius: 12, padding: '13px 0', cursor: 'pointer' }}
        animate={{ background: 'var(--color-primary)', y: 0 }}
        whileHover={{ background: 'var(--color-purple-mid-11)', y: -1 }}
        transition={{ duration: 0.1 }}
      >
        <Icon name="open_in_new" size={16} color="var(--color-white)" />
        Connect to Claude
      </MotionButton>
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
              <MotionButton
                onClick={() => handleDisconnect(t.id)}
                disabled={revokingId === t.id}
                title="Disconnect"
                style={{ flexShrink: 0, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-error)', border: '1px solid var(--color-error-bg)', borderRadius: 8, padding: '7px 12px', cursor: revokingId === t.id ? 'wait' : 'pointer' }}
                animate={{ background: 'var(--color-error-bg-alt)' }}
                whileHover={revokingId !== t.id ? { background: 'var(--color-red-pale-7)' } : undefined}
                transition={{ duration: 0.15 }}
              >
                {revokingId === t.id ? 'Disconnecting…' : 'Disconnect'}
              </MotionButton>
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

// The four notification types this app can actually raise an email for
// today (see backend/src/notifications.ts's DEFAULT_EMAIL_PREFS) — all
// default ON server-side when the user has no override, which is why an
// Only `workspace_added` defaults ON server-side (notifications.ts's
// DEFAULT_EMAIL_PREFS) — DEFAULT_ON_EMAIL_TYPES below mirrors just that one
// exception rather than the full default map, since every other type here
// defaults to the same `false` an absent key already falls back to.
const DEFAULT_ON_EMAIL_TYPES = new Set(['workspace_added']);
const EMAIL_NOTIFICATION_DEFS: { id: string; label: string; description: string; icon: string }[] = [
  { id: 'mention', label: 'Mentions & tags', description: 'Someone @-mentions you in a note, or tags you on an item.', icon: 'alternate_email' },
  { id: 'workspace_added', label: 'Workspace invitations', description: "You're added to a workspace.", icon: 'group_add' },
  { id: 'automation_run', label: 'Automation failures', description: 'An automation you own fails to run. (Successful runs stay in-app only.)', icon: 'bolt' },
  { id: 'meeting_reminder', label: 'Meeting reminders', description: 'A meeting on your calendar is about to start.', icon: 'event' },
];

const REMINDER_LEAD_OPTIONS = [
  { value: 0, label: 'Off' },
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 hour' },
  { value: 120, label: '2 hours' },
];

interface EmailNotificationSettings {
  prefs: Record<string, boolean>;
  leadMinutes: number;
}
const DEFAULT_EMAIL_NOTIFICATION_SETTINGS: EmailNotificationSettings = { prefs: {}, leadMinutes: 30 };

function EmailNotificationsSection() {
  const token = useAuthStore(s => s.token);
  const [savingId, setSavingId] = useState<string | null>(null);

  const { data, loading, setData } = useAsyncData<EmailNotificationSettings>(
    token,
    async () => {
      const r = await apiVerifySessionToken(token as string);
      return { prefs: r.user.emailNotificationPrefs ?? {}, leadMinutes: r.user.meetingReminderLeadMinutes ?? 30 };
    },
    DEFAULT_EMAIL_NOTIFICATION_SETTINGS,
    { enabled: !!token }
  );
  const { prefs, leadMinutes } = data;

  const isEnabled = (id: string) => prefs[id] ?? DEFAULT_ON_EMAIL_TYPES.has(id);

  const toggle = async (id: string) => {
    const prevValue = isEnabled(id);
    const nextValue = !prevValue;
    // The backend stores `prefs` as a single JSONB column and REPLACES it
    // wholesale on every save (same as /shortcuts) — it does not merge keys
    // server-side. So the client must send the full, already-merged map here,
    // not just the one changed key, or every toggle would silently wipe out
    // every previously saved preference except this one.
    const nextPrefs = { ...prefs, [id]: nextValue };
    setData(d => ({ ...d, prefs: nextPrefs }));
    setSavingId(id);
    try {
      await apiUpdateEmailNotificationPrefs({ prefs: nextPrefs });
    } catch {
      setData(d => ({ ...d, prefs: { ...d.prefs, [id]: prevValue } }));
    } finally {
      setSavingId(null);
    }
  };

  const setLead = async (value: number) => {
    const prev = leadMinutes;
    setData(d => ({ ...d, leadMinutes: value }));
    try {
      await apiUpdateEmailNotificationPrefs({ meetingReminderLeadMinutes: value });
    } catch {
      setData(d => ({ ...d, leadMinutes: prev }));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Intro / explainer */}
      <div style={{ ...card, padding: '14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="mail" size={19} color="var(--color-primary)" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>
              Email Notifications
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginTop: 3 }}>
              Choose which notifications also send you an email, on top of the in-app bell. Only sends if an admin has configured email delivery for this instance.
            </div>
          </div>
        </div>
      </div>

      <div style={{ ...card, opacity: loading ? 0.6 : 1 }}>
        {EMAIL_NOTIFICATION_DEFS.map((def, i) => {
          const enabled = isEnabled(def.id);
          const isMeetingReminder = def.id === 'meeting_reminder';
          return (
            <MotionIn key={def.id} animate={{ opacity: 1 }} transition={{ duration: 0.15 }} style={{ ...rowStyle, flexWrap: 'wrap', borderTop: i === 0 ? 'none' : '1px solid var(--color-surface-tint-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: '1 1 220px' }}>
                <Icon name={def.icon} size={17} color="var(--color-text-tertiary)" />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)' }}>{def.label}</div>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{def.description}</div>
                </div>
              </div>
              <MotionButton
                onClick={() => toggle(def.id)}
                disabled={savingId === def.id}
                title={enabled ? 'Turn off' : 'Turn on'}
                style={{ width: 38, height: 22, borderRadius: 9999, border: 'none', cursor: savingId === def.id ? 'wait' : 'pointer', position: 'relative', flexShrink: 0 }}
                animate={{ background: enabled ? 'var(--color-primary)' : 'var(--color-border-alt)' }}
                transition={{ duration: 0.15 }}
              >
                <MotionIn animate={{ left: enabled ? 18 : 2 }} transition={{ duration: 0.15 }} style={{ position: 'absolute', top: 2, width: 18, height: 18, borderRadius: '50%', background: 'var(--color-white)', boxShadow: '0 1px 3px rgba(var(--color-black-rgb), 0.2)' }} />
              </MotionButton>
              {isMeetingReminder && enabled && (
                <div style={{ flexBasis: '100%', display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                  {REMINDER_LEAD_OPTIONS.map(opt => (
                    <MotionButton
                      key={opt.value}
                      onClick={() => setLead(opt.value)}
                      style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 8, padding: '6px 11px', cursor: 'pointer' }}
                      animate={{ color: leadMinutes === opt.value ? 'var(--color-white)' : 'var(--color-primary)', background: leadMinutes === opt.value ? 'var(--color-primary)' : 'var(--color-surface-tint)' }}
                      whileHover={leadMinutes !== opt.value ? { background: 'var(--color-surface-tint-4)' } : undefined}
                      transition={{ duration: 0.15 }}
                    >
                      {opt.label}
                    </MotionButton>
                  ))}
                </div>
              )}
            </MotionIn>
          );
        })}
      </div>
    </div>
  );
}

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
            <MotionIn key={def.id} animate={{ opacity: binding.enabled ? 1 : 0.55 }} transition={{ duration: 0.15 }} style={{ ...rowStyle, flexWrap: 'wrap', borderTop: i === 0 ? 'none' : '1px solid var(--color-surface-tint-2)' }}>
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
                <MotionButton
                  onClick={() => { setRecordingId(def.id); setRecordError(''); }}
                  style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, border: 'none', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', minWidth: 60, textAlign: 'center' }}
                  animate={{ color: isRecording ? 'var(--color-white)' : 'var(--color-primary)', background: isRecording ? 'var(--color-primary)' : 'var(--color-surface-tint)' }}
                  whileHover={!isRecording ? { background: 'var(--color-surface-tint-4)' } : undefined}
                  transition={{ duration: 0.15 }}
                >
                  {isRecording ? 'Press key…' : formatCombo(binding.key)}
                </MotionButton>
                {isOverridden && (
                  <MotionButton
                    onClick={() => resetOne(def.id)}
                    title="Reset to default"
                    style={{ width: 30, height: 30, borderRadius: 7, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                    animate={{ background: 'transparent' }}
                    whileHover={{ background: 'var(--color-surface-tint-2)' }}
                    transition={{ duration: 0.15 }}
                  >
                    <Icon name="restart_alt" size={16} color="var(--color-purple-mid-6)" />
                  </MotionButton>
                )}
                <MotionButton
                  onClick={() => setEnabled(def.id, !binding.enabled)}
                  title={binding.enabled ? 'Turn off' : 'Turn on'}
                  style={{ width: 38, height: 22, borderRadius: 9999, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0 }}
                  animate={{ background: binding.enabled ? 'var(--color-primary)' : 'var(--color-border-alt)' }}
                  transition={{ duration: 0.15 }}
                >
                  <MotionIn animate={{ left: binding.enabled ? 18 : 2 }} transition={{ duration: 0.15 }} style={{ position: 'absolute', top: 2, width: 18, height: 18, borderRadius: '50%', background: 'var(--color-white)', boxShadow: '0 1px 3px rgba(var(--color-black-rgb), 0.2)' }} />
                </MotionButton>
              </div>
            </MotionIn>
          );
        })}
      </div>

      <MotionButton
        onClick={resetAll}
        disabled={!hasAnyOverride}
        style={{ alignSelf: 'flex-start', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '7px 14px', cursor: hasAnyOverride ? 'pointer' : 'default' }}
        animate={{ background: 'transparent', color: hasAnyOverride ? 'var(--color-text-tertiary)' : 'var(--color-border-strong)' }}
        whileHover={hasAnyOverride ? { background: 'var(--color-surface-tint)', color: 'var(--color-primary)' } : undefined}
        transition={{ duration: 0.15 }}
      >
        Reset all to defaults
      </MotionButton>
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
              <MotionButton
                onClick={() => handleRevoke(c.id)}
                disabled={revokingId === c.id}
                title="Revoke"
                style={{ flexShrink: 0, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-error)', border: '1px solid var(--color-error-bg)', borderRadius: 8, padding: '7px 12px', cursor: revokingId === c.id ? 'wait' : 'pointer' }}
                animate={{ background: 'var(--color-error-bg-alt)' }}
                whileHover={revokingId !== c.id ? { background: 'var(--color-red-pale-7)' } : undefined}
                transition={{ duration: 0.15 }}
              >
                {revokingId === c.id ? 'Revoking…' : 'Revoke'}
              </MotionButton>
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
              <MotionButton
                onClick={() => handleRemove(c.id)}
                disabled={removingId === c.id}
                title="Remove"
                style={{ flexShrink: 0, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-error)', border: '1px solid var(--color-error-bg)', borderRadius: 8, padding: '7px 12px', cursor: removingId === c.id ? 'wait' : 'pointer' }}
                animate={{ background: 'var(--color-error-bg-alt)' }}
                whileHover={removingId !== c.id ? { background: 'var(--color-red-pale-7)' } : undefined}
                transition={{ duration: 0.15 }}
              >
                {removingId === c.id ? 'Removing…' : 'Remove'}
              </MotionButton>
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
        <MotionButton onClick={() => copy(value, key)} title={`Copy ${label}`}
          style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 8, padding: '8px 12px', cursor: 'pointer' }}
          animate={{ color: copied === key ? 'var(--color-success)' : 'var(--color-primary)', background: copied === key ? 'rgba(var(--color-success-rgb), 0.1)' : 'var(--color-surface-tint)' }}
          transition={{ duration: 0.15 }}>
          <Icon name={copied === key ? 'check' : 'content_copy'} size={13} color={copied === key ? 'var(--color-success)' : 'var(--color-primary)'} />
          {copied === key ? 'Copied' : 'Copy'}
        </MotionButton>
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
                  style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-surface-tint)', border: 'none', borderRadius: 8, padding: '8px 10px', cursor: 'pointer' }}>
                  <Icon name={showPassword ? 'visibility_off' : 'visibility'} size={15} color="var(--color-primary)" />
                </button>
                <MotionButton onClick={() => copy(password, 'pw')} title="Copy password"
                  style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 8, padding: '8px 12px', cursor: 'pointer' }}
                  animate={{ color: copied === 'pw' ? 'var(--color-success)' : 'var(--color-primary)', background: copied === 'pw' ? 'rgba(var(--color-success-rgb), 0.1)' : 'var(--color-surface-tint)' }}
                  transition={{ duration: 0.15 }}>
                  <Icon name={copied === 'pw' ? 'check' : 'content_copy'} size={13} color={copied === 'pw' ? 'var(--color-success)' : 'var(--color-primary)'} />
                  {copied === 'pw' ? 'Copied' : 'Copy'}
                </MotionButton>
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
          <MotionButton onClick={handleGenerate} disabled={generating}
            style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', border: 'none', borderRadius: 10, padding: '10px 18px', cursor: generating ? 'wait' : 'pointer' }}
            animate={{ background: generating ? 'var(--color-border-strong)' : 'var(--color-primary)' }}
            transition={{ duration: 0.15 }}>
            <Icon name={connected ? 'autorenew' : 'key'} size={15} color="var(--color-white)" />
            {generating ? 'Generating…' : connected ? 'Regenerate password' : 'Generate password'}
          </MotionButton>
          {connected && (
            <button onClick={handleRevoke} disabled={revoking}
              style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-error)', background: 'var(--color-error-bg-alt)', border: '1px solid var(--color-error-bg)', borderRadius: 10, padding: '10px 18px', cursor: revoking ? 'wait' : 'pointer' }}>
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
      <MotionButton
        onClick={() => { setOpen(v => !v); setSearch(''); }}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '9px 12px', borderRadius: 8, borderWidth: 1.5, borderStyle: 'solid', background: 'var(--color-white)', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)' }}
        animate={{ borderColor: 'var(--color-border)' }}
        whileHover={{ borderColor: 'var(--color-primary)' }}
        transition={{ duration: 0.15 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Icon name="public" size={14} color="var(--color-accent-purple-light)" />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>{displayLabel}</span>
        </div>
        <Icon name={open ? 'expand_less' : 'expand_more'} size={16} color="var(--color-text-tertiary)" />
      </MotionButton>

      {open && (
        <MotionIn
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.16, ease: EASE_SETTLE }}
          style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 200, background: 'var(--color-white)', borderRadius: 10, border: '1.5px solid var(--color-border)', boxShadow: '0 8px 24px rgba(var(--color-black-rgb), 0.13)', overflow: 'hidden' }}
        >
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
                  <MotionButton
                    key={tz.value}
                    onClick={() => { onChange(tz.value); setOpen(false); }}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 14px', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                    animate={{ background: selected ? 'var(--color-surface-tint)' : 'transparent' }}
                    whileHover={!selected ? { background: 'var(--color-surface-tint-3)' } : undefined}
                    transition={{ duration: 0.1 }}
                  >
                    <span style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: selected ? 'var(--color-primary)' : 'var(--color-text-primary)', fontWeight: selected ? 600 : 400 }}>{tz.label}</span>
                    {selected && <Icon name="check" size={13} color="var(--color-primary)" />}
                  </MotionButton>
                );
              })
            )}
          </div>
        </MotionIn>
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
  // Step-up (S3): see TwoFAWizard.tsx's matching comment — a valid-but-stolen
  // session token alone must not be enough to silently (re)generate a user's
  // TOTP secret, so the account password is required before /2fa/setup.
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
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

  // Same shape as TwoFAWizard.tsx: the key goes non-null once the wizard
  // leaves the intro step and stays constant after that, so stepping back to
  // scan reuses the already-minted secret rather than generating a second one.
  const { data: setup, loading: loadingSetup, error: setupError } = useAsyncData(
    step === 'intro' ? null : 'totp-setup',
    () => api2FASetup(password),
    null as { qrCode: string; secret: string } | null
  );
  const qrCode = setup?.qrCode ?? '';
  const secret = setup?.secret ?? '';
  const displayError = otpError || (setupError ? 'Failed to generate QR code. Please try again.' : '');

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
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2, ease: EASE_STANDARD }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.32)', backdropFilter: 'blur(6px)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget && step !== 'done') onClose(); }}
    >
      <MotionIn
        initial={{ opacity: 0, scale: 0.92, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.32, ease: EASE_SETTLE }}
        style={{ background: 'var(--color-white)', borderRadius: 22, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(var(--color-black-rgb), 0.24)', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}
      >
        {step === 'intro' && (
          <MotionIn initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, ease: EASE_SETTLE }} style={{ padding: '36px 32px 32px', display: 'flex', flexDirection: 'column', gap: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
              <MotionButton onClick={onClose} style={{ width: 32, height: 32, borderRadius: 8, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                animate={{ background: 'transparent' }} whileHover={{ background: 'var(--color-surface-tint-2)' }} transition={{ duration: 0.15 }}>
                <Icon name="close" size={18} color="var(--color-text-quaternary)" />
              </MotionButton>
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
            <div style={{ position: 'relative', marginBottom: 16 }}>
              <input
                type={passwordVisible ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && password) setStep('scan'); }}
                placeholder="Confirm your password to continue"
                style={{ width: '100%', boxSizing: 'border-box' as const, padding: '11px 32px 11px 12px', borderRadius: 10, border: '1.5px solid var(--color-border-alt)', fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-primary)', background: 'var(--color-surface-gray)', outline: 'none' }}
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setPasswordVisible(v => !v)}
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex' }}
              >
                <Icon name={passwordVisible ? 'visibility_off' : 'visibility'} size={16} color="var(--color-text-quaternary)" />
              </button>
            </div>
            <MotionButton onClick={() => setStep('scan')} disabled={!password}
              style={{ width: '100%', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, padding: '13px 0', borderRadius: 12, border: 'none', cursor: password ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
              animate={{ background: password ? 'var(--color-primary)' : 'var(--color-border-strong)' }}
              whileHover={password ? { background: 'var(--color-purple-mid-10)' } : undefined}
              transition={{ duration: 0.15 }}>
              Get Started <Icon name="arrow_forward" size={16} color="var(--color-white)" />
            </MotionButton>
          </MotionIn>
        )}

        {step === 'scan' && (
          <MotionIn initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, ease: EASE_SETTLE }} style={{ padding: '28px 32px 32px', display: 'flex', flexDirection: 'column', gap: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {[0, 1].map(i => (<MotionIn key={i} animate={{ width: i === 0 ? 20 : 8, background: i === 0 ? 'var(--color-primary)' : 'var(--color-border)' }} transition={{ duration: 0.3 }} style={{ height: 8, borderRadius: 4 }} />))}
              </div>
              <MotionButton onClick={onClose} style={{ width: 32, height: 32, borderRadius: 8, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                animate={{ background: 'transparent' }} whileHover={{ background: 'var(--color-surface-tint-2)' }} transition={{ duration: 0.15 }}>
                <Icon name="close" size={18} color="var(--color-text-quaternary)" />
              </MotionButton>
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
                <MotionButton onClick={copySecret} title="Copy setup key"
                  style={{ flexShrink: 0, width: 32, height: 32, borderRadius: 8, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  animate={{ background: copied ? 'rgba(var(--color-success-rgb), 0.1)' : 'transparent' }}
                  whileHover={!copied ? { background: 'var(--color-surface-tint)' } : undefined}
                  transition={{ duration: 0.15 }}>
                  <Icon name={copied ? 'check' : 'content_copy'} size={15} color={copied ? 'var(--color-success)' : 'var(--color-text-tertiary)'} />
                </MotionButton>
              </div>
            )}
            <MotionButton onClick={() => { setStep('verify'); setTimeout(() => r0.current?.focus(), 80); }} disabled={loadingSetup || !qrCode}
              style={{ width: '100%', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, padding: '13px 0', borderRadius: 12, border: 'none', cursor: loadingSetup || !qrCode ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
              animate={{ background: loadingSetup || !qrCode ? 'var(--color-border-strong)' : 'var(--color-primary)' }}
              whileHover={!loadingSetup && qrCode ? { background: 'var(--color-purple-mid-10)' } : undefined}
              transition={{ duration: 0.15 }}>
              I've scanned it <Icon name="arrow_forward" size={16} color="var(--color-white)" />
            </MotionButton>
          </MotionIn>
        )}

        {step === 'verify' && (
          <MotionIn initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, ease: EASE_SETTLE }} style={{ padding: '28px 32px 32px', display: 'flex', flexDirection: 'column', gap: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {[0, 1].map(i => (<MotionIn key={i} animate={{ width: i === 1 ? 20 : 8, background: i === 1 ? 'var(--color-primary)' : 'var(--color-border)' }} transition={{ duration: 0.3 }} style={{ height: 8, borderRadius: 4 }} />))}
              </div>
              <MotionButton onClick={onClose} style={{ width: 32, height: 32, borderRadius: 8, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                animate={{ background: 'transparent' }} whileHover={{ background: 'var(--color-surface-tint-2)' }} transition={{ duration: 0.15 }}>
                <Icon name="close" size={18} color="var(--color-text-quaternary)" />
              </MotionButton>
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 6 }}>Confirm setup</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginBottom: 28 }}>Enter the 6-digit code from your authenticator app to confirm setup.</div>
            <MotionIn
              style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 8 }}
              animate={{ x: shake ? [0, -8, 8, 0] : 0 }}
              transition={{ duration: 0.4, times: shake ? [0, 0.25, 0.75, 1] : undefined, ease: 'easeInOut' }}
            >
              {otp.map((digit, i) => (
                <motion.input key={i} ref={otpRefs[i]} type="text" inputMode="numeric" maxLength={1} value={digit}
                  onChange={e => handleOtpChange(i, e.target.value)} onKeyDown={e => handleOtpKey(i, e)}
                  onPaste={i === 0 ? handleOtpPaste : undefined}
                  animate={{
                    background: digit ? 'var(--color-surface-tint)' : 'var(--color-surface-gray)',
                    borderColor: displayError ? 'var(--color-error-bg)' : digit ? 'var(--color-primary)' : 'var(--color-border-alt)',
                  }}
                  transition={{ duration: 0.15 }}
                  style={{ width: 46, height: 56, textAlign: 'center', fontFamily: 'var(--font-heading)', fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)', borderWidth: 2, borderStyle: 'solid', borderRadius: 10, outline: 'none', caretColor: 'transparent' }}
                />
              ))}
            </MotionIn>
            {displayError && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)', textAlign: 'center', marginBottom: 16, marginTop: 4 }}>{displayError}</div>}
            {!displayError && <div style={{ height: 20, marginBottom: 16 }} />}
            <div style={{ display: 'flex', gap: 10 }}>
              <MotionButton onClick={() => { setStep('scan'); setOtp(Array(6).fill('')); setOtpError(''); }}
                style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)', border: '1.5px solid var(--color-border-alt)', borderRadius: 12, padding: '12px 0', cursor: 'pointer' }}
                animate={{ background: 'var(--color-surface-gray)' }} whileHover={{ background: 'var(--color-surface-tint-2)' }} transition={{ duration: 0.15 }}>
                ← Back
              </MotionButton>
              <MotionButton onClick={handleVerify} disabled={verifying || !otpComplete}
                style={{ flex: 2, color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, padding: '12px 0', borderRadius: 12, border: 'none', cursor: verifying || !otpComplete ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                animate={{ background: verifying || !otpComplete ? 'var(--color-border-strong)' : 'var(--color-primary)' }}
                whileHover={!verifying && otpComplete ? { background: 'var(--color-purple-mid-10)' } : undefined}
                transition={{ duration: 0.15 }}>
                {verifying ? 'Activating…' : <><Icon name="shield_lock" size={15} color="var(--color-white)" />Activate 2FA</>}
              </MotionButton>
            </div>
          </MotionIn>
        )}

        {step === 'done' && (
          <MotionIn initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: EASE_SETTLE }} style={{ padding: '48px 32px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
            <MotionIn
              initial={{ opacity: 0, scale: 0 }}
              animate={{ opacity: [0, 1, 1], scale: [0, 1.1, 1] }}
              transition={{ duration: 0.4, times: [0, 0.6, 1], ease: EASE_SPRING }}
              style={{ width: 68, height: 68, borderRadius: '50%', background: 'rgba(var(--color-success-rgb), 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name="check_circle" size={36} color="var(--color-success)" />
            </MotionIn>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', textAlign: 'center' }}>2FA Enabled!</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-tertiary)', textAlign: 'center', lineHeight: 1.5 }}>Your account is now protected with two-factor authentication.</div>
          </MotionIn>
        )}
      </MotionIn>
    </motion.div>
  );
}
