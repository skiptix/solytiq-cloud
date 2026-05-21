import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task, List } from '../types';
import Icon from './Icon';
import useAuthStore from '../store/useAuthStore';
import { apiUpdateProfile, apiUploadProfileImage } from '../api/client';

interface TopBarProps {
  tasks: Task[];
  lists: List[];
  synced: boolean;
  lastSynced: string | null;
  onNavigate: (path: string) => void;
}

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const SETTINGS_RESULTS = [
  { label: 'Profile Settings', sub: 'Edit your name and email', path: '/settings', icon: 'manage_accounts' },
  { label: 'Sync Settings', sub: 'Cloud sync preferences', path: '/settings', icon: 'cloud_sync' },
  { label: 'Sign Out', sub: 'End your session', path: '/settings', icon: 'logout' },
];

function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: '#ede9ff', color: '#5e4dbb', fontWeight: 700, borderRadius: 2 }}>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export default function TopBar({ tasks, lists, synced, onNavigate }: TopBarProps) {
  const navigate = useNavigate();

  // Search state
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  // Profile state
  const { username, email, fullName, profileImage, isAdmin, setProfile, signOut } = useAuthStore();
  const [profileOpen, setProfileOpen] = useState(false);
  const profileDropRef = useRef<HTMLDivElement>(null);
  const [avatarHover, setAvatarHover] = useState(false);
  const [uploadAvatarHover, setUploadAvatarHover] = useState(false);

  // Inline field editing
  const [editingField, setEditingField] = useState<'name' | 'email' | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // Upload wizard state
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [imgSaving, setImgSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const initials = (fullName || username || 'U').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

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

  // Search logic
  const q = query.trim().toLowerCase();
  const showDrop = focused && q.length > 0;
  const taskResults = q ? tasks.filter(t => t.title.toLowerCase().includes(q)).slice(0, 5) : [];
  const listResults = q ? lists.filter(l => l.name.toLowerCase().includes(q)).slice(0, 3) : [];
  const settingsResults = q ? SETTINGS_RESULTS.filter(s => s.label.toLowerCase().includes(q)).slice(0, 3) : [];
  const allResults: Array<{ type: 'task' | 'list' | 'setting'; label: string; sub?: string; path: string; icon?: string; task?: Task; list?: List }> = [
    ...taskResults.map(t => ({ type: 'task' as const, label: t.title, sub: t._listName ?? 'Dashboard', path: t._source === 'list' && t._listId ? `/list/${t._listId}` : '/dashboard', task: t })),
    ...listResults.map(l => ({ type: 'list' as const, label: l.name, sub: `${l.sections.flatMap(s => s.tasks).length} tasks`, path: `/list/${l.id}`, list: l })),
    ...settingsResults.map(s => ({ type: 'setting' as const, label: s.label, sub: s.sub, path: s.path, icon: s.icon })),
  ];

  useEffect(() => { setActiveIdx(0); }, [query]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); inputRef.current?.focus(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const goTo = useCallback((path: string) => {
    setQuery(''); setFocused(false);
    navigate(path);
    onNavigate(path);
  }, [navigate, onNavigate]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setFocused(false); setQuery(''); }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, allResults.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    if (e.key === 'Enter' && allResults[activeIdx]) goTo(allResults[activeIdx].path);
  };

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

  const GROUP_COLORS: Record<string, string> = { task: '#5e4dbb', list: '#1D4ED8', setting: '#10B981' };
  const GROUP_LABELS: Record<string, string> = { task: 'Tasks', list: 'Lists', setting: 'Settings' };
  let renderedGroups: string[] = [];

  const iconBtn = {
    width: 26, height: 26, borderRadius: 6,
    background: 'transparent', border: 'none', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, transition: 'background 120ms',
  };

  const renderField = (label: string, field: 'name' | 'email', displayValue: string, inputType = 'text') => (
    <div style={{ padding: '11px 0', borderBottom: '1px solid #f1ecf6' }}>
      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: 5 }}>{label}</div>
      {editingField === field ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            autoFocus
            type={inputType}
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={handleFieldKey}
            style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#1c1b22', background: 'transparent', border: 'none', outline: 'none', padding: '1px 0', borderBottom: '1.5px solid #5e4dbb' }}
          />
          <button
            onClick={commitEdit}
            disabled={editSaving || !editValue.trim()}
            style={{ ...iconBtn, color: '#10B981' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(16,185,129,0.10)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <Icon name="check" size={15} color={editSaving ? '#b0acbe' : '#10B981'} />
          </button>
          <button
            onClick={cancelEdit}
            style={iconBtn}
            onMouseEnter={e => { e.currentTarget.style.background = '#f1ecf6'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <Icon name="close" size={15} color="#b0acbe" />
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayValue}</span>
          <button
            onClick={() => startEdit(field)}
            style={iconBtn}
            onMouseEnter={e => { e.currentTarget.style.background = '#f1ecf6'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <Icon name="edit" size={14} color="#b0acbe" />
          </button>
        </div>
      )}
    </div>
  );

  return (
    <>
      <header style={{ position: 'sticky', top: 0, zIndex: 50, background: 'rgba(253,248,255,0.92)', backdropFilter: 'blur(12px)', borderBottom: '1px solid #e8e4f0', display: 'flex', alignItems: 'center', gap: 16, padding: '10px 24px', height: 56 }}>
        {/* Search */}
        <div style={{ flex: 1, maxWidth: 440, margin: '0 auto', position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: focused ? '#fff' : '#f7f4fc', borderRadius: focused ? 10 : 9999, border: `1.5px solid ${focused ? '#5e4dbb' : 'transparent'}`, padding: '7px 14px', transition: 'all 200ms', boxShadow: focused ? '0 0 0 4px rgba(94,77,187,0.12)' : 'none' }}>
            <Icon name="search" size={16} color="#787584" />
            <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)}
              onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 150)}
              onKeyDown={handleKey}
              placeholder="Search tasks, lists… ⌘K"
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontFamily: 'Inter, sans-serif', fontSize: 13.5, color: '#1c1b22' }} />
            {query && <button onClick={() => setQuery('')} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 0 }}><Icon name="close" size={14} color="#787584" /></button>}
          </div>

          {showDrop && allResults.length > 0 && (
            <div ref={dropRef} style={{ position: 'absolute', top: 'calc(100% + 8px)', left: 0, right: 0, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.14)', overflow: 'hidden', zIndex: 300, animation: 'menuIn 160ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
              {allResults.map((r, i) => {
                const isNewGroup = !renderedGroups.includes(r.type);
                if (isNewGroup) renderedGroups = [...renderedGroups, r.type];
                return (
                  <div key={i}>
                    {isNewGroup && (
                      <div style={{ padding: '8px 14px 4px', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: GROUP_COLORS[r.type] }}>
                        {GROUP_LABELS[r.type]}
                      </div>
                    )}
                    <div onMouseDown={() => goTo(r.path)}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', background: i === activeIdx ? '#F5F3FF' : 'transparent', cursor: 'pointer', transition: 'background 120ms' }}>
                      <div style={{ width: 28, height: 28, borderRadius: 8, background: `${GROUP_COLORS[r.type]}12`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        {r.type === 'task' && <Icon name="check_circle" size={14} color={GROUP_COLORS.task} />}
                        {r.type === 'list' && <span style={{ fontSize: 14 }}>{r.list?.emoji ?? ''}</span>}
                        {r.type === 'setting' && <Icon name={r.icon ?? 'settings'} size={14} color={GROUP_COLORS.setting} />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22' }}>{highlight(r.label, query)}</div>
                        {r.sub && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584', marginTop: 1 }}>{r.sub}</div>}
                      </div>
                      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 9.5, fontWeight: 600, color: GROUP_COLORS[r.type], background: `${GROUP_COLORS[r.type]}12`, borderRadius: 9999, padding: '2px 7px', textTransform: 'uppercase' }}>{r.type}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
          {synced && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ position: 'relative', width: 8, height: 8 }}>
                <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: '#10B981' }} />
                <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: '#10B981', animation: 'ping 2s ease-in-out infinite' }} />
              </div>
              <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10, fontWeight: 700, color: '#10B981', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Synced</span>
            </div>
          )}

          {/* Settings button */}
          <button
            onClick={() => { setProfileOpen(false); onNavigate('/settings'); }}
            style={{ width: 32, height: 32, borderRadius: '50%', background: 'transparent', border: '1px solid #e8e4f0', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#F5F3FF'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <Icon name="settings" size={16} color="#787584" />
          </button>

          {/* Profile avatar + dropdown */}
          <div ref={profileDropRef} style={{ position: 'relative' }}>
            <button
              onClick={() => { setProfileOpen(v => !v); setEditingField(null); }}
              onMouseEnter={() => setAvatarHover(true)}
              onMouseLeave={() => setAvatarHover(false)}
              style={{ width: 34, height: 34, borderRadius: '50%', border: profileOpen ? '2px solid #5e4dbb' : '2px solid transparent', cursor: 'pointer', padding: 0, background: 'none', transition: 'border-color 150ms', flexShrink: 0, position: 'relative', overflow: 'hidden' }}
              title="Profile"
            >
              <div style={{ width: '100%', height: '100%', borderRadius: '50%', background: 'linear-gradient(135deg, #9d8dff 0%, #5e4dbb 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                {profileImage ? (
                  <img src={profileImage} alt="Profile" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 700, color: '#fff', lineHeight: 1 }}>{initials}</span>
                )}
              </div>
              <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'rgba(0,0,0,0.12)', opacity: avatarHover && !profileOpen ? 1 : 0, transition: 'opacity 150ms', pointerEvents: 'none' }} />
            </button>

            {/* Profile dropdown */}
            {profileOpen && (
              <div style={{ position: 'absolute', top: 'calc(100% + 10px)', right: 0, width: 300, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 16, boxShadow: '0 8px 32px rgba(0,0,0,0.14)', zIndex: 200, animation: 'menuIn 160ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}>

                {/* Avatar header */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '22px 20px 16px', background: '#faf9ff', borderBottom: '1px solid #f1ecf6', gap: 8 }}>
                  <div
                    style={{ position: 'relative', width: 64, height: 64, cursor: 'pointer', flexShrink: 0 }}
                    onMouseEnter={() => setUploadAvatarHover(true)}
                    onMouseLeave={() => setUploadAvatarHover(false)}
                    onClick={() => { setProfileOpen(false); setUploadOpen(true); }}
                    title="Upload profile photo"
                  >
                    <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'linear-gradient(135deg, #9d8dff 0%, #5e4dbb 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                      {profileImage ? (
                        <img src={profileImage} alt="Profile" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
                      ) : (
                        <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 22, fontWeight: 700, color: '#fff' }}>{initials}</span>
                      )}
                    </div>
                    <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: uploadAvatarHover ? 1 : 0, transition: 'opacity 180ms', pointerEvents: 'none' }}>
                      <Icon name="add" size={22} color="#fff" />
                    </div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                      <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 700, color: '#1c1b22' }}>{fullName || username}</span>
                      {isAdmin && (
                        <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 700, color: '#5e4dbb', background: '#F5F3FF', borderRadius: 9999, padding: '2px 8px', textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>Admin</span>
                      )}
                    </div>
                    <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2 }}>@{username}</div>
                  </div>
                </div>

                {/* Editable fields */}
                <div style={{ padding: '0 16px' }}>
                  {renderField('Full Name', 'name', fullName || username)}
                  {renderField('Email Address', 'email', email, 'email')}
                </div>

                {/* Sign Out */}
                <div style={{ padding: '12px 16px' }}>
                  <button
                    onClick={handleSignOut}
                    style={{ width: '100%', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#ba1a1a', background: '#fff5f5', border: '1.5px solid #ffdad6', borderRadius: 8, padding: '9px 0', cursor: 'pointer', transition: 'all 150ms' }}
                    onMouseEnter={e => { e.currentTarget.style.background = '#ba1a1a'; e.currentTarget.style.color = '#fff'; e.currentTarget.style.borderColor = '#ba1a1a'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = '#fff5f5'; e.currentTarget.style.color = '#ba1a1a'; e.currentTarget.style.borderColor = '#ffdad6'; }}
                  >
                    Sign Out
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

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
                    style={{ border: `2px dashed ${dragOver ? '#5e4dbb' : fileError ? '#ba1a1a' : '#e8e4f0'}`, borderRadius: 14, background: dragOver ? '#F5F3FF' : fileError ? '#fff5f5' : '#faf9ff', padding: '36px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, cursor: 'pointer', transition: 'all 200ms', userSelect: 'none' }}
                  >
                    <div style={{ width: 48, height: 48, borderRadius: '50%', background: dragOver ? '#ede9ff' : '#f1ecf6', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 200ms' }}>
                      <Icon name="upload" size={24} color={dragOver ? '#5e4dbb' : '#b0acbe'} />
                    </div>
                    <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: dragOver ? '#5e4dbb' : '#484552', textAlign: 'center' }}>
                      {dragOver ? 'Drop to upload' : 'Drag & drop your photo'}
                    </div>
                    <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe' }}>or</div>
                    <div
                      style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', borderRadius: 8, padding: '8px 20px' }}
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

                  {fileError && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, padding: '10px 14px', background: '#fff5f5', borderRadius: 8, border: '1px solid #ffdad6' }}>
                      <Icon name="error" size={15} color="#ba1a1a" />
                      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a' }}>{fileError}</span>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                    <button
                      onClick={() => { setPendingImage(null); setFileError(null); }}
                      style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: '#f1ecf6', border: 'none', borderRadius: 8, padding: '11px 0', cursor: 'pointer' }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#e8e4f0'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = '#f1ecf6'; }}
                    >
                      Choose different
                    </button>
                    <button
                      onClick={handleSaveImage}
                      disabled={imgSaving}
                      style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: imgSaving ? '#c9c4d5' : '#5e4dbb', border: 'none', borderRadius: 8, padding: '11px 0', cursor: imgSaving ? 'wait' : 'pointer' }}
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
    </>
  );
}
