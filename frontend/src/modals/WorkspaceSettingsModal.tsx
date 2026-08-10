import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../components/Icon';
import useWorkspaceStore from '../store/useWorkspaceStore';
import useAuthStore from '../store/useAuthStore';
import useAppStore from '../store/useAppStore';
import type { Workspace, WorkspaceMember, SharedFile, AgentMode } from '../types';
import useAgentStore from '../store/useAgentStore';
import { RunRow } from '../components/AgentInbox';
import { EmojiGrid, POPUP_WIDTH } from '../components/EmojiSelector';
import { apiGetMembers, apiGetFiles, asVisibilityConflict, type VisibilityConflict } from '../api/client';
import VisibilityConflictModal from '../components/VisibilityConflictModal';
import CreatorBubble from '../components/CreatorBubble';
import TrashPanel from '../components/TrashPanel';
import ArchivedPanel from '../components/ArchivedPanel';
import { deriveWorkspacePermissions } from '../utils/workspacePermissions';

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
      style={{ position: 'fixed', inset: 0, zIndex: 1500, background: 'rgba(var(--color-black-rgb), 0.38)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: 'var(--color-white)', borderRadius: 18, width: '100%', maxWidth: 440, maxHeight: '68vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 60px rgba(var(--color-black-rgb), 0.22)', animation: 'modalIn 240ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 18px 14px', borderBottom: '1px solid var(--color-purple-pale-23)', flexShrink: 0 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="image" size={16} color="var(--color-primary)" />
          </div>
          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', flex: 1 }}>Pick icon from Files</span>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-tint)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <Icon name="close" size={16} color="var(--color-text-tertiary)" />
          </button>
        </div>
        {/* Search */}
        <div style={{ padding: '10px 18px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 9, padding: '7px 12px' }}>
            <Icon name="search" size={15} color="var(--color-text-quaternary)" />
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search images…"
              style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)', background: 'transparent', border: 'none', outline: 'none' }}
            />
          </div>
        </div>
        {/* File list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 10px 12px' }}>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 28 }}>
              <div style={{ width: 22, height: 22, border: '2.5px solid var(--color-border)', borderTopColor: 'var(--color-primary)', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '28px 16px' }}>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>
                {search ? 'No matching images' : 'No image files found'}
              </div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-border-strong)', marginTop: 4 }}>
                Upload PNG, JPG, SVG, or WEBP to Files first
              </div>
            </div>
          ) : (
            filtered.map(f => (
              <button key={f.id}
                disabled={!!fetchingId}
                onClick={() => handleSelect(f)}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '9px 10px', borderRadius: 10, border: 'none', background: fetchingId === f.id ? 'var(--color-surface-tint)' : 'transparent', cursor: fetchingId ? 'default' : 'pointer', textAlign: 'left', transition: 'background 120ms' }}
                onMouseEnter={e => { if (!fetchingId) e.currentTarget.style.background = 'var(--color-surface-tint-3)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = fetchingId === f.id ? 'var(--color-surface-tint)' : 'transparent'; }}
              >
                <div style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--color-surface-tint)', border: '1px solid var(--color-purple-pale-21)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 9.5, fontWeight: 700, color: 'var(--color-primary)', letterSpacing: '0.03em' }}>{extBadge(f.mimeType)}</span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.title || f.name}</div>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', marginTop: 1 }}>{(f.size / 1024).toFixed(0)} KB</div>
                </div>
                {fetchingId === f.id
                  ? <div style={{ width: 14, height: 14, border: '2px solid var(--color-accent-purple-soft-alt)', borderTopColor: 'var(--color-primary)', borderRadius: '50%', animation: 'spin 0.6s linear infinite', flexShrink: 0 }} />
                  : <Icon name="add_photo_alternate" size={16} color="var(--color-border-strong)" />
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

type Tab = 'general' | 'members' | 'agent' | 'admin' | 'trash' | 'danger';

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
  const [emojiPopPos, setEmojiPopPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const [imgError, setImgError]       = useState<string | null>(null);
  const [dragOver, setDragOver]       = useState(false);
  const [saving, setSaving]           = useState(false);
  const [saved, setSaved]             = useState(false);
  const [conflict, setConflict]       = useState<VisibilityConflict | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const iconTileRef = useRef<HTMLDivElement>(null);
  const emojiPopRef = useRef<HTMLDivElement>(null);

  // Open the emoji grid as a floating popup anchored to the icon tile —
  // matching EmojiSelector's own popup everywhere else — instead of pushing
  // the rest of the panel down inline.
  const toggleEmojiPicker = () => {
    if (!showEmojiPicker) {
      const rect = iconTileRef.current?.getBoundingClientRect();
      if (rect) {
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - POPUP_WIDTH - 8));
        const spaceBelow = window.innerHeight - rect.bottom - 12;
        const spaceAbove = rect.top - 12;
        setEmojiPopPos(spaceBelow < 380 && spaceAbove > spaceBelow
          ? { left, bottom: window.innerHeight - rect.top + 6 }
          : { left, top: rect.bottom + 6 });
      }
    }
    setShowEmojiPicker(p => !p);
  };

  useEffect(() => {
    if (!showEmojiPicker) return;
    const handler = (e: MouseEvent) => {
      if (
        emojiPopRef.current && !emojiPopRef.current.contains(e.target as Node) &&
        iconTileRef.current && !iconTileRef.current.contains(e.target as Node)
      ) setShowEmojiPicker(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showEmojiPicker]);

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

  // Agent
  const [agentMode, setAgentMode] = useState<AgentMode>(workspace.agentMode ?? 'off');
  const [agentSaving, setAgentSaving] = useState(false);
  const [agentSaved, setAgentSaved] = useState(false);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const agentRuns = useAgentStore(s => s.runs);
  const agentRunsLoading = useAgentStore(s => s.loading);
  const agentRunsLoaded = useAgentStore(s => s.loaded);
  const loadAgentRuns = useAgentStore(s => s.load);

  // Trash & Archived
  const [trashSubTab, setTrashSubTab] = useState<'trash' | 'archived'>('trash');

  // Danger
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Image picker from Files
  const [showImagePicker, setShowImagePicker] = useState(false);

  const { updateWorkspace, deleteWorkspace, getMembers, addMember, removeMember, setDeletingWorkspaceId } = useWorkspaceStore();
  const setWorkspaceAgent = useAgentStore(s => s.setWorkspaceAgent);
  const { isAdmin } = useAuthStore();
  const { lists, timelines } = useAppStore();
  // Sprint 03, M17 fix: derive visibility/permission from the real server
  // model (per-viewer `workspace.role` + the instance-wide `isAdmin` flag)
  // instead of a client-side `workspace.ownerId === userId` comparison that
  // duplicated, rather than read, server state and — critically — never
  // considered `isAdmin` at all, silently hiding owner-gated controls
  // (Save, the Agent tab, Delete workspace) from an admin managing a
  // workspace they don't personally own even though the server explicitly
  // grants them that access. See utils/workspacePermissions.ts.
  const { canManageWorkspace, canInviteMembers, canRemoveMember } = deriveWorkspacePermissions(workspace, isAdmin);
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

  useEffect(() => {
    if (activeTab === 'agent' && canManageWorkspace && !agentRunsLoaded) {
      void loadAgentRuns(workspace.id);
    }
  }, [activeTab, canManageWorkspace, agentRunsLoaded, loadAgentRuns, workspace.id]);

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

  const handleSaveAgent = async () => {
    setAgentSaving(true);
    try {
      await setWorkspaceAgent(workspace.id, agentMode);
      setAgentSaved(true);
      setTimeout(() => setAgentSaved(false), 2000);
    } catch {
      // silent — matches handleSave's own quiet-failure convention for non-conflict errors
    } finally {
      setAgentSaving(false);
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
    ...(canManageWorkspace ? [{ id: 'agent' as const, label: 'Agent', icon: 'smart_toy' }] : []),
    ...(isAdmin ? [{ id: 'admin' as const, label: 'Admin', icon: 'admin_panel_settings' }] : []),
    { id: 'trash',   label: 'Trash',    icon: 'delete'       },
    { id: 'danger',  label: 'Danger',   icon: 'warning'      },
  ];

  // Portaled to <body>: this modal is opened from inside the fixed-position
  // Sidebar (its own stacking context), which would otherwise cap it below
  // the topbar no matter how high its z-index is set.
  return createPortal(
    <>
    <div
      onClick={e => { if (e.target === e.currentTarget) handleClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.28)', backdropFilter: 'blur(5px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)', animation: backdropAnim }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--color-white)', borderRadius: 20, width: '100%', maxWidth: 780, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(var(--color-black-rgb), 0.18)', animation: panelAnim, overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '20px 24px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
              {workspace.image
                ? <img src={workspace.image} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <span style={{ fontSize: 22 }}>{workspace.emoji ?? '🏠'}</span>
              }
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>{workspace.name}</div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-tertiary)' }}>Workspace settings</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              <CreatorBubble creatorId={workspace.ownerId} taskHovered />
              <button onClick={handleClose} style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="close" size={18} color="var(--color-text-tertiary)" />
              </button>
            </div>
          </div>

          {/* Tab bar */}
          <div style={{ display: 'flex', gap: 4, background: 'var(--color-surface-tint)', borderRadius: 10, padding: 4 }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setActiveTab(t.id)}
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '7px 10px', borderRadius: 7, border: 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: activeTab === t.id ? 700 : 500, background: activeTab === t.id ? 'var(--color-white)' : 'transparent', color: activeTab === t.id ? (t.id === 'danger' ? 'var(--color-error)' : 'var(--color-primary)') : 'var(--color-text-tertiary)', boxShadow: activeTab === t.id ? '0 1px 4px rgba(var(--color-black-rgb), 0.08)' : 'none', transition: 'all 150ms' }}>
                <Icon name={t.icon} size={14} color={activeTab === t.id ? (t.id === 'danger' ? 'var(--color-error)' : 'var(--color-primary)') : 'var(--color-text-tertiary)'} />
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
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Icon</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div ref={iconTileRef} style={{ width: 64, height: 64, borderRadius: 16, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', overflow: 'hidden', border: '2px solid var(--color-border)', flexShrink: 0 }}
                    onClick={() => useImage ? fileInputRef.current?.click() : toggleEmojiPicker()}>
                    {useImage && image
                      ? <img src={image} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : <span style={{ fontSize: 30 }}>{emoji}</span>
                    }
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', background: 'var(--color-surface-tint-2)', borderRadius: 8, padding: 2, gap: 2 }}>
                      <button onClick={() => setUseImage(false)} style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', background: !useImage ? 'var(--color-primary)' : 'transparent', color: !useImage ? 'var(--color-white)' : 'var(--color-text-tertiary)', transition: 'all 150ms' }}>Emoji</button>
                      <button onClick={() => setUseImage(true)} style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', background: useImage ? 'var(--color-primary)' : 'transparent', color: useImage ? 'var(--color-white)' : 'var(--color-text-tertiary)', transition: 'all 150ms' }}>Image</button>
                    </div>
                    {useImage && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                        <button onClick={() => fileInputRef.current?.click()} style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Icon name="upload" size={13} color="var(--color-primary)" />Upload from device
                        </button>
                        <button onClick={() => setShowImagePicker(true)} style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Icon name="folder_open" size={13} color="var(--color-primary)" />Pick from Files
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
                    style={{ marginTop: 10, border: `2px dashed ${dragOver ? 'var(--color-primary)' : 'var(--color-accent-purple-soft-alt)'}`, borderRadius: 10, padding: '14px', textAlign: 'center', cursor: 'pointer', background: dragOver ? 'var(--color-surface-tint-alt)' : 'var(--color-blue-pale-1)', transition: 'all 150ms' }}>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>Drop image or click to upload</div>
                    {imgError && <div style={{ color: 'var(--color-error)', fontSize: 11, marginTop: 4 }}>{imgError}</div>}
                  </div>
                )}
                {!useImage && showEmojiPicker && emojiPopPos && createPortal(
                  <div
                    ref={emojiPopRef}
                    onMouseDown={e => e.preventDefault()}
                    style={{ position: 'fixed', left: emojiPopPos.left, top: emojiPopPos.top, bottom: emojiPopPos.bottom, zIndex: 1600, background: 'var(--color-white)', borderRadius: 12, boxShadow: '0 4px 24px rgba(var(--color-black-rgb), 0.13)', border: '1px solid var(--color-border)', padding: '10px', width: POPUP_WIDTH, boxSizing: 'border-box', maxHeight: 'calc(100vh - 24px)', overflowY: 'auto', animation: 'modalIn 180ms cubic-bezier(0.34,1.56,0.64,1) both' }}
                  >
                    <EmojiGrid value={emoji} onSelect={em => { setEmoji(em); setShowEmojiPicker(false); }} />
                  </div>,
                  document.body
                )}
              </div>
              <input ref={fileInputRef} type="file" accept={ACCEPTED_TYPES.join(',')} style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) processFile(f); e.target.value = ''; }} />

              {/* Name */}
              <div>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Name</div>
                <input value={name} onChange={e => setName(e.target.value)} maxLength={60}
                  style={{ width: '100%', fontFamily: 'var(--font-heading)', fontSize: 14, padding: '10px 14px', borderRadius: 10, border: '1.5px solid var(--color-border)', outline: 'none', color: 'var(--color-text-primary)', background: 'var(--color-surface-neutral)', boxSizing: 'border-box' }} />
              </div>

              {/* Description */}
              <div>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Description</div>
                <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} maxLength={300}
                  style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 13, padding: '10px 14px', borderRadius: 10, border: '1.5px solid var(--color-border)', outline: 'none', color: 'var(--color-text-secondary)', background: 'var(--color-surface-neutral)', resize: 'none', boxSizing: 'border-box' }} />
              </div>

              {/* Visibility */}
              <div>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Visibility</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {(['private', 'public'] as const).map(v => (
                    <button key={v} onClick={() => setVisibility(v)}
                      style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, border: `1.5px solid ${visibility === v ? 'var(--color-primary)' : 'var(--color-border)'}`, background: visibility === v ? 'var(--color-surface-tint)' : 'var(--color-surface-neutral)', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: visibility === v ? 600 : 450, color: visibility === v ? 'var(--color-primary)' : 'var(--color-text-secondary)', transition: 'all 150ms' }}>
                      <Icon name={v === 'private' ? 'lock' : 'public'} size={15} color={visibility === v ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                      {v === 'private' ? 'Private' : 'Public'}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10 }}>
                {saved && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-green-deep-3)', animation: 'savedPop 300ms ease both', display: 'flex', alignItems: 'center', gap: 4 }}><Icon name="check_circle" size={14} color="var(--color-green-deep-3)" /> Saved</div>}
                <button onClick={() => handleSave()} disabled={saving || !canManageWorkspace}
                  style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-primary)', border: 'none', borderRadius: 10, padding: '10px 22px', cursor: (saving || !canManageWorkspace) ? 'default' : 'pointer', opacity: !canManageWorkspace ? 0.5 : 1 }}>
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </div>
          )}

          {/* ── Members ── */}
          {activeTab === 'members' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, animation: 'sectionFadeUp 280ms cubic-bezier(0.22,1,0.36,1) both' }}>
              {canInviteMembers && (
                <div>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Invite member</div>
                  <div style={{ position: 'relative' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--color-purple-pale-11)', borderRadius: 10, padding: '8px 14px', border: `1.5px solid ${showSuggestions && suggestions.length > 0 ? 'var(--color-accent-purple-soft-alt)' : 'transparent'}`, transition: 'border-color 150ms' }}>
                      <Icon name="person_search" size={16} color="var(--color-text-tertiary)" />
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
                        style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-primary)' }}
                      />
                      {inviteLoading && <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid var(--color-accent-purple-soft-alt)', borderTopColor: 'var(--color-primary)', animation: 'spin 600ms linear infinite', flexShrink: 0 }} />}
                    </div>

                    {showSuggestions && suggestions.length > 0 && (
                      <div ref={suggestionsRef} style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, background: 'var(--color-white)', borderRadius: 12, boxShadow: '0 4px 20px rgba(var(--color-black-rgb), 0.13)', border: '1px solid var(--color-border)', overflow: 'hidden', zIndex: 50, animation: 'menuIn 140ms ease both' }}>
                        {suggestions.map((u, i) => (
                          <button key={u.id}
                            tabIndex={0}
                            onMouseDown={e => { e.preventDefault(); handleInviteUser(u.username); }}
                            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 14px', border: 'none', background: i === suggestionIndex ? 'var(--color-surface-tint)' : 'transparent', cursor: 'pointer', textAlign: 'left', transition: 'background 100ms' }}
                            onMouseEnter={() => setSuggestionIndex(i)}
                            onMouseLeave={() => setSuggestionIndex(-1)}
                          >
                            {u.profileImage
                              ? <img src={u.profileImage} style={{ width: 30, height: 30, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                              : <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--color-purple-pale-21)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                  <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 700, color: 'var(--color-primary)' }}>{u.username[0].toUpperCase()}</span>
                                </div>
                            }
                            <div style={{ flex: 1, overflow: 'hidden' }}>
                              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.fullName ?? u.username}</div>
                              <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-tertiary)' }}>@{u.username}</div>
                            </div>
                            <Icon name="person_add" size={14} color="var(--color-accent-purple-light)" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {inviteError && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)', marginTop: 6 }}>{inviteError}</div>}
                </div>
              )}

              <div>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Members</div>
                {!membersLoaded
                  ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-body)', fontSize: 13 }}>Loading…</div>
                  : members.length === 0
                    ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-body)', fontSize: 13 }}>No members yet.</div>
                    : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {members.map(m => (
                          <div key={m.userId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--color-surface-neutral)', borderRadius: 10, border: '1px solid var(--color-surface-tint-2)' }}>
                            {m.profileImage
                              ? <img src={m.profileImage} style={{ width: 34, height: 34, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                              : <div style={{ width: 34, height: 34, borderRadius: '50%', background: m.role === 'owner' ? 'var(--color-primary)' : 'var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                  <span style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 700, color: m.role === 'owner' ? 'var(--color-white)' : 'var(--color-text-tertiary)' }}>{m.username[0].toUpperCase()}</span>
                                </div>
                            }
                            <div style={{ flex: 1 }}>
                              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{m.fullName ?? m.username}</div>
                              <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-tertiary)' }}>@{m.username}</div>
                            </div>
                            <span style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 9999, background: m.role === 'owner' ? 'var(--color-surface-tint)' : 'var(--color-surface-tint-2)', color: m.role === 'owner' ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }}>
                              {m.role}
                            </span>
                            {canRemoveMember(m.role) && (
                              <button onClick={() => handleRemoveMember(m.userId)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 4, borderRadius: 6 }}
                                title="Remove member">
                                <Icon name="person_remove" size={15} color="var(--color-error)" />
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


          {/* ── Agent ── */}
          {activeTab === 'agent' && canManageWorkspace && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, animation: 'sectionFadeUp 280ms cubic-bezier(0.22,1,0.36,1) both' }}>
              <div>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Autonomy</div>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-tertiary)', marginBottom: 12 }}>
                  Controls how much the AI agent can do on its own in this workspace — from proposing every action for you to approve, to acting fully autonomously within its policy limits. Reachable from an automation's "AI Agent" action, or by assigning a task to it directly.
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {([
                    { id: 'off', label: 'Off', desc: 'The agent never runs in this workspace.' },
                    { id: 'suggest', label: 'Suggest', desc: 'Every action is queued as a proposal for a human to accept or reject — nothing runs automatically.' },
                    { id: 'assisted', label: 'Assisted', desc: 'Pre-approved tools run automatically; anything else is proposed for approval.' },
                    { id: 'autonomous', label: 'Autonomous', desc: 'Runs everything its policy allows on its own (deletions still require approval by default).' },
                  ] as { id: AgentMode; label: string; desc: string }[]).map(m => (
                    <button
                      key={m.id}
                      onClick={() => { setAgentMode(m.id); setAgentSaved(false); }}
                      style={{
                        display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                        border: agentMode === m.id ? '1.5px solid var(--color-primary)' : '1.5px solid var(--color-border)',
                        background: agentMode === m.id ? 'var(--color-purple-pale-14, var(--color-surface-tint))' : 'var(--color-surface-neutral)',
                      }}
                    >
                      <span style={{
                        width: 14, height: 14, borderRadius: '50%', flexShrink: 0, marginTop: 2,
                        border: agentMode === m.id ? '4px solid var(--color-primary)' : '2px solid var(--color-purple-tint-8)',
                        background: agentMode === m.id ? 'var(--color-white)' : 'transparent',
                      }} />
                      <span>
                        <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', display: 'block' }}>{m.label}</span>
                        <span style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>{m.desc}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10 }}>
                {agentSaved && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-green-deep-3)', animation: 'savedPop 300ms ease both', display: 'flex', alignItems: 'center', gap: 4 }}><Icon name="check_circle" size={14} color="var(--color-green-deep-3)" /> Saved</div>}
                <button onClick={handleSaveAgent} disabled={agentSaving}
                  style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-primary)', border: 'none', borderRadius: 10, padding: '10px 22px', cursor: agentSaving ? 'default' : 'pointer', opacity: agentSaving ? 0.6 : 1 }}>
                  {agentSaving ? 'Saving…' : 'Save changes'}
                </button>
              </div>

              <div style={{ borderTop: '1px solid var(--color-divider)', paddingTop: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <div>
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Activity log</div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 4 }}>What the agent has worked on in this workspace, most recent first.</div>
                  </div>
                  <button
                    onClick={() => void loadAgentRuns(workspace.id)}
                    disabled={agentRunsLoading}
                    title="Refresh"
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-white)', cursor: agentRunsLoading ? 'default' : 'pointer', flexShrink: 0 }}
                  >
                    <Icon name="refresh" size={14} color={agentRunsLoading ? 'var(--color-text-quaternary)' : 'var(--color-text-secondary)'} />
                  </button>
                </div>
                {agentRunsLoading && !agentRunsLoaded && (
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-quaternary)', padding: '10px 0' }}>Loading…</div>
                )}
                {agentRunsLoaded && agentRuns.length === 0 && (
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-quaternary)', padding: '10px 0' }}>No agent activity yet in this workspace.</div>
                )}
                {agentRuns.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
                    {agentRuns.map(r => (
                      <RunRow key={r.id} run={r} expanded={expandedRunId === r.id} onToggle={() => setExpandedRunId(id => (id === r.id ? null : r.id))} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Admin ── */}
          {activeTab === 'admin' && isAdmin && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, animation: 'sectionFadeUp 280ms cubic-bezier(0.22,1,0.36,1) both' }}>
              <div>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Workspace ID</div>
                <div style={{ background: 'var(--color-surface-tint)', border: '1px solid var(--color-border)', borderRadius: 12, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <code style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{workspace.id}</code>
                  <button onClick={copyWorkspaceId} style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 700, color: copiedWorkspaceId ? 'var(--color-success)' : 'var(--color-primary)', background: 'var(--color-white)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '7px 10px', cursor: 'pointer', flexShrink: 0 }}>
                    <Icon name={copiedWorkspaceId ? 'check' : 'content_copy'} size={13} color={copiedWorkspaceId ? 'var(--color-success)' : 'var(--color-primary)'} />
                    {copiedWorkspaceId ? 'Copied' : 'Copy ID'}
                  </button>
                </div>
              </div>
              <div>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Stats</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  {[
                    ['Boards', workspaceLists.length, 'format_list_bulleted'],
                    ['Private boards', workspaceLists.filter(l => !l.isPublic).length, 'lock'],
                    ['Timelines', workspaceTimelines.length, 'timeline'],
                    ['Private timelines', workspaceTimelines.filter(t => !t.isPublic).length, 'lock_clock'],
                  ].map(([label, value, icon]) => (
                    <div key={String(label)} style={{ background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 14, padding: 14 }}>
                      <Icon name={String(icon)} size={16} color="var(--color-primary)" />
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22, fontWeight: 800, color: 'var(--color-text-primary)', marginTop: 8 }}>{value}</div>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{label}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── Trash & Archived ── */}
          {activeTab === 'trash' && (
            <div style={{ animation: 'sectionFadeUp 280ms cubic-bezier(0.22,1,0.36,1) both' }}>
              <div style={{ display: 'flex', gap: 4, background: 'var(--color-surface-tint)', borderRadius: 10, padding: 4, marginBottom: 16 }}>
                {([
                  { id: 'trash' as const, label: 'Trash', icon: 'delete' },
                  { id: 'archived' as const, label: 'Archived', icon: 'archive' },
                ]).map(t => (
                  <button key={t.id} onClick={() => setTrashSubTab(t.id)}
                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '7px 10px', borderRadius: 7, border: 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: trashSubTab === t.id ? 700 : 500, background: trashSubTab === t.id ? 'var(--color-white)' : 'transparent', color: trashSubTab === t.id ? 'var(--color-primary)' : 'var(--color-text-tertiary)', boxShadow: trashSubTab === t.id ? '0 1px 4px rgba(var(--color-black-rgb), 0.08)' : 'none', transition: 'all 150ms' }}>
                    <Icon name={t.icon} size={14} color={trashSubTab === t.id ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                    {t.label}
                  </button>
                ))}
              </div>
              {trashSubTab === 'trash' ? <TrashPanel /> : <ArchivedPanel workspaceId={workspace.id} />}
            </div>
          )}

          {/* ── Danger ── */}
          {activeTab === 'danger' && (
            <div style={{ animation: 'sectionFadeUp 280ms cubic-bezier(0.22,1,0.36,1) both' }}>
              {!canManageWorkspace
                ? <div style={{ padding: '24px', textAlign: 'center', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-body)', fontSize: 13 }}>Only the workspace owner{isAdmin ? '' : ' or an instance admin'} can perform these actions.</div>
                : confirmDelete
                  ? (
                    <div style={{ background: 'var(--color-error-bg-alt)', border: '1.5px solid var(--color-error-bg)', borderRadius: 14, padding: '24px', textAlign: 'center' }}>
                      <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--color-error-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
                        <Icon name="warning" size={24} color="var(--color-error)" />
                      </div>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}>Delete workspace?</div>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.6, marginBottom: 20 }}>
                        This will permanently delete "<strong>{workspace.name}</strong>" and all its lists, folders, and tasks. This cannot be undone.
                      </div>
                      <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                        <button onClick={() => setConfirmDelete(false)} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 10, padding: '10px 20px', cursor: 'pointer' }}>Cancel</button>
                        <button onClick={handleDelete} disabled={deleteLoading}
                          style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-error)', border: 'none', borderRadius: 10, padding: '10px 20px', cursor: deleteLoading ? 'wait' : 'pointer' }}>
                          {deleteLoading ? 'Deleting…' : 'Delete permanently'}
                        </button>
                      </div>
                    </div>
                  )
                  : (
                    <div style={{ background: 'var(--color-error-bg-alt)', border: '1.5px solid var(--color-error-bg)', borderRadius: 14, padding: '20px' }}>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 700, color: 'var(--color-error)', marginBottom: 6 }}>Delete workspace</div>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginBottom: 16 }}>
                        Permanently deletes this workspace and all of its lists, folders, and tasks.
                      </div>
                      <button onClick={() => setConfirmDelete(true)}
                        style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-error)', background: 'var(--color-error-bg)', border: 'none', borderRadius: 10, padding: '10px 20px', cursor: 'pointer' }}>
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
    </>,
    document.body
  );
}
