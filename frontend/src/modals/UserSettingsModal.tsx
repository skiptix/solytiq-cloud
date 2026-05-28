import { useState, useRef, useEffect } from 'react';
import Icon from '../components/Icon';
import useAuthStore from '../store/useAuthStore';
import {
  apiUpdateProfile,
  apiUploadProfileImage,
  apiChangePassword,
  apiGetFeatureFlags,
  api2FASetup,
  api2FAEnable,
  api2FADisable,
} from '../api/client';

interface UserSettingsModalProps {
  onClose: () => void;
}

type PwStep = 'idle' | 'current' | 'new' | 'done';

const inputStyle = (focused: boolean): React.CSSProperties => ({
  width: '100%',
  fontFamily: 'Inter, sans-serif',
  fontSize: 14,
  color: '#1c1b22',
  background: 'transparent',
  border: 'none',
  outline: 'none',
  padding: '8px 0',
  borderBottom: `1.5px solid ${focused ? '#5e4dbb' : '#E5E7EB'}`,
  transition: 'border-color 180ms',
});

const sectionLabel = (text: string) => (
  <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: '#b0acbe', marginBottom: 10, paddingLeft: 2 }}>
    {text}
  </div>
);

const card: React.CSSProperties = {
  background: '#F9FAFB',
  border: '1px solid #E5E7EB',
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

export default function UserSettingsModal({ onClose }: UserSettingsModalProps) {
  const { username, fullName, profileImage, isAdmin, totpEnabled, setProfile, setTotpEnabled } = useAuthStore();

  // Feature flag
  const [twoFAFeatureEnabled, setTwoFAFeatureEnabled] = useState(true);
  useEffect(() => {
    apiGetFeatureFlags().then(r => setTwoFAFeatureEnabled(r.twoFAEnabled)).catch(() => {});
  }, []);

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

  return (
    <>
      {/* Backdrop */}
      <div
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
        onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div
          style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 480, boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '22px 24px 0' }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 18, fontWeight: 700, color: '#1c1b22', letterSpacing: '-0.01em' }}>Account Settings</div>
            <button
              onClick={onClose}
              style={{ width: 30, height: 30, borderRadius: '50%', background: '#f1ecf6', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              onMouseEnter={e => { e.currentTarget.style.background = '#e8e4f0'; }}
              onMouseLeave={e => { e.currentTarget.style.background = '#f1ecf6'; }}
            >
              <Icon name="close" size={15} color="#484552" />
            </button>
          </div>

          {/* Scrollable body */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px 28px', display: 'flex', flexDirection: 'column', gap: 24 }}>

            {/* ── PROFILE ── */}
            <div>
              {sectionLabel('Profile')}
              <div style={card}>
                {/* Avatar + identity */}
                <div style={{ padding: '18px 18px', borderBottom: '1px solid #f1ecf6', display: 'flex', alignItems: 'center', gap: 16 }}>
                  {/* Avatar with upload overlay */}
                  <div
                    style={{ position: 'relative', flexShrink: 0, cursor: 'pointer' }}
                    onMouseEnter={() => setAvatarHover(true)}
                    onMouseLeave={() => setAvatarHover(false)}
                    onClick={() => setUploadWizardOpen(true)}
                    title="Upload profile photo"
                  >
                    <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'linear-gradient(135deg, #9d8dff 0%, #5e4dbb 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
                      {profileImage ? (
                        <img src={profileImage} alt={username} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 26, fontWeight: 700, color: '#fff' }}>
                          {(fullName || username || 'U').split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2)}
                        </span>
                      )}
                    </div>
                    <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: avatarHover ? 1 : 0, transition: 'opacity 180ms', pointerEvents: 'none' }}>
                      <Icon name="add" size={22} color="#fff" />
                    </div>
                  </div>

                  {/* Name + role + username */}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 3 }}>
                      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {fullName || username}
                      </div>
                      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 700, color: isAdmin ? '#5e4dbb' : '#787584', background: isAdmin ? '#F5F3FF' : '#F3F4F6', borderRadius: 9999, padding: '2px 8px', textTransform: 'uppercase' as const, letterSpacing: '0.05em', flexShrink: 0 }}>
                        {isAdmin ? 'Admin' : 'Member'}
                      </span>
                    </div>
                    <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584' }}>@{username}</div>
                    {profileImage && (
                      <button
                        onClick={e => { e.stopPropagation(); handleRemoveImage(); }}
                        disabled={removeLoading}
                        style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a', background: 'none', border: 'none', padding: '4px 0 0', cursor: removeLoading ? 'wait' : 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}
                        onMouseEnter={e => { e.currentTarget.style.color = '#991212'; }}
                        onMouseLeave={e => { e.currentTarget.style.color = '#ba1a1a'; }}
                      >{removeLoading ? 'Removing…' : 'Remove photo'}</button>
                    )}
                  </div>
                </div>

                {/* Full Name */}
                <div style={{ padding: '14px 18px', borderBottom: '1px solid #f1ecf6' }}>
                  <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Full Name</div>
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
                        style={{ flexShrink: 0, width: 28, height: 28, borderRadius: 7, background: nameSaved ? 'rgba(16,185,129,0.1)' : '#F5F3FF', border: 'none', cursor: nameSaving ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 150ms' }}
                        onMouseEnter={e => { if (!nameSaving && !nameSaved) e.currentTarget.style.background = '#ede9ff'; }}
                        onMouseLeave={e => { if (!nameSaving && !nameSaved) e.currentTarget.style.background = '#F5F3FF'; }}
                      >
                        <Icon name="check" size={14} color={nameSaved ? '#10B981' : '#5e4dbb'} />
                      </button>
                    )}
                  </div>
                  {nameError && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#ba1a1a', marginTop: 5 }}>{nameError}</div>}
                  {nameSaved && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#10B981', marginTop: 5 }}>Saved!</div>}
                </div>

                {/* Handle (read-only) */}
                <div style={{ padding: '14px 18px' }}>
                  <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Username</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#787584' }}>@{username}</span>
                    <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', background: '#f7f4fc', borderRadius: 9999, padding: '2px 8px' }}>can't be changed</span>
                  </div>
                </div>
              </div>
            </div>

            {/* ── SECURITY ── */}
            <div>
              {sectionLabel('Security')}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

                {/* Password card */}
                <div style={card}>
                  {pwStep === 'idle' && (
                    <div style={rowStyle}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{ width: 36, height: 36, borderRadius: 10, background: '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <Icon name="lock" size={18} color="#5e4dbb" />
                        </div>
                        <div>
                          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22' }}>Password</div>
                          <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 1 }}>Change your account password</div>
                        </div>
                      </div>
                      <button
                        onClick={() => { setPwStep('current'); setTimeout(() => currentPwRef.current?.focus(), 60); }}
                        style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', transition: 'background 150ms' }}
                        onMouseEnter={e => { e.currentTarget.style.background = '#ede9ff'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = '#F5F3FF'; }}
                      >
                        Change
                        <Icon name="arrow_forward" size={14} color="#5e4dbb" />
                      </button>
                    </div>
                  )}

                  {pwStep === 'current' && (
                    <div style={{ padding: '18px 18px 16px' }}>
                      {/* Progress */}
                      <div style={{ display: 'flex', gap: 5, marginBottom: 16 }}>
                        {[0, 1].map(i => (
                          <div key={i} style={{ height: 3, flex: 1, borderRadius: 99, background: i === 0 ? '#5e4dbb' : '#e8e4f0', transition: 'background 300ms' }} />
                        ))}
                      </div>
                      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22', marginBottom: 14 }}>Enter your current password</div>
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
                          <Icon name={currentPwVisible ? 'visibility_off' : 'visibility'} size={16} color="#b0acbe" />
                        </button>
                      </div>
                      {pwError && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a', marginTop: 8 }}>{pwError}</div>}
                      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                        <button
                          onClick={resetPwWizard}
                          style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: '#f1ecf6', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer', transition: 'background 150ms' }}
                          onMouseEnter={e => { e.currentTarget.style.background = '#e8e4f0'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = '#f1ecf6'; }}
                        >Cancel</button>
                        <button
                          onClick={handlePwNext}
                          disabled={!currentPw}
                          style={{ flex: 2, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: currentPw ? '#5e4dbb' : '#c9c4d5', border: 'none', borderRadius: 8, padding: '10px 0', cursor: currentPw ? 'pointer' : 'not-allowed', transition: 'background 150ms', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                          onMouseEnter={e => { if (currentPw) e.currentTarget.style.background = '#4d3da8'; }}
                          onMouseLeave={e => { if (currentPw) e.currentTarget.style.background = '#5e4dbb'; }}
                        >
                          Next <Icon name="arrow_forward" size={14} color="#fff" />
                        </button>
                      </div>
                    </div>
                  )}

                  {pwStep === 'new' && (
                    <div style={{ padding: '18px 18px 16px' }}>
                      {/* Progress */}
                      <div style={{ display: 'flex', gap: 5, marginBottom: 16 }}>
                        {[0, 1].map(i => (
                          <div key={i} style={{ height: 3, flex: 1, borderRadius: 99, background: '#5e4dbb', transition: 'background 300ms' }} />
                        ))}
                      </div>
                      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22', marginBottom: 14 }}>Set a new password</div>
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
                            <Icon name={newPwVisible ? 'visibility_off' : 'visibility'} size={16} color="#b0acbe" />
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
                        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584', marginTop: 6 }}>At least 8 characters required</div>
                      )}
                      {pwError && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a', marginTop: 8 }}>{pwError}</div>}
                      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                        <button
                          onClick={() => { setPwStep('current'); setPwError(''); setNewPw(''); setConfirmPw(''); }}
                          style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: '#f1ecf6', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer', transition: 'background 150ms' }}
                          onMouseEnter={e => { e.currentTarget.style.background = '#e8e4f0'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = '#f1ecf6'; }}
                        >← Back</button>
                        <button
                          onClick={handlePwSave}
                          disabled={pwSaving || !newPw || !confirmPw}
                          style={{ flex: 2, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: pwSaving || !newPw || !confirmPw ? '#c9c4d5' : '#5e4dbb', border: 'none', borderRadius: 8, padding: '10px 0', cursor: pwSaving || !newPw || !confirmPw ? 'not-allowed' : 'pointer', transition: 'background 150ms', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                          onMouseEnter={e => { if (!pwSaving && newPw && confirmPw) e.currentTarget.style.background = '#4d3da8'; }}
                          onMouseLeave={e => { if (!pwSaving && newPw && confirmPw) e.currentTarget.style.background = '#5e4dbb'; }}
                        >
                          {pwSaving ? 'Saving…' : <><Icon name="lock_reset" size={14} color="#fff" /> Save Password</>}
                        </button>
                      </div>
                    </div>
                  )}

                  {pwStep === 'done' && (
                    <div style={{ padding: '24px 18px', display: 'flex', alignItems: 'center', gap: 14 }}>
                      <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(16,185,129,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <Icon name="check_circle" size={22} color="#10B981" />
                      </div>
                      <div>
                        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22' }}>Password changed!</div>
                        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2 }}>Your new password is active.</div>
                      </div>
                    </div>
                  )}
                </div>

                {/* 2FA card — only if feature is enabled by admin */}
                {twoFAFeatureEnabled && (
                  <div style={card}>
                    <div style={rowStyle}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                        <div style={{ width: 36, height: 36, borderRadius: 10, background: totpEnabled ? 'linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%)' : '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <Icon name="shield_lock" size={18} color={totpEnabled ? '#10B981' : '#5e4dbb'} />
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22' }}>Two-Factor Auth</div>
                            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 700, color: totpEnabled ? '#10B981' : '#b0acbe', background: totpEnabled ? 'rgba(16,185,129,0.10)' : '#f1ecf6', borderRadius: 9999, padding: '2px 8px', textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>
                              {totpEnabled ? 'Enabled' : 'Disabled'}
                            </span>
                          </div>
                          <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2 }}>
                            {totpEnabled ? 'Account protected with authenticator app.' : 'Add an extra layer of security.'}
                          </div>
                        </div>
                      </div>
                      <div style={{ flexShrink: 0 }}>
                        {totpEnabled ? (
                          <button
                            onClick={() => { setDisableOpen(true); setDisableOtp(Array(6).fill('')); setDisableError(''); }}
                            style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#ba1a1a', background: '#fff5f5', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', transition: 'background 150ms' }}
                            onMouseEnter={e => { e.currentTarget.style.background = '#ffdad6'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = '#fff5f5'; }}
                          >Disable</button>
                        ) : (
                          <button
                            onClick={() => setTwoFAOpen(true)}
                            style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', transition: 'background 150ms' }}
                            onMouseEnter={e => { e.currentTarget.style.background = '#ede9ff'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = '#F5F3FF'; }}
                          >Enable 2FA</button>
                        )}
                      </div>
                    </div>

                    {/* Disable 2FA OTP entry */}
                    {disableOpen && (
                      <div style={{ padding: '0 18px 18px', borderTop: '1px solid #f1ecf6' }}>
                        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#484552', margin: '14px 0 12px' }}>
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
                                fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 20, fontWeight: 700,
                                color: '#1c1b22', background: digit ? '#F5F3FF' : '#F9FAFB',
                                border: `2px solid ${disableError ? '#ffdad6' : digit ? '#5e4dbb' : '#E5E7EB'}`,
                                borderRadius: 9, outline: 'none', transition: 'border-color 150ms, background 150ms',
                                caretColor: 'transparent',
                              }}
                            />
                          ))}
                        </div>
                        {disableError && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a', textAlign: 'center', marginBottom: 10 }}>{disableError}</div>}
                        <div style={{ display: 'flex', gap: 8, marginTop: disableError ? 0 : 10 }}>
                          <button
                            onClick={() => { setDisableOpen(false); setDisableOtp(Array(6).fill('')); setDisableError(''); }}
                            style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: '#f1ecf6', border: 'none', borderRadius: 8, padding: '9px 0', cursor: 'pointer' }}
                            onMouseEnter={e => { e.currentTarget.style.background = '#e8e4f0'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = '#f1ecf6'; }}
                          >Cancel</button>
                          <button
                            onClick={handleDisable2FA}
                            disabled={disableLoading || !disableOtp.every(d => d)}
                            style={{ flex: 2, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: disableLoading || !disableOtp.every(d => d) ? '#c9c4d5' : '#ba1a1a', border: 'none', borderRadius: 8, padding: '9px 0', cursor: disableLoading || !disableOtp.every(d => d) ? 'not-allowed' : 'pointer', transition: 'background 150ms' }}
                            onMouseEnter={e => { if (!disableLoading && disableOtp.every(d => d)) e.currentTarget.style.background = '#9b1515'; }}
                            onMouseLeave={e => { if (!disableLoading && disableOtp.every(d => d)) e.currentTarget.style.background = '#ba1a1a'; }}
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
          </div>
        </div>
      </div>

      {/* Profile Image Upload Wizard (nested modal) */}
      {uploadWizardOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.32)', backdropFilter: 'blur(6px)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) closeUploadWizard(); }}
        >
          <div
            style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 440, boxShadow: '0 12px 40px rgba(0,0,0,0.22)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 0' }}>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22' }}>
                {pendingImage ? 'Preview' : 'Upload Profile Photo'}
              </div>
              <button
                onClick={closeUploadWizard}
                style={{ width: 30, height: 30, borderRadius: '50%', background: '#f1ecf6', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={e => { e.currentTarget.style.background = '#e8e4f0'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#f1ecf6'; }}
              >
                <Icon name="close" size={15} color="#484552" />
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
                    style={{ border: `2px dashed ${dragOver ? '#5e4dbb' : imgFileError ? '#ba1a1a' : '#e8e4f0'}`, borderRadius: 14, background: dragOver ? '#F5F3FF' : imgFileError ? '#fff5f5' : '#faf9ff', padding: '36px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, cursor: 'pointer', transition: 'all 200ms', userSelect: 'none' }}
                  >
                    <div style={{ width: 48, height: 48, borderRadius: '50%', background: dragOver ? '#ede9ff' : '#f1ecf6', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 200ms' }}>
                      <Icon name="upload" size={24} color={dragOver ? '#5e4dbb' : '#b0acbe'} />
                    </div>
                    <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: dragOver ? '#5e4dbb' : '#484552', textAlign: 'center' }}>
                      {dragOver ? 'Drop to upload' : 'Drag & drop your photo'}
                    </div>
                    <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe' }}>or</div>
                    <div
                      style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', borderRadius: 8, padding: '8px 20px', transition: 'background 150ms' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#ede9ff'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#F5F3FF'; }}
                    >
                      Select file
                    </div>
                    <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', marginTop: 2 }}>JPG, PNG, GIF or WebP · Max 2 MB</div>
                  </div>

                  {imgFileError && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, padding: '10px 14px', background: '#fff5f5', borderRadius: 8, border: '1px solid #ffdad6' }}>
                      <Icon name="error" size={15} color="#ba1a1a" />
                      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a' }}>{imgFileError}</span>
                    </div>
                  )}

                  <div style={{ marginTop: 20 }}>
                    <button
                      onClick={closeUploadWizard}
                      style={{ width: '100%', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: '#f1ecf6', border: 'none', borderRadius: 8, padding: '11px 0', cursor: 'pointer' }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#e8e4f0'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = '#f1ecf6'; }}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
                    <div style={{ width: 96, height: 96, borderRadius: '50%', overflow: 'hidden', boxShadow: '0 4px 16px rgba(94,77,187,0.25)' }}>
                      <img src={pendingImage} alt="Preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22' }}>Looks good?</div>
                      <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 3 }}>This will be your profile photo.</div>
                    </div>
                  </div>

                  {imgFileError && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, padding: '10px 14px', background: '#fff5f5', borderRadius: 8, border: '1px solid #ffdad6' }}>
                      <Icon name="error" size={15} color="#ba1a1a" />
                      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a' }}>{imgFileError}</span>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                    <button
                      onClick={() => { setPendingImage(null); setImgFileError(null); }}
                      style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: '#f1ecf6', border: 'none', borderRadius: 8, padding: '11px 0', cursor: 'pointer' }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#e8e4f0'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = '#f1ecf6'; }}
                    >
                      Choose different
                    </button>
                    <button
                      onClick={handleSaveImage}
                      disabled={imgSaving}
                      style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: imgSaving ? '#c9c4d5' : '#5e4dbb', border: 'none', borderRadius: 8, padding: '11px 0', cursor: imgSaving ? 'wait' : 'pointer', transition: 'background 150ms' }}
                      onMouseEnter={e => { if (!imgSaving) e.currentTarget.style.background = '#4d3da8'; }}
                      onMouseLeave={e => { if (!imgSaving) e.currentTarget.style.background = '#5e4dbb'; }}
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

      {/* 2FA Enable Wizard (nested modal) */}
      {twoFAOpen && <TwoFAWizardInline onClose={() => setTwoFAOpen(false)} onEnabled={() => setTotpEnabled(true)} />}
    </>
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
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.32)', backdropFilter: 'blur(6px)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget && step !== 'done') onClose(); }}
    >
      <div
        style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 420, boxShadow: '0 12px 40px rgba(0,0,0,0.22)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}
      >
        {step === 'intro' && (
          <div style={{ padding: '36px 32px 32px', display: 'flex', flexDirection: 'column', gap: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
              <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={e => { e.currentTarget.style.background = '#f1ecf6'; }} onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                <Icon name="close" size={18} color="#b0acbe" />
              </button>
            </div>
            <div style={{ width: 64, height: 64, borderRadius: 20, background: 'linear-gradient(135deg, #F5F3FF 0%, #e0d9ff 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
              <Icon name="shield_lock" size={30} color="#5e4dbb" />
            </div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 22, fontWeight: 700, color: '#1c1b22', letterSpacing: '-0.02em', marginBottom: 8 }}>Enable Two-Factor Auth</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#787584', lineHeight: 1.6, marginBottom: 28 }}>
              Add an extra layer of security. Each login will require a one-time code from your authenticator app.
            </div>
            <div style={{ background: '#F9FAFB', borderRadius: 12, padding: '14px 16px', marginBottom: 28, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: '#b0acbe', marginBottom: 2 }}>You'll need</div>
              {[{ icon: 'smartphone', text: 'An authenticator app (Google Authenticator, Authy, 1Password…)' }, { icon: 'qr_code_scanner', text: 'A few seconds to scan a QR code' }].map(item => (
                <div key={item.icon} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 8, background: '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
                    <Icon name={item.icon} size={14} color="#5e4dbb" />
                  </div>
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#484552', lineHeight: 1.5, paddingTop: 5 }}>{item.text}</div>
                </div>
              ))}
            </div>
            <button onClick={() => setStep('scan')}
              style={{ width: '100%', background: '#5e4dbb', color: '#fff', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, padding: '13px 0', borderRadius: 12, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'background 150ms' }}
              onMouseEnter={e => { e.currentTarget.style.background = '#4f3fa8'; }} onMouseLeave={e => { e.currentTarget.style.background = '#5e4dbb'; }}>
              Get Started <Icon name="arrow_forward" size={16} color="#fff" />
            </button>
          </div>
        )}

        {step === 'scan' && (
          <div style={{ padding: '28px 32px 32px', display: 'flex', flexDirection: 'column', gap: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {[0, 1].map(i => (<div key={i} style={{ width: i === 0 ? 20 : 8, height: 8, borderRadius: 4, background: i === 0 ? '#5e4dbb' : '#e8e4f0', transition: 'all 300ms' }} />))}
              </div>
              <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={e => { e.currentTarget.style.background = '#f1ecf6'; }} onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                <Icon name="close" size={18} color="#b0acbe" />
              </button>
            </div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 20, fontWeight: 700, color: '#1c1b22', marginBottom: 6 }}>Scan the QR code</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', lineHeight: 1.5, marginBottom: 24 }}>Open your authenticator app and scan this code. Or enter the setup key manually.</div>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
              {loadingSetup ? (
                <div style={{ width: 180, height: 180, background: '#F9FAFB', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #E5E7EB' }}>
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>Generating…</div>
                </div>
              ) : qrCode ? (
                <div style={{ padding: 12, background: '#fff', border: '1.5px solid #e8e4f0', borderRadius: 14, boxShadow: '0 2px 12px rgba(94,77,187,0.08)' }}>
                  <img src={qrCode} alt="2FA QR Code" style={{ width: 164, height: 164, display: 'block', borderRadius: 4 }} />
                </div>
              ) : (
                <div style={{ width: 180, height: 180, background: '#fff5f5', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #ffdad6' }}>
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#ba1a1a', textAlign: 'center', padding: '0 12px' }}>Failed to load QR code</div>
                </div>
              )}
            </div>
            {secret && (
              <div style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 10, padding: '10px 12px', marginBottom: 24, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div>
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.06em', color: '#b0acbe', marginBottom: 3 }}>Setup key</div>
                  <div style={{ fontFamily: 'monospace', fontSize: 13, color: '#1c1b22', letterSpacing: '0.1em', wordBreak: 'break-all' as const }}>{secret.match(/.{1,4}/g)?.join(' ')}</div>
                </div>
                <button onClick={copySecret} title="Copy setup key"
                  style={{ flexShrink: 0, width: 32, height: 32, borderRadius: 8, border: 'none', background: copied ? 'rgba(16,185,129,0.1)' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 150ms' }}
                  onMouseEnter={e => { if (!copied) e.currentTarget.style.background = '#F5F3FF'; }} onMouseLeave={e => { if (!copied) e.currentTarget.style.background = 'transparent'; }}>
                  <Icon name={copied ? 'check' : 'content_copy'} size={15} color={copied ? '#10B981' : '#787584'} />
                </button>
              </div>
            )}
            <button onClick={() => { setStep('verify'); setTimeout(() => r0.current?.focus(), 80); }} disabled={loadingSetup || !qrCode}
              style={{ width: '100%', background: loadingSetup || !qrCode ? '#c9c4d5' : '#5e4dbb', color: '#fff', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, padding: '13px 0', borderRadius: 12, border: 'none', cursor: loadingSetup || !qrCode ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'background 150ms' }}
              onMouseEnter={e => { if (!loadingSetup && qrCode) e.currentTarget.style.background = '#4f3fa8'; }} onMouseLeave={e => { if (!loadingSetup && qrCode) e.currentTarget.style.background = '#5e4dbb'; }}>
              I've scanned it <Icon name="arrow_forward" size={16} color="#fff" />
            </button>
          </div>
        )}

        {step === 'verify' && (
          <div style={{ padding: '28px 32px 32px', display: 'flex', flexDirection: 'column', gap: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {[0, 1].map(i => (<div key={i} style={{ width: i === 1 ? 20 : 8, height: 8, borderRadius: 4, background: i === 1 ? '#5e4dbb' : '#e8e4f0', transition: 'all 300ms' }} />))}
              </div>
              <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={e => { e.currentTarget.style.background = '#f1ecf6'; }} onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                <Icon name="close" size={18} color="#b0acbe" />
              </button>
            </div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 20, fontWeight: 700, color: '#1c1b22', marginBottom: 6 }}>Confirm setup</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', lineHeight: 1.5, marginBottom: 28 }}>Enter the 6-digit code from your authenticator app to confirm setup.</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 8, animation: shake ? 'shake 400ms ease-in-out' : undefined }}>
              {otp.map((digit, i) => (
                <input key={i} ref={otpRefs[i]} type="text" inputMode="numeric" maxLength={1} value={digit}
                  onChange={e => handleOtpChange(i, e.target.value)} onKeyDown={e => handleOtpKey(i, e)}
                  onPaste={i === 0 ? handleOtpPaste : undefined}
                  style={{ width: 46, height: 56, textAlign: 'center', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 22, fontWeight: 700, color: '#1c1b22', background: digit ? '#F5F3FF' : '#F9FAFB', border: `2px solid ${otpError ? '#ffdad6' : digit ? '#5e4dbb' : '#E5E7EB'}`, borderRadius: 10, outline: 'none', transition: 'border-color 150ms, background 150ms', caretColor: 'transparent' }}
                />
              ))}
            </div>
            {otpError && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a', textAlign: 'center', marginBottom: 16, marginTop: 4 }}>{otpError}</div>}
            {!otpError && <div style={{ height: 20, marginBottom: 16 }} />}
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => { setStep('scan'); setOtp(Array(6).fill('')); setOtpError(''); }}
                style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#484552', background: '#F9FAFB', border: '1.5px solid #E5E7EB', borderRadius: 12, padding: '12px 0', cursor: 'pointer', transition: 'background 150ms' }}
                onMouseEnter={e => { e.currentTarget.style.background = '#f1ecf6'; }} onMouseLeave={e => { e.currentTarget.style.background = '#F9FAFB'; }}>
                ← Back
              </button>
              <button onClick={handleVerify} disabled={verifying || !otpComplete}
                style={{ flex: 2, background: verifying || !otpComplete ? '#c9c4d5' : '#5e4dbb', color: '#fff', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, padding: '12px 0', borderRadius: 12, border: 'none', cursor: verifying || !otpComplete ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, transition: 'background 150ms' }}
                onMouseEnter={e => { if (!verifying && otpComplete) e.currentTarget.style.background = '#4f3fa8'; }} onMouseLeave={e => { if (!verifying && otpComplete) e.currentTarget.style.background = '#5e4dbb'; }}>
                {verifying ? 'Activating…' : <><Icon name="shield_lock" size={15} color="#fff" />Activate 2FA</>}
              </button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div style={{ padding: '48px 32px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
            <div style={{ width: 68, height: 68, borderRadius: '50%', background: 'rgba(16,185,129,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'scIn 400ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
              <Icon name="check_circle" size={36} color="#10B981" />
            </div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 20, fontWeight: 700, color: '#1c1b22', textAlign: 'center' }}>2FA Enabled!</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#787584', textAlign: 'center', lineHeight: 1.5 }}>Your account is now protected with two-factor authentication.</div>
          </div>
        )}
      </div>
    </div>
  );
}
