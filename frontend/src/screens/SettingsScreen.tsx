import { usePageTitle } from "../hooks/usePageTitle";
import { useState, useEffect, useCallback } from 'react';
import { useMobile } from '../hooks/useBreakpoint';
import { useNavigate } from 'react-router-dom';
import useAuthStore from '../store/useAuthStore';
import useAIStore from '../store/useAIStore';
import { apiGetUsers, apiCreateUser, apiUpdateUser, apiDeleteUser, apiGetSystemStorage, apiGetAppSettings, apiUpdateAppSettings, apiUpdateAppSettingsAI, apiGetAISettings, apiUpdateFeatureFlags, apiUpdateAppSettingsMcp, apiGetAIUsage, apiGetAdminReadApiKeys, apiRevokeAdminReadApiKey, type AdminReadApiKey, type AIUsageDay, type AIUsageModel, type AIUsageTotals } from '../api/client';
import Icon from '../components/Icon';
import AdminApiKeyWizard from '../modals/AdminApiKeyWizard';
import { featureForScope } from '../modals/adminApiFeatures';

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

type TabId = 'system' | 'ai' | 'security' | 'api' | 'users' | 'danger';

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

const MODEL_PRICING: Record<string, { input: number; output: number; label: string; color: string }> = {
  'openai/gpt-4o-mini':                 { input: 0.15,  output: 0.60,  label: 'GPT-4o Mini',           color: '#10a37f' },
  'openai/gpt-4o':                      { input: 2.50,  output: 10.00, label: 'GPT-4o',                color: '#4d9e80' },
  'anthropic/claude-3-5-haiku':         { input: 0.80,  output: 4.00,  label: 'Claude 3.5 Haiku',      color: '#d4691e' },
  'anthropic/claude-3-5-sonnet':        { input: 3.00,  output: 15.00, label: 'Claude 3.5 Sonnet',     color: '#cc785c' },
  'anthropic/claude-3.7-sonnet':        { input: 3.00,  output: 15.00, label: 'Claude 3.7 Sonnet',     color: '#cc785c' },
  'google/gemini-flash-1.5':            { input: 0.075, output: 0.30,  label: 'Gemini Flash 1.5',      color: '#4285f4' },
  'google/gemini-2.5-flash':            { input: 0.15,  output: 0.60,  label: 'Gemini 2.5 Flash',      color: '#4285f4' },
  'google/gemini-2.5-pro':              { input: 1.25,  output: 10.00, label: 'Gemini 2.5 Pro',        color: '#4285f4' },
  'meta-llama/llama-3.3-70b-instruct':  { input: 0.12,  output: 0.30,  label: 'Llama 3.3 70B',        color: '#0064e0' },
};

