import { usePageTitle } from "../hooks/usePageTitle";
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from '@/components/animate-ui/motion';
import { useMobile } from '../hooks/useBreakpoint';
import { useNavigate } from 'react-router-dom';
import useAuthStore from '../store/useAuthStore';
import useAIStore from '../store/useAIStore';
import { apiGetUsers, apiCreateUser, apiUpdateUser, apiDeleteUser, apiGetSystemStorage, apiGetAppSettings, apiUpdateAppSettings, apiUpdateAppSettingsAI, apiGetAISettings, apiUpdateFeatureFlags, apiUpdateAppSettingsMcp, apiUpdateAppSettingsMobile, apiGetAIUsage, apiGetAdminReadApiKeys, apiRevokeAdminReadApiKey, apiUpdateAppSettingsKnowledge, apiGetKnowledgeStatus, apiKnowledgeReindex, apiUpdateAppSettingsResend, apiSendResendTestEmail, type AdminReadApiKey, type AIUsageDay, type AIUsageModel, type AIUsageTotals, type KnowledgeStatus } from '../api/client';
import Icon from '../components/Icon';
import AdminApiKeyWizard from '../modals/AdminApiKeyWizard';
import AppsStoreModal from '../modals/AppsStoreModal';
import AiSkillUploadModal from '../modals/AiSkillUploadModal';
import AiSkillEditModal from '../modals/AiSkillEditModal';
import { featureForScope } from '../modals/adminApiFeatures';
import useInstalledAppsStore from '../store/useInstalledAppsStore';
import useAiSkillsStore from '../store/useAiSkillsStore';
import PopIn from '../components/animate-ui/PopIn';
import ModalIn from '../components/animate-ui/ModalIn';
import MotionButton from '../components/animate-ui/MotionButton';
import MotionIn from '../components/animate-ui/MotionIn';
import useNow from '../hooks/useNow';
import useAsyncData from '../hooks/useAsyncData';

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

type TabId = 'system' | 'ai' | 'ai_skills' | 'email' | 'security' | 'api' | 'mobile' | 'users' | 'danger';

/** Milliseconds since `last_online` within which a user counts as online. */
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

// useAsyncData returns `initial` as-is whenever the current key has no result,
// so these must be one stable identity rather than a fresh [] per render —
// otherwise every consumer sees a "new" empty array on every pass.
const EMPTY_USERS: UserEntry[] = [];
const EMPTY_API_KEYS: AdminReadApiKey[] = [];

// Module scope, not the component body: a component defined during render
// is a NEW type every render, so React unmounts and remounts it each time —
// restarting its Motion transition and dropping any focus inside it. Every
// input here is already a prop, so there was nothing keeping it inside.
const SaveButton = ({ onClick, saving, saved, disabled }: { onClick: () => void; saving: boolean; saved: boolean; disabled?: boolean }) => (
  <MotionButton
    onClick={onClick}
    disabled={saving || disabled}
    style={{
      display: 'flex', alignItems: 'center', gap: 6,
      fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600,
      color: saved ? 'var(--color-success)' : 'var(--color-white)',
      background: saved ? 'rgba(var(--color-success-rgb), 0.12)' : (saving || disabled) ? 'var(--color-border-strong)' : 'var(--color-primary)',
      border: saved ? '1.5px solid rgba(var(--color-success-rgb), 0.3)' : 'none',
      borderRadius: 10, padding: '9px 20px',
      cursor: (saving || disabled) ? 'not-allowed' : 'pointer',
    }}
    whileHover={!saving && !saved && !disabled ? { background: 'var(--color-purple-mid-10)' } : undefined}
    transition={{ duration: 0.15 }}
  >
    <Icon name={saved ? 'check' : 'save'} size={14} color={saved ? 'var(--color-success)' : 'var(--color-white)'} />
    {saved ? 'Saved' : saving ? 'Saving…' : 'Save'}
  </MotionButton>
);

