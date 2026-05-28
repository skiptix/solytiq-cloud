import { useState, useEffect, useRef, useCallback } from 'react';
import Icon from '../components/Icon';
import useWorkspaceStore from '../store/useWorkspaceStore';
import useAuthStore from '../store/useAuthStore';
import type { Workspace, WorkspaceMember } from '../types';
import EmojiPicker from 'emoji-picker-react';
import { apiGetMembers } from '../api/client';

interface UserSuggestion { id: string; username: string; fullName: string | null; profileImage: string | null; }

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

interface Props { workspace: Workspace; onClose: () => void; }

type Tab = 'general' | 'members' | 'danger';

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

  const { updateWorkspace, deleteWorkspace, getMembers, addMember, removeMember } = useWorkspaceStore();
  const { userId } = useAuthStore();
  const isOwner = workspace.ownerId === userId || workspace.role === 'owner';

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

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateWorkspace(workspace.id, {
        name: name.trim() || workspace.name,
        description: description.trim() || undefined,
        emoji: useImage ? undefined : emoji,
        image: useImage ? image ?? undefined : null as unknown as undefined,
        visibility,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // silent
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

  const handleDelete = async () => {
    setDeleteLoading(true);
    try {
      await deleteWorkspace(workspace.id);
      onClose();
    } catch {
      setDeleteLoading(false);
    }
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
    { id: 'danger',  label: 'Danger',   icon: 'warning'      },
  ];

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) handleClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)', backdropFilter: 'blur(5px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: backdropAnim }}>
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
                    {useImage && <button onClick={() => fileInputRef.current?.click()} style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#5e4dbb', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}>Upload image…</button>}
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
                  <div style={{ marginTop: 10 }}>
                    <EmojiPicker onEmojiClick={d => { setEmoji(d.emoji); setShowEmojiPicker(false); }} width="100%" height={280} searchPlaceholder="Search…" previewConfig={{ showPreview: false }} />
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
                <button onClick={handleSave} disabled={saving || !isOwner}
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
  );
}
