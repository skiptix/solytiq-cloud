import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import useAuthStore from '../store/useAuthStore';
import useAppStore from '../store/useAppStore';
import { apiGetUsers, apiCreateUser } from '../api/client';
import Icon from '../components/Icon';

interface UserEntry {
  id: string;
  username: string;
  email: string;
  fullName: string | null;
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

function UserAvatar({ name, username, size = 36 }: { name: string | null; username: string; size?: number }) {
  const initials = (name || username || 'U').split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2);
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: 'linear-gradient(135deg, #9d8dff 0%, #5e4dbb 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: size * 0.36, fontWeight: 700, color: '#fff' }}>{initials}</span>
    </div>
  );
}

export default function SettingsScreen() {
  const navigate = useNavigate();
  const { isAdmin, signOut } = useAuthStore();
  const { synced, lastSynced, loadFromApi } = useAppStore();
  const [autoSync, setAutoSync] = useState(true);
  const [nukeStep, setNukeStep] = useState(0);
  const [nukeText, setNukeText] = useState('');
  const [nukePw, setNukePw] = useState('');
  const [syncing, setSyncing] = useState(false);

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

  const syncNow = async () => {
    setSyncing(true);
    await loadFromApi();
    setSyncing(false);
  };

  const friendlyTime = (iso: string | null) => {
    if (!iso) return 'Never';
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  };

  const openAddUser = () => {
    setNewUsername('');
    setNewEmail('');
    setNewPassword('');
    setNewFullName('');
    setCreateError(null);
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
                users.map((u, i) => (
                  <div key={u.id} style={{ ...row, borderBottom: i < users.length - 1 ? '1px solid #f1ecf6' : 'none' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                      <UserAvatar name={u.fullName} username={u.username} size={38} />
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      <div style={{ width: 6, height: 6, borderRadius: '50%', background: u.lastOnline && Date.now() - new Date(u.lastOnline).getTime() < 5 * 60 * 1000 ? '#10B981' : '#e8e4f0', flexShrink: 0 }} />
                      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe', whiteSpace: 'nowrap' }}>
                        {relativeTime(u.lastOnline)}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

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
                <input
                  type="password"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  placeholder="••••••••"
                  style={fi}
                  onFocus={() => setPasswordFocus(true)}
                  onBlur={() => setPasswordFocus(false)}
                  onKeyDown={e => { if (e.key === 'Enter') handleCreateUser(); }}
                />
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
