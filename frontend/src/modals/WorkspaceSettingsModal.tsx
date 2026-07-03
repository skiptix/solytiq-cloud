import { useState, useEffect, useRef, useCallback } from 'react';
import Icon from '../components/Icon';
import useWorkspaceStore from '../store/useWorkspaceStore';
import useAuthStore from '../store/useAuthStore';
import useAppStore from '../store/useAppStore';
import type { Workspace, WorkspaceMember, SharedFile } from '../types';
import { EmojiGrid } from '../components/EmojiSelector';
import { apiGetMembers, apiGetFiles, asVisibilityConflict, type VisibilityConflict } from '../api/client';
import VisibilityConflictModal from '../components/VisibilityConflictModal';

interface UserSuggestion { id: string; username: string; fullName: string | null; profileImage: string | null; }

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const IMAGE_PICKER_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

function extBadge(mime: string) {
  if (mime === 'image/svg+xml') return 'SVG';
  if (mime === 'image/png') return 'PNG';
  if (mime === 'image/jpeg') return 'JPG';
  if (mime === 'image/webp') return 'WEBP';
  return 'IMG';
}

async function fetchFileAsDataUrl(fileId: string): Promise<string> {
  const token = localStorage.getItem('solytiq_token');
  const res = await fetch(`${API_BASE}/files/${fileId}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function WorkspaceImagePicker({ onSelect, onClose }: { onSelect: (dataUrl: string) => void; onClose: () => void }) {
  const [files, setFiles] = useState<SharedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [fetchingId, setFetchingId] = useState<string | null>(null);

  useEffect(() => {
    apiGetFiles()
      .then(r => setFiles(r.files.filter(f => IMAGE_PICKER_MIMES.includes(f.mimeType))))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const filtered = files.filter(f =>
    f.name.toLowerCase().includes(search.toLowerCase()) ||
    (f.title ?? '').toLowerCase().includes(search.toLowerCase())
  );

  const handleSelect = async (f: SharedFile) => {
    if (fetchingId) return;
    setFetchingId(f.id);
    try {
      const dataUrl = await fetchFileAsDataUrl(f.id);
      onSelect(dataUrl);
    } catch {
      setFetchingId(null);
    }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1500, background: 'rgba(0,0,0,0.38)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: '#fff', borderRadius: 18, width: '100%', maxWidth: 440, maxHeight: '68vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 60px rgba(0,0,0,0.22)', animation: 'modalIn 240ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 18px 14px', borderBottom: '1px solid #F0EEF8', flexShrink: 0 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="image" size={16} color="#5e4dbb" />
          </div>
          <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 700, color: '#1c1b22', flex: 1 }}>Pick icon from Files</span>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#F5F3FF')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <Icon name="close" size={16} color="#787584" />
          </button>
        </div>
        {/* Search */}
        <div style={{ padding: '10px 18px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 9, padding: '7px 12px' }}>
            <Icon name="search" size={15} color="#b0acbe" />
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search images…"
              style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#1c1b22', background: 'transparent', border: 'none', outline: 'none' }}
            />
          </div>
        </div>
        {/* File list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 10px 12px' }}>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 28 }}>
              <div style={{ width: 22, height: 22, border: '2.5px solid #e8e4f0', borderTopColor: '#5e4dbb', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '28px 16px' }}>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>
                {search ? 'No matching images' : 'No image files found'}
              </div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#c9c4d5', marginTop: 4 }}>
                Upload PNG, JPG, SVG, or WEBP to Files first
              </div>
            </div>
          ) : (
            filtered.map(f => (
              <button key={f.id}
                disabled={!!fetchingId}
                onClick={() => handleSelect(f)}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '9px 10px', borderRadius: 10, border: 'none', background: fetchingId === f.id ? '#F5F3FF' : 'transparent', cursor: fetchingId ? 'default' : 'pointer', textAlign: 'left', transition: 'background 120ms' }}
                onMouseEnter={e => { if (!fetchingId) e.currentTarget.style.background = '#faf9ff'; }}
                onMouseLeave={e => { e.currentTarget.style.background = fetchingId === f.id ? '#F5F3FF' : 'transparent'; }}
              >
                <div style={{ width: 38, height: 38, borderRadius: 10, background: '#F5F3FF', border: '1px solid #ede9fe', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 9.5, fontWeight: 700, color: '#5e4dbb', letterSpacing: '0.03em' }}>{extBadge(f.mimeType)}</span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.title || f.name}</div>
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', marginTop: 1 }}>{(f.size / 1024).toFixed(0)} KB</div>
                </div>
                {fetchingId === f.id
                  ? <div style={{ width: 14, height: 14, border: '2px solid #c4b5fd', borderTopColor: '#5e4dbb', borderRadius: '50%', animation: 'spin 0.6s linear infinite', flexShrink: 0 }} />
                  : <Icon name="add_photo_alternate" size={16} color="#c9c4d5" />
                }
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

interface Props { workspace: Workspace; onClose: () => void; }

type Tab = 'general' | 'members' | 'admin' | 'danger';

export default function WorkspaceSettingsModal({ workspace, onClose }: Props) {
  const [closing, setClosing] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('general');

  // General
  const [name, setName]               = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description ?? '');
  const [emoji, setEmoji]             = useState(workspace.emoji ?? '🏠');
  const [useImage, setUseImage]       = useState(!!workspace.image);
  const [image, setImage]             = useState<string | null>(workspace.image ?? null);
  const [visibility, setVisibility]   = useState<'private' | 'public'>(workspace.visibility);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [imgError, setImgError]       = useState<string | null>(null);
  const [dragOver, setDragOver]       = useState(false);
  const [saving, setSaving]           = useState(false);
  const [saved, setSaved]             = useState(false);
  const [conflict, setConflict]       = useState<VisibilityConflict | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Members
  const [members, setMembers]         = useState<WorkspaceMember[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const [inviteUsername, setInviteUsername] = useState('');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [allUsers, setAllUsers]       = useState<UserSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const inviteInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Danger
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Image picker from Files
  const [showImagePicker, setShowImagePicker] = useState(false);

  const { updateWorkspace, deleteWorkspace, getMembers, addMember, removeMember, setDeletingWorkspaceId } = useWorkspaceStore();
  const { userId, isAdmin } = useAuthStore();
  const { lists, timelines } = useAppStore();
  const isOwner = workspace.ownerId === userId || workspace.role === 'owner';
  const [copiedWorkspaceId, setCopiedWorkspaceId] = useState(false);
  const workspaceLists = lists.filter(l => l.workspaceId === workspace.id);
  const workspaceTimelines = timelines.filter(t => t.workspaceId === workspace.id);
  const copyWorkspaceId = () => {
    navigator.clipboard.writeText(workspace.id).then(() => {
      setCopiedWorkspaceId(true);
      setTimeout(() => setCopiedWorkspaceId(false), 1600);
    });
  };

  const handleClose = () => { setClosing(true); setTimeout(() => onClose(), 190); };

  useEffect(() => {
    if (activeTab === 'members' && !membersLoaded) {
      getMembers(workspace.id).then(m => { setMembers(m); setMembersLoaded(true); }).catch(() => {});
      apiGetMembers().then(r => setAllUsers(r.members)).catch(() => {});
    }
  }, [activeTab, membersLoaded]);

  const memberUserIds = new Set(members.map(m => m.userId));
  const suggestions = inviteUsername.trim().length > 0
    ? allUsers.filter(u =>
        !memberUserIds.has(u.id) &&
        (u.username.toLowerCase().includes(inviteUsername.toLowerCase()) ||
         (u.fullName ?? '').toLowerCase().includes(inviteUsername.toLowerCase()))
      ).slice(0, 6)
    : [];

  const handleInviteUser = useCallback(async (username: string) => {
    setInviteLoading(true);
    setInviteError(null);
    setShowSuggestions(false);
    setInviteUsername('');
    setSuggestionIndex(-1);
    try {
      const m = await addMember(workspace.id, username);
      setMembers(prev => [...prev, m]);
    } catch (e: unknown) {
      setInviteError(e instanceof Error ? e.message : 'User not found or already a member.');
    } finally {
      setInviteLoading(false);
    }
  }, [workspace.id, addMember]);

  function processFile(file: File) {
    setImgError(null);
    if (!ACCEPTED_TYPES.includes(file.type)) { setImgError('Unsupported format. Use JPEG, PNG, GIF, or WebP.'); return; }
    if (file.size > MAX_IMAGE_BYTES) { setImgError('Max 2 MB.'); return; }
    const reader = new FileReader();
    reader.onload = e => { const r = e.target?.result as string; if (r) setImage(r); };
    reader.readAsDataURL(file);
  }

  const handleSave = async (cascade = false) => {
    setSaving(true);
    try {
      await updateWorkspace(workspace.id, {
        name: name.trim() || workspace.name,
        description: description.trim() || undefined,
        emoji: useImage ? undefined : emoji,
        image: useImage ? image ?? undefined : null as unknown as undefined,
        visibility,
        ...(cascade ? { cascade: true } : {}),
      });
      setConflict(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      // Turning the workspace private with public folders/lists/timelines inside
      // surfaces a conflict the owner can confirm (cascade) or cancel.
      const c = asVisibilityConflict(err);
      if (c) setConflict(c);
      // else: silent (matches prior behaviour)
    } finally {
      setSaving(false);
    }
  };

  const handleInvite = async () => {
    const uname = inviteUsername.trim();
    if (!uname) return;
    await handleInviteUser(uname);
  };

  const handleRemoveMember = async (memberId: string) => {
    try {
      await removeMember(workspace.id, memberId);
      setMembers(prev => prev.filter(m => m.userId !== memberId));
    } catch {
      // silent
    }
  };

  const handleDelete = () => {
    setDeleteLoading(true);
    setDeletingWorkspaceId(workspace.id);
    handleClose(); // plays modal exit animation then unmounts
    // Give time for: modal exit (190ms) + dropdown open + item animation (420ms)
    setTimeout(() => {
      deleteWorkspace(workspace.id).catch(() => setDeletingWorkspaceId(null));
    }, 550);
  };

  const panelAnim = closing
    ? 'settingsModalOut 190ms ease-in both'
    : 'settingsModalIn 360ms cubic-bezier(0.22,1,0.36,1) both';
  const backdropAnim = closing
    ? 'backdropOut 190ms ease both'
    : 'backdropIn 220ms ease both';

  const TABS: { id: Tab; label: string; icon: string }[] = [
    { id: 'general', label: 'General',  icon: 'settings'     },
    { id: 'members', label: 'Members',  icon: 'group'        },
    ...(isAdmin ? [{ id: 'admin' as const, label: 'Admin', icon: 'admin_panel_settings' }] : []),
    { id: 'danger',  label: 'Danger',   icon: 'warning'      },
  ];

  return (
    <>
    <div
      onClick={e => { if (e.target === e.currentTarget) handleClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)', backdropFilter: 'blur(5px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)', animation: backdropAnim }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 520, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.18)', animation: panelAnim, overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '20px 24px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
              {workspace.image
                ? <img src={workspace.image} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <span style={{ fontSize: 22 }}>{workspace.emoji ?? '🏠'}</span>
              }
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>{workspace.name}</div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584' }}>Workspace settings</div>
            </div>
            <button onClick={handleClose} style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="close" size={18} color="#787584" />
            </button>
          </div>

          {/* Tab bar */}
          <div style={{ display: 'flex', gap: 4, background: '#F5F3FF', borderRadius: 10, padding: 4 }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setActiveTab(t.id)}
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '7px 10px', borderRadius: 7, border: 'none', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: activeTab === t.id ? 700 : 500, background: activeTab === t.id ? '#fff' : 'transparent', color: activeTab === t.id ? (t.id === 'danger' ? '#ba1a1a' : '#5e4dbb') : '#787584', boxShadow: activeTab === t.id ? '0 1px 4px rgba(0,0,0,0.08)' : 'none', transition: 'all 150ms' }}>
                <Icon name={t.icon} size={14} color={activeTab === t.id ? (t.id === 'danger' ? '#ba1a1a' : '#5e4dbb') : '#787584'} />
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px 24px' }}>

          {/* ── General ── */}
          {activeTab === 'general' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18, animation: 'sectionFadeUp 280ms cubic-bezier(0.22,1,0.36,1) both' }}>
              {/* Icon */}
              <div>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#787584', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Icon</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ width: 64, height: 64, borderRadius: 16, background: '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', overflow: 'hidden', border: '2px solid #e8e4f0', flexShrink: 0 }}
                    onClick={() => useImage ? fileInputRef.current?.click() : setShowEmojiPicker(p => !p)}>
                    {useImage && image
                      ? <img src={image} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : <span style={{ fontSize: 30 }}>{emoji}</span>
                    }
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', background: '#f1ecf6', borderRadius: 8, padding: 2, gap: 2 }}>
                      <button onClick={() => setUseImage(false)} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', background: !useImage ? '#5e4dbb' : 'transparent', color: !useImage ? '#fff' : '#787584', transition: 'all 150ms' }}>Emoji</button>
                      <button onClick={() => setUseImage(true)} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', background: useImage ? '#5e4dbb' : 'transparent', color: useImage ? '#fff' : '#787584', transition: 'all 150ms' }}>Image</button>
                    </div>
                    {useImage && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                        <button onClick={() => fileInputRef.current?.click()} style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#5e4dbb', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Icon name="upload" size={13} color="#5e4dbb" />Upload from device
                        </button>
                        <button onClick={() => setShowImagePicker(true)} style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#5e4dbb', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Icon name="folder_open" size={13} color="#5e4dbb" />Pick from Files
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {useImage && (
                  <div
                    onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) processFile(f); }}
                    onClick={() => fileInputRef.current?.click()}
                    style={{ marginTop: 10, border: `2px dashed ${dragOver ? '#5e4dbb' : '#c4b5fd'}`, borderRadius: 10, padding: '14px', textAlign: 'center', cursor: 'pointer', background: dragOver ? '#f0edff' : '#fafbff', transition: 'all 150ms' }}>
                    <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584' }}>Drop image or click to upload</div>
                    {imgError && <div style={{ color: '#ba1a1a', fontSize: 11, marginTop: 4 }}>{imgError}</div>}
                  </div>
                )}
                {!useImage && showEmojiPicker && (
                  <div style={{ marginTop: 10, border: '1px solid #e8e4f0', borderRadius: 12, padding: 10, background: '#fff', width: 'fit-content', animation: 'menuIn 160ms ease both', transformOrigin: 'top left' }}>
                    <EmojiGrid value={emoji} onSelect={em => { setEmoji(em); setShowEmojiPicker(false); }} />
                  </div>
                )}
              </div>
              <input ref={fileInputRef} type="file" accept={ACCEPTED_TYPES.join(',')} style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) processFile(f); e.target.value = ''; }} />

              {/* Name */}
              <div>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#787584', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Name</div>
                <input value={name} onChange={e => setName(e.target.value)} maxLength={60}
                  style={{ width: '100%', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, padding: '10px 14px', borderRadius: 10, border: '1.5px solid #e8e4f0', outline: 'none', color: '#1c1b22', background: '#fafafa', boxSizing: 'border-box' }} />
              </div>

              {/* Description */}
              <div>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#787584', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Description</div>
                <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} maxLength={300}
                  style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 13, padding: '10px 14px', borderRadius: 10, border: '1.5px solid #e8e4f0', outline: 'none', color: '#484552', background: '#fafafa', resize: 'none', boxSizing: 'border-box' }} />
              </div>

              {/* Visibility */}
              <div>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#787584', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Visibility</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {(['private', 'public'] as const).map(v => (
                    <button key={v} onClick={() => setVisibility(v)}
                      style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, border: `1.5px solid ${visibility === v ? '#5e4dbb' : '#e8e4f0'}`, background: visibility === v ? '#F5F3FF' : '#fafafa', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: visibility === v ? 600 : 450, color: visibility === v ? '#5e4dbb' : '#484552', transition: 'all 150ms' }}>
                      <Icon name={v === 'private' ? 'lock' : 'public'} size={15} color={visibility === v ? '#5e4dbb' : '#787584'} />
                      {v === 'private' ? 'Private' : 'Public'}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10 }}>
                {saved && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#15803d', animation: 'savedPop 300ms ease both', display: 'flex', alignItems: 'center', gap: 4 }}><Icon name="check_circle" size={14} color="#15803d" /> Saved</div>}
                <button onClick={() => handleSave()} disabled={saving || !isOwner}
                  style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#5e4dbb', border: 'none', borderRadius: 10, padding: '10px 22px', cursor: (saving || !isOwner) ? 'default' : 'pointer', opacity: !isOwner ? 0.5 : 1 }}>
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </div>
          )}

          {/* ── Members ── */}
          {activeTab === 'members' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, animation: 'sectionFadeUp 280ms cubic-bezier(0.22,1,0.36,1) both' }}>
              {isOwner && (
                <div>
                  <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#787584', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Invite member</div>
                  <div style={{ position: 'relative' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#f7f4fc', borderRadius: 10, padding: '8px 14px', border: `1.5px solid ${showSuggestions && suggestions.length > 0 ? '#c4b5fd' : 'transparent'}`, transition: 'border-color 150ms' }}>
                      <Icon name="person_search" size={16} color="#787584" />
                      <input
                        ref={inviteInputRef}
                        value={inviteUsername}
                        onChange={e => { setInviteUsername(e.target.value); setInviteError(null); setSuggestionIndex(-1); setShowSuggestions(true); }}
                        onFocus={() => setShowSuggestions(true)}
                        onBlur={e => { if (!suggestionsRef.current?.contains(e.relatedTarget as Node)) { setShowSuggestions(false); setSuggestionIndex(-1); } }}
                        onKeyDown={e => {
                          if (e.key === 'ArrowDown') { e.preventDefault(); setSuggestionIndex(i => Math.min(i + 1, suggestions.length - 1)); }
                          else if (e.key === 'ArrowUp') { e.preventDefault(); setSuggestionIndex(i => Math.max(i - 1, -1)); }
                          else if (e.key === 'Enter') {
                            if (suggestionIndex >= 0 && suggestions[suggestionIndex]) handleInviteUser(suggestions[suggestionIndex].username);
                            else handleInvite();
                          }
                          else if (e.key === 'Escape') { setShowSuggestions(false); setSuggestionIndex(-1); }
                        }}
                        placeholder="Search by name or username…"
                        style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontFamily: 'Inter, sans-serif', fontSize: 13.5, color: '#1c1b22' }}
                      />
                      {inviteLoading && <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid #c4b5fd', borderTopColor: '#5e4dbb', animation: 'spin 600ms linear infinite', flexShrink: 0 }} />}
                    </div>

                    {showSuggestions && suggestions.length > 0 && (
                      <div ref={suggestionsRef} style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, background: '#fff', borderRadius: 12, boxShadow: '0 4px 20px rgba(0,0,0,0.13)', border: '1px solid #e8e4f0', overflow: 'hidden', zIndex: 50, animation: 'menuIn 140ms ease both' }}>
                        {suggestions.map((u, i) => (
                          <button key={u.id}
                            tabIndex={0}
                            onMouseDown={e => { e.preventDefault(); handleInviteUser(u.username); }}
                            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 14px', border: 'none', background: i === suggestionIndex ? '#F5F3FF' : 'transparent', cursor: 'pointer', textAlign: 'left', transition: 'background 100ms' }}
                            onMouseEnter={() => setSuggestionIndex(i)}
                            onMouseLeave={() => setSuggestionIndex(-1)}
                          >
                            {u.profileImage
                              ? <img src={u.profileImage} style={{ width: 30, height: 30, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                              : <div style={{ width: 30, height: 30, borderRadius: '50%', background: '#ede9fe', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                  <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 700, color: '#5e4dbb' }}>{u.username[0].toUpperCase()}</span>
                                </div>
                            }
                            <div style={{ flex: 1, overflow: 'hidden' }}>
                              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.fullName ?? u.username}</div>
                              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584' }}>@{u.username}</div>
                            </div>
                            <Icon name="person_add" size={14} color="#9d8dff" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {inviteError && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a', marginTop: 6 }}>{inviteError}</div>}
                </div>
              )}

              <div>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#787584', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Members</div>
                {!membersLoaded
                  ? <div style={{ padding: 20, textAlign: 'center', color: '#b0acbe', fontFamily: 'Inter, sans-serif', fontSize: 13 }}>Loading…</div>
                  : members.length === 0
                    ? <div style={{ padding: 20, textAlign: 'center', color: '#b0acbe', fontFamily: 'Inter, sans-serif', fontSize: 13 }}>No members yet.</div>
                    : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {members.map(m => (
                          <div key={m.userId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: '#fafafa', borderRadius: 10, border: '1px solid #f1ecf6' }}>
                            {m.profileImage
                              ? <img src={m.profileImage} style={{ width: 34, height: 34, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                              : <div style={{ width: 34, height: 34, borderRadius: '50%', background: m.role === 'owner' ? '#5e4dbb' : '#e8e4f0', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                  <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 700, color: m.role === 'owner' ? '#fff' : '#787584' }}>{m.username[0].toUpperCase()}</span>
                                </div>
                            }
                            <div style={{ flex: 1 }}>
                              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22' }}>{m.fullName ?? m.username}</div>
                              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584' }}>@{m.username}</div>
                            </div>
                            <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 9999, background: m.role === 'owner' ? '#F5F3FF' : '#f1ecf6', color: m.role === 'owner' ? '#5e4dbb' : '#787584' }}>
                              {m.role}
                            </span>
                            {isOwner && m.role !== 'owner' && (
                              <button onClick={() => handleRemoveMember(m.userId)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 4, borderRadius: 6 }}
                                title="Remove member">
                                <Icon name="person_remove" size={15} color="#ba1a1a" />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )
                }
              </div>
            </div>
          )}


          {/* ── Admin ── */}
          {activeTab === 'admin' && isAdmin && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, animation: 'sectionFadeUp 280ms cubic-bezier(0.22,1,0.36,1) both' }}>
              <div>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#787584', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Workspace ID</div>
                <div style={{ background: '#F5F3FF', border: '1px solid #e8e4f0', borderRadius: 12, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <code style={{ flex: 1, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: '#484552', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{workspace.id}</code>
                  <button onClick={copyWorkspaceId} style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 700, color: copiedWorkspaceId ? '#10B981' : '#5e4dbb', background: '#fff', border: '1px solid #e8e4f0', borderRadius: 8, padding: '7px 10px', cursor: 'pointer', flexShrink: 0 }}>
                    <Icon name={copiedWorkspaceId ? 'check' : 'content_copy'} size={13} color={copiedWorkspaceId ? '#10B981' : '#5e4dbb'} />
                    {copiedWorkspaceId ? 'Copied' : 'Copy ID'}
                  </button>
                </div>
              </div>
              <div>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#787584', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Stats</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  {[
                    ['Lists', workspaceLists.length, 'format_list_bulleted'],
                    ['Private lists', workspaceLists.filter(l => !l.isPublic).length, 'lock'],
                    ['Timelines', workspaceTimelines.length, 'timeline'],
                    ['Private timelines', workspaceTimelines.filter(t => !t.isPublic).length, 'lock_clock'],
                  ].map(([label, value, icon]) => (
                    <div key={String(label)} style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 14, padding: 14 }}>
                      <Icon name={String(icon)} size={16} color="#5e4dbb" />
                      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 22, fontWeight: 800, color: '#1c1b22', marginTop: 8 }}>{value}</div>
                      <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2 }}>{label}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── Danger ── */}
          {activeTab === 'danger' && (
            <div style={{ animation: 'sectionFadeUp 280ms cubic-bezier(0.22,1,0.36,1) both' }}>
              {!isOwner
                ? <div style={{ padding: '24px', textAlign: 'center', color: '#787584', fontFamily: 'Inter, sans-serif', fontSize: 13 }}>Only the workspace owner can perform these actions.</div>
                : confirmDelete
                  ? (
                    <div style={{ background: '#fff5f5', border: '1.5px solid #ffdad6', borderRadius: 14, padding: '24px', textAlign: 'center' }}>
                      <div style={{ width: 48, height: 48, borderRadius: '50%', background: '#ffdad6', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
                        <Icon name="warning" size={24} color="#ba1a1a" />
                      </div>
                      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22', marginBottom: 8 }}>Delete workspace?</div>
                      <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', lineHeight: 1.6, marginBottom: 20 }}>
                        This will permanently delete "<strong>{workspace.name}</strong>" and all its lists, folders, and tasks. This cannot be undone.
                      </div>
                      <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                        <button onClick={() => setConfirmDelete(false)} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: '#f1ecf6', border: 'none', borderRadius: 10, padding: '10px 20px', cursor: 'pointer' }}>Cancel</button>
                        <button onClick={handleDelete} disabled={deleteLoading}
                          style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#ba1a1a', border: 'none', borderRadius: 10, padding: '10px 20px', cursor: deleteLoading ? 'wait' : 'pointer' }}>
                          {deleteLoading ? 'Deleting…' : 'Delete permanently'}
                        </button>
                      </div>
                    </div>
                  )
                  : (
                    <div style={{ background: '#fff5f5', border: '1.5px solid #ffdad6', borderRadius: 14, padding: '20px' }}>
                      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 700, color: '#ba1a1a', marginBottom: 6 }}>Delete workspace</div>
                      <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', lineHeight: 1.5, marginBottom: 16 }}>
                        Permanently deletes this workspace and all of its lists, folders, and tasks.
                      </div>
                      <button onClick={() => setConfirmDelete(true)}
                        style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#ba1a1a', background: '#ffdad6', border: 'none', borderRadius: 10, padding: '10px 20px', cursor: 'pointer' }}>
                        Delete workspace…
                      </button>
                    </div>
                  )
              }
            </div>
          )}
        </div>
      </div>
    </div>

    {showImagePicker && (
      <WorkspaceImagePicker
        onSelect={dataUrl => { setImage(dataUrl); setUseImage(true); setShowImagePicker(false); }}
        onClose={() => setShowImagePicker(false)}
      />
    )}

    {conflict && (
      <VisibilityConflictModal
        conflict={conflict}
        busy={saving}
        onCancel={() => setConflict(null)}
        onConfirm={() => handleSave(true)}
      />
    )}
    </>
  );
}
