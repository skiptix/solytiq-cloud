import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import useAuthStore from '../store/useAuthStore';
import { apiGetUsers, apiCreateUser, apiUpdateUser, apiDeleteUser, apiGetSystemStorage, apiGetAppSettings, apiUpdateAppSettings } from '../api/client';
import Icon from '../components/Icon';

interface UserEntry {
  id: string;
  username: string;
  email: string;
  fullName: string | null;
  profileImage: string | null;
  isAdmin: boolean;
  lastOnline: string | null;
  createdAt: string;
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function UserAvatar({ name, username, profileImage, size = 36 }: { name: string | null; username: string; profileImage?: string | null; size?: number }) {
  const initials = (name || username || 'U').split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2);
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: 'linear-gradient(135deg, #9d8dff 0%, #5e4dbb 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
      {profileImage
        ? <img src={profileImage} alt={username} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: size * 0.36, fontWeight: 700, color: '#fff' }}>{initials}</span>
      }
    </div>
  );
}

export default function SettingsScreen() {
  const navigate = useNavigate();
  const { isAdmin, userId } = useAuthStore();
  const [nukeStep, setNukeStep] = useState(0);
  const [nukeText, setNukeText] = useState('');
  const [nukePw, setNukePw] = useState('');

  // Users state
  const [users, setUsers] = useState<UserEntry[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newFullName, setNewFullName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [usernameFocus, setUsernameFocus] = useState(false);
  const [emailFocus, setEmailFocus] = useState(false);
  const [passwordFocus, setPasswordFocus] = useState(false);
  const [fullNameFocus, setFullNameFocus] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [passwordCopied, setPasswordCopied] = useState(false);

  // Edit user state
  const [editUserOpen, setEditUserOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<UserEntry | null>(null);
  const [editUsername, setEditUsername] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editUsernameFocus, setEditUsernameFocus] = useState(false);
  const [editPasswordFocus, setEditPasswordFocus] = useState(false);
  const [editPasswordVisible, setEditPasswordVisible] = useState(false);
  const [editPasswordCopied, setEditPasswordCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Delete user state
  const [deleteTarget, setDeleteTarget] = useState<UserEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  // All users dialog state
  const [allUsersOpen, setAllUsersOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | 'admin' | 'user'>('all');
  const [searchFocus, setSearchFocus] = useState(false);

  // System storage state
  const [storage, setStorage] = useState<{ total: number; used: number; available: number } | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);

  // Storage quota settings
  const [quotaGb, setQuotaGb] = useState('');
  const [quotaInputFocus, setQuotaInputFocus] = useState(false);
  const [quotaSaving, setQuotaSaving] = useState(false);
  const [quotaSaved, setQuotaSaved] = useState(false);

  const loadUsers = useCallback(async () => {
    if (!isAdmin) return;
    setUsersLoading(true);
    try {
      const res = await apiGetUsers();
      setUsers(res.users);
    } catch (e) {
      console.error('failed to load users', e);
    } finally {
      setUsersLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (isAdmin) loadUsers();
  }, [isAdmin, loadUsers]);

  useEffect(() => {
    if (!isAdmin) return;
    setStorageLoading(true);
    apiGetSystemStorage()
      .then(setStorage)
      .catch(() => setStorage(null))
      .finally(() => setStorageLoading(false));
    apiGetAppSettings()
      .then(res => {
        const bytes = parseInt(res.settings['storage_quota_per_user'] ?? '0', 10);
        setQuotaGb(bytes > 0 ? (bytes / (1024 ** 3)).toFixed(0) : '15');
      })
      .catch(() => setQuotaGb('15'));
  }, [isAdmin]);

  const handleSaveQuota = async () => {
    const gb = parseFloat(quotaGb);
    if (!gb || gb <= 0 || isNaN(gb)) return;
    setQuotaSaving(true);
    setQuotaSaved(false);
    try {
      await apiUpdateAppSettings({ storageQuotaPerUser: Math.round(gb * 1024 ** 3) });
      setQuotaSaved(true);
      setTimeout(() => setQuotaSaved(false), 2500);
    } catch (e) {
      console.error('Failed to save quota', e);
    } finally {
      setQuotaSaving(false);
    }
  };

  const generatePassword = () => {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    const pw = Array.from(crypto.getRandomValues(new Uint32Array(16)))
      .map(n => chars[n % chars.length]).join('');
    setNewPassword(pw);
    setPasswordVisible(true);
    setPasswordCopied(false);
  };

  const copyPassword = () => {
    if (!newPassword) return;
    navigator.clipboard.writeText(newPassword).then(() => {
      setPasswordCopied(true);
      setTimeout(() => setPasswordCopied(false), 2000);
    });
  };

  const openEditUser = (u: UserEntry) => {
    setEditTarget(u);
    setEditUsername(u.username);
    setEditPassword('');
    setEditError(null);
    setEditPasswordVisible(false);
    setEditPasswordCopied(false);
    setEditUserOpen(true);
  };

  const closeEditUser = () => {
    setEditUserOpen(false);
    setEditTarget(null);
    setEditError(null);
  };

  const generateEditPassword = () => {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    const pw = Array.from(crypto.getRandomValues(new Uint32Array(16)))
      .map(n => chars[n % chars.length]).join('');
    setEditPassword(pw);
    setEditPasswordVisible(true);
    setEditPasswordCopied(false);
  };

  const copyEditPassword = () => {
    if (!editPassword) return;
    navigator.clipboard.writeText(editPassword).then(() => {
      setEditPasswordCopied(true);
      setTimeout(() => setEditPasswordCopied(false), 2000);
    });
  };

  const handleEditUser = async () => {
    if (!editTarget) return;
    const data: { username?: string; password?: string } = {};
    if (editUsername.trim() && editUsername.trim() !== editTarget.username) data.username = editUsername.trim();
    if (editPassword.trim()) data.password = editPassword.trim();
    if (!data.username && !data.password) {
      setEditError('No changes to save.');
      return;
    }
    setEditing(true);
    setEditError(null);
    try {
      const res = await apiUpdateUser(editTarget.id, data);
      setUsers(prev => prev.map(u => u.id === editTarget.id ? { ...u, username: res.user.username } : u));
      closeEditUser();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      setEditError(msg.includes('taken') || msg.includes('409') ? 'Username already taken.' : 'Failed to update user.');
    } finally {
      setEditing(false);
    }
  };

  const handleDeleteUser = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiDeleteUser(deleteTarget.id);
      setUsers(prev => prev.filter(u => u.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (e) {
      console.error('delete user failed', e);
    } finally {
      setDeleting(false);
    }
  };

  const openAddUser = () => {
    setNewUsername('');
    setNewEmail('');
    setNewPassword('');
    setNewFullName('');
    setCreateError(null);
    setPasswordVisible(false);
    setPasswordCopied(false);
    setAddUserOpen(true);
  };

  const closeAddUser = () => {
    setAddUserOpen(false);
    setCreateError(null);
  };

  const handleCreateUser = async () => {
    if (!newUsername.trim() || !newPassword.trim()) {
      setCreateError('Username and password are required.');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const res = await apiCreateUser({
        username: newUsername.trim(),
        password: newPassword.trim(),
        email: newEmail.trim() || undefined,
        fullName: newFullName.trim() || undefined,
      });
      setUsers(prev => [...prev, res.user]);
      closeAddUser();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      setCreateError(msg.includes('taken') || msg.includes('409') ? 'Username or email already taken.' : 'Failed to create user. Try again.');
    } finally {
      setCreating(false);
    }
  };

  const PREVIEW_COUNT = 5;
  const previewUsers = users.slice(0, PREVIEW_COUNT);
  const hasMore = users.length > PREVIEW_COUNT;
  const filteredUsers = users.filter(u => {
    const q = searchQuery.toLowerCase();
    const matchesSearch = !q ||
      u.username.toLowerCase().includes(q) ||
      (u.fullName ?? '').toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q);
    const matchesRole = roleFilter === 'all' ||
      (roleFilter === 'admin' && u.isAdmin) ||
      (roleFilter === 'user' && !u.isAdmin);
    return matchesSearch && matchesRole;
  });

  const sectionLabel = (text: string, action?: React.ReactNode) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, paddingLeft: 4 }}>
      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: '#b0acbe' }}>{text}</div>
      {action}
    </div>
  );
  const card = { background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 14, overflow: 'hidden' as const };
  const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between' as const, gap: 12, padding: '14px 18px' };
  const fi = { width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#1c1b22', background: 'transparent', border: 'none', outline: 'none', padding: '6px 0' };

  return (
    <div style={{ flex: 1, height: '100%', overflowY: 'auto' }}>
      <div style={{ maxWidth: 680, margin: '0 auto', padding: '32px 32px 48px', display: 'flex', flexDirection: 'column', gap: 28, width: '100%' }}>
        <h1 style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 28, fontWeight: 700, color: '#1c1b22', letterSpacing: '-0.02em' }}>Settings</h1>

        {/* Users — admin only */}
        {isAdmin && (
          <div>
            {sectionLabel('Users',
              <button
                onClick={openAddUser}
                style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', border: 'none', borderRadius: 8, padding: '5px 12px', cursor: 'pointer', transition: 'background 150ms' }}
                onMouseEnter={e => { e.currentTarget.style.background = '#ede9ff'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#F5F3FF'; }}
              >
                <Icon name="person_add" size={14} color="#5e4dbb" />
                Add User
              </button>
            )}
            <div style={card}>
              {usersLoading ? (
                <div style={{ ...row, justifyContent: 'center' }}>
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>Loading users…</div>
                </div>
              ) : users.length === 0 ? (
                <div style={{ ...row, justifyContent: 'center' }}>
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>No users yet.</div>
                </div>
              ) : (
                <>
                {previewUsers.map((u, i) => (
                  <div key={u.id} style={{ ...row, borderBottom: i < previewUsers.length - 1 || hasMore ? '1px solid #f1ecf6' : 'none' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                      <UserAvatar name={u.fullName} username={u.username} profileImage={u.profileImage} size={38} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {u.fullName || u.username}
                          </div>
                          {u.isAdmin && (
                            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 700, color: '#5e4dbb', background: '#F5F3FF', borderRadius: 9999, padding: '1px 7px', textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>Admin</span>
                          )}
                        </div>
                        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          @{u.username} · {u.email}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: u.lastOnline && Date.now() - new Date(u.lastOnline).getTime() < 5 * 60 * 1000 ? '#10B981' : '#e8e4f0', flexShrink: 0 }} />
                        <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe', whiteSpace: 'nowrap' }}>
                          {relativeTime(u.lastOnline)}
                        </span>
                      </div>
                      <button
                        onClick={() => openEditUser(u)}
                        title="Edit user"
                        style={{ width: 28, height: 28, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 120ms' }}
                        onMouseEnter={e => { e.currentTarget.style.background = '#F5F3FF'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                      >
                        <Icon name="edit" size={15} color="#787584" />
                      </button>
                      {u.id !== userId && (
                        <button
                          onClick={() => setDeleteTarget(u)}
                          title="Remove user"
                          style={{ width: 28, height: 28, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 120ms' }}
                          onMouseEnter={e => { e.currentTarget.style.background = '#fff5f5'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                        >
                          <Icon name="delete" size={15} color="#ba1a1a" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {hasMore && (
                  <button
                    onClick={() => { setSearchQuery(''); setRoleFilter('all'); setAllUsersOpen(true); }}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '12px 18px', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#5e4dbb', transition: 'background 150ms' }}
                    onMouseEnter={e => { e.currentTarget.style.background = '#F5F3FF'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <Icon name="group" size={15} color="#5e4dbb" />
                    Show all {users.length} users
                  </button>
                )}
                </>
              )}
            </div>
          </div>
        )}

        {/* System — admin only */}
        {isAdmin && (
          <div>
            {sectionLabel('System')}
            <div style={card}>
              {storageLoading ? (
                <div style={{ ...row, justifyContent: 'center' }}>
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>Loading…</div>
                </div>
              ) : storage === null ? (
                <div style={{ ...row, justifyContent: 'center' }}>
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>Unable to read disk usage.</div>
                </div>
              ) : (() => {
                const fmt = (b: number) => {
                  if (b >= 1e12) return `${(b / 1e12).toFixed(1)} TB`;
                  if (b >= 1e9)  return `${(b / 1e9).toFixed(1)} GB`;
                  return `${(b / 1e6).toFixed(1)} MB`;
                };
                const pct = Math.round((storage.used / storage.total) * 100);
                const barColor = pct >= 90 ? '#ba1a1a' : pct >= 70 ? '#d97706' : '#5e4dbb';
                return (
                  <div style={{ padding: '18px 18px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22' }}>Disk Storage</div>
                      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, fontWeight: 600, color: barColor, background: pct >= 90 ? '#ffdad6' : pct >= 70 ? '#fef3c7' : '#F5F3FF', borderRadius: 9999, padding: '2px 9px' }}>{pct}% used</span>
                    </div>
                    <div style={{ background: '#E5E7EB', borderRadius: 99, height: 8, overflow: 'hidden', marginBottom: 12 }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: 99, transition: 'width 600ms ease' }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', gap: 20 }}>
                        <div>
                          <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Used</div>
                          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22' }}>{fmt(storage.used)}</div>
                        </div>
                        <div>
                          <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Available</div>
                          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22' }}>{fmt(storage.available)}</div>
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Total</div>
                        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22' }}>{fmt(storage.total)}</div>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* Storage quota — admin only */}
        {isAdmin && (
          <div>
            {sectionLabel('User Storage Quota')}
            <div style={card}>
              <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                  <div>
                    <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22' }}>Storage limit per user</div>
                    <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2 }}>Admins are exempt and always have unlimited storage.</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', background: '#fff', border: `1.5px solid ${quotaInputFocus ? '#5e4dbb' : '#E5E7EB'}`, borderRadius: 10, overflow: 'hidden', transition: 'border-color 200ms' }}>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={quotaGb}
                        onChange={e => { setQuotaGb(e.target.value); setQuotaSaved(false); }}
                        onFocus={() => setQuotaInputFocus(true)}
                        onBlur={() => setQuotaInputFocus(false)}
                        onKeyDown={e => { if (e.key === 'Enter') handleSaveQuota(); }}
                        style={{ width: 64, fontFamily: 'Inter, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22', background: 'transparent', border: 'none', outline: 'none', padding: '8px 10px', textAlign: 'right' }}
                      />
                      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', paddingRight: 10, paddingLeft: 2, userSelect: 'none' }}>GB</span>
                    </div>
                    <button
                      onClick={handleSaveQuota}
                      disabled={quotaSaving || !quotaGb || parseFloat(quotaGb) <= 0}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: quotaSaved ? '#10B981' : '#fff', background: quotaSaved ? 'rgba(16,185,129,0.12)' : quotaSaving || !quotaGb || parseFloat(quotaGb) <= 0 ? '#c9c4d5' : '#5e4dbb', border: quotaSaved ? '1.5px solid rgba(16,185,129,0.3)' : 'none', borderRadius: 10, padding: '8px 14px', cursor: quotaSaving || !quotaGb || parseFloat(quotaGb) <= 0 ? 'not-allowed' : 'pointer', transition: 'all 150ms', whiteSpace: 'nowrap' }}
                      onMouseEnter={e => { if (!quotaSaving && !quotaSaved && quotaGb && parseFloat(quotaGb) > 0) e.currentTarget.style.background = '#4f3fa8'; }}
                      onMouseLeave={e => { if (!quotaSaving && !quotaSaved) e.currentTarget.style.background = '#5e4dbb'; }}
                    >
                      <Icon name={quotaSaved ? 'check' : 'save'} size={14} color={quotaSaved ? '#10B981' : '#fff'} />
                      {quotaSaved ? 'Saved' : quotaSaving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Danger Zone — admin only */}
        {isAdmin && <div>
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
        </div>}
      </div>

      {/* All Users Dialog */}
      {allUsersOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) setAllUsersOpen(false); }}
        >
          <div
            style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 580, maxHeight: '82vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ padding: '22px 24px 0', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="group" size={18} color="#5e4dbb" />
                  </div>
                  <div>
                    <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22' }}>All Users</div>
                    <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584' }}>{users.length} {users.length === 1 ? 'user' : 'users'} total</div>
                  </div>
                </div>
                <button
                  onClick={() => setAllUsersOpen(false)}
                  style={{ width: 30, height: 30, borderRadius: '50%', background: '#f1ecf6', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#e8e4f0'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = '#f1ecf6'; }}
                >
                  <Icon name="close" size={15} color="#484552" />
                </button>
              </div>

              {/* Search */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#F9FAFB', border: `1.5px solid ${searchFocus ? '#5e4dbb' : '#E5E7EB'}`, borderRadius: 10, padding: '8px 14px', marginBottom: 14, transition: 'border-color 200ms' }}>
                <Icon name="search" size={16} color="#b0acbe" />
                <input
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search by name, username or email…"
                  style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#1c1b22', background: 'transparent', border: 'none', outline: 'none' }}
                  onFocus={() => setSearchFocus(true)}
                  onBlur={() => setSearchFocus(false)}
                  autoFocus
                />
                {searchQuery && (
                  <button onClick={() => setSearchQuery('')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
                    <Icon name="close" size={14} color="#b0acbe" />
                  </button>
                )}
              </div>

              {/* Role filter */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
                {(['all', 'admin', 'user'] as const).map(f => (
                  <button
                    key={f}
                    onClick={() => setRoleFilter(f)}
                    style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, padding: '5px 14px', borderRadius: 9999, border: 'none', cursor: 'pointer', transition: 'all 150ms', background: roleFilter === f ? '#5e4dbb' : '#F5F3FF', color: roleFilter === f ? '#fff' : '#5e4dbb' }}
                    onMouseEnter={e => { if (roleFilter !== f) e.currentTarget.style.background = '#ede9ff'; }}
                    onMouseLeave={e => { if (roleFilter !== f) e.currentTarget.style.background = '#F5F3FF'; }}
                  >
                    {f === 'all' ? `All (${users.length})` : f === 'admin' ? `Admins (${users.filter(u => u.isAdmin).length})` : `Users (${users.filter(u => !u.isAdmin).length})`}
                  </button>
                ))}
              </div>
            </div>

            {/* Scrollable list */}
            <div style={{ overflowY: 'auto', flex: 1, borderTop: '1px solid #f1ecf6' }}>
              {filteredUsers.length === 0 ? (
                <div style={{ padding: '32px 24px', textAlign: 'center', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>
                  No users match your search.
                </div>
              ) : (
                filteredUsers.map((u, i) => (
                  <div key={u.id} style={{ ...row, borderBottom: i < filteredUsers.length - 1 ? '1px solid #f1ecf6' : 'none', padding: '12px 24px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                      <UserAvatar name={u.fullName} username={u.username} profileImage={u.profileImage} size={38} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {u.fullName || u.username}
                          </div>
                          {u.isAdmin && (
                            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 700, color: '#5e4dbb', background: '#F5F3FF', borderRadius: 9999, padding: '1px 7px', textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>Admin</span>
                          )}
                        </div>
                        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          @{u.username} · {u.email}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: u.lastOnline && Date.now() - new Date(u.lastOnline).getTime() < 5 * 60 * 1000 ? '#10B981' : '#e8e4f0', flexShrink: 0 }} />
                        <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe', whiteSpace: 'nowrap' }}>
                          {relativeTime(u.lastOnline)}
                        </span>
                      </div>
                      <button
                        onClick={() => { setAllUsersOpen(false); openEditUser(u); }}
                        title="Edit user"
                        style={{ width: 28, height: 28, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 120ms' }}
                        onMouseEnter={e => { e.currentTarget.style.background = '#F5F3FF'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                      >
                        <Icon name="edit" size={15} color="#787584" />
                      </button>
                      {u.id !== userId && (
                        <button
                          onClick={() => { setAllUsersOpen(false); setDeleteTarget(u); }}
                          title="Remove user"
                          style={{ width: 28, height: 28, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 120ms' }}
                          onMouseEnter={e => { e.currentTarget.style.background = '#fff5f5'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                        >
                          <Icon name="delete" size={15} color="#ba1a1a" />
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Add User Modal */}
      {addUserOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) closeAddUser(); }}
        >
          <div
            style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 420, boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '22px 24px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="person_add" size={18} color="#5e4dbb" />
                </div>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22' }}>Add New User</div>
              </div>
              <button
                onClick={closeAddUser}
                style={{ width: 30, height: 30, borderRadius: '50%', background: '#f1ecf6', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={e => { e.currentTarget.style.background = '#e8e4f0'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#f1ecf6'; }}
              >
                <Icon name="close" size={15} color="#484552" />
              </button>
            </div>

            {/* Fields */}
            <div style={{ padding: '20px 24px' }}>
              {/* Full Name */}
              <div style={{ borderBottom: `${fullNameFocus ? 2 : 1}px solid ${fullNameFocus ? '#5e4dbb' : '#e8e4f0'}`, paddingBottom: 10, marginBottom: 16, transition: 'border-color 200ms' }}>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Full Name</div>
                <input
                  value={newFullName}
                  onChange={e => setNewFullName(e.target.value)}
                  placeholder="Jane Doe"
                  style={fi}
                  onFocus={() => setFullNameFocus(true)}
                  onBlur={() => setFullNameFocus(false)}
                />
              </div>
              {/* Username */}
              <div style={{ borderBottom: `${usernameFocus ? 2 : 1}px solid ${usernameFocus ? '#5e4dbb' : '#e8e4f0'}`, paddingBottom: 10, marginBottom: 16, transition: 'border-color 200ms' }}>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Username <span style={{ color: '#ba1a1a' }}>*</span></div>
                <input
                  value={newUsername}
                  onChange={e => setNewUsername(e.target.value)}
                  placeholder="janedoe"
                  style={fi}
                  onFocus={() => setUsernameFocus(true)}
                  onBlur={() => setUsernameFocus(false)}
                />
              </div>
              {/* Email */}
              <div style={{ borderBottom: `${emailFocus ? 2 : 1}px solid ${emailFocus ? '#5e4dbb' : '#e8e4f0'}`, paddingBottom: 10, marginBottom: 16, transition: 'border-color 200ms' }}>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Email</div>
                <input
                  type="email"
                  value={newEmail}
                  onChange={e => setNewEmail(e.target.value)}
                  placeholder="jane@example.com"
                  style={fi}
                  onFocus={() => setEmailFocus(true)}
                  onBlur={() => setEmailFocus(false)}
                />
              </div>
              {/* Password */}
              <div style={{ borderBottom: `${passwordFocus ? 2 : 1}px solid ${passwordFocus ? '#5e4dbb' : '#e8e4f0'}`, paddingBottom: 10, marginBottom: 20, transition: 'border-color 200ms' }}>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Password <span style={{ color: '#ba1a1a' }}>*</span></div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type={passwordVisible ? 'text' : 'password'}
                    value={newPassword}
                    onChange={e => { setNewPassword(e.target.value); setPasswordCopied(false); }}
                    placeholder="••••••••"
                    style={{ ...fi, flex: 1 }}
                    onFocus={() => setPasswordFocus(true)}
                    onBlur={() => setPasswordFocus(false)}
                    onKeyDown={e => { if (e.key === 'Enter') handleCreateUser(); }}
                  />
                  {/* Generate random password */}
                  <button
                    type="button"
                    onClick={generatePassword}
                    title="Generate random password"
                    style={{ width: 28, height: 28, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 120ms' }}
                    onMouseEnter={e => { e.currentTarget.style.background = '#F5F3FF'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <Icon name="casino" size={16} color="#787584" />
                  </button>
                  {/* Copy to clipboard */}
                  <button
                    type="button"
                    onClick={copyPassword}
                    disabled={!newPassword}
                    title={passwordCopied ? 'Copied!' : 'Copy password'}
                    style={{ width: 28, height: 28, borderRadius: 7, background: passwordCopied ? 'rgba(16,185,129,0.10)' : 'transparent', border: 'none', cursor: newPassword ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 120ms' }}
                    onMouseEnter={e => { if (newPassword && !passwordCopied) e.currentTarget.style.background = '#F5F3FF'; }}
                    onMouseLeave={e => { if (!passwordCopied) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <Icon name={passwordCopied ? 'check' : 'content_copy'} size={15} color={passwordCopied ? '#10B981' : newPassword ? '#787584' : '#e8e4f0'} />
                  </button>
                </div>
              </div>

              {createError && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, padding: '10px 14px', background: '#fff5f5', borderRadius: 8, border: '1px solid #ffdad6' }}>
                  <Icon name="error" size={15} color="#ba1a1a" />
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a' }}>{createError}</span>
                </div>
              )}

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={closeAddUser}
                  style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: '#f1ecf6', border: 'none', borderRadius: 8, padding: '11px 0', cursor: 'pointer' }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#e8e4f0'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = '#f1ecf6'; }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateUser}
                  disabled={creating || !newUsername.trim() || !newPassword.trim()}
                  style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: creating || !newUsername.trim() || !newPassword.trim() ? '#c9c4d5' : '#5e4dbb', border: 'none', borderRadius: 8, padding: '11px 0', cursor: creating || !newUsername.trim() || !newPassword.trim() ? 'not-allowed' : 'pointer', transition: 'background 150ms' }}
                  onMouseEnter={e => { if (!creating && newUsername.trim() && newPassword.trim()) e.currentTarget.style.background = '#4d3da8'; }}
                  onMouseLeave={e => { if (!creating && newUsername.trim() && newPassword.trim()) e.currentTarget.style.background = '#5e4dbb'; }}
                >
                  {creating ? 'Creating…' : 'Create User'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit User Modal */}
      {editUserOpen && editTarget && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) closeEditUser(); }}
        >
          <div
            style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 420, boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '22px 24px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="edit" size={18} color="#5e4dbb" />
                </div>
                <div>
                  <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22' }}>Edit User</div>
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584' }}>@{editTarget.username}</div>
                </div>
              </div>
              <button
                onClick={closeEditUser}
                style={{ width: 30, height: 30, borderRadius: '50%', background: '#f1ecf6', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={e => { e.currentTarget.style.background = '#e8e4f0'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#f1ecf6'; }}
              >
                <Icon name="close" size={15} color="#484552" />
              </button>
            </div>

            <div style={{ padding: '20px 24px' }}>
              {/* Username */}
              <div style={{ borderBottom: `${editUsernameFocus ? 2 : 1}px solid ${editUsernameFocus ? '#5e4dbb' : '#e8e4f0'}`, paddingBottom: 10, marginBottom: 16, transition: 'border-color 200ms' }}>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Username</div>
                <input
                  value={editUsername}
                  onChange={e => setEditUsername(e.target.value)}
                  placeholder={editTarget.username}
                  style={fi}
                  onFocus={() => setEditUsernameFocus(true)}
                  onBlur={() => setEditUsernameFocus(false)}
                />
              </div>
              {/* New Password */}
              <div style={{ borderBottom: `${editPasswordFocus ? 2 : 1}px solid ${editPasswordFocus ? '#5e4dbb' : '#e8e4f0'}`, paddingBottom: 10, marginBottom: 20, transition: 'border-color 200ms' }}>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>New Password <span style={{ color: '#b0acbe', fontWeight: 400 }}>(optional)</span></div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type={editPasswordVisible ? 'text' : 'password'}
                    value={editPassword}
                    onChange={e => { setEditPassword(e.target.value); setEditPasswordCopied(false); }}
                    placeholder="Leave blank to keep current"
                    style={{ ...fi, flex: 1 }}
                    onFocus={() => setEditPasswordFocus(true)}
                    onBlur={() => setEditPasswordFocus(false)}
                    onKeyDown={e => { if (e.key === 'Enter') handleEditUser(); }}
                  />
                  <button
                    type="button"
                    onClick={generateEditPassword}
                    title="Generate random password"
                    style={{ width: 28, height: 28, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 120ms' }}
                    onMouseEnter={e => { e.currentTarget.style.background = '#F5F3FF'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <Icon name="casino" size={16} color="#787584" />
                  </button>
                  <button
                    type="button"
                    onClick={copyEditPassword}
                    disabled={!editPassword}
                    title={editPasswordCopied ? 'Copied!' : 'Copy password'}
                    style={{ width: 28, height: 28, borderRadius: 7, background: editPasswordCopied ? 'rgba(16,185,129,0.10)' : 'transparent', border: 'none', cursor: editPassword ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 120ms' }}
                    onMouseEnter={e => { if (editPassword && !editPasswordCopied) e.currentTarget.style.background = '#F5F3FF'; }}
                    onMouseLeave={e => { if (!editPasswordCopied) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <Icon name={editPasswordCopied ? 'check' : 'content_copy'} size={15} color={editPasswordCopied ? '#10B981' : editPassword ? '#787584' : '#e8e4f0'} />
                  </button>
                </div>
              </div>

              {editError && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, padding: '10px 14px', background: '#fff5f5', borderRadius: 8, border: '1px solid #ffdad6' }}>
                  <Icon name="error" size={15} color="#ba1a1a" />
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a' }}>{editError}</span>
                </div>
              )}

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={closeEditUser}
                  style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: '#f1ecf6', border: 'none', borderRadius: 8, padding: '11px 0', cursor: 'pointer' }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#e8e4f0'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = '#f1ecf6'; }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleEditUser}
                  disabled={editing}
                  style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: editing ? '#c9c4d5' : '#5e4dbb', border: 'none', borderRadius: 8, padding: '11px 0', cursor: editing ? 'not-allowed' : 'pointer', transition: 'background 150ms' }}
                  onMouseEnter={e => { if (!editing) e.currentTarget.style.background = '#4d3da8'; }}
                  onMouseLeave={e => { if (!editing) e.currentTarget.style.background = '#5e4dbb'; }}
                >
                  {editing ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete User Confirmation Modal */}
      {deleteTarget && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) setDeleteTarget(null); }}
        >
          <div
            style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 380, padding: '28px 28px 24px', boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ width: 48, height: 48, borderRadius: '50%', background: '#ffdad6', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Icon name="person_remove" size={24} color="#ba1a1a" />
            </div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 18, fontWeight: 700, color: '#1c1b22', marginBottom: 8 }}>Remove user?</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', lineHeight: 1.6, marginBottom: 24 }}>
              <span style={{ fontWeight: 600, color: '#1c1b22' }}>@{deleteTarget.username}</span> will be permanently deleted along with all their data. This cannot be undone.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setDeleteTarget(null)}
                style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: '#f1ecf6', border: 'none', borderRadius: 8, padding: '11px 0', cursor: 'pointer' }}
                onMouseEnter={e => { e.currentTarget.style.background = '#e8e4f0'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#f1ecf6'; }}
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteUser}
                disabled={deleting}
                style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: deleting ? '#c9c4d5' : '#ba1a1a', border: 'none', borderRadius: 8, padding: '11px 0', cursor: deleting ? 'not-allowed' : 'pointer', transition: 'background 150ms' }}
                onMouseEnter={e => { if (!deleting) e.currentTarget.style.background = '#991212'; }}
                onMouseLeave={e => { if (!deleting) e.currentTarget.style.background = '#ba1a1a'; }}
              >
                {deleting ? 'Removing…' : 'Remove User'}
              </button>
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
                  <button onClick={() => { setNukeStep(0); navigate('/nuke', { state: { password: nukePw } }); }} style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#ba1a1a', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer' }}>Nuke Everything</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