function relativeTime(iso: string | null, now: number): string {
  if (!iso) return 'Never';
  const diff = now - new Date(iso).getTime();
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
    <div style={{ width: size, height: size, borderRadius: '50%', background: 'linear-gradient(135deg, var(--color-accent-purple-light) 0%, var(--color-primary) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
      {profileImage
        ? <img src={profileImage} alt={username} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : <span style={{ fontFamily: 'var(--font-heading)', fontSize: size * 0.36, fontWeight: 700, color: 'var(--color-white)' }}>{initials}</span>
      }
    </div>
  );
}

const MODEL_PRICING: Record<string, { input: number; output: number; label: string; color: string }> = {
  'openai/gpt-4o-mini':                 { input: 0.15,  output: 0.60,  label: 'GPT-4o Mini',           color: 'var(--color-teal-deep-1)' },
  'openai/gpt-4o':                      { input: 2.50,  output: 10.00, label: 'GPT-4o',                color: 'var(--color-green-mid-1)' },
  'anthropic/claude-3-5-haiku':         { input: 0.80,  output: 4.00,  label: 'Claude 3.5 Haiku',      color: 'var(--color-orange-mid-2)' },
  'anthropic/claude-3-5-sonnet':        { input: 3.00,  output: 15.00, label: 'Claude 3.5 Sonnet',     color: 'var(--color-orange-mid-1)' },
  'anthropic/claude-3.7-sonnet':        { input: 3.00,  output: 15.00, label: 'Claude 3.7 Sonnet',     color: 'var(--color-orange-mid-1)' },
  'google/gemini-flash-1.5':            { input: 0.075, output: 0.30,  label: 'Gemini Flash 1.5',      color: 'var(--color-blue-mid-3)' },
  'google/gemini-2.5-flash':            { input: 0.15,  output: 0.60,  label: 'Gemini 2.5 Flash',      color: 'var(--color-blue-mid-3)' },
  'google/gemini-2.5-pro':              { input: 1.25,  output: 10.00, label: 'Gemini 2.5 Pro',        color: 'var(--color-blue-mid-3)' },
  'meta-llama/llama-3.3-70b-instruct':  { input: 0.12,  output: 0.30,  label: 'Llama 3.3 70B',        color: 'var(--color-blue-mid-9)' },
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
  // One clock per render, ticking on its own — see hooks/useNow. Reading
  // Date.now() inline made the "last seen" labels and online dots update only
  // when something else happened to re-render the list.
  const now = useNow();
  usePageTitle("Settings");
  const navigate = useNavigate();
  const { isAdmin, userId } = useAuthStore();
  const isMobile = useMobile();
  const [activeTab, setActiveTab] = useState<TabId>('system');
  const [nukeStep, setNukeStep] = useState(0);
  const [nukeText, setNukeText] = useState('');
  const [nukePw, setNukePw] = useState('');


  // Admin API keys — only fetched while the API tab is open, hence the null
  // key rather than a guard inside an effect.
  const { data: apiKeys, loading: apiKeysLoading, setData: setApiKeys } = useAsyncData(
    activeTab === 'api' && isAdmin ? 'admin-api-keys' : null,
    async () => (await apiGetAdminReadApiKeys()).keys,
    EMPTY_API_KEYS
  );
  const [showApiKeyWizard, setShowApiKeyWizard] = useState(false);

  // Users state
  const {
    data: users, loading: usersLoading, setData: setUsers,
  } = useAsyncData(
    isAdmin ? 'admin-users' : null,
    async () => (await apiGetUsers()).users,
    EMPTY_USERS
  );
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

  // System storage state. A failed read renders the same "unable to read disk
  // usage" branch as an empty one, so the error is folded into the value.
  const { data: storage, loading: storageLoading } = useAsyncData(
    isAdmin ? 'system-storage' : null,
    () => apiGetSystemStorage().catch(() => null),
    null as { total: number; used: number; available: number } | null
  );

  // Discover Apps dialog
  const [showAppsStore, setShowAppsStore] = useState(false);

  // ── AI Skills ──
  const { skills: aiSkills, loading: aiSkillsLoading, loaded: aiSkillsLoaded, load: loadAiSkills, setEnabled: setAiSkillEnabled } = useAiSkillsStore();
  const [showSkillUploadModal, setShowSkillUploadModal] = useState(false);
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const installedApps = useInstalledAppsStore(s => s.installedApps);
  const loadInstalledApps = useInstalledAppsStore(s => s.load);

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
  const { data: usage, loading: usageLoading } = useAsyncData(
    activeTab === 'ai' && isAdmin ? 'ai-usage' : null,
    () => apiGetAIUsage().catch(() => null),
    null as { daily: AIUsageDay[]; byModel: AIUsageModel[]; totals: AIUsageTotals } | null
  );
  const [hoveredBar, setHoveredBar] = useState<{ x: number; y: number; date: string; total: number; prompt: number; completion: number } | null>(null);

  // Knowledge Layer (semantic search) settings
  const [knowledgeSearchEnabled, setKnowledgeSearchEnabled] = useState(true);
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState('');
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [embeddingBudget, setEmbeddingBudget] = useState('');
  const [knowledgeSaving, setKnowledgeSaving] = useState(false);
  const [knowledgeSaved, setKnowledgeSaved] = useState(false);
  const [knowledgeStatus, setKnowledgeStatus] = useState<KnowledgeStatus | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [reindexResult, setReindexResult] = useState<number | null>(null);

  // Email notifications (Resend) settings
  const [resendEnabled, setResendEnabled] = useState(false);
  const [resendApiKeyInput, setResendApiKeyInput] = useState('');
  const [resendApiKeyConfigured, setResendApiKeyConfigured] = useState(false);
  const [resendApiKeyHint, setResendApiKeyHint] = useState('');
  const [resendFromEmail, setResendFromEmail] = useState('');
  const [resendFromName, setResendFromName] = useState('Solytiq Cloud');
  const [resendSaving, setResendSaving] = useState(false);
  const [resendSaved, setResendSaved] = useState(false);
  const [resendTesting, setResendTesting] = useState(false);
  const [resendTestResult, setResendTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Security / 2FA feature flag
  const [twoFAFeatureEnabled, setTwoFAFeatureEnabled] = useState(true);
  const [securitySaving, setSecuritySaving] = useState(false);
  const [securitySaved, setSecuritySaved] = useState(false);

  // MCP enable/disable
  const [mcpEnabled, setMcpEnabled] = useState(true);
  const [mcpSaving, setMcpSaving] = useState(false);
  const [showMcpDisableConfirm, setShowMcpDisableConfirm] = useState(false);

  // Mobile app enable/disable
  const [mobileEnabled, setMobileEnabled] = useState(true);
  const [mobileSaving, setMobileSaving] = useState(false);
  const [showMobileDisableConfirm, setShowMobileDisableConfirm] = useState(false);

  // The app-settings load stays an effect: it fills a dozen EDITABLE form
  // buffers rather than one loaded value, so there is nothing for
  // useAsyncData's key-derived `data` to be. Its setState calls all happen in
  // an async continuation, which is not what set-state-in-effect flags.
  useEffect(() => {
    if (!isAdmin) return;
    apiGetAppSettings()
      .then(res => {
        const bytes = parseInt(res.settings['storage_quota_per_user'] ?? '0', 10);
        setQuotaGb(bytes > 0 ? (bytes / (1024 ** 3)).toFixed(0) : '15');
        setTwoFAFeatureEnabled(res.settings['two_fa_feature_enabled'] !== 'false');
        setMcpEnabled(res.settings['mcp_enabled'] !== 'false');
        setMobileEnabled(res.settings['mobile_app_enabled'] !== 'false');
        setKnowledgeSearchEnabled(res.settings['knowledge_search_enabled'] !== 'false');
        setEmbeddingBaseUrl(res.settings['embedding_base_url'] ?? '');
        setEmbeddingModel(res.settings['embedding_model'] ?? '');
        const budget = parseInt(res.settings['embedding_monthly_token_budget'] ?? '0', 10);
        setEmbeddingBudget(budget > 0 ? String(budget) : '');
        setResendEnabled(res.settings['resend_enabled'] === 'true');
        setResendApiKeyConfigured(res.settings['resend_api_key_configured'] === 'true');
        setResendApiKeyHint(res.settings['resend_api_key_hint'] ?? '');
        setResendFromEmail(res.settings['resend_from_email'] ?? '');
        setResendFromName(res.settings['resend_from_name'] || 'Solytiq Cloud');
      })
      .catch(() => setQuotaGb('15'));
  }, [isAdmin]);

  useEffect(() => {
    if (activeTab !== 'ai' || !isAdmin) return;
    apiGetKnowledgeStatus().then(setKnowledgeStatus).catch(() => setKnowledgeStatus(null));
  }, [activeTab, isAdmin, knowledgeSaved, reindexResult]);

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
    if (activeTab !== 'ai_skills' || !isAdmin || aiSkillsLoaded) return;
    loadAiSkills();
  }, [activeTab, isAdmin, aiSkillsLoaded, loadAiSkills]);

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

  const handleSaveKnowledge = async () => {
    setKnowledgeSaving(true);
    setKnowledgeSaved(false);
    try {
      await apiUpdateAppSettingsKnowledge({
        knowledgeSearchEnabled,
        embeddingBaseUrl,
        embeddingModel,
        embeddingMonthlyTokenBudget: embeddingBudget ? parseInt(embeddingBudget, 10) : 0,
      });
      setKnowledgeSaved(true);
      setTimeout(() => setKnowledgeSaved(false), 2500);
    } catch (e) {
      console.error('Failed to save Knowledge Search settings', e);
    } finally {
      setKnowledgeSaving(false);
    }
  };

  const handleSaveResend = async () => {
    setResendSaving(true);
    setResendSaved(false);
    setResendTestResult(null);
    try {
      const res = await apiUpdateAppSettingsResend({
        resendEnabled,
        // Only send a key when the admin actually typed a new one — leaving
        // the field blank (and the key already configured) must NOT clear it.
        ...(resendApiKeyInput.trim() ? { resendApiKey: resendApiKeyInput.trim() } : {}),
        resendFromEmail,
        resendFromName,
      });
      setResendApiKeyInput('');
      setResendApiKeyConfigured(res.settings['resend_api_key_configured'] === 'true');
      setResendApiKeyHint(res.settings['resend_api_key_hint'] ?? '');
      setResendSaved(true);
      setTimeout(() => setResendSaved(false), 2500);
    } catch (e) {
      console.error('Failed to save Email settings', e);
    } finally {
      setResendSaving(false);
    }
  };

  const handleClearResendKey = async () => {
    setResendSaving(true);
    setResendTestResult(null);
    try {
      const res = await apiUpdateAppSettingsResend({ resendApiKey: '' });
      setResendApiKeyInput('');
      setResendApiKeyConfigured(res.settings['resend_api_key_configured'] === 'true');
      setResendApiKeyHint('');
    } catch (e) {
      console.error('Failed to clear the Resend API key', e);
    } finally {
      setResendSaving(false);
    }
  };

  const handleTestResend = async () => {
    setResendTesting(true);
    setResendTestResult(null);
    try {
      const res = await apiSendResendTestEmail();
      setResendTestResult({ ok: true, message: `Sent to ${res.to}.` });
    } catch (e) {
      setResendTestResult({ ok: false, message: e instanceof Error ? e.message : 'Send failed' });
    } finally {
      setResendTesting(false);
    }
  };

  const handleReindex = async () => {
    setReindexing(true);
    setReindexResult(null);
    try {
      const res = await apiKnowledgeReindex();
      setReindexResult(res.enqueued);
    } catch (e) {
      console.error('Failed to trigger reindex', e);
    } finally {
      setReindexing(false);
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

  const handleToggleMobile = (newValue: boolean) => {
    if (!newValue) {
      // Disabling: show confirmation dialog first
      setShowMobileDisableConfirm(true);
    } else {
      setMobileSaving(true);
      setMobileEnabled(true);
      apiUpdateAppSettingsMobile(true)
        .catch(() => setMobileEnabled(false))
        .finally(() => setMobileSaving(false));
    }
  };

  const handleConfirmDisableMobile = async () => {
    setMobileSaving(true);
    setShowMobileDisableConfirm(false);
    try {
      await apiUpdateAppSettingsMobile(false);
      setMobileEnabled(false);
    } catch {
      // Revert on error
      setMobileEnabled(true);
    } finally {
      setMobileSaving(false);
    }
  };

  const AI_MODELS: { value: string; label: string; sub: string; badge?: string; badgeColor?: string }[] = [
    { value: 'google/gemini-2.5-flash',            label: 'Gemini 2.5 Flash',    sub: 'Fast · Excellent tool use',         badge: 'Best Value',   badgeColor: 'var(--color-green-deep-2)' },
    { value: 'anthropic/claude-3.7-sonnet',        label: 'Claude 3.7 Sonnet',   sub: 'Best for AI tasks · Expensive',     badge: 'Recommended',  badgeColor: 'var(--color-primary)' },
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
      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-tertiary)', background: 'var(--color-surface-tint)', borderRadius: 6, padding: '2px 6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>ID: {id}</code>
      <button
        onClick={() => copyUserId(id)}
        title="Copy user ID"
        style={{ display: 'flex', alignItems: 'center', gap: 3, fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, color: copiedUserId === id ? 'var(--color-success)' : 'var(--color-primary)', background: copiedUserId === id ? 'rgba(var(--color-success-rgb), 0.10)' : 'var(--color-surface-tint)', border: 'none', borderRadius: 6, padding: '3px 7px', cursor: 'pointer', flexShrink: 0 }}
      >
        <Icon name={copiedUserId === id ? 'check' : 'content_copy'} size={12} color={copiedUserId === id ? 'var(--color-success)' : 'var(--color-primary)'} />
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

  const card = { background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 14, overflow: 'hidden' as const };
  const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between' as const, gap: 12, padding: '14px 18px' };
  const fi = { width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-primary)', background: 'transparent', border: 'none', outline: 'none', padding: '6px 0' };

  const sectionLabel = (text: string, action?: React.ReactNode) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, paddingLeft: 4 }}>
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: 'var(--color-text-quaternary)' }}>{text}</div>
      {action}
    </div>
  );


  const TABS: { id: TabId; label: string; icon: string }[] = [
    { id: 'system',   label: 'System',      icon: 'storage' },
    { id: 'ai',       label: 'AI',          icon: 'smart_toy' },
    { id: 'ai_skills', label: 'AI Skills',  icon: 'auto_awesome' },
    { id: 'email',    label: 'Email',       icon: 'mail' },
    { id: 'security', label: 'Security',    icon: 'shield_lock' },
    { id: 'api',      label: 'API',         icon: 'key' },
    { id: 'mobile',   label: 'Mobile',      icon: 'smartphone' },
    { id: 'users',    label: 'Users',       icon: 'group' },
    { id: 'danger',   label: 'Danger Zone', icon: 'warning' },
  ];

  return (
    <div style={{ flex: 1, height: '100%', overflowY: 'auto' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: isMobile ? '16px 12px 48px' : '32px 32px 48px', display: 'flex', flexDirection: 'column', gap: 24, width: '100%' }}>
        <h1 style={{ fontFamily: 'var(--font-heading)', fontSize: 28, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.02em' }}>Settings</h1>

        {isAdmin ? (
          <>
            {/* Tab bar */}
            <div style={{ display: 'flex', flexWrap: isMobile ? 'nowrap' : 'wrap', gap: 4, background: 'var(--color-surface-tint)', borderRadius: 14, padding: 4, overflowX: isMobile ? 'auto' : undefined, WebkitOverflowScrolling: 'touch', flexShrink: 0 }}>
              {TABS.map(tab => {
                const active = activeTab === tab.id;
                const isDanger = tab.id === 'danger';
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600,
                      color: active ? (isDanger ? 'var(--color-white)' : 'var(--color-white)') : (isDanger ? 'var(--color-error)' : 'var(--color-primary)'),
                      background: active ? (isDanger ? 'var(--color-error)' : 'var(--color-primary)') : 'transparent',
                      border: 'none', borderRadius: 10,
                      padding: '7px 14px',
                      cursor: 'pointer',
                      flex: '1 1 auto',
                      justifyContent: 'center',
                      minWidth: 0,
                    }}
                    onMouseEnter={e => { if (!active) e.currentTarget.style.background = isDanger ? 'rgba(var(--color-error-rgb), 0.08)' : 'var(--color-surface-tint-4)'; }}
                    onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <Icon name={tab.icon} size={15} color={active ? 'var(--color-white)' : (isDanger ? 'var(--color-error)' : 'var(--color-primary)')} />
                    <span style={{ whiteSpace: 'nowrap' }}>{tab.label}</span>
                  </button>
                );
              })}
            </div>

            {/* ── System Tab ── */}
            {activeTab === 'system' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {/* Apps */}
                {sectionLabel('Apps')}
                <div style={card}>
                  <div style={{ padding: '16px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Installed apps</div>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                        {installedApps.length === 0 ? 'No optional apps installed yet.' : `${installedApps.length} app${installedApps.length === 1 ? '' : 's'} installed.`}
                        {' '}Optional features stay hidden from every user until you install them here.
                      </div>
                    </div>
                    <MotionButton
                      onClick={() => setShowAppsStore(true)}
                      style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '10px 18px', borderRadius: 10, border: 'none', background: 'var(--color-primary)', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', flexShrink: 0, boxShadow: '0 4px 14px rgba(var(--color-primary-rgb), 0.28)' }}
                      whileHover={{ filter: 'brightness(0.92)' }}
                      transition={{ duration: 0.15 }}
                    >
                      <Icon name="apps" size={16} color="var(--color-white)" />
                      Discover Apps
                    </MotionButton>
                  </div>
                </div>

                {/* Disk Storage */}
                {sectionLabel('Disk Storage')}
                <div style={card}>
                  {storageLoading ? (
                    <div style={{ ...row, justifyContent: 'center' }}>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>Loading…</div>
                    </div>
                  ) : storage === null ? (
                    <div style={{ ...row, justifyContent: 'center' }}>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>Unable to read disk usage.</div>
                    </div>
                  ) : (() => {
                    const fmt = (b: number) => {
                      if (b >= 1e12) return `${(b / 1e12).toFixed(1)} TB`;
                      if (b >= 1e9)  return `${(b / 1e9).toFixed(1)} GB`;
                      return `${(b / 1e6).toFixed(1)} MB`;
                    };
                    const pct = Math.round((storage.used / storage.total) * 100);
                    const barColor = pct >= 90 ? 'var(--color-error)' : pct >= 70 ? 'var(--color-warning)' : 'var(--color-primary)';
                    return (
                      <div style={{ padding: '18px 18px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Used Space</div>
                          <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600, color: barColor, background: pct >= 90 ? 'var(--color-error-bg)' : pct >= 70 ? 'var(--color-yellow-tint-1)' : 'var(--color-surface-tint)', borderRadius: 9999, padding: '2px 9px' }}>{pct}% used</span>
                        </div>
                        <div style={{ background: 'var(--color-border-alt)', borderRadius: 99, height: 8, overflow: 'hidden', marginBottom: 12 }}>
                          <motion.div animate={{ width: `${pct}%` }} transition={{ duration: 0.6, ease: 'easeInOut' }} style={{ height: '100%', background: barColor, borderRadius: 99 }} />
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <div style={{ display: 'flex', gap: 20 }}>
                            <div>
                              <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Used</div>
                              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>{fmt(storage.used)}</div>
                            </div>
                            <div>
                              <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Available</div>
                              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>{fmt(storage.available)}</div>
                            </div>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Total</div>
                            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>{fmt(storage.total)}</div>
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
                        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Storage limit per user</div>
                        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>Admins are exempt and always have unlimited storage.</div>
                      </div>
                      <MotionIn animate={{ borderColor: quotaInputFocus ? 'var(--color-primary)' : 'var(--color-border-alt)' }} transition={{ duration: 0.2 }} style={{ display: 'flex', alignItems: 'center', background: 'var(--color-white)', borderWidth: 1.5, borderStyle: 'solid', borderRadius: 10, overflow: 'hidden' }}>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={quotaGb}
                          onChange={e => { setQuotaGb(e.target.value); setSystemSaved(false); }}
                          onFocus={() => setQuotaInputFocus(true)}
                          onBlur={() => setQuotaInputFocus(false)}
                          onKeyDown={e => { if (e.key === 'Enter') handleSaveSystem(); }}
                          style={{ width: 64, fontFamily: 'var(--font-body)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', background: 'transparent', border: 'none', outline: 'none', padding: '8px 10px', textAlign: 'right' }}
                        />
                        <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', paddingRight: 10, paddingLeft: 2, userSelect: 'none' }}>GB</span>
                      </MotionIn>
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
                        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Enable AI Assistant</div>
                        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>Show the AI assistant bubble for all users on this instance.</div>
                      </div>
                      <MotionButton
                        onClick={() => { setAiEnabled(v => !v); setAiSaved(false); }}
                        style={{
                          width: 44, height: 24, borderRadius: 12,
                          border: 'none', cursor: 'pointer',
                          position: 'relative', flexShrink: 0,
                        }}
                        animate={{ background: aiEnabled ? 'var(--color-primary)' : 'var(--color-border)' }}
                        transition={{ duration: 0.2 }}
                      >
                        <motion.span
                          animate={{ left: aiEnabled ? 22 : 2 }}
                          transition={{ duration: 0.2 }}
                          style={{
                          position: 'absolute', top: 2,
                          width: 20, height: 20, borderRadius: '50%',
                          background: 'var(--color-white)', boxShadow: '0 1px 4px rgba(var(--color-black-rgb), 0.2)',
                        }} />
                      </MotionButton>
                    </div>

                    <div style={{ height: 1, background: 'var(--color-surface-tint-2)' }} />

                    {/* Model picker */}
                    <div>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: 8 }}>AI Model</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {AI_MODELS.map(m => {
                          const selected = aiModel === m.value;
                          return (
                            <MotionButton
                              key={m.value}
                              onClick={() => { setAiModel(m.value); setAiSaved(false); }}
                              style={{
                                display: 'flex', alignItems: 'center', gap: 10,
                                padding: '9px 12px', borderRadius: 10, cursor: 'pointer',
                                borderWidth: 1.5, borderStyle: 'solid',
                                textAlign: 'left', width: '100%',
                              }}
                              animate={{
                                borderColor: selected ? 'var(--color-primary)' : 'var(--color-border)',
                                background: selected ? 'var(--color-purple-pale-14)' : 'var(--color-surface-neutral)',
                              }}
                              transition={{ duration: 0.15 }}
                            >
                              <motion.span
                                animate={{
                                  borderWidth: selected ? 4 : 2,
                                  borderColor: selected ? 'var(--color-primary)' : 'var(--color-purple-tint-8)',
                                  background: selected ? 'var(--color-white)' : 'transparent',
                                }}
                                transition={{ duration: 0.15 }}
                                style={{
                                  width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
                                  borderStyle: 'solid',
                                }} />
                              <span style={{ flex: 1, minWidth: 0 }}>
                                <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', display: 'block' }}>{m.label}</span>
                                <span style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-purple-mid-7)' }}>{m.sub}</span>
                              </span>
                              {m.badge && (
                                <span style={{
                                  fontFamily: 'var(--font-body)', fontSize: 10.5, fontWeight: 700,
                                  color: 'var(--color-white)', background: m.badgeColor ?? 'var(--color-primary)',
                                  borderRadius: 5, padding: '2px 7px', flexShrink: 0,
                                  letterSpacing: '0.02em',
                                }}>
                                  {m.badge}
                                </span>
                              )}
                            </MotionButton>
                          );
                        })}
                      </div>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-quaternary)', marginTop: 8 }}>
                        Requires <code style={{ background: 'var(--color-surface-tint-2)', padding: '1px 5px', borderRadius: 4 }}>OPENROUTER_API_KEY</code> set in your environment.
                      </div>
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <SaveButton onClick={handleSaveAI} saving={aiSaving} saved={aiSaved} />
                </div>

                {/* ── Knowledge Search ── */}
                {sectionLabel('Knowledge Search')}
                <div style={card}>
                  <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                      <div>
                        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Enable Knowledge Search</div>
                        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>Search over the CONTENT of notes, pages, milestones, and meetings — not just titles. Works lexically (trigram) with zero setup; add an embedding provider below for semantic (meaning-based) results too.</div>
                      </div>
                      <MotionButton
                        onClick={() => { setKnowledgeSearchEnabled(v => !v); setKnowledgeSaved(false); }}
                        animate={{ background: knowledgeSearchEnabled ? 'var(--color-primary)' : 'var(--color-border)' }} transition={{ duration: 0.2 }} style={{ width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0 }}
                      >
                        <motion.span animate={{ left: knowledgeSearchEnabled ? 22 : 2 }} transition={{ duration: 0.2 }} style={{ position: 'absolute', top: 2, width: 20, height: 20, borderRadius: '50%', background: 'var(--color-white)', boxShadow: '0 1px 4px rgba(var(--color-black-rgb), 0.2)' }} />
                      </MotionButton>
                    </div>

                    <div style={{ height: 1, background: 'var(--color-surface-tint-2)' }} />

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <div>
                        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: 6 }}>Embedding provider base URL</div>
                        <input
                          value={embeddingBaseUrl}
                          onChange={e => { setEmbeddingBaseUrl(e.target.value); setKnowledgeSaved(false); }}
                          placeholder="https://api.openai.com/v1 (default)"
                          style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 13, border: '1.5px solid var(--color-border)', borderRadius: 8, padding: '8px 10px', outline: 'none' }}
                        />
                      </div>
                      <div>
                        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: 6 }}>Embedding model</div>
                        <input
                          value={embeddingModel}
                          onChange={e => { setEmbeddingModel(e.target.value); setKnowledgeSaved(false); }}
                          placeholder="text-embedding-3-small (default)"
                          style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 13, border: '1.5px solid var(--color-border)', borderRadius: 8, padding: '8px 10px', outline: 'none' }}
                        />
                      </div>
                      <div>
                        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: 6 }}>Monthly token budget</div>
                        <input
                          type="number"
                          min={0}
                          value={embeddingBudget}
                          onChange={e => { setEmbeddingBudget(e.target.value); setKnowledgeSaved(false); }}
                          placeholder="0 = unlimited"
                          style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 13, border: '1.5px solid var(--color-border)', borderRadius: 8, padding: '8px 10px', outline: 'none' }}
                        />
                      </div>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-quaternary)' }}>
                        Requires <code style={{ background: 'var(--color-surface-tint-2)', padding: '1px 5px', borderRadius: 4 }}>EMBEDDING_API_KEY</code> (falls back to <code style={{ background: 'var(--color-surface-tint-2)', padding: '1px 5px', borderRadius: 4 }}>OPENROUTER_API_KEY</code>) set in your environment.
                      </div>
                    </div>

                    {knowledgeStatus && (
                      <>
                        <div style={{ height: 1, background: 'var(--color-surface-tint-2)' }} />
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
                          <div>
                            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 10.5, fontWeight: 700, color: 'var(--color-text-quaternary)', textTransform: 'uppercase' as const }}>Semantic search</div>
                            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: knowledgeStatus.pgvectorAvailable && knowledgeStatus.providerConfigured ? 'var(--color-success)' : 'var(--color-text-tertiary)' }}>
                              {knowledgeStatus.pgvectorAvailable ? (knowledgeStatus.providerConfigured ? 'Active' : 'pgvector ready, no provider key') : 'Unavailable (needs pgvector/pgvector:pg16)'}
                            </div>
                          </div>
                          <div>
                            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 10.5, fontWeight: 700, color: 'var(--color-text-quaternary)', textTransform: 'uppercase' as const }}>Indexed</div>
                            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-secondary)' }}>{knowledgeStatus.queue.done} done · {knowledgeStatus.queue.pending + knowledgeStatus.queue.processing} pending</div>
                          </div>
                          <div>
                            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 10.5, fontWeight: 700, color: 'var(--color-text-quaternary)', textTransform: 'uppercase' as const }}>Tokens this month</div>
                            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-secondary)' }}>
                              {knowledgeStatus.budget.usedThisMonth.toLocaleString()}{knowledgeStatus.budget.monthlyLimit > 0 ? ` / ${knowledgeStatus.budget.monthlyLimit.toLocaleString()}` : ''}
                            </div>
                          </div>
                        </div>
                      </>
                    )}

                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <button
                        onClick={handleReindex}
                        disabled={reindexing}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-white)', cursor: reindexing ? 'default' : 'pointer', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-secondary)', opacity: reindexing ? 0.6 : 1 }}
                      >
                        <Icon name={reindexing ? 'progress_activity' : 'refresh'} size={14} color="var(--color-text-tertiary)" />
                        {reindexing ? 'Re-indexing…' : 'Re-index everything'}
                      </button>
                      {reindexResult !== null && (
                        <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-success)' }}>Queued {reindexResult} item(s).</span>
                      )}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <SaveButton onClick={handleSaveKnowledge} saving={knowledgeSaving} saved={knowledgeSaved} />
                </div>

                {/* ── Claude MCP Integration ── */}
                {sectionLabel('Claude MCP Integration')}
                <div style={{ ...card }}>
                  <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {!installedApps.includes('mcp') && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--color-surface-tint)', border: '1px solid var(--color-border)', borderRadius: 10, padding: '10px 14px' }}>
                        <Icon name="info" size={16} color="var(--color-primary)" />
                        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-secondary)', flex: 1 }}>
                          Not installed yet — this stays hidden from every user until you install it from <strong>Discover Apps</strong>.
                        </div>
                        <button onClick={() => setShowAppsStore(true)}
                          style={{ flexShrink: 0, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', background: 'var(--color-white)', border: '1px solid var(--color-purple-pale-45)', borderRadius: 8, padding: '6px 12px', cursor: 'pointer' }}>
                          Install
                        </button>
                      </div>
                    )}
                    {/* Toggle row */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                      <div>
                        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Enable Claude MCP</div>
                        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>Allow users to connect Claude via the MCP server. Disabling immediately revokes all active connections for all users.</div>
                      </div>
                      <MotionButton
                        onClick={() => !mcpSaving && handleToggleMcp(!mcpEnabled)}
                        disabled={mcpSaving}
                        style={{
                          width: 44, height: 24, borderRadius: 12,
                          border: 'none', cursor: mcpSaving ? 'wait' : 'pointer',
                          position: 'relative', flexShrink: 0,
                        }}
                        animate={{ background: mcpSaving ? 'var(--color-border-strong)' : mcpEnabled ? 'var(--color-primary)' : 'var(--color-border)' }}
                        transition={{ duration: 0.2 }}
                      >
                        <motion.span
                          animate={{ left: mcpEnabled ? 22 : 2 }}
                          transition={{ duration: 0.2 }}
                          style={{
                          position: 'absolute', top: 2,
                          width: 20, height: 20, borderRadius: '50%',
                          background: 'var(--color-white)', boxShadow: '0 1px 4px rgba(var(--color-black-rgb), 0.2)',
                        }} />
                      </MotionButton>
                    </div>

                    {/* Confirmation dialog — shown inline when admin clicks to disable */}
                    {showMcpDisableConfirm && (
                      <PopIn duration={160} ease="settle" style={{ background: 'var(--color-orange-pale-1)', border: '1.5px solid var(--color-error-bg)', borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                          <Icon name="warning" size={18} color="var(--color-error)" />
                          <div>
                            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 700, color: 'var(--color-error)', marginBottom: 4 }}>Disable Claude MCP for all users?</div>
                            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.55 }}>
                              This will <strong>immediately revoke all Claude connections</strong> across the entire instance. Every user will be disconnected and will need to reconnect once MCP is re-enabled. This action cannot be undone.
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                          <button
                            onClick={() => setShowMcpDisableConfirm(false)}
                            style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)', background: 'var(--color-gray-pale-1)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '8px 16px', cursor: 'pointer' }}
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleConfirmDisableMcp}
                            style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-error)', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer' }}
                          >
                            Disable MCP &amp; revoke all connections
                          </button>
                        </div>
                      </PopIn>
                    )}
                  </div>
                </div>

                {/* ── Usage Analytics ── */}
                {sectionLabel('Token Usage — Last 30 Days')}

                {usageLoading && (
                  <div style={{ ...card, padding: '32px', textAlign: 'center' as const }}>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>Loading usage data…</div>
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
                          { label: 'Total Tokens', value: fmtTokens(usage.totals.totalTokens), icon: 'bolt', color: 'var(--color-primary)' },
                          { label: 'Est. Cost', value: fmtCost(totalCost), icon: 'payments', color: 'var(--color-success)' },
                          { label: 'Total Requests', value: usage.totals.requestCount.toLocaleString(), icon: 'chat_bubble', color: 'var(--color-warning-alt)' },
                        ].map(stat => (
                          <div key={stat.label} style={{ background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 12, padding: '16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 30, height: 30, borderRadius: 8, background: stat.color + '1a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <Icon name={stat.icon} size={16} color={stat.color} />
                              </div>
                              <div style={{ fontFamily: 'var(--font-body)', fontSize: 10, color: 'var(--color-text-quaternary)', textTransform: 'uppercase' as const, letterSpacing: '0.07em', fontWeight: 600 }}>{stat.label}</div>
                            </div>
                            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)', lineHeight: 1 }}>{stat.value}</div>
                          </div>
                        ))}
                      </div>

                      {/* Bar chart */}
                      <div style={{ ...card, padding: '16px 18px 12px' }}>
                        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase' as const, letterSpacing: '0.07em', marginBottom: 10 }}>Daily Token Usage</div>
                        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}>
                          {/* Y-axis grid + labels */}
                          {([0, 0.25, 0.5, 0.75, 1] as const).map(frac => {
                            const y = padT + plotH * (1 - frac);
                            return (
                              <g key={frac}>
                                <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="var(--color-surface-tint-2)" strokeWidth={1} />
                                {frac > 0 && (
                                  <text x={padL - 5} y={y + 3.5} textAnchor="end" fontFamily="Inter, sans-serif" fontSize="9" fill="var(--color-text-quaternary)">
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
                                  <motion.rect
                                    x={x} y={y} width={barW} height={barH} rx={3}
                                    animate={{ fill: isHov ? 'var(--color-purple-mid-10)' : 'var(--color-primary)' }}
                                    transition={{ duration: 0.1 }}
                                    style={{ cursor: 'pointer' }}
                                    onMouseEnter={() => setHoveredBar({ x: x + barW / 2, y, date, total, prompt: data?.prompt ?? 0, completion: data?.completion ?? 0 })}
                                    onMouseLeave={() => setHoveredBar(null)}
                                  />
                                ) : (
                                  <rect x={x} y={padT + plotH - 2} width={barW} height={2} rx={1} fill="var(--color-purple-pale-20)" />
                                )}
                                {showLabel && (
                                  <text x={padL + i * slotW + slotW / 2} y={H - 4} textAnchor="middle" fontFamily="Inter, sans-serif" fontSize="8.5" fill="var(--color-text-quaternary)">{lStr}</text>
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
                                <rect x={tx - 76} y={ttTop} width={152} height={ttH} rx={7} fill="rgba(var(--color-text-primary-rgb), 0.93)" />
                                <text x={tx} y={ttTop + 17} textAnchor="middle" fontFamily="Inter, sans-serif" fontSize="9" fill="var(--color-accent-purple-light)">
                                  {new Date(hoveredBar.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                                </text>
                                <text x={tx} y={ttTop + 35} textAnchor="middle" fontFamily="Hanken Grotesk, sans-serif" fontSize="14" fontWeight="700" fill="var(--color-white)">
                                  {fmtTokens(hoveredBar.total)} tokens
                                </text>
                                <text x={tx} y={ttTop + 52} textAnchor="middle" fontFamily="Inter, sans-serif" fontSize="9" fill="var(--color-accent-purple-light)">
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
                          <div style={{ display: 'flex', alignItems: 'center', padding: '10px 18px', borderBottom: '1px solid var(--color-surface-tint-2)' }}>
                            <div style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase' as const, letterSpacing: '0.07em' }}>Model</div>
                            {['Requests', 'Tokens In', 'Tokens Out', 'Est. Cost'].map(h => (
                              <div key={h} style={{ width: 84, textAlign: 'right' as const, fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase' as const, letterSpacing: '0.07em' }}>{h}</div>
                            ))}
                          </div>
                          {usage.byModel.map((m, idx) => {
                            const cost = calcCost(m.model, m.promptTokens, m.completionTokens);
                            const info = MODEL_PRICING[m.model];
                            const label = info?.label ?? (m.model.split('/').pop() ?? m.model);
                            const color = info?.color ?? 'var(--color-primary)';
                            const isLast = idx === usage.byModel.length - 1;
                            return (
                              <div key={m.model} style={{ display: 'flex', alignItems: 'center', padding: '10px 18px', borderBottom: isLast ? 'none' : '1px solid var(--color-purple-pale-8)' }}>
                                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                                  <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{label}</span>
                                </div>
                                <div style={{ width: 84, textAlign: 'right' as const, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-secondary)' }}>{m.requestCount.toLocaleString()}</div>
                                <div style={{ width: 84, textAlign: 'right' as const, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-secondary)' }}>{fmtTokens(m.promptTokens)}</div>
                                <div style={{ width: 84, textAlign: 'right' as const, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-secondary)' }}>{fmtTokens(m.completionTokens)}</div>
                                <div style={{ width: 84, textAlign: 'right' as const, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{fmtCost(cost)}</div>
                              </div>
                            );
                          })}
                          <div style={{ padding: '9px 18px', borderTop: '1px solid var(--color-surface-tint-2)', fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', display: 'flex', alignItems: 'center', gap: 5 }}>
                            <Icon name="info" size={12} color="var(--color-text-quaternary)" />
                            Estimates based on OpenRouter published rates. Actual billing may differ.
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()}

                {!usageLoading && !usage && (
                  <div style={{ ...card, padding: '32px', textAlign: 'center' as const }}>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>No AI usage data for the last 30 days.</div>
                  </div>
                )}
              </div>
            )}

            {/* ── AI Skills Tab ── */}
            {activeTab === 'ai_skills' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {sectionLabel('AI Skills')}
                <div style={card}>
                  <div style={{ padding: '16px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Skill bundles</div>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                        {aiSkills.length === 0 ? 'No skills yet.' : `${aiSkills.length} skill${aiSkills.length === 1 ? '' : 's'}, ${aiSkills.filter(s => s.enabled).length} enabled.`}
                        {' '}Admin-curated context that personalizes Sol, the workspace Agent, and MCP clients.
                      </div>
                    </div>
                    <MotionButton
                      onClick={() => setShowSkillUploadModal(true)}
                      style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '10px 18px', borderRadius: 10, border: 'none', background: 'var(--color-primary)', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', flexShrink: 0, boxShadow: '0 4px 14px rgba(var(--color-primary-rgb), 0.28)' }}
                      whileHover={{ filter: 'brightness(0.92)' }}
                      transition={{ duration: 0.15 }}
                    >
                      <Icon name="add" size={16} color="var(--color-white)" />
                      Add Skill
                    </MotionButton>
                  </div>
                </div>

                {aiSkillsLoading && !aiSkillsLoaded ? (
                  <div style={card}>
                    <div style={{ ...row, justifyContent: 'center' }}>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>Loading…</div>
                    </div>
                  </div>
                ) : aiSkills.length === 0 ? (
                  <div style={{ ...card, padding: '40px 20px', textAlign: 'center' as const, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 52, height: 52, borderRadius: 16, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Icon name="auto_awesome" size={24} color="var(--color-primary)" />
                    </div>
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)' }}>No AI Skills yet</div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-tertiary)', maxWidth: 340 }}>Upload a SKILL.md file or a .zip bundle, or write one manually, to give the assistant extra, curated knowledge and instructions.</div>
                  </div>
                ) : (
                  <div style={card}>
                    {aiSkills.map((skill, i) => (
                      <MotionIn
                        key={skill.id}
                        onClick={() => setEditingSkillId(skill.id)}
                        style={{ ...row, borderBottom: i < aiSkills.length - 1 ? '1px solid var(--color-border-alt)' : 'none', cursor: 'pointer', opacity: skill.enabled ? 1 : 0.6 }}
                        whileHover={{ background: 'var(--color-surface-tint-4)' }}
                        transition={{ duration: 0.12 }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{skill.name}</span>
                            {skill.origin === 'ai' && (
                              <span style={{ fontFamily: 'var(--font-body)', fontSize: 9.5, fontWeight: 700, color: 'var(--color-primary)', background: 'var(--color-purple-pale-14)', borderRadius: 5, padding: '1px 6px', letterSpacing: '0.02em', flexShrink: 0 }}>SOL</span>
                            )}
                            {skill.fileCount > 0 && (
                              <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', flexShrink: 0 }}>
                                <Icon name="attach_file" size={11} color="var(--color-text-quaternary)" />{skill.fileCount}
                              </span>
                            )}
                          </div>
                          <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {skill.description || 'No description'}
                          </div>
                        </div>
                        <MotionButton
                          onClick={(e) => { e.stopPropagation(); setAiSkillEnabled(skill.id, !skill.enabled); }}
                          animate={{ background: skill.enabled ? 'var(--color-primary)' : 'var(--color-border)' }} transition={{ duration: 0.2 }} style={{ width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0 }}
                        >
                          <motion.span animate={{ left: skill.enabled ? 20 : 2 }} transition={{ duration: 0.2 }} style={{ position: 'absolute', top: 2, width: 18, height: 18, borderRadius: '50%', background: 'var(--color-white)', boxShadow: '0 1px 4px rgba(var(--color-black-rgb), 0.2)' }} />
                        </MotionButton>
                      </MotionIn>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── Email Tab (Resend) ── */}
            {activeTab === 'email' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {sectionLabel('Email Notifications')}
                <div style={card}>
                  <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                      <div>
                        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Enable email delivery</div>
                        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>Send notification emails via Resend, on top of the in-app bell. Each user chooses which types they get in Account Settings → Notifications.</div>
                      </div>
                      <MotionButton
                        onClick={() => { setResendEnabled(v => !v); setResendSaved(false); }}
                        style={{ width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0 }}
                        animate={{ background: resendEnabled ? 'var(--color-primary)' : 'var(--color-border)' }}
                        transition={{ duration: 0.2 }}
                      >
                        <motion.span animate={{ left: resendEnabled ? 22 : 2 }} transition={{ duration: 0.2 }} style={{ position: 'absolute', top: 2, width: 20, height: 20, borderRadius: '50%', background: 'var(--color-white)', boxShadow: '0 1px 4px rgba(var(--color-black-rgb), 0.2)' }} />
                      </MotionButton>
                    </div>

                    <div style={{ height: 1, background: 'var(--color-surface-tint-2)' }} />

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <div>
                        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: 6 }}>Resend API key</div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <input
                            type="password"
                            value={resendApiKeyInput}
                            onChange={e => { setResendApiKeyInput(e.target.value); setResendSaved(false); }}
                            placeholder={resendApiKeyConfigured ? `Configured — ends in •••• ${resendApiKeyHint}` : 're_xxxxxxxxxxxxxxxxxxxxxxxx'}
                            style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 13, border: '1.5px solid var(--color-border)', borderRadius: 8, padding: '8px 10px', outline: 'none' }}
                            autoComplete="off"
                          />
                          {resendApiKeyConfigured && (
                            <button
                              onClick={handleClearResendKey}
                              disabled={resendSaving}
                              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '7px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-white)', cursor: resendSaving ? 'default' : 'pointer', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-error)', flexShrink: 0 }}
                            >
                              Clear
                            </button>
                          )}
                        </div>
                        <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-quaternary)', marginTop: 6 }}>
                          Stored encrypted. Leave blank to keep the current key. Get one from <code style={{ background: 'var(--color-surface-tint-2)', padding: '1px 5px', borderRadius: 4 }}>resend.com</code> after verifying your sending domain.
                        </div>
                      </div>
                      <div>
                        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: 6 }}>From email</div>
                        <input
                          type="email"
                          value={resendFromEmail}
                          onChange={e => { setResendFromEmail(e.target.value); setResendSaved(false); }}
                          placeholder="notifications@yourdomain.com"
                          style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 13, border: '1.5px solid var(--color-border)', borderRadius: 8, padding: '8px 10px', outline: 'none' }}
                        />
                      </div>
                      <div>
                        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: 6 }}>From name</div>
                        <input
                          value={resendFromName}
                          onChange={e => { setResendFromName(e.target.value); setResendSaved(false); }}
                          placeholder="Solytiq Cloud"
                          style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 13, border: '1.5px solid var(--color-border)', borderRadius: 8, padding: '8px 10px', outline: 'none' }}
                        />
                      </div>
                    </div>

                    <div style={{ height: 1, background: 'var(--color-surface-tint-2)' }} />

                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <button
                        onClick={handleTestResend}
                        disabled={resendTesting || !resendApiKeyConfigured}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-white)', cursor: (resendTesting || !resendApiKeyConfigured) ? 'default' : 'pointer', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-secondary)', opacity: (resendTesting || !resendApiKeyConfigured) ? 0.6 : 1 }}
                      >
                        <Icon name={resendTesting ? 'progress_activity' : 'send'} size={14} color="var(--color-text-tertiary)" />
                        {resendTesting ? 'Sending…' : 'Send test email'}
                      </button>
                      {resendTestResult && (
                        <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: resendTestResult.ok ? 'var(--color-success)' : 'var(--color-error)' }}>{resendTestResult.message}</span>
                      )}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <SaveButton onClick={handleSaveResend} saving={resendSaving} saved={resendSaved} />
                </div>
              </div>
            )}

            {/* ── Security Tab ── */}
            {activeTab === 'security' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {sectionLabel('Security Features')}
                <div style={card}>
                  <div style={{ ...row }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                      <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <Icon name="shield_lock" size={18} color="var(--color-primary)" />
                      </div>
                      <div>
                        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Two-Factor Authentication</div>
                        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                          Allow users to set up 2FA on their accounts via Account Settings.
                        </div>
                      </div>
                    </div>
                    <MotionButton
                      onClick={() => { setTwoFAFeatureEnabled(v => !v); setSecuritySaved(false); }}
                      style={{
                        width: 44, height: 24, borderRadius: 12,
                        border: 'none', cursor: 'pointer',
                        position: 'relative', flexShrink: 0,
                      }}
                      animate={{ background: twoFAFeatureEnabled ? 'var(--color-primary)' : 'var(--color-border)' }}
                      transition={{ duration: 0.2 }}
                    >
                      <motion.span
                        animate={{ left: twoFAFeatureEnabled ? 23 : 3 }}
                        transition={{ duration: 0.2 }}
                        style={{
                        position: 'absolute', top: 3,
                        width: 18, height: 18, borderRadius: '50%',
                        background: 'var(--color-white)', boxShadow: '0 1px 4px rgba(var(--color-black-rgb), 0.18)',
                      }} />
                    </MotionButton>
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
                  <MotionButton
                    onClick={() => setShowApiKeyWizard(true)}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', border: 'none', borderRadius: 8, padding: '5px 12px', cursor: 'pointer' }}
                    whileHover={{ background: 'var(--color-surface-tint-4)' }}
                    transition={{ duration: 0.15 }}
                  >
                    <Icon name="add" size={14} color="var(--color-primary)" />
                    New API key
                  </MotionButton>
                )}
                <div style={card}>
                  <div style={{ padding: '16px 18px' }}>
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)' }}>Instance-wide API access</div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 3 }}>Each key carries its own set of permissions, chosen when you create it. Grant a key only the features an integration needs — read/export, or create &amp; manage users, workspaces, folders, lists, timelines and meetings. Secrets are shown once and stored only as hashes.</div>
                  </div>
                </div>

                {sectionLabel('Endpoints & examples')}
                <div style={card}>
                  <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>Base URL</div>
                    <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-primary)', background: 'var(--color-white)', border: '1px solid var(--color-border-alt)', borderRadius: 10, padding: 10, overflowWrap: 'anywhere' }}>{apiOrigin}</code>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 4 }}>Read everything (needs the <b>read</b> permission):</div>
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-primary)', background: 'var(--color-white)', border: '1px solid var(--color-border-alt)', borderRadius: 10, padding: 10, overflowX: 'auto' }}>{exportExample}</pre>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 4 }}>Create a board for a user (needs the <b>lists</b> permission). Write endpoints accept an optional <b>ownerId</b> — the target user; it defaults to the admin who owns the key:</div>
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-primary)', background: 'var(--color-white)', border: '1px solid var(--color-border-alt)', borderRadius: 10, padding: 10, overflowX: 'auto' }}>{writeExample}</pre>
                  </div>
                </div>

                {sectionLabel('Active keys')}
                <div style={card}>
                  {apiKeysLoading ? <div style={{ ...row, justifyContent: 'center', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>Loading…</div> : apiKeys.length === 0 ? <div style={{ ...row, justifyContent: 'center', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>No API keys yet.</div> : apiKeys.map(k => (
                    <div key={k.id} style={{ ...row, borderBottom: '1px solid var(--color-surface-tint-2)', flexWrap: 'wrap', gap: 10 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)' }}>{k.name}</div>
                        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{k.keyPrefix} · Created {new Date(k.createdAt).toLocaleDateString()} · Last used {k.lastUsedAt ? relativeTime(k.lastUsedAt, now) : 'never'}</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
                          {k.scopes.map(s => {
                            const f = featureForScope(s);
                            return (
                              <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', border: '1px solid var(--color-border)', borderRadius: 9999, padding: '3px 9px' }}>
                                <Icon name={f?.icon ?? 'key'} size={12} color="var(--color-primary)" /> {f?.label ?? s}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                      <button onClick={() => handleRevokeApiKey(k.id)} style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 700, color: 'var(--color-error)', background: 'var(--color-error-bg-alt)', border: '1px solid var(--color-error-bg)', borderRadius: 8, padding: '7px 10px', cursor: 'pointer', alignSelf: 'flex-start' }}>Revoke</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Mobile Tab ── */}
            {activeTab === 'mobile' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {sectionLabel('Mobile App')}
                <div style={{ ...card }}>
                  <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {/* Toggle row */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                      <div>
                        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Allow mobile app connections</div>
                        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>Let users connect the Solytiq Cloud iOS app to this instance and sign in. Disabling immediately signs out every connected device and blocks new mobile logins.</div>
                      </div>
                      <MotionButton
                        onClick={() => !mobileSaving && handleToggleMobile(!mobileEnabled)}
                        disabled={mobileSaving}
                        style={{
                          width: 44, height: 24, borderRadius: 12,
                          border: 'none', cursor: mobileSaving ? 'wait' : 'pointer',
                          position: 'relative', flexShrink: 0,
                        }}
                        animate={{ background: mobileSaving ? 'var(--color-border-strong)' : mobileEnabled ? 'var(--color-primary)' : 'var(--color-border)' }}
                        transition={{ duration: 0.2 }}
                      >
                        <motion.span
                          animate={{ left: mobileEnabled ? 22 : 2 }}
                          transition={{ duration: 0.2 }}
                          style={{
                          position: 'absolute', top: 2,
                          width: 20, height: 20, borderRadius: '50%',
                          background: 'var(--color-white)', boxShadow: '0 1px 4px rgba(var(--color-black-rgb), 0.2)',
                        }} />
                      </MotionButton>
                    </div>

                    {/* Confirmation dialog — shown inline when admin clicks to disable */}
                    {showMobileDisableConfirm && (
                      <PopIn duration={160} ease="settle" style={{ background: 'var(--color-orange-pale-1)', border: '1.5px solid var(--color-error-bg)', borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                          <Icon name="warning" size={18} color="var(--color-error)" />
                          <div>
                            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 700, color: 'var(--color-error)', marginBottom: 4 }}>Disable the mobile app for all users?</div>
                            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.55 }}>
                              This will <strong>immediately sign out every connected mobile device</strong> across the entire instance. Users can still use the app in on-device (local) mode, but will need to reconnect once mobile access is re-enabled.
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                          <button
                            onClick={() => setShowMobileDisableConfirm(false)}
                            style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)', background: 'var(--color-gray-pale-1)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '8px 16px', cursor: 'pointer' }}
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleConfirmDisableMobile}
                            style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-error)', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer' }}
                          >
                            Disable &amp; sign out all devices
                          </button>
                        </div>
                      </PopIn>
                    )}
                  </div>
                </div>

                <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-quaternary)', lineHeight: 1.6 }}>
                  Each user can review and revoke their own connected devices from <strong>Account Settings → Mobile</strong>. The app also works fully offline in on-device mode without connecting to a server.
                </div>
              </div>
            )}

            {/* ── Users Tab ── */}
            {activeTab === 'users' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {sectionLabel('Users',
                  <MotionButton
                    onClick={openAddUser}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', border: 'none', borderRadius: 8, padding: '5px 12px', cursor: 'pointer' }}
                    whileHover={{ background: 'var(--color-surface-tint-4)' }}
                    transition={{ duration: 0.15 }}
                  >
                    <Icon name="person_add" size={14} color="var(--color-primary)" />
                    Add User
                  </MotionButton>
                )}
                <div style={card}>
                  {usersLoading ? (
                    <div style={{ ...row, justifyContent: 'center' }}>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>Loading users…</div>
                    </div>
                  ) : users.length === 0 ? (
                    <div style={{ ...row, justifyContent: 'center' }}>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>No users yet.</div>
                    </div>
                  ) : (
                    <>
                      {previewUsers.map((u, i) => (
                        <div key={u.id} style={{ ...row, borderBottom: i < previewUsers.length - 1 || hasMore ? '1px solid var(--color-surface-tint-2)' : 'none' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                            <UserAvatar name={u.fullName} username={u.username} profileImage={u.profileImage} size={38} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {u.fullName || u.username}
                                </div>
                                {u.isAdmin && (
                                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 700, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', borderRadius: 9999, padding: '1px 7px', textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>Admin</span>
                                )}
                              </div>
                              <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                @{u.username} · {u.email}
                              </div>
                              {renderUserIdCopy(u.id)}
                            </div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <div style={{ width: 6, height: 6, borderRadius: '50%', background: u.lastOnline && now - new Date(u.lastOnline).getTime() < ONLINE_WINDOW_MS ? 'var(--color-success)' : 'var(--color-border)', flexShrink: 0 }} />
                              <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', whiteSpace: 'nowrap' }}>
                                {relativeTime(u.lastOnline, now)}
                              </span>
                            </div>
                            <MotionButton
                              onClick={() => openEditUser(u)}
                              title="Edit user"
                              style={{ width: 28, height: 28, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                              whileHover={{ background: 'var(--color-surface-tint)' }}
                              transition={{ duration: 0.12 }}
                            >
                              <Icon name="edit" size={15} color="var(--color-text-tertiary)" />
                            </MotionButton>
                            {u.id !== userId && (
                              <MotionButton
                                onClick={() => setDeleteTarget(u)}
                                title="Remove user"
                                style={{ width: 28, height: 28, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                                whileHover={{ background: 'var(--color-error-bg-alt)' }}
                                transition={{ duration: 0.12 }}
                              >
                                <Icon name="delete" size={15} color="var(--color-error)" />
                              </MotionButton>
                            )}
                          </div>
                        </div>
                      ))}
                      {hasMore && (
                        <MotionButton
                          onClick={() => { setSearchQuery(''); setRoleFilter('all'); setAllUsersOpen(true); }}
                          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '12px 18px', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-primary)' }}
                          whileHover={{ background: 'var(--color-surface-tint)' }}
                          transition={{ duration: 0.15 }}
                        >
                          <Icon name="group" size={15} color="var(--color-primary)" />
                          Show all {users.length} users
                        </MotionButton>
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
                <div style={{ ...card, border: '1.5px solid var(--color-error-bg)' }}>
                  <div style={{ ...row, background: 'var(--color-error-bg-alt)' }}>
                    <div>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 700, color: 'var(--color-error)' }}>Nuke Everything</div>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>Permanently delete all data. This cannot be undone.</div>
                    </div>
                    <MotionButton
                      onClick={() => setNukeStep(1)}
                      style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-error)', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', flexShrink: 0 }}
                      whileHover={{ background: 'var(--color-red-deep-2)' }}
                      transition={{ duration: 0.15 }}
                    >
                      Nuke
                    </MotionButton>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-quaternary)', textAlign: 'center', padding: '48px 0' }}>
            No settings available.
          </div>
        )}
      </div>

      {/* ── All Users Dialog ── */}
      {allUsersOpen && createPortal(
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) setAllUsersOpen(false); }}
        >
          <ModalIn
            duration={280}
            style={{ background: 'var(--color-white)', borderRadius: 20, width: '100%', maxWidth: 580, maxHeight: '82vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ padding: '22px 24px 0', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="group" size={18} color="var(--color-primary)" />
                  </div>
                  <div>
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)' }}>All Users</div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>{users.length} {users.length === 1 ? 'user' : 'users'} total</div>
                  </div>
                </div>
                <MotionButton
                  onClick={() => setAllUsersOpen(false)}
                  style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--color-surface-tint-2)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  whileHover={{ background: 'var(--color-border)' }}
                  transition={{ duration: 0.15 }}
                >
                  <Icon name="close" size={15} color="var(--color-text-secondary)" />
                </MotionButton>
              </div>
              <MotionIn animate={{ borderColor: searchFocus ? 'var(--color-primary)' : 'var(--color-border-alt)' }} transition={{ duration: 0.2 }} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--color-surface-gray)', borderWidth: 1.5, borderStyle: 'solid', borderRadius: 10, padding: '8px 14px', marginBottom: 14 }}>
                <Icon name="search" size={16} color="var(--color-text-quaternary)" />
                <input
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search by name, username or email…"
                  style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)', background: 'transparent', border: 'none', outline: 'none' }}
                  onFocus={() => setSearchFocus(true)}
                  onBlur={() => setSearchFocus(false)}
                  autoFocus
                />
                {searchQuery && (
                  <button onClick={() => setSearchQuery('')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
                    <Icon name="close" size={14} color="var(--color-text-quaternary)" />
                  </button>
                )}
              </MotionIn>
              <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
                {(['all', 'admin', 'user'] as const).map(f => (
                  <MotionButton
                    key={f}
                    onClick={() => setRoleFilter(f)}
                    animate={{ background: roleFilter === f ? 'var(--color-primary)' : 'var(--color-surface-tint)' }} transition={{ duration: 0.15 }} style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, padding: '5px 14px', borderRadius: 9999, border: 'none', cursor: 'pointer', color: roleFilter === f ? 'var(--color-white)' : 'var(--color-primary)' }}
                    whileHover={roleFilter !== f ? { background: 'var(--color-surface-tint-4)' } : undefined}
                  >
                    {f === 'all' ? `All (${users.length})` : f === 'admin' ? `Admins (${users.filter(u => u.isAdmin).length})` : `Users (${users.filter(u => !u.isAdmin).length})`}
                  </MotionButton>
                ))}
              </div>
            </div>
            <div style={{ overflowY: 'auto', flex: 1, borderTop: '1px solid var(--color-surface-tint-2)' }}>
              {filteredUsers.length === 0 ? (
                <div style={{ padding: '32px 24px', textAlign: 'center', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>
                  No users match your search.
                </div>
              ) : (
                filteredUsers.map((u, i) => (
                  <div key={u.id} style={{ ...row, borderBottom: i < filteredUsers.length - 1 ? '1px solid var(--color-surface-tint-2)' : 'none', padding: '12px 24px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                      <UserAvatar name={u.fullName} username={u.username} profileImage={u.profileImage} size={38} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {u.fullName || u.username}
                          </div>
                          {u.isAdmin && (
                            <span style={{ fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 700, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', borderRadius: 9999, padding: '1px 7px', textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>Admin</span>
                          )}
                        </div>
                        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          @{u.username} · {u.email}
                        </div>
                        {renderUserIdCopy(u.id)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: u.lastOnline && now - new Date(u.lastOnline).getTime() < ONLINE_WINDOW_MS ? 'var(--color-success)' : 'var(--color-border)', flexShrink: 0 }} />
                        <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', whiteSpace: 'nowrap' }}>
                          {relativeTime(u.lastOnline, now)}
                        </span>
                      </div>
                      <MotionButton
                        onClick={() => { setAllUsersOpen(false); openEditUser(u); }}
                        title="Edit user"
                        style={{ width: 28, height: 28, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                        whileHover={{ background: 'var(--color-surface-tint)' }}
                        transition={{ duration: 0.12 }}
                      >
                        <Icon name="edit" size={15} color="var(--color-text-tertiary)" />
                      </MotionButton>
                      {u.id !== userId && (
                        <MotionButton
                          onClick={() => { setAllUsersOpen(false); setDeleteTarget(u); }}
                          title="Remove user"
                          style={{ width: 28, height: 28, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                          whileHover={{ background: 'var(--color-error-bg-alt)' }}
                          transition={{ duration: 0.12 }}
                        >
                          <Icon name="delete" size={15} color="var(--color-error)" />
                        </MotionButton>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </ModalIn>
        </div>,
        document.body
      )}

      {/* ── Add User Modal ── */}
      {addUserOpen && createPortal(
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) closeAddUser(); }}
        >
          <ModalIn
            duration={280}
            style={{ background: 'var(--color-white)', borderRadius: 20, width: '100%', maxWidth: 420, boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '22px 24px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="person_add" size={18} color="var(--color-primary)" />
                </div>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)' }}>Add New User</div>
              </div>
              <MotionButton
                onClick={closeAddUser}
                style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--color-surface-tint-2)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                whileHover={{ background: 'var(--color-border)' }}
                transition={{ duration: 0.15 }}
              >
                <Icon name="close" size={15} color="var(--color-text-secondary)" />
              </MotionButton>
            </div>
            <div style={{ padding: '20px 24px' }}>
              <MotionIn animate={{ borderBottomWidth: fullNameFocus ? 2 : 1, borderBottomColor: fullNameFocus ? 'var(--color-primary)' : 'var(--color-border)' }} transition={{ duration: 0.15 }} style={{ borderBottomStyle: 'solid', paddingBottom: 10, marginBottom: 16 }}>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Full Name</div>
                <input value={newFullName} onChange={e => setNewFullName(e.target.value)} placeholder="Jane Doe" style={fi} onFocus={() => setFullNameFocus(true)} onBlur={() => setFullNameFocus(false)} />
              </MotionIn>
              <MotionIn animate={{ borderBottomWidth: usernameFocus ? 2 : 1, borderBottomColor: usernameFocus ? 'var(--color-primary)' : 'var(--color-border)' }} transition={{ duration: 0.15 }} style={{ borderBottomStyle: 'solid', paddingBottom: 10, marginBottom: 16 }}>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Username <span style={{ color: 'var(--color-error)' }}>*</span></div>
                <input value={newUsername} onChange={e => setNewUsername(e.target.value)} placeholder="janedoe" style={fi} onFocus={() => setUsernameFocus(true)} onBlur={() => setUsernameFocus(false)} />
              </MotionIn>
              <MotionIn animate={{ borderBottomWidth: emailFocus ? 2 : 1, borderBottomColor: emailFocus ? 'var(--color-primary)' : 'var(--color-border)' }} transition={{ duration: 0.15 }} style={{ borderBottomStyle: 'solid', paddingBottom: 10, marginBottom: 16 }}>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Email</div>
                <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="jane@example.com" style={fi} onFocus={() => setEmailFocus(true)} onBlur={() => setEmailFocus(false)} />
              </MotionIn>
              <MotionIn animate={{ borderBottomWidth: passwordFocus ? 2 : 1, borderBottomColor: passwordFocus ? 'var(--color-primary)' : 'var(--color-border)' }} transition={{ duration: 0.15 }} style={{ borderBottomStyle: 'solid', paddingBottom: 10, marginBottom: 20 }}>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Password <span style={{ color: 'var(--color-error)' }}>*</span></div>
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
                  <MotionButton type="button" onClick={generatePassword} title="Generate random password" transition={{ duration: 0.12 }} style={{ width: 28, height: 28, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }} onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint)'; }} onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                    <Icon name="casino" size={16} color="var(--color-text-tertiary)" />
                  </MotionButton>
                  <MotionButton type="button" onClick={copyPassword} disabled={!newPassword} title={passwordCopied ? 'Copied!' : 'Copy password'} transition={{ duration: 0.12 }} style={{ width: 28, height: 28, borderRadius: 7, background: passwordCopied ? 'rgba(var(--color-success-rgb), 0.10)' : 'transparent', border: 'none', cursor: newPassword ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }} onMouseEnter={e => { if (newPassword && !passwordCopied) e.currentTarget.style.background = 'var(--color-surface-tint)'; }} onMouseLeave={e => { if (!passwordCopied) e.currentTarget.style.background = 'transparent'; }}>
                    <Icon name={passwordCopied ? 'check' : 'content_copy'} size={15} color={passwordCopied ? 'var(--color-success)' : newPassword ? 'var(--color-text-tertiary)' : 'var(--color-border)'} />
                  </MotionButton>
                </div>
              </MotionIn>
              {createError && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, padding: '10px 14px', background: 'var(--color-error-bg-alt)', borderRadius: 8, border: '1px solid var(--color-error-bg)' }}>
                  <Icon name="error" size={15} color="var(--color-error)" />
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>{createError}</span>
                </div>
              )}
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={closeAddUser} style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 8, padding: '11px 0', cursor: 'pointer' }} onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-border)'; }} onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }}>Cancel</button>
                <MotionButton onClick={handleCreateUser} disabled={creating || !newUsername.trim() || !newPassword.trim()} transition={{ duration: 0.15 }} style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: creating || !newUsername.trim() || !newPassword.trim() ? 'var(--color-border-strong)' : 'var(--color-primary)', border: 'none', borderRadius: 8, padding: '11px 0', cursor: creating || !newUsername.trim() || !newPassword.trim() ? 'not-allowed' : 'pointer' }} onMouseEnter={e => { if (!creating && newUsername.trim() && newPassword.trim()) e.currentTarget.style.background = 'var(--color-purple-mid-11)'; }} onMouseLeave={e => { if (!creating && newUsername.trim() && newPassword.trim()) e.currentTarget.style.background = 'var(--color-primary)'; }}>
                  {creating ? 'Creating…' : 'Create User'}
                </MotionButton>
              </div>
            </div>
          </ModalIn>
        </div>,
        document.body
      )}

      {/* ── Edit User Modal ── */}
      {editUserOpen && editTarget && createPortal(
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) closeEditUser(); }}
        >
          <ModalIn
            duration={280}
            style={{ background: 'var(--color-white)', borderRadius: 20, width: '100%', maxWidth: 420, boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '22px 24px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="edit" size={18} color="var(--color-primary)" />
                </div>
                <div>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)' }}>Edit User</div>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>@{editTarget.username}</div>
                </div>
              </div>
              <button onClick={closeEditUser} style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--color-surface-tint-2)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-border)'; }} onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }}>
                <Icon name="close" size={15} color="var(--color-text-secondary)" />
              </button>
            </div>
            <div style={{ padding: '20px 24px' }}>
              <MotionIn animate={{ borderBottomWidth: editUsernameFocus ? 2 : 1, borderBottomColor: editUsernameFocus ? 'var(--color-primary)' : 'var(--color-border)' }} transition={{ duration: 0.15 }} style={{ borderBottomStyle: 'solid', paddingBottom: 10, marginBottom: 16 }}>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Username</div>
                <input value={editUsername} onChange={e => setEditUsername(e.target.value)} placeholder={editTarget.username} style={fi} onFocus={() => setEditUsernameFocus(true)} onBlur={() => setEditUsernameFocus(false)} />
              </MotionIn>
              <MotionIn animate={{ borderBottomWidth: editPasswordFocus ? 2 : 1, borderBottomColor: editPasswordFocus ? 'var(--color-primary)' : 'var(--color-border)' }} transition={{ duration: 0.15 }} style={{ borderBottomStyle: 'solid', paddingBottom: 10, marginBottom: 20 }}>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>New Password <span style={{ color: 'var(--color-text-quaternary)', fontWeight: 400 }}>(optional)</span></div>
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
                  <MotionButton type="button" onClick={generateEditPassword} title="Generate random password" transition={{ duration: 0.12 }} style={{ width: 28, height: 28, borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }} onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint)'; }} onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                    <Icon name="casino" size={16} color="var(--color-text-tertiary)" />
                  </MotionButton>
                  <MotionButton type="button" onClick={copyEditPassword} disabled={!editPassword} title={editPasswordCopied ? 'Copied!' : 'Copy password'} transition={{ duration: 0.12 }} style={{ width: 28, height: 28, borderRadius: 7, background: editPasswordCopied ? 'rgba(var(--color-success-rgb), 0.10)' : 'transparent', border: 'none', cursor: editPassword ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }} onMouseEnter={e => { if (editPassword && !editPasswordCopied) e.currentTarget.style.background = 'var(--color-surface-tint)'; }} onMouseLeave={e => { if (!editPasswordCopied) e.currentTarget.style.background = 'transparent'; }}>
                    <Icon name={editPasswordCopied ? 'check' : 'content_copy'} size={15} color={editPasswordCopied ? 'var(--color-success)' : editPassword ? 'var(--color-text-tertiary)' : 'var(--color-border)'} />
                  </MotionButton>
                </div>
              </MotionIn>
              {editError && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, padding: '10px 14px', background: 'var(--color-error-bg-alt)', borderRadius: 8, border: '1px solid var(--color-error-bg)' }}>
                  <Icon name="error" size={15} color="var(--color-error)" />
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>{editError}</span>
                </div>
              )}
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={closeEditUser} style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 8, padding: '11px 0', cursor: 'pointer' }} onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-border)'; }} onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }}>Cancel</button>
                <MotionButton onClick={handleEditUser} disabled={editing} transition={{ duration: 0.15 }} style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: editing ? 'var(--color-border-strong)' : 'var(--color-primary)', border: 'none', borderRadius: 8, padding: '11px 0', cursor: editing ? 'not-allowed' : 'pointer' }} onMouseEnter={e => { if (!editing) e.currentTarget.style.background = 'var(--color-purple-mid-11)'; }} onMouseLeave={e => { if (!editing) e.currentTarget.style.background = 'var(--color-primary)'; }}>
                  {editing ? 'Saving…' : 'Save Changes'}
                </MotionButton>
              </div>
            </div>
          </ModalIn>
        </div>,
        document.body
      )}

      {/* ── Delete User Confirmation Modal ── */}
      {deleteTarget && createPortal(
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) setDeleteTarget(null); }}
        >
          <ModalIn
            duration={280}
            style={{ background: 'var(--color-white)', borderRadius: 20, width: '100%', maxWidth: 380, padding: '28px 28px 24px', boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--color-error-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Icon name="person_remove" size={24} color="var(--color-error)" />
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}>Remove user?</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.6, marginBottom: 24 }}>
              <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>@{deleteTarget.username}</span> will be permanently deleted along with all their data. This cannot be undone.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setDeleteTarget(null)} style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 8, padding: '11px 0', cursor: 'pointer' }} onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-border)'; }} onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }}>Cancel</button>
              <MotionButton onClick={handleDeleteUser} disabled={deleting} transition={{ duration: 0.15 }} style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: deleting ? 'var(--color-border-strong)' : 'var(--color-error)', border: 'none', borderRadius: 8, padding: '11px 0', cursor: deleting ? 'not-allowed' : 'pointer' }} onMouseEnter={e => { if (!deleting) e.currentTarget.style.background = 'var(--color-red-deep-2)'; }} onMouseLeave={e => { if (!deleting) e.currentTarget.style.background = 'var(--color-error)'; }}>
                {deleting ? 'Removing…' : 'Remove User'}
              </MotionButton>
            </div>
          </ModalIn>
        </div>,
        document.body
      )}

      {/* ── Nuke Confirm Modal ── */}
      {nukeStep > 0 && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) setNukeStep(0); }}>
          <ModalIn duration={280} style={{ background: 'var(--color-white)', borderRadius: 16, width: '100%', maxWidth: 420, padding: '28px 32px', boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--color-error-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Icon name="warning" size={24} color="var(--color-error)" />
            </div>
            {nukeStep === 1 && (
              <>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 12 }}>Are you absolutely sure?</div>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.6, marginBottom: 20 }}>This will permanently delete all your tasks, lists, and account data. This action cannot be undone.</div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={() => setNukeStep(0)} style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer' }}>Cancel</button>
                  <button onClick={() => setNukeStep(2)} style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-error)', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer' }}>I understand</button>
                </div>
              </>
            )}
            {nukeStep === 2 && (
              <>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}>Type NUKE to confirm</div>
                <input value={nukeText} onChange={e => setNukeText(e.target.value)} placeholder="NUKE"
                  style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, border: '1.5px solid var(--color-border)', borderRadius: 8, padding: '10px 12px', outline: 'none', marginBottom: 16, boxSizing: 'border-box' }} />
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={() => setNukeStep(0)} style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer' }}>Cancel</button>
                  <button disabled={nukeText !== 'NUKE'} onClick={() => setNukeStep(3)} style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: nukeText === 'NUKE' ? 'var(--color-error)' : 'var(--color-border-strong)', border: 'none', borderRadius: 8, padding: '10px 0', cursor: nukeText === 'NUKE' ? 'pointer' : 'not-allowed' }}>Continue</button>
                </div>
              </>
            )}
            {nukeStep === 3 && (
              <>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}>Confirm your password</div>
                <input type="password" value={nukePw} onChange={e => setNukePw(e.target.value)} placeholder="••••••••"
                  style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, border: '1.5px solid var(--color-border)', borderRadius: 8, padding: '10px 12px', outline: 'none', marginBottom: 16, boxSizing: 'border-box' }} />
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={() => setNukeStep(0)} style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer' }}>Cancel</button>
                  <button onClick={() => { setNukeStep(0); navigate('/nuke', { state: { password: nukePw } }); }} style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-error)', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer' }}>Nuke Everything</button>
                </div>
              </>
            )}
          </ModalIn>
        </div>,
        document.body
      )}

      {/* ── Admin API key wizard ── */}
      {showApiKeyWizard && (
        <AdminApiKeyWizard
          onClose={() => setShowApiKeyWizard(false)}
          onCreated={key => setApiKeys(prev => [key, ...prev])}
        />
      )}

      {/* ── Discover Apps ── */}
      {showAppsStore && (
        <AppsStoreModal onClose={() => { setShowAppsStore(false); loadInstalledApps(); }} />
      )}

      {/* ── AI Skills ── */}
      <AnimatePresence>
        {showSkillUploadModal && (
          <AiSkillUploadModal
            key="ai-skill-upload"
            onClose={() => setShowSkillUploadModal(false)}
            onCreated={(skill) => setEditingSkillId(skill.id)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {editingSkillId && (
          <AiSkillEditModal key="ai-skill-edit" skillId={editingSkillId} onClose={() => setEditingSkillId(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}