function calcCost(model: string, promptTokens: number, completionTokens: number): number {
  const p = MODEL_PRICING[model];
  if (!p) return (promptTokens * 0.15 + completionTokens * 0.60) / 1_000_000;
  return (promptTokens * p.input + completionTokens * p.output) / 1_000_000;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtCost(usd: number): string {
  if (usd < 0.0001) return '$0.00';
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export default function SettingsScreen() {
  usePageTitle("Settings");
  const navigate = useNavigate();
  const { isAdmin, userId } = useAuthStore();
  const isMobile = useMobile();
  const [activeTab, setActiveTab] = useState<TabId>('system');
  const [nukeStep, setNukeStep] = useState(0);
  const [nukeText, setNukeText] = useState('');
  const [nukePw, setNukePw] = useState('');


  // Admin API keys
  const [apiKeys, setApiKeys] = useState<AdminReadApiKey[]>([]);
  const [apiKeysLoading, setApiKeysLoading] = useState(false);
  const [showApiKeyWizard, setShowApiKeyWizard] = useState(false);

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
  const [copiedUserId, setCopiedUserId] = useState<string | null>(null);

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
  const [systemSaving, setSystemSaving] = useState(false);
  const [systemSaved, setSystemSaved] = useState(false);

  // AI assistant settings
  const { setSettings: setAISettings } = useAIStore();
  const [aiEnabled, setAiEnabled] = useState(true);
  const [aiModel, setAiModel] = useState('openai/gpt-4o-mini');
  const [aiSaving, setAiSaving] = useState(false);
  const [aiSaved, setAiSaved] = useState(false);
  const [aiLoaded, setAiLoaded] = useState(false);

  // AI usage analytics
  const [usage, setUsage] = useState<{ daily: AIUsageDay[]; byModel: AIUsageModel[]; totals: AIUsageTotals } | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [hoveredBar, setHoveredBar] = useState<{ x: number; y: number; date: string; total: number; prompt: number; completion: number } | null>(null);

  // Security / 2FA feature flag
  const [twoFAFeatureEnabled, setTwoFAFeatureEnabled] = useState(true);
  const [securitySaving, setSecuritySaving] = useState(false);
  const [securitySaved, setSecuritySaved] = useState(false);

  // MCP enable/disable
  const [mcpEnabled, setMcpEnabled] = useState(true);
  const [mcpSaving, setMcpSaving] = useState(false);
  const [showMcpDisableConfirm, setShowMcpDisableConfirm] = useState(false);

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
        setTwoFAFeatureEnabled(res.settings['two_fa_feature_enabled'] !== 'false');
        setMcpEnabled(res.settings['mcp_enabled'] !== 'false');
      })
      .catch(() => setQuotaGb('15'));
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin || aiLoaded) return;
    apiGetAISettings()
      .then(res => {
        setAiEnabled(res.enabled);
        setAiModel(res.model);
        setAiLoaded(true);
      })
      .catch(() => setAiLoaded(true));
  }, [isAdmin, aiLoaded]);

  useEffect(() => {
    if (activeTab !== 'ai' || !isAdmin) return;
    setUsageLoading(true);
    apiGetAIUsage()
      .then(setUsage)
      .catch(() => {})
      .finally(() => setUsageLoading(false));
  }, [activeTab, isAdmin]);


  useEffect(() => {
    if (activeTab !== 'api' || !isAdmin) return;
    setApiKeysLoading(true);
    apiGetAdminReadApiKeys()
      .then(res => setApiKeys(res.keys))
      .catch(() => setApiKeys([]))
      .finally(() => setApiKeysLoading(false));
  }, [activeTab, isAdmin]);

  const apiOrigin = `${window.location.origin}/api/admin-read`;
  const exportExample = `curl -H "Authorization: Bearer <ADMIN_API_KEY>" \\\n  "${apiOrigin}/export?workspaceId=<workspace-id>&userId=<user-id>"`;
  const writeExample = `curl -X POST "${apiOrigin}/lists" \\\n  -H "Authorization: Bearer <ADMIN_API_KEY>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"ownerId":"<user-id>","name":"Roadmap","emoji":"🗺️"}'`;

  const handleRevokeApiKey = async (id: string) => {
    await apiRevokeAdminReadApiKey(id);
    setApiKeys(prev => prev.filter(k => k.id !== id));
  };

  const handleSaveSystem = async () => {
    const gb = parseFloat(quotaGb);
    if (!gb || gb <= 0 || isNaN(gb)) return;
    setSystemSaving(true);
    setSystemSaved(false);
    try {
      await apiUpdateAppSettings({ storageQuotaPerUser: Math.round(gb * 1024 ** 3) });
      setSystemSaved(true);
      setTimeout(() => setSystemSaved(false), 2500);
    } catch (e) {
      console.error('Failed to save system settings', e);
    } finally {
      setSystemSaving(false);
    }
  };

  const handleSaveAI = async () => {
    setAiSaving(true);
    setAiSaved(false);
    try {
      await apiUpdateAppSettingsAI({ aiAssistantEnabled: aiEnabled, aiModel });
      setAISettings({ enabled: aiEnabled, model: aiModel });
      setAiSaved(true);
      setTimeout(() => setAiSaved(false), 2500);
    } catch (e) {
      console.error('Failed to save AI settings', e);
    } finally {
      setAiSaving(false);
    }
  };

  const handleSaveSecurity = async () => {
    setSecuritySaving(true);
    setSecuritySaved(false);
    try {
      await apiUpdateFeatureFlags({ twoFAFeatureEnabled });
      setSecuritySaved(true);
      setTimeout(() => setSecuritySaved(false), 2500);
    } catch {
      // Rollback: re-fetch actual state
      apiGetAppSettings()
        .then(res => setTwoFAFeatureEnabled(res.settings['two_fa_feature_enabled'] !== 'false'))
        .catch(() => {});
    } finally {
      setSecuritySaving(false);
    }
  };

  const handleToggleMcp = (newValue: boolean) => {
    if (!newValue) {
      // Disabling: show confirmation dialog first
      setShowMcpDisableConfirm(true);
    } else {
      // Enabling: no confirmation needed
      setMcpSaving(true);
      setMcpEnabled(true);
      apiUpdateAppSettingsMcp(true)
        .catch(() => setMcpEnabled(false))
        .finally(() => setMcpSaving(false));
    }
  };

  const handleConfirmDisableMcp = async () => {
    setMcpSaving(true);
    setShowMcpDisableConfirm(false);
    try {
      await apiUpdateAppSettingsMcp(false);
      setMcpEnabled(false);
    } catch {
      // Revert on error
      setMcpEnabled(true);
    } finally {
      setMcpSaving(false);
    }
  };

  const AI_MODELS: { value: string; label: string; sub: string; badge?: string; badgeColor?: string }[] = [
    { value: 'google/gemini-2.5-flash',            label: 'Gemini 2.5 Flash',    sub: 'Fast · Excellent tool use',         badge: 'Best Value',   badgeColor: '#1a8a4a' },
    { value: 'anthropic/claude-3.7-sonnet',        label: 'Claude 3.7 Sonnet',   sub: 'Best for AI tasks · Expensive',     badge: 'Recommended',  badgeColor: '#5e4dbb' },
    { value: 'openai/gpt-4o-mini',                 label: 'GPT-4o Mini',         sub: 'Fast · Affordable' },
    { value: 'anthropic/claude-3-5-haiku',         label: 'Claude 3.5 Haiku',    sub: 'Smart · Good value' },
    { value: 'google/gemini-2.5-pro',              label: 'Gemini 2.5 Pro',      sub: 'Most capable Gemini · Slower' },
    { value: 'openai/gpt-4o',                      label: 'GPT-4o',              sub: 'Powerful · Higher cost' },
    { value: 'anthropic/claude-3-5-sonnet',        label: 'Claude 3.5 Sonnet',   sub: 'Very smart · Expensive' },
    { value: 'google/gemini-flash-1.5',            label: 'Gemini Flash 1.5',    sub: 'Fast · Older model' },
    { value: 'meta-llama/llama-3.3-70b-instruct',  label: 'Llama 3.3 70B',       sub: 'Open-source · Free on some tiers' },
  ];

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


  const copyUserId = (id: string) => {
    if (!isAdmin) return;
    navigator.clipboard.writeText(id).then(() => {
      setCopiedUserId(id);
      setTimeout(() => setCopiedUserId(current => current === id ? null : current), 2000);
    });
  };


  const renderUserIdCopy = (id: string) => !isAdmin ? null : (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, minWidth: 0 }}>
      <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, color: '#787584', background: '#F5F3FF', borderRadius: 6, padding: '2px 6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>ID: {id}</code>
      <button
        onClick={() => copyUserId(id)}
        title="Copy user ID"
        style={{ display: 'flex', alignItems: 'center', gap: 3, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 700, color: copiedUserId === id ? '#10B981' : '#5e4dbb', background: copiedUserId === id ? 'rgba(16,185,129,0.10)' : '#F5F3FF', border: 'none', borderRadius: 6, padding: '3px 7px', cursor: 'pointer', flexShrink: 0 }}
      >
        <Icon name={copiedUserId === id ? 'check' : 'content_copy'} size={12} color={copiedUserId === id ? '#10B981' : '#5e4dbb'} />
        {copiedUserId === id ? 'Copied' : 'Copy ID'}
      </button>
    </div>
  );

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

  const card = { background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 14, overflow: 'hidden' as const };
  const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between' as const, gap: 12, padding: '14px 18px' };
  const fi = { width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#1c1b22', background: 'transparent', border: 'none', outline: 'none', padding: '6px 0' };

  const sectionLabel = (text: string, action?: React.ReactNode) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, paddingLeft: 4 }}>
      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: '#b0acbe' }}>{text}</div>
      {action}
    </div>
  );

  const SaveButton = ({ onClick, saving, saved, disabled }: { onClick: () => void; saving: boolean; saved: boolean; disabled?: boolean }) => (
    <button
      onClick={onClick}
      disabled={saving || disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600,
        color: saved ? '#10B981' : '#fff',
        background: saved ? 'rgba(16,185,129,0.12)' : (saving || disabled) ? '#c9c4d5' : '#5e4dbb',
        border: saved ? '1.5px solid rgba(16,185,129,0.3)' : 'none',
        borderRadius: 10, padding: '9px 20px',
        cursor: (saving || disabled) ? 'not-allowed' : 'pointer',
        transition: 'all 150ms',
      }}
      onMouseEnter={e => { if (!saving && !saved && !disabled) e.currentTarget.style.background = '#4f3fa8'; }}
      onMouseLeave={e => { if (!saving && !saved && !disabled) e.currentTarget.style.background = '#5e4dbb'; }}
    >
      <Icon name={saved ? 'check' : 'save'} size={14} color={saved ? '#10B981' : '#fff'} />
      {saved ? 'Saved' : saving ? 'Saving…' : 'Save'}
    </button>
  );

  const TABS: { id: TabId; label: string; icon: string }[] = [
    { id: 'system',   label: 'System',      icon: 'storage' },
    { id: 'ai',       label: 'AI',          icon: 'smart_toy' },
    { id: 'security', label: 'Security',    icon: 'shield_lock' },
    { id: 'api',      label: 'API',         icon: 'key' },
    { id: 'users',    label: 'Users',       icon: 'group' },
    { id: 'danger',   label: 'Danger Zone', icon: 'warning' },
  ];

  return (
    <div style={{ flex: 1, height: '100%', overflowY: 'auto' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: isMobile ? '16px 12px 48px' : '32px 32px 48px', display: 'flex', flexDirection: 'column', gap: 24, width: '100%' }}>
        <h1 style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 28, fontWeight: 700, color: '#1c1b22', letterSpacing: '-0.02em' }}>Settings</h1>

        {isAdmin ? (
          <>
            {/* Tab bar */}
            <div style={{ display: 'flex', gap: 4, background: '#F5F3FF', borderRadius: 14, padding: 4, overflowX: isMobile ? 'auto' : undefined, WebkitOverflowScrolling: 'touch', flexShrink: 0 }}>
              {TABS.map(tab => {
                const active = activeTab === tab.id;
                const isDanger = tab.id === 'danger';
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600,
                      color: active ? (isDanger ? '#fff' : '#fff') : (isDanger ? '#ba1a1a' : '#5e4dbb'),
                      background: active ? (isDanger ? '#ba1a1a' : '#5e4dbb') : 'transparent',
                      border: 'none', borderRadius: 10,
                      padding: '7px 14px',
                      cursor: 'pointer',
                      transition: 'all 150ms',
                      flex: '1 1 auto',
                      justifyContent: 'center',
                      minWidth: 0,
                    }}
                    onMouseEnter={e => { if (!active) e.currentTarget.style.background = isDanger ? 'rgba(186,26,26,0.08)' : '#ede9ff'; }}
                    onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <Icon name={tab.icon} size={15} color={active ? '#fff' : (isDanger ? '#ba1a1a' : '#5e4dbb')} />
                    <span style={{ whiteSpace: 'nowrap' }}>{tab.label}</span>
                  </button>
                );
              })}
            </div>

            {/* ── System Tab ── */}
            {activeTab === 'system' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {/* Disk Storage */}
                {sectionLabel('Disk Storage')}
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
                          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22' }}>Used Space</div>
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

                {/* User Storage Quota */}
                {sectionLabel('User Storage Quota')}
                <div style={card}>
                  <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                      <div>
                        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22' }}>Storage limit per user</div>
                        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2 }}>Admins are exempt and always have unlimited storage.</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', background: '#fff', border: `1.5px solid ${quotaInputFocus ? '#5e4dbb' : '#E5E7EB'}`, borderRadius: 10, overflow: 'hidden', transition: 'border-color 200ms' }}>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={quotaGb}
                          onChange={e => { setQuotaGb(e.target.value); setSystemSaved(false); }}
                          onFocus={() => setQuotaInputFocus(true)}
                          onBlur={() => setQuotaInputFocus(false)}
                          onKeyDown={e => { if (e.key === 'Enter') handleSaveSystem(); }}
                          style={{ width: 64, fontFamily: 'Inter, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22', background: 'transparent', border: 'none', outline: 'none', padding: '8px 10px', textAlign: 'right' }}
                        />
                        <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', paddingRight: 10, paddingLeft: 2, userSelect: 'none' }}>GB</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Single Save button for System tab */}
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <SaveButton
                    onClick={handleSaveSystem}
                    saving={systemSaving}
                    saved={systemSaved}
                    disabled={!quotaGb || parseFloat(quotaGb) <= 0 || isNaN(parseFloat(quotaGb))}
                  />
                </div>
              </div>
            )}

            {/* ── AI Tab ── */}
            {activeTab === 'ai' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {sectionLabel('AI Assistant')}
                <div style={card}>
                  <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {/* Enable toggle */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                      <div>
                        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22' }}>Enable AI Assistant</div>
                        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2 }}>Show the AI assistant bubble for all users on this instance.</div>
                      </div>
                      <button
                        onClick={() => { setAiEnabled(v => !v); setAiSaved(false); }}
                        style={{
                          width: 44, height: 24, borderRadius: 12,
                          background: aiEnabled ? '#5e4dbb' : '#e8e4f0',
                          border: 'none', cursor: 'pointer',
                          position: 'relative', flexShrink: 0,
                          transition: 'background 200ms',
                        }}
                      >
                        <span style={{
                          position: 'absolute', top: 2,
                          left: aiEnabled ? 22 : 2,
                          width: 20, height: 20, borderRadius: '50%',
                          background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
                          transition: 'left 200ms',
                        }} />
                      </button>
                    </div>

                    <div style={{ height: 1, background: '#f1ecf6' }} />

                    {/* Model picker */}
                    <div>
                      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: 8 }}>AI Model</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {AI_MODELS.map(m => {
                          const selected = aiModel === m.value;
                          return (
                            <button
                              key={m.value}
                              onClick={() => { setAiModel(m.value); setAiSaved(false); }}
                              style={{
                                display: 'flex', alignItems: 'center', gap: 10,
                                padding: '9px 12px', borderRadius: 10, cursor: 'pointer',
                                border: selected ? '1.5px solid #5e4dbb' : '1.5px solid #e8e4f0',
                                background: selected ? '#f4f1fc' : '#fafafa',
                                textAlign: 'left', width: '100%',
                                transition: 'border-color 150ms, background 150ms',
                              }}
                            >
                              <span style={{
                                width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
                                border: selected ? '4px solid #5e4dbb' : '2px solid #c8c3d8',
                                background: selected ? '#fff' : 'transparent',
                                transition: 'border 150ms',
                              }} />
                              <span style={{ flex: 1, minWidth: 0 }}>
                                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22', display: 'block' }}>{m.label}</span>
                                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#9995a8' }}>{m.sub}</span>
                              </span>
                              {m.badge && (
                                <span style={{
                                  fontFamily: 'Inter, sans-serif', fontSize: 10.5, fontWeight: 700,
                                  color: '#fff', background: m.badgeColor ?? '#5e4dbb',
                                  borderRadius: 5, padding: '2px 7px', flexShrink: 0,
                                  letterSpacing: '0.02em',
                                }}>
                                  {m.badge}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                      <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#b0acbe', marginTop: 8 }}>
                        Requires <code style={{ background: '#f1ecf6', padding: '1px 5px', borderRadius: 4 }}>OPENROUTER_API_KEY</code> set in your environment.
                      </div>
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <SaveButton onClick={handleSaveAI} saving={aiSaving} saved={aiSaved} />
                </div>

                {/* ── Claude MCP Integration ── */}
                {sectionLabel('Claude MCP Integration')}
                <div style={{ ...card }}>
                  <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {/* Toggle row */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                      <div>
                        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22' }}>Enable Claude MCP</div>
                        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2 }}>Allow users to connect Claude via the MCP server. Disabling immediately revokes all active connections for all users.</div>
                      </div>
                      <button
                        onClick={() => !mcpSaving && handleToggleMcp(!mcpEnabled)}
                        disabled={mcpSaving}
                        style={{
                          width: 44, height: 24, borderRadius: 12,
                          background: mcpSaving ? '#c9c4d5' : mcpEnabled ? '#5e4dbb' : '#e8e4f0',
                          border: 'none', cursor: mcpSaving ? 'wait' : 'pointer',
                          position: 'relative', flexShrink: 0,
                          transition: 'background 200ms',
                        }}
                      >
                        <span style={{
                          position: 'absolute', top: 2,
                          left: mcpEnabled ? 22 : 2,
                          width: 20, height: 20, borderRadius: '50%',
                          background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
                          transition: 'left 200ms',
                        }} />
                      </button>
                    </div>

                    {/* Confirmation dialog — shown inline when admin clicks to disable */}
                    {showMcpDisableConfirm && (
                      <div style={{ background: '#fff8f5', border: '1.5px solid #ffdad6', borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12, animation: 'menuIn 160ms cubic-bezier(0.22,1,0.36,1) both' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                          <Icon name="warning" size={18} color="#ba1a1a" />
                          <div>
                            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 700, color: '#ba1a1a', marginBottom: 4 }}>Disable Claude MCP for all users?</div>
                            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12.5, color: '#484552', lineHeight: 1.55 }}>
                              This will <strong>immediately revoke all Claude connections</strong> across the entire instance. Every user will be disconnected and will need to reconnect once MCP is re-enabled. This action cannot be undone.
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                          <button
                            onClick={() => setShowMcpDisableConfirm(false)}
                            style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#484552', background: '#f5f5f5', border: '1px solid #e8e4f0', borderRadius: 8, padding: '8px 16px', cursor: 'pointer' }}
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleConfirmDisableMcp}
                            style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#ba1a1a', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer' }}
                          >
                            Disable MCP &amp; revoke all connections
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* ── Usage Analytics ── */}
                {sectionLabel('Token Usage — Last 30 Days')}

                {usageLoading && (
                  <div style={{ ...card, padding: '32px', textAlign: 'center' as const }}>
                    <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>Loading usage data…</div>
                  </div>
                )}

                {!usageLoading && usage && (() => {
                  // Aggregate daily rows (one per model) into per-date totals
                  const byDate = new Map<string, { total: number; prompt: number; completion: number }>();
                  for (const d of usage.daily) {
                    const e = byDate.get(d.date) ?? { total: 0, prompt: 0, completion: 0 };
                    byDate.set(d.date, { total: e.total + d.totalTokens, prompt: e.prompt + d.promptTokens, completion: e.completion + d.completionTokens });
                  }

                  // Build ordered 30-day window
                  const today = new Date();
                  const days: string[] = [];
                  for (let i = 29; i >= 0; i--) {
                    const dt = new Date(today);
                    dt.setDate(dt.getDate() - i);
                    days.push(dt.toISOString().slice(0, 10));
                  }

                  const maxTotal = Math.max(...days.map(d => byDate.get(d)?.total ?? 0), 1);
                  const totalCost = usage.byModel.reduce((s, m) => s + calcCost(m.model, m.promptTokens, m.completionTokens), 0);

                  // SVG chart dimensions
                  const W = 600, H = 160;
                  const padL = 52, padR = 10, padT = 10, padB = 30;
                  const plotW = W - padL - padR;
                  const plotH = H - padT - padB;
                  const slotW = plotW / 30;
                  const barW = Math.max(4, slotW - 3);

                  return (
                    <>
                      {/* Stat cards */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                        {[
                          { label: 'Total Tokens', value: fmtTokens(usage.totals.totalTokens), icon: 'bolt', color: '#5e4dbb' },
                          { label: 'Est. Cost', value: fmtCost(totalCost), icon: 'payments', color: '#10B981' },
                          { label: 'Total Requests', value: usage.totals.requestCount.toLocaleString(), icon: 'chat_bubble', color: '#f59e0b' },
                        ].map(stat => (
                          <div key={stat.label} style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 12, padding: '16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 30, height: 30, borderRadius: 8, background: stat.color + '1a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <Icon name={stat.icon} size={16} color={stat.color} />
                              </div>
                              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#b0acbe', textTransform: 'uppercase' as const, letterSpacing: '0.07em', fontWeight: 600 }}>{stat.label}</div>
                            </div>
                            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 22, fontWeight: 700, color: '#1c1b22', lineHeight: 1 }}>{stat.value}</div>
                          </div>
                        ))}
                      </div>

                      {/* Bar chart */}
                      <div style={{ ...card, padding: '16px 18px 12px' }}>
                        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase' as const, letterSpacing: '0.07em', marginBottom: 10 }}>Daily Token Usage</div>
                        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}>
                          {/* Y-axis grid + labels */}
                          {([0, 0.25, 0.5, 0.75, 1] as const).map(frac => {
                            const y = padT + plotH * (1 - frac);
                            return (
                              <g key={frac}>
                                <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="#f1ecf6" strokeWidth={1} />
                                {frac > 0 && (
                                  <text x={padL - 5} y={y + 3.5} textAnchor="end" fontFamily="Inter, sans-serif" fontSize="9" fill="#b0acbe">
                                    {fmtTokens(Math.round(maxTotal * frac))}
                                  </text>
                                )}
                              </g>
                            );
                          })}

                          {/* Bars + X-axis labels */}
                          {days.map((date, i) => {
                            const data = byDate.get(date);
                            const total = data?.total ?? 0;
                            const barH = total > 0 ? Math.max(3, (total / maxTotal) * plotH) : 0;
                            const x = padL + i * slotW + (slotW - barW) / 2;
                            const y = padT + plotH - barH;
                            const isHov = hoveredBar?.date === date;
                            const showLabel = i === 0 || i === 6 || i === 13 || i === 20 || i === 27 || i === 29;
                            const lDate = new Date(date + 'T00:00:00');
                            const lStr = lDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                            return (
                              <g key={date}>
                                {total > 0 ? (
                                  <rect
                                    x={x} y={y} width={barW} height={barH} rx={3}
                                    fill={isHov ? '#4f3fa8' : '#5e4dbb'}
                                    style={{ cursor: 'pointer', transition: 'fill 100ms' }}
                                    onMouseEnter={() => setHoveredBar({ x: x + barW / 2, y, date, total, prompt: data?.prompt ?? 0, completion: data?.completion ?? 0 })}
                                    onMouseLeave={() => setHoveredBar(null)}
                                  />
                                ) : (
                                  <rect x={x} y={padT + plotH - 2} width={barW} height={2} rx={1} fill="#f0edfb" />
                                )}
                                {showLabel && (
                                  <text x={padL + i * slotW + slotW / 2} y={H - 4} textAnchor="middle" fontFamily="Inter, sans-serif" fontSize="8.5" fill="#b0acbe">{lStr}</text>
                                )}
                              </g>
                            );
                          })}

                          {/* Hover tooltip (SVG-native) */}
                          {hoveredBar && (() => {
                            const tx = Math.min(Math.max(hoveredBar.x, padL + 76), W - padR - 76);
                            const ttH = 68;
                            const ttTop = hoveredBar.y > padT + ttH + 12 ? hoveredBar.y - ttH - 6 : hoveredBar.y + barW + 6;
                            return (
                              <g style={{ pointerEvents: 'none' }}>
                                <rect x={tx - 76} y={ttTop} width={152} height={ttH} rx={7} fill="rgba(28,27,34,0.93)" />
                                <text x={tx} y={ttTop + 17} textAnchor="middle" fontFamily="Inter, sans-serif" fontSize="9" fill="#9d8dff">
                                  {new Date(hoveredBar.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                                </text>
                                <text x={tx} y={ttTop + 35} textAnchor="middle" fontFamily="Hanken Grotesk, sans-serif" fontSize="14" fontWeight="700" fill="#ffffff">
                                  {fmtTokens(hoveredBar.total)} tokens
                                </text>
                                <text x={tx} y={ttTop + 52} textAnchor="middle" fontFamily="Inter, sans-serif" fontSize="9" fill="#9d8dff">
                                  {`In: ${fmtTokens(hoveredBar.prompt)}  ·  Out: ${fmtTokens(hoveredBar.completion)}`}
                                </text>
                              </g>
                            );
                          })()}
                        </svg>
                      </div>

                      {/* Per-model breakdown */}
                      {usage.byModel.length > 0 && (
                        <div style={card}>
                          <div style={{ display: 'flex', alignItems: 'center', padding: '10px 18px', borderBottom: '1px solid #f1ecf6' }}>
                            <div style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase' as const, letterSpacing: '0.07em' }}>Model</div>
                            {['Requests', 'Tokens In', 'Tokens Out', 'Est. Cost'].map(h => (
                              <div key={h} style={{ width: 84, textAlign: 'right' as const, fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase' as const, letterSpacing: '0.07em' }}>{h}</div>
                            ))}
                          </div>
                          {usage.byModel.map((m, idx) => {
                            const cost = calcCost(m.model, m.promptTokens, m.completionTokens);
                            const info = MODEL_PRICING[m.model];
                            const label = info?.label ?? (m.model.split('/').pop() ?? m.model);
                            const color = info?.color ?? '#5e4dbb';
                            const isLast = idx === usage.byModel.length - 1;
                            return (
                              <div key={m.model} style={{ display: 'flex', alignItems: 'center', padding: '10px 18px', borderBottom: isLast ? 'none' : '1px solid #f9f8fc' }}>
                                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                                  <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22' }}>{label}</span>
                                </div>
                                <div style={{ width: 84, textAlign: 'right' as const, fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#484552' }}>{m.requestCount.toLocaleString()}</div>
                                <div style={{ width: 84, textAlign: 'right' as const, fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#484552' }}>{fmtTokens(m.promptTokens)}</div>
                                <div style={{ width: 84, textAlign: 'right' as const, fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#484552' }}>{fmtTokens(m.completionTokens)}</div>
                                <div style={{ width: 84, textAlign: 'right' as const, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22' }}>{fmtCost(cost)}</div>
                              </div>
                            );
                          })}
                          <div style={{ padding: '9px 18px', borderTop: '1px solid #f1ecf6', fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', display: 'flex', alignItems: 'center', gap: 5 }}>
                            <Icon name="info" size={12} color="#b0acbe" />
                            Estimates based on OpenRouter published rates. Actual billing may differ.
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()}

                {!usageLoading && !usage && (
                  <div style={{ ...card, padding: '32px', textAlign: 'center' as const }}>
                    <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>No AI usage data for the last 30 days.</div>
                  </div>
                )}
              </div>
            )}

            {/* ── Security Tab ── */}
            {activeTab === 'security' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {sectionLabel('Security Features')}
                <div style={card}>
                  <div style={{ ...row }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                      <div style={{ width: 36, height: 36, borderRadius: 10, background: '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <Icon name="shield_lock" size={18} color="#5e4dbb" />
                      </div>
                      <div>
                        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22' }}>Two-Factor Authentication</div>
                        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2 }}>
                          Allow users to set up 2FA on their accounts via Account Settings.
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => { setTwoFAFeatureEnabled(v => !v); setSecuritySaved(false); }}
                      style={{
                        width: 44, height: 24, borderRadius: 12,
                        background: twoFAFeatureEnabled ? '#5e4dbb' : '#e8e4f0',
                        border: 'none', cursor: 'pointer',
                        position: 'relative', flexShrink: 0,
                        transition: 'background 200ms',
                      }}
                    >
                      <span style={{
                        position: 'absolute', top: 3,
                        left: twoFAFeatureEnabled ? 23 : 3,
                        width: 18, height: 18, borderRadius: '50%',
                        background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
                        transition: 'left 200ms',
                      }} />
                    </button>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <SaveButton onClick={handleSaveSecurity} saving={securitySaving} saved={securitySaved} />
                </div>
              </div>
            )}


            {/* ── API Tab ── */}
            {activeTab === 'api' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {sectionLabel('Admin API',
                  <button
                    onClick={() => setShowApiKeyWizard(true)}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', border: 'none', borderRadius: 8, padding: '5px 12px', cursor: 'pointer', transition: 'background 150ms' }}
                    onMouseEnter={e => { e.currentTarget.style.background = '#ede9ff'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = '#F5F3FF'; }}
                  >
                    <Icon name="add" size={14} color="#5e4dbb" />
                    New API key
                  </button>
                )}
                <div style={card}>
                  <div style={{ padding: '16px 18px' }}>
                    <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 700, color: '#1c1b22' }}>Instance-wide API access</div>
                    <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 3 }}>Each key carries its own set of permissions, chosen when you create it. Grant a key only the features an integration needs — read/export, or create &amp; manage users, workspaces, folders, lists, timelines and meetings. Secrets are shown once and stored only as hashes.</div>
                  </div>
                </div>

                {sectionLabel('Endpoints & examples')}
                <div style={card}>
                  <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584' }}>Base URL</div>
                    <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: '#1c1b22', background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, padding: 10, overflowWrap: 'anywhere' }}>{apiOrigin}</code>
                    <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 4 }}>Read everything (needs the <b>read</b> permission):</div>
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: '#1c1b22', background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, padding: 10, overflowX: 'auto' }}>{exportExample}</pre>
                    <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 4 }}>Create a list for a user (needs the <b>lists</b> permission). Write endpoints accept an optional <b>ownerId</b> — the target user; it defaults to the admin who owns the key:</div>
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: '#1c1b22', background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, padding: 10, overflowX: 'auto' }}>{writeExample}</pre>
                  </div>
                </div>

                {sectionLabel('Active keys')}
                <div style={card}>
                  {apiKeysLoading ? <div style={{ ...row, justifyContent: 'center', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>Loading…</div> : apiKeys.length === 0 ? <div style={{ ...row, justifyContent: 'center', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>No API keys yet.</div> : apiKeys.map(k => (
                    <div key={k.id} style={{ ...row, borderBottom: '1px solid #f1ecf6', flexWrap: 'wrap', gap: 10 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 700, color: '#1c1b22' }}>{k.name}</div>
                        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2 }}>{k.keyPrefix} · Created {new Date(k.createdAt).toLocaleDateString()} · Last used {k.lastUsedAt ? relativeTime(k.lastUsedAt) : 'never'}</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
                          {k.scopes.map(s => {
                            const f = featureForScope(s);
                            return (
                              <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', border: '1px solid #e8e4f0', borderRadius: 9999, padding: '3px 9px' }}>
                                <Icon name={f?.icon ?? 'key'} size={12} color="#5e4dbb" /> {f?.label ?? s}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                      <button onClick={() => handleRevokeApiKey(k.id)} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 700, color: '#ba1a1a', background: '#fff5f5', border: '1px solid #ffdad6', borderRadius: 8, padding: '7px 10px', cursor: 'pointer', alignSelf: 'flex-start' }}>Revoke</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Users Tab ── */}
            {activeTab === 'users' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
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
                              {renderUserIdCopy(u.id)}
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

            {/* ── Danger Zone Tab ── */}
            {activeTab === 'danger' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {sectionLabel('Danger Zone')}
                <div style={{ ...card, border: '1.5px solid #ffdad6' }}>
                  <div style={{ ...row, background: '#fff5f5' }}>
                    <div>
                      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 700, color: '#ba1a1a' }}>Nuke Everything</div>
                      <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2 }}>Permanently delete all data. This cannot be undone.</div>
                    </div>
                    <button
                      onClick={() => setNukeStep(1)}
                      style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#ba1a1a', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', flexShrink: 0, transition: 'background 150ms' }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#991212'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = '#ba1a1a'; }}
                    >
                      Nuke
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#b0acbe', textAlign: 'center', padding: '48px 0' }}>
            No settings available.
          </div>
        )}
      </div>

      {/* ── All Users Dialog ── */}
      {allUsersOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) setAllUsersOpen(false); }}
        >
          <div
            style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 580, maxHeight: '82vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}
          >
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
                        {renderUserIdCopy(u.id)}
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

      {/* ── Add User Modal ── */}
      {addUserOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) closeAddUser(); }}
        >
          <div
            style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 420, boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}
          >
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
            <div style={{ padding: '20px 24px' }}>
              <div style={{ borderBottom: `${fullNameFocus ? 2 : 1}px solid ${fullNameFocus ? '#5e4dbb' : '#e8e4f0'}`, paddingBottom: 10, marginBottom: 16, transition: 'border-color 200ms' }}>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Full Name</div>
                <input value={newFullName} onChange={e => setNewFullName(e.target.value)} placeholder="Jane Doe" style={fi} onFocus={() => setFullNameFocus(true)} onBlur={() => setFullNameFocus(false)} />
              </div>
              <div style={{ borderBottom: `${usernameFocus ? 2 : 1}px solid ${usernameFocus ? '#5e4dbb' : '#e8e4f0'}`, paddingBottom: 10, marginBottom: 16, transition: 'border-color 200ms' }}>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Username <span style={{ color: '#ba1a1a' }}>*</span></div>
                <input value={newUsername} onChange={e => setNewUsername(e.target.value)} placeholder="janedoe" style={fi} onFocus={() => setUsernameFocus(true)} onBlur={() => setUsernameFocus(false)} />
              </div>
              <div style={{ borderBottom: `${emailFocus ? 2 : 1}px solid ${emailFocus ? '#5e4dbb' : '#e8e4f0'}`, paddingBottom: 10, marginBottom: 16, transition: 'border-color 200ms' }}>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Email</div>
                <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="jane@example.com" style={fi} onFocus={() => setEmailFocus(true)} onBlur={() => setEmailFocus(false)} />
              </div>
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
                  <button type="button" onClick={generatePassword} title="Generate random password" style={{ width: 28, height: 28, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 120ms' }} onMouseEnter={e => { e.currentTarget.style.background = '#F5F3FF'; }} onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                    <Icon name="casino" size={16} color="#787584" />
                  </button>
                  <button type="button" onClick={copyPassword} disabled={!newPassword} title={passwordCopied ? 'Copied!' : 'Copy password'} style={{ width: 28, height: 28, borderRadius: 7, background: passwordCopied ? 'rgba(16,185,129,0.10)' : 'transparent', border: 'none', cursor: newPassword ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 120ms' }} onMouseEnter={e => { if (newPassword && !passwordCopied) e.currentTarget.style.background = '#F5F3FF'; }} onMouseLeave={e => { if (!passwordCopied) e.currentTarget.style.background = 'transparent'; }}>
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
                <button onClick={closeAddUser} style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: '#f1ecf6', border: 'none', borderRadius: 8, padding: '11px 0', cursor: 'pointer' }} onMouseEnter={e => { e.currentTarget.style.background = '#e8e4f0'; }} onMouseLeave={e => { e.currentTarget.style.background = '#f1ecf6'; }}>Cancel</button>
                <button onClick={handleCreateUser} disabled={creating || !newUsername.trim() || !newPassword.trim()} style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: creating || !newUsername.trim() || !newPassword.trim() ? '#c9c4d5' : '#5e4dbb', border: 'none', borderRadius: 8, padding: '11px 0', cursor: creating || !newUsername.trim() || !newPassword.trim() ? 'not-allowed' : 'pointer', transition: 'background 150ms' }} onMouseEnter={e => { if (!creating && newUsername.trim() && newPassword.trim()) e.currentTarget.style.background = '#4d3da8'; }} onMouseLeave={e => { if (!creating && newUsername.trim() && newPassword.trim()) e.currentTarget.style.background = '#5e4dbb'; }}>
                  {creating ? 'Creating…' : 'Create User'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit User Modal ── */}
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
              <button onClick={closeEditUser} style={{ width: 30, height: 30, borderRadius: '50%', background: '#f1ecf6', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onMouseEnter={e => { e.currentTarget.style.background = '#e8e4f0'; }} onMouseLeave={e => { e.currentTarget.style.background = '#f1ecf6'; }}>
                <Icon name="close" size={15} color="#484552" />
              </button>
            </div>
            <div style={{ padding: '20px 24px' }}>
              <div style={{ borderBottom: `${editUsernameFocus ? 2 : 1}px solid ${editUsernameFocus ? '#5e4dbb' : '#e8e4f0'}`, paddingBottom: 10, marginBottom: 16, transition: 'border-color 200ms' }}>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Username</div>
                <input value={editUsername} onChange={e => setEditUsername(e.target.value)} placeholder={editTarget.username} style={fi} onFocus={() => setEditUsernameFocus(true)} onBlur={() => setEditUsernameFocus(false)} />
              </div>
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
                  <button type="button" onClick={generateEditPassword} title="Generate random password" style={{ width: 28, height: 28, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 120ms' }} onMouseEnter={e => { e.currentTarget.style.background = '#F5F3FF'; }} onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                    <Icon name="casino" size={16} color="#787584" />
                  </button>
                  <button type="button" onClick={copyEditPassword} disabled={!editPassword} title={editPasswordCopied ? 'Copied!' : 'Copy password'} style={{ width: 28, height: 28, borderRadius: 7, background: editPasswordCopied ? 'rgba(16,185,129,0.10)' : 'transparent', border: 'none', cursor: editPassword ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 120ms' }} onMouseEnter={e => { if (editPassword && !editPasswordCopied) e.currentTarget.style.background = '#F5F3FF'; }} onMouseLeave={e => { if (!editPasswordCopied) e.currentTarget.style.background = 'transparent'; }}>
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
                <button onClick={closeEditUser} style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: '#f1ecf6', border: 'none', borderRadius: 8, padding: '11px 0', cursor: 'pointer' }} onMouseEnter={e => { e.currentTarget.style.background = '#e8e4f0'; }} onMouseLeave={e => { e.currentTarget.style.background = '#f1ecf6'; }}>Cancel</button>
                <button onClick={handleEditUser} disabled={editing} style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: editing ? '#c9c4d5' : '#5e4dbb', border: 'none', borderRadius: 8, padding: '11px 0', cursor: editing ? 'not-allowed' : 'pointer', transition: 'background 150ms' }} onMouseEnter={e => { if (!editing) e.currentTarget.style.background = '#4d3da8'; }} onMouseLeave={e => { if (!editing) e.currentTarget.style.background = '#5e4dbb'; }}>
                  {editing ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete User Confirmation Modal ── */}
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
              <button onClick={() => setDeleteTarget(null)} style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: '#f1ecf6', border: 'none', borderRadius: 8, padding: '11px 0', cursor: 'pointer' }} onMouseEnter={e => { e.currentTarget.style.background = '#e8e4f0'; }} onMouseLeave={e => { e.currentTarget.style.background = '#f1ecf6'; }}>Cancel</button>
              <button onClick={handleDeleteUser} disabled={deleting} style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: deleting ? '#c9c4d5' : '#ba1a1a', border: 'none', borderRadius: 8, padding: '11px 0', cursor: deleting ? 'not-allowed' : 'pointer', transition: 'background 150ms' }} onMouseEnter={e => { if (!deleting) e.currentTarget.style.background = '#991212'; }} onMouseLeave={e => { if (!deleting) e.currentTarget.style.background = '#ba1a1a'; }}>
                {deleting ? 'Removing…' : 'Remove User'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Nuke Confirm Modal ── */}
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
                  style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '10px 12px', outline: 'none', marginBottom: 16, boxSizing: 'border-box' }} />
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
                  style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '10px 12px', outline: 'none', marginBottom: 16, boxSizing: 'border-box' }} />
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={() => setNukeStep(0)} style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: '#f1ecf6', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer' }}>Cancel</button>
                  <button onClick={() => { setNukeStep(0); navigate('/nuke', { state: { password: nukePw } }); }} style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#ba1a1a', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer' }}>Nuke Everything</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Admin API key wizard ── */}
      {showApiKeyWizard && (
        <AdminApiKeyWizard
          onClose={() => setShowApiKeyWizard(false)}
          onCreated={key => setApiKeys(prev => [key, ...prev])}
        />
      )}
    </div>
  );
}
