import { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import useAuthStore from '../store/useAuthStore';
import useAppStore from '../store/useAppStore';
import { apiUpdateProfile, apiUploadProfileImage } from '../api/client';
import Icon from '../components/Icon';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export default function SettingsScreen() {
  const navigate = useNavigate();
  const { username, email, fullName, profileImage, signOut, setProfile } = useAuthStore();
  const { synced, lastSynced, loadFromApi } = useAppStore();
  const [name, setName] = useState(fullName || username);
  const [emailVal, setEmailVal] = useState(email);
  const [autoSync, setAutoSync] = useState(true);
  const [nameFocus, setNameFocus] = useState(false);
  const [emailFocus, setEmailFocus] = useState(false);
  const [nukeStep, setNukeStep] = useState(0);
  const [nukeText, setNukeText] = useState('');
  const [nukePw, setNukePw] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [avatarHover, setAvatarHover] = useState(false);

  // Upload wizard state
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const initials = (fullName || username || 'U').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

  const saveProfile = async () => {
    try {
      await apiUpdateProfile({ fullName: name, email: emailVal });
      setProfile({ fullName: name, email: emailVal });
    } catch (e) { console.error('profile save failed', e); }
  };

  const syncNow = async () => {
    setSyncing(true);
    await loadFromApi();
    setSyncing(false);
  };

  const handleSignOut = () => { signOut(); navigate('/login'); };

  const friendlyTime = (iso: string | null) => {
    if (!iso) return 'Never';
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  };

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
    reader.onload = (e) => {
      setPendingImage(e.target?.result as string);
    };
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

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };

  const handleSaveImage = async () => {
    if (!pendingImage) return;
    setSaving(true);
    try {
      const res = await apiUploadProfileImage(pendingImage);
      setProfile({ profileImage: res.user.profileImage });
      closeUploadWizard();
    } catch (e) {
      console.error('image upload failed', e);
      setFileError('Failed to save image. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const closeUploadWizard = () => {
    setUploadOpen(false);
    setPendingImage(null);
    setFileError(null);
    setDragOver(false);
  };

  const sectionLabel = (text: string) => (
    <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: '#b0acbe', marginBottom: 10, paddingLeft: 4 }}>{text}</div>
  );
  const card = { background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 14, overflow: 'hidden' as const };
  const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between' as const, gap: 12, padding: '14px 18px' };
  const fi = { width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#1c1b22', background: 'transparent', border: 'none', outline: 'none', padding: '6px 0', transition: 'border-color 200ms' };

  return (
    <div style={{ flex: 1, height: '100%', overflowY: 'auto' }}>
      <div style={{ maxWidth: 680, margin: '0 auto', padding: '32px 32px 48px', display: 'flex', flexDirection: 'column', gap: 28, width: '100%' }}>
        <h1 style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 28, fontWeight: 700, color: '#1c1b22', letterSpacing: '-0.02em' }}>Settings</h1>

        {/* Profile */}
        <div>
          {sectionLabel('Profile')}
          <div style={card}>
            <div style={{ ...row, borderBottom: '1px solid #f1ecf6' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                {/* Avatar with upload overlay */}
                <div
                  style={{ position: 'relative', width: 56, height: 56, flexShrink: 0, cursor: 'pointer' }}
                  onMouseEnter={() => setAvatarHover(true)}
                  onMouseLeave={() => setAvatarHover(false)}
                  onClick={() => setUploadOpen(true)}
                  title="Upload profile photo"
                >
                  <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'linear-gradient(135deg, #9d8dff 0%, #5e4dbb 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                    {profileImage ? (
                      <img src={profileImage} alt="Profile" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
                    ) : (
                      <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 20, fontWeight: 700, color: '#fff' }}>{initials}</span>
                    )}
                  </div>
                  {/* Hover overlay */}
                  <div style={{
                    position: 'absolute', inset: 0, borderRadius: '50%',
                    background: 'rgba(0,0,0,0.45)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    opacity: avatarHover ? 1 : 0,
                    transition: 'opacity 180ms ease',
                    pointerEvents: 'none',
                  }}>
                    <Icon name="add" size={22} color="#fff" />
                  </div>
                </div>

                <div>
                  <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>{name || username}</div>
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', marginTop: 2 }}>@{username}</div>
                </div>
              </div>
            </div>
            <div style={{ padding: '0 18px' }}>
              <div style={{ borderBottom: `${nameFocus ? 2 : 1}px solid ${nameFocus ? '#5e4dbb' : '#e8e4f0'}`, padding: '14px 0', transition: 'border-color 200ms' }}>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#b0acbe', marginBottom: 4 }}>Full Name</div>
                <input value={name} onChange={e => setName(e.target.value)} style={fi} onFocus={() => setNameFocus(true)} onBlur={() => { setNameFocus(false); saveProfile(); }} />
              </div>
              <div style={{ padding: '14px 0', borderBottom: `${emailFocus ? 2 : 1}px solid ${emailFocus ? '#5e4dbb' : '#e8e4f0'}` }}>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#b0acbe', marginBottom: 4 }}>Email Address</div>
                <input type="email" value={emailVal} onChange={e => setEmailVal(e.target.value)} style={fi} onFocus={() => setEmailFocus(true)} onBlur={() => { setEmailFocus(false); saveProfile(); }} />
              </div>
            </div>
          </div>
        </div>

        {/* Sync */}
        <div>
          {sectionLabel('Sync')}
          <div style={card}>
            <div style={{ ...row, borderBottom: '1px solid #f1ecf6' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: synced ? 'rgba(16,185,129,0.10)' : '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="cloud_sync" size={18} color={synced ? '#10B981' : '#5e4dbb'} />
                </div>
                <div>
                  <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22' }}>Cloud Sync Active</div>
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 1 }}>Last synced: {friendlyTime(lastSynced)}</div>
                </div>
              </div>
              <button onClick={syncNow} disabled={syncing}
                style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', border: 'none', borderRadius: 8, padding: '7px 16px', cursor: syncing ? 'wait' : 'pointer', transition: 'all 150ms' }}>
                {syncing ? 'Syncing…' : 'Sync Now'}
              </button>
            </div>
            <div style={{ ...row, borderBottom: '1px solid #f1ecf6' }}>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 500, color: '#1c1b22' }}>Automatic Sync</div>
              <div onClick={() => setAutoSync(v => !v)}
                style={{ width: 44, height: 24, borderRadius: 9999, background: autoSync ? '#5e4dbb' : '#e8e4f0', position: 'relative', cursor: 'pointer', transition: 'background 200ms', flexShrink: 0 }}>
                <div style={{ position: 'absolute', top: 2, left: autoSync ? 22 : 2, width: 20, height: 20, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.15)', transition: 'left 200ms' }} />
              </div>
            </div>
            <div style={row}>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 500, color: '#1c1b22' }}>Storage Location</div>
              <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, fontWeight: 600, color: '#787584', background: '#f1ecf6', borderRadius: 9999, padding: '3px 10px' }}>This device</span>
            </div>
          </div>
        </div>

        {/* Sign Out */}
        <button onClick={handleSignOut}
          style={{ width: '100%', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#ba1a1a', background: '#fff5f5', border: '1.5px solid #ffdad6', borderRadius: 12, padding: '14px 0', cursor: 'pointer', transition: 'all 180ms' }}
          onMouseEnter={e => { e.currentTarget.style.background = '#ba1a1a'; e.currentTarget.style.color = '#fff'; }}
          onMouseLeave={e => { e.currentTarget.style.background = '#fff5f5'; e.currentTarget.style.color = '#ba1a1a'; }}>
          Sign Out
        </button>

        {/* Danger Zone */}
        <div>
          {sectionLabel('Danger Zone')}
          <div style={{ ...card, border: '1.5px solid #ffdad6' }}>
            <div style={{ ...row, background: '#fff5f5' }}>
              <div>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 700, color: '#ba1a1a' }}>Nuke Everything</div>
                <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2 }}>Permanently delete all data. This cannot be undone.</div>
              </div>
              <button onClick={() => setNukeStep(1)}
                style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#ba1a1a', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', flexShrink: 0 }}>
                Nuke
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Profile Image Upload Wizard */}
      {uploadOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) closeUploadWizard(); }}
        >
          <div
            style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 440, boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Modal header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 0' }}>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22' }}>
                {pendingImage ? 'Preview' : 'Upload Profile Photo'}
              </div>
              <button
                onClick={closeUploadWizard}
                style={{ width: 30, height: 30, borderRadius: '50%', background: '#f1ecf6', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 150ms' }}
                onMouseEnter={e => { e.currentTarget.style.background = '#e8e4f0'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#f1ecf6'; }}
              >
                <Icon name="close" size={15} color="#484552" />
              </button>
            </div>

            <div style={{ padding: '20px 24px 24px' }}>
              {!pendingImage ? (
                /* Step 1: Drop zone */
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/gif,image/webp"
                    style={{ display: 'none' }}
                    onChange={handleFileInput}
                  />
                  <div
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onClick={() => fileInputRef.current?.click()}
                    style={{
                      border: `2px dashed ${dragOver ? '#5e4dbb' : fileError ? '#ba1a1a' : '#e8e4f0'}`,
                      borderRadius: 14,
                      background: dragOver ? '#F5F3FF' : fileError ? '#fff5f5' : '#faf9ff',
                      padding: '36px 24px',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 10,
                      cursor: 'pointer',
                      transition: 'all 200ms',
                      userSelect: 'none',
                    }}
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

                  {fileError && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, padding: '10px 14px', background: '#fff5f5', borderRadius: 8, border: '1px solid #ffdad6' }}>
                      <Icon name="error" size={15} color="#ba1a1a" />
                      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a' }}>{fileError}</span>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                    <button
                      onClick={closeUploadWizard}
                      style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: '#f1ecf6', border: 'none', borderRadius: 8, padding: '11px 0', cursor: 'pointer', transition: 'background 150ms' }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#e8e4f0'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = '#f1ecf6'; }}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                /* Step 2: Preview */
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
                    {/* Preview bubble */}
                    <div style={{ width: 96, height: 96, borderRadius: '50%', background: 'linear-gradient(135deg, #9d8dff 0%, #5e4dbb 100%)', overflow: 'hidden', boxShadow: '0 4px 16px rgba(94,77,187,0.25)' }}>
                      <img src={pendingImage} alt="Preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22' }}>Looks good?</div>
                      <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 3 }}>This will be your profile photo.</div>
                    </div>
                  </div>

                  {fileError && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, padding: '10px 14px', background: '#fff5f5', borderRadius: 8, border: '1px solid #ffdad6' }}>
                      <Icon name="error" size={15} color="#ba1a1a" />
                      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a' }}>{fileError}</span>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                    <button
                      onClick={() => { setPendingImage(null); setFileError(null); }}
                      style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: '#f1ecf6', border: 'none', borderRadius: 8, padding: '11px 0', cursor: 'pointer', transition: 'background 150ms' }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#e8e4f0'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = '#f1ecf6'; }}
                    >
                      Choose different
                    </button>
                    <button
                      onClick={handleSaveImage}
                      disabled={saving}
                      style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: saving ? '#c9c4d5' : '#5e4dbb', border: 'none', borderRadius: 8, padding: '11px 0', cursor: saving ? 'wait' : 'pointer', transition: 'background 150ms' }}
                      onMouseEnter={e => { if (!saving) e.currentTarget.style.background = '#4d3da8'; }}
                      onMouseLeave={e => { if (!saving) e.currentTarget.style.background = '#5e4dbb'; }}
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Nuke Confirm Modal */}
      {nukeStep > 0 && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) setNukeStep(0); }}>
          <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 420, padding: '28px 32px', boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ width: 48, height: 48, borderRadius: '50%', background: '#ffdad6', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Icon name="warning" size={24} color="#ba1a1a" />
            </div>
            {nukeStep === 1 && (
              <>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 18, fontWeight: 700, color: '#1c1b22', marginBottom: 12 }}>Are you absolutely sure?</div>
                <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', lineHeight: 1.6, marginBottom: 20 }}>This will permanently delete all your tasks, lists, and account data. This action cannot be undone.</div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={() => setNukeStep(0)} style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: '#f1ecf6', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer' }}>Cancel</button>
                  <button onClick={() => setNukeStep(2)} style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#ba1a1a', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer' }}>I understand</button>
                </div>
              </>
            )}
            {nukeStep === 2 && (
              <>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22', marginBottom: 8 }}>Type NUKE to confirm</div>
                <input value={nukeText} onChange={e => setNukeText(e.target.value)} placeholder="NUKE"
                  style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '10px 12px', outline: 'none', marginBottom: 16 }} />
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={() => setNukeStep(0)} style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: '#f1ecf6', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer' }}>Cancel</button>
                  <button disabled={nukeText !== 'NUKE'} onClick={() => setNukeStep(3)} style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: nukeText === 'NUKE' ? '#ba1a1a' : '#c9c4d5', border: 'none', borderRadius: 8, padding: '10px 0', cursor: nukeText === 'NUKE' ? 'pointer' : 'not-allowed' }}>Continue</button>
                </div>
              </>
            )}
            {nukeStep === 3 && (
              <>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22', marginBottom: 8 }}>Confirm your password</div>
                <input type="password" value={nukePw} onChange={e => setNukePw(e.target.value)} placeholder="••••••••"
                  style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '10px 12px', outline: 'none', marginBottom: 16 }} />
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={() => setNukeStep(0)} style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: '#f1ecf6', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer' }}>Cancel</button>
                  <button onClick={() => { signOut(); navigate('/login'); }} style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#ba1a1a', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer' }}>Nuke Everything</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
