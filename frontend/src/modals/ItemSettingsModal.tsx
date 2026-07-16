import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Folder } from '../types';
import Icon from '../components/Icon';
import EmojiSelector from '../components/EmojiSelector';
import CalendarPicker from '../components/CalendarPicker';
import CreatorBubble from '../components/CreatorBubble';
import { useMobile } from '../hooks/useBreakpoint';
import {
  apiUpdateListShare, apiUpdateTimelineShare, apiUpdateMarkdownListShare,
  apiUpdateList, apiUpdateTimeline, apiUpdateFolder, apiUpdateMarkdownList,
  asVisibilityConflict, type VisibilityConflict,
  type ShareInfo, type ShareUpdate,
} from '../api/client';
import VisibilityConflictModal from '../components/VisibilityConflictModal';
import useWorkspaceStore from '../store/useWorkspaceStore';
import useAuthStore from '../store/useAuthStore';
import useAppStore from '../store/useAppStore';
import useMarkdownListsStore from '../store/useMarkdownListsStore';

const FOLDER_COLORS = [
  'var(--color-primary)', 'var(--color-blue-mid-7)', 'var(--color-green-deep-3)', 'var(--color-orange)',
  'var(--color-pink-mid-3)', 'var(--color-error)', 'var(--color-teal-deep-2)', 'var(--color-blue-mid-8)',
];

const KIND_DISPLAY_NAME: Record<'list' | 'folder' | 'timeline' | 'markdownList', string> = {
  list: 'to-do', folder: 'folder', timeline: 'timeline', markdownList: 'markdown list',
};

const LIST_COLORS = [
  { color: 'var(--color-primary)', bg: 'var(--color-surface-tint)' },
  { color: 'var(--color-blue-mid-7)', bg: 'var(--color-blue-pale-2)' },
  { color: 'var(--color-success)', bg: 'rgba(var(--color-success-rgb), 0.10)' },
  { color: 'var(--color-orange)', bg: 'var(--color-orange-pale-3)' },
  { color: 'var(--color-warning-alt)', bg: 'var(--color-yellow-pale-1)' },
  { color: 'var(--color-error)', bg: 'var(--color-error-bg)' },
];

export interface ItemSettingsUpdates {
  emoji?: string;
  color?: string;
  colorBg?: string;
  isPublic?: boolean;
  folderId?: string | null;
}

interface ItemSettingsModalProps {
  kind: 'list' | 'folder' | 'timeline' | 'markdownList';
  name: string;
  emoji?: string;
  color?: string;
  isPublic?: boolean;
  folders?: Folder[];
  folderId?: string;
  itemId?: string;
  /** The user who created this list/folder/timeline — shown as a badge in the header. */
  creatorId?: string;
  share?: {
    enabled?: boolean;
    token?: string | null;
    hasPassword?: boolean;
    expiresAt?: string | null;
    subpages?: boolean;
    viewMode?: 'list' | 'kanban' | 'timeline' | null;
  };
  onShareUpdated?: (share: ShareInfo) => void;
  onVisibilityApplied?: (isPublic: boolean) => void;
  onChange: (updates: ItemSettingsUpdates) => void;
  onClose: () => void;
}

const sectionLabel = (text: string) => (
  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: 'var(--color-text-quaternary)', marginBottom: 10, paddingLeft: 2 }}>
    {text}
  </div>
);

const card: React.CSSProperties = {
  background: 'var(--color-surface-gray)',
  border: '1px solid var(--color-border-alt)',
  borderRadius: 14,
  overflow: 'hidden',
};

// URL path segment for the public share route — distinct from the modal's
// `kind` prop value (e.g. `markdownList` -&gt; `/share/markdown-list/:token`).
const SHARE_URL_SEGMENT: Record<'list' | 'timeline' | 'markdownList', string> = {
  list: 'list', timeline: 'timeline', markdownList: 'markdown-list',
};
const SHARE_UPDATE_FN: Record<'list' | 'timeline' | 'markdownList', (id: string, data: ShareUpdate) => Promise<{ share: ShareInfo }>> = {
  list: apiUpdateListShare, timeline: apiUpdateTimelineShare, markdownList: apiUpdateMarkdownListShare,
};

// ── Share via link ────────────────────────────────────────────────────────────
function ShareSection({ kind, itemId, share, onShareUpdated }: {
  kind: 'list' | 'timeline' | 'markdownList';
  itemId: string;
  share?: ItemSettingsModalProps['share'];
  onShareUpdated?: (share: ShareInfo) => void;
}) {
  const [enabled, setEnabled]         = useState(Boolean(share?.enabled));
  const [token, setToken]             = useState<string | null>(share?.token ?? null);
  const [hasPassword, setHasPassword] = useState(Boolean(share?.hasPassword));
  const [expiresAt, setExpiresAt]     = useState<string>(share?.expiresAt ? share.expiresAt.slice(0, 10) : '');
  const [subpages, setSubpages]       = useState(Boolean(share?.subpages));
  const [viewMode, setViewMode]       = useState<'list' | 'kanban' | 'timeline'>(
    share?.viewMode === 'kanban' || share?.viewMode === 'timeline' ? share.viewMode : 'list'
  );
  const [pwInput, setPwInput]         = useState('');
  const [saving, setSaving]           = useState(false);
  const [copied, setCopied]           = useState(false);
  const [showPwField, setShowPwField] = useState(false);
  const [showExpiryCal, setShowExpiryCal] = useState(false);

  const shareUrl = token ? `${window.location.origin}/share/${SHARE_URL_SEGMENT[kind]}/${token}` : '';

  const apply = async (update: ShareUpdate) => {
    setSaving(true);
    try {
      const fn = SHARE_UPDATE_FN[kind];
      const { share: next } = await fn(itemId, update);
      setEnabled(next.enabled);
      setToken(next.token);
      setHasPassword(next.hasPassword);
      setExpiresAt(next.expiresAt ? next.expiresAt.slice(0, 10) : '');
      if (next.subpages !== undefined) setSubpages(next.subpages);
      if (next.viewMode) setViewMode(next.viewMode);
      onShareUpdated?.(next);
    } catch (err) {
      console.error('share update failed', err);
    } finally {
      setSaving(false);
    }
  };

  const copyLink = () => {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* On / Off toggle */}
      <div>
        {sectionLabel('Public link')}
        <div style={card}>
          <div style={{ padding: '4px', display: 'flex', gap: 4 }}>
            {([{ label: 'Off', icon: 'link_off', val: false }, { label: 'On', icon: 'link', val: true }] as const).map(opt => {
              const selected = enabled === opt.val;
              return (
                <button key={opt.label}
                  disabled={saving}
                  onClick={() => { if (enabled !== opt.val) apply({ enabled: opt.val }); }}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '10px 12px', borderRadius: 10, border: 'none', background: selected ? 'var(--color-primary)' : 'transparent', cursor: saving ? 'wait' : 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: selected ? 600 : 500, color: selected ? 'var(--color-white)' : 'var(--color-primary)', transition: 'all 120ms' }}>
                  <Icon name={opt.icon} size={15} color={selected ? 'var(--color-white)' : 'var(--color-primary)'} />
                  {opt.label}
                  {selected && <Icon name="check" size={13} color="var(--color-white)" />}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {enabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, animation: 'sectionFadeUp 200ms ease both' }}>
          {/* Copyable link */}
          {shareUrl && (
            <div>
              {sectionLabel('Share URL')}
              <div style={{ background: 'var(--color-surface-tint)', borderRadius: 12, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <Icon name="link" size={16} color="var(--color-primary)" />
                <span style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shareUrl}</span>
                <button onClick={copyLink}
                  style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: copied ? 'var(--color-success)' : 'var(--color-primary)', background: copied ? 'var(--color-green-pale-1)' : 'var(--color-white)', border: `1px solid ${copied ? 'var(--color-green-tint-2)' : 'var(--color-accent-purple-soft-alt)'}`, borderRadius: 7, padding: '5px 12px', cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, transition: 'all 150ms' }}>
                  <Icon name={copied ? 'check' : 'content_copy'} size={12} color={copied ? 'var(--color-success)' : 'var(--color-primary)'} />
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-quaternary)', lineHeight: 1.4, marginTop: 6, paddingLeft: 2 }}>
                <span style={{ marginTop: 1, flexShrink: 0, display: 'flex' }}><Icon name="visibility" size={13} color="var(--color-text-quaternary)" /></span>
                Anyone with this link can view a read-only copy. No sign-in required.
              </div>
            </div>
          )}

          {/* Shared view (lists only) — which layout the public page renders */}
          {kind === 'list' && (
            <div>
              {sectionLabel('Shared view')}
              <div style={card}>
                <div style={{ padding: '4px', display: 'flex', gap: 4 }}>
                  {([
                    { label: 'List', icon: 'format_list_bulleted', val: 'list' },
                    { label: 'Kanban', icon: 'view_kanban', val: 'kanban' },
                    { label: 'Timeline', icon: 'view_timeline', val: 'timeline' },
                  ] as const).map(opt => {
                    const selected = viewMode === opt.val;
                    return (
                      <button key={opt.val}
                        disabled={saving}
                        onClick={() => { if (viewMode !== opt.val) apply({ viewMode: opt.val }); }}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '10px 8px', borderRadius: 10, border: 'none', background: selected ? 'var(--color-primary)' : 'transparent', cursor: saving ? 'wait' : 'pointer', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: selected ? 600 : 500, color: selected ? 'var(--color-white)' : 'var(--color-primary)', transition: 'all 120ms' }}>
                        <Icon name={opt.icon} size={14} color={selected ? 'var(--color-white)' : 'var(--color-primary)'} />
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-quaternary)', marginTop: 6, lineHeight: 1.4, paddingLeft: 2 }}>
                Choose which layout visitors see on the public page — independent of your own view.
              </div>
            </div>
          )}

          {/* Subpages (lists only) */}
          {kind === 'list' && (
            <div>
              {sectionLabel('Subpages')}
              <div style={card}>
                <div style={{ padding: '4px', display: 'flex', gap: 4 }}>
                  {([{ label: 'Keep private', icon: 'lock', val: false }, { label: 'Share too', icon: 'account_tree', val: true }] as const).map(opt => {
                    const selected = subpages === opt.val;
                    return (
                      <button key={opt.label}
                        disabled={saving}
                        onClick={() => { if (subpages !== opt.val) apply({ subpages: opt.val }); }}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '10px 12px', borderRadius: 10, border: 'none', background: selected ? 'var(--color-primary)' : 'transparent', cursor: saving ? 'wait' : 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: selected ? 600 : 500, color: selected ? 'var(--color-white)' : 'var(--color-primary)', transition: 'all 120ms' }}>
                        <Icon name={opt.icon} size={14} color={selected ? 'var(--color-white)' : 'var(--color-primary)'} />
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-quaternary)', marginTop: 6, lineHeight: 1.4, paddingLeft: 2 }}>
                When shared, nested sublists become clickable links on the public page.
              </div>
            </div>
          )}

          {/* Password */}
          <div>
            {sectionLabel('Password')}
            {hasPassword && !showPwField ? (
              <div style={{ ...card, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <Icon name="lock" size={15} color="var(--color-primary)" />
                <span style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-secondary)' }}>Password protected</span>
                <button onClick={() => setShowPwField(true)}
                  style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Change</button>
                <button disabled={saving} onClick={() => apply({ password: null })}
                  style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-error)', background: 'transparent', border: 'none', cursor: saving ? 'wait' : 'pointer' }}>Remove</button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="password"
                  value={pwInput}
                  onChange={e => setPwInput(e.target.value)}
                  placeholder="Set a password (optional)"
                  style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 13, border: '1.5px solid var(--color-border-alt)', borderRadius: 10, padding: '10px 14px', outline: 'none', background: 'var(--color-white)', color: 'var(--color-text-primary)' }}
                  onFocus={e => (e.target.style.borderColor = 'var(--color-primary)')}
                  onBlur={e => (e.target.style.borderColor = 'var(--color-border-alt)')}
                />
                <button disabled={saving || !pwInput.trim()}
                  onClick={() => { apply({ password: pwInput }); setPwInput(''); setShowPwField(false); }}
                  style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: pwInput.trim() ? 'var(--color-primary)' : 'var(--color-border-strong)', border: 'none', borderRadius: 10, padding: '10px 20px', cursor: pwInput.trim() && !saving ? 'pointer' : 'not-allowed', flexShrink: 0 }}>
                  Set
                </button>
              </div>
            )}
          </div>

          {/* Expiry */}
          <div style={{ position: 'relative' }}>
            {sectionLabel('Expiry date')}
            <button
              disabled={saving}
              onClick={() => setShowExpiryCal(s => !s)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 12, padding: '11px 16px', cursor: saving ? 'wait' : 'pointer', fontFamily: 'var(--font-body)', fontSize: 13, color: expiresAt ? 'var(--color-text-primary)' : 'var(--color-text-quaternary)', textAlign: 'left' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-primary)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-border-alt)'; }}
            >
              <Icon name="calendar_today" size={14} color={expiresAt ? 'var(--color-primary)' : 'var(--color-text-quaternary)'} />
              <span style={{ flex: 1 }}>
                {expiresAt ? new Date(expiresAt + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'No expiry'}
              </span>
              {expiresAt && (
                <span onClick={e => { e.stopPropagation(); setShowExpiryCal(false); apply({ expiresAt: null }); }}
                  style={{ color: 'var(--color-text-quaternary)', lineHeight: 1, cursor: 'pointer', padding: '0 2px', fontSize: 16 }}>×</span>
              )}
            </button>
            {showExpiryCal && (
              <div style={{ position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, zIndex: 10 }}>
                <CalendarPicker
                  value={expiresAt}
                  onChange={d => { setShowExpiryCal(false); apply({ expiresAt: d || null }); }}
                  onClear={() => { setShowExpiryCal(false); apply({ expiresAt: null }); }}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Workspace visibility ──────────────────────────────────────────────────────
function AccessibilitySection({ kind, itemId, initialPublic, onApplied }: {
  kind: 'list' | 'folder' | 'timeline' | 'markdownList';
  itemId: string;
  initialPublic?: boolean;
  onApplied?: (isPublic: boolean) => void;
}) {
  const [pub, setPub]           = useState(Boolean(initialPublic));
  const [busy, setBusy]         = useState(false);
  const [conflict, setConflict] = useState<VisibilityConflict | null>(null);
  const [pending, setPending]   = useState(false);
  const loadWorkspaces = useWorkspaceStore(s => s.loadWorkspaces);

  const updateFn = kind === 'list' ? apiUpdateList : kind === 'timeline' ? apiUpdateTimeline : kind === 'markdownList' ? apiUpdateMarkdownList : apiUpdateFolder;

  const apply = async (value: boolean, cascade = false) => {
    setBusy(true);
    const resolving = conflict;
    try {
      await updateFn(itemId, cascade ? { isPublic: value, cascade: true } : { isPublic: value });
      setPub(value);
      setConflict(null);
      onApplied?.(value);
      if (cascade && resolving?.ancestors?.some(a => a.type === 'workspace')) {
        loadWorkspaces();
      }
    } catch (err) {
      const c = asVisibilityConflict(err);
      if (c) { setConflict(c); setPending(value); }
      else console.error('visibility update failed', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ ...card, padding: '4px', display: 'flex', gap: 4 }}>
        {([{ label: 'Private', icon: 'lock', val: false }, { label: 'Public', icon: 'public', val: true }] as const).map(opt => {
          const selected = pub === opt.val;
          return (
            <button key={opt.label}
              disabled={busy}
              onClick={() => { if (pub !== opt.val) apply(opt.val); }}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '10px 12px', borderRadius: 10, border: 'none', background: selected ? 'var(--color-primary)' : 'transparent', cursor: busy ? 'wait' : 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: selected ? 600 : 500, color: selected ? 'var(--color-white)' : 'var(--color-primary)', transition: 'all 120ms' }}>
              <Icon name={opt.icon} size={14} color={selected ? 'var(--color-white)' : 'var(--color-primary)'} />
              {opt.label}
              {selected && <Icon name="check" size={13} color="var(--color-white)" />}
            </button>
          );
        })}
      </div>
      {conflict && (
        <VisibilityConflictModal
          conflict={conflict}
          busy={busy}
          onCancel={() => setConflict(null)}
          onConfirm={() => apply(pending, true)}
        />
      )}
    </div>
  );
}

// ── Tab type ──────────────────────────────────────────────────────────────────
type ItemTab = 'appearance' | 'access' | 'organization' | 'share' | 'admin';

// ── Main modal ────────────────────────────────────────────────────────────────
export default function ItemSettingsModal({ kind, name, emoji, color, isPublic, folders, folderId, itemId, creatorId, share, onShareUpdated, onVisibilityApplied, onChange, onClose }: ItemSettingsModalProps) {
  const isMobile = useMobile();
  const accent = color ?? 'var(--color-primary)';
  const { isAdmin } = useAuthStore();
  const { lists, timelines } = useAppStore();
  const { markdownLists } = useMarkdownListsStore();
  const [copiedAdminId, setCopiedAdminId] = useState(false);

  // Markdown lists have no folder-nesting UI yet (they always render at the
  // workspace root in the Sidebar) — hide the Folder tab rather than show a
  // picker that silently has no effect.
  const hasFolders = kind !== 'folder' && kind !== 'markdownList' && folders && folders.length > 0;
  const hasShare   = kind !== 'folder' && !!itemId;
  const currentList = kind === 'list' && itemId ? lists.find(l => l.id === itemId) : undefined;
  const currentTimeline = kind === 'timeline' && itemId ? timelines.find(t => t.id === itemId) : undefined;
  const currentMarkdownList = kind === 'markdownList' && itemId ? markdownLists.find(m => m.id === itemId) : undefined;
  const listItems = currentList?.sections.flatMap(s => s.tasks) ?? [];
  const milestones = currentTimeline?.milestones ?? [];
  const mdBlocks = currentMarkdownList?.content.blocks ?? [];
  const copyAdminId = () => {
    if (!itemId) return;
    navigator.clipboard.writeText(itemId).then(() => {
      setCopiedAdminId(true);
      setTimeout(() => setCopiedAdminId(false), 1600);
    });
  };

  const tabs: { id: ItemTab; label: string; icon: string }[] = [
    { id: 'appearance',   label: 'Appearance', icon: 'palette' },
    { id: 'access',       label: 'Access',     icon: 'shield_lock' },
    ...(hasFolders ? [{ id: 'organization' as const, label: 'Folder', icon: 'folder_open' }] : []),
    ...(hasShare   ? [{ id: 'share' as const,        label: 'Share',  icon: 'link' }]        : []),
    ...(isAdmin && itemId && kind !== 'folder' ? [{ id: 'admin' as const, label: 'Admin', icon: 'admin_panel_settings' }] : []),
  ];

  const [activeTab, setActiveTab] = useState<ItemTab>('appearance');

  const modal = (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.24)', backdropFilter: 'blur(5px)', zIndex: 1200, display: 'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center', padding: isMobile ? 0 : 24, animation: 'backdropIn 220ms ease both' }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--color-white)', borderRadius: isMobile ? '16px 16px 0 0' : 22, width: '100%', maxWidth: isMobile ? undefined : 720, boxShadow: '0 20px 60px rgba(var(--color-black-rgb), 0.22)', animation: isMobile ? 'slideUp 300ms cubic-bezier(0.22,1,0.36,1) both' : 'settingsModalIn 360ms cubic-bezier(0.22,1,0.36,1) both', overflow: 'hidden', maxHeight: isMobile ? '92vh' : '90vh', display: 'flex', flexDirection: 'column' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '22px 24px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {emoji
                ? <span style={{ fontSize: 18 }}>{emoji}</span>
                : <Icon name={kind === 'folder' ? 'folder' : kind === 'timeline' ? 'timeline' : kind === 'markdownList' ? 'notes' : 'format_list_bulleted'} size={18} color={accent} />
              }
            </div>
            <div>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: isMobile ? 200 : 420 }}>{name}</div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-quaternary)', marginTop: 1 }}>
                {kind === 'folder' ? 'Folder settings' : kind === 'timeline' ? 'Timeline settings' : kind === 'markdownList' ? 'Markdown List settings' : 'To-Do settings'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            {creatorId && <CreatorBubble creatorId={creatorId} taskHovered />}
            <button
              onClick={onClose}
              style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--color-surface-tint-2)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 150ms' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-border)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--color-surface-tint-2)')}
            >
              <Icon name="close" size={15} color="var(--color-text-secondary)" />
            </button>
          </div>
        </div>

        {/* Tab bar */}
        <div style={{ padding: '16px 24px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 4, background: 'var(--color-surface-tint)', borderRadius: 14, padding: 4, overflowX: isMobile ? 'auto' : undefined, WebkitOverflowScrolling: 'touch' }}>
            {tabs.map(tab => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600,
                    color: active ? 'var(--color-white)' : 'var(--color-primary)',
                    background: active ? 'var(--color-primary)' : 'transparent',
                    border: 'none', borderRadius: 10, padding: '8px 14px', cursor: 'pointer',
                    transition: 'all 150ms', flex: '1 1 0', flexBasis: 0, justifyContent: 'center', minWidth: 0,
                  }}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--color-surface-tint-4)'; }}
                  onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                >
                  <Icon name={tab.icon} size={15} color={active ? 'var(--color-white)' : 'var(--color-primary)'} />
                  <span style={{ whiteSpace: 'nowrap' }}>{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px 28px', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* ── APPEARANCE ── */}
          {activeTab === 'appearance' && (
            <div style={{ animation: 'sectionFadeUp 340ms cubic-bezier(0.22,1,0.36,1) both' }}>
              {sectionLabel('Icon')}
              <div style={card}>
                <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 16 }}>
                  <EmojiSelector value={emoji ?? ''} onChange={em => onChange({ emoji: em })} direction="down" size={44} />
                  <div>
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)' }}>Emoji</div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', marginTop: 3 }}>
                      {emoji ? 'Click to change or remove' : 'Click to add an emoji icon'}
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 20 }}>
                {sectionLabel('Color')}
                <div style={card}>
                  <div style={{ padding: '16px 18px', display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                    {kind === 'folder'
                      ? FOLDER_COLORS.map(c => (
                        <button key={c} onClick={() => onChange({ color: c })} title={c}
                          style={{ width: 32, height: 32, borderRadius: '50%', background: c, border: 'none', cursor: 'pointer', padding: 0, outline: 'none', boxShadow: color === c ? `0 0 0 2px white, 0 0 0 4px ${c}` : 'none', transition: 'all 140ms cubic-bezier(0.34,1.56,0.64,1)' }}
                          onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.18)')}
                          onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')} />
                      ))
                      : LIST_COLORS.map(c => (
                        <button key={c.color} onClick={() => onChange({ color: c.color, colorBg: c.bg })} title={c.color}
                          style={{ width: 32, height: 32, borderRadius: '50%', background: c.color, border: 'none', cursor: 'pointer', padding: 0, outline: 'none', boxShadow: color === c.color ? `0 0 0 2px white, 0 0 0 4px ${c.color}` : 'none', transition: 'all 140ms cubic-bezier(0.34,1.56,0.64,1)' }}
                          onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.18)')}
                          onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')} />
                      ))
                    }
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── ACCESS ── */}
          {activeTab === 'access' && (
            <div style={{ animation: 'sectionFadeUp 340ms cubic-bezier(0.22,1,0.36,1) both' }}>
              {sectionLabel('Workspace visibility')}
              {itemId
                ? <AccessibilitySection kind={kind} itemId={itemId} initialPublic={isPublic} onApplied={onVisibilityApplied} />
                : (
                  <div style={{ ...card, padding: '4px', display: 'flex', gap: 4 }}>
                    {([{ label: 'Private', icon: 'lock', val: false }, { label: 'Public', icon: 'public', val: true }] as const).map(opt => {
                      const selected = isPublic === opt.val;
                      return (
                        <button key={opt.label}
                          onClick={() => onChange({ isPublic: opt.val })}
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '10px 12px', borderRadius: 10, border: 'none', background: selected ? 'var(--color-primary)' : 'transparent', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: selected ? 600 : 500, color: selected ? 'var(--color-white)' : 'var(--color-primary)', transition: 'all 120ms' }}>
                          <Icon name={opt.icon} size={14} color={selected ? 'var(--color-white)' : 'var(--color-primary)'} />
                          {opt.label}
                          {selected && <Icon name="check" size={13} color="var(--color-white)" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', marginTop: 10, lineHeight: 1.5, paddingLeft: 2 }}>
                Controls who can see this {KIND_DISPLAY_NAME[kind]} inside your workspace. Does not affect public share links.
              </div>
            </div>
          )}

          {/* ── ORGANIZATION (folder picker) ── */}
          {activeTab === 'organization' && hasFolders && (
            <div style={{ animation: 'sectionFadeUp 340ms cubic-bezier(0.22,1,0.36,1) both' }}>
              {sectionLabel('Folder')}
              <div style={card}>
                {[{ id: null as string | null, name: 'No folder', emoji: undefined as string | undefined, color: undefined as string | undefined }, ...(folders ?? [])].map((f, i, arr) => {
                  const selected = (f.id ?? undefined) === folderId || (f.id === null && !folderId);
                  return (
                    <div key={f.id ?? '__none__'}>
                      <button
                        onClick={() => { if (!selected) onChange({ folderId: f.id }); }}
                        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px', border: 'none', background: selected ? 'var(--color-surface-tint-alt)' : 'transparent', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: selected ? 600 : 450, color: selected ? 'var(--color-primary)' : 'var(--color-text-secondary)', textAlign: 'left', width: '100%', transition: 'background 120ms' }}
                        onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--color-purple-pale-5)'; }}
                        onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}>
                        {f.id === null
                          ? <Icon name="remove_circle_outline" size={17} color={selected ? 'var(--color-primary)' : 'var(--color-text-quaternary)'} />
                          : f.emoji
                            ? <span style={{ fontSize: 16 }}>{f.emoji}</span>
                            : <Icon name="folder" size={17} color={f.color ?? 'var(--color-text-tertiary)'} />
                        }
                        <span style={{ flex: 1 }}>{f.name}</span>
                        {selected && <Icon name="check" size={15} color="var(--color-primary)" />}
                      </button>
                      {i < arr.length - 1 && <div style={{ height: 1, background: 'var(--color-divider)', marginLeft: 18 }} />}
                    </div>
                  );
                })}
              </div>
            </div>
          )}


          {/* ── ADMIN ── */}
          {activeTab === 'admin' && isAdmin && itemId && kind !== 'folder' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18, animation: 'sectionFadeUp 340ms cubic-bezier(0.22,1,0.36,1) both' }}>
              {sectionLabel(`${kind === 'timeline' ? 'Timeline' : kind === 'markdownList' ? 'Markdown List' : 'To-Do'} ID`)}
              <div style={{ background: 'var(--color-surface-tint)', border: '1px solid var(--color-border)', borderRadius: 12, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <code style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{itemId}</code>
                <button onClick={copyAdminId} style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 700, color: copiedAdminId ? 'var(--color-success)' : 'var(--color-primary)', background: 'var(--color-white)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '7px 10px', cursor: 'pointer', flexShrink: 0 }}>
                  <Icon name={copiedAdminId ? 'check' : 'content_copy'} size={13} color={copiedAdminId ? 'var(--color-success)' : 'var(--color-primary)'} />
                  {copiedAdminId ? 'Copied' : 'Copy ID'}
                </button>
              </div>

              {sectionLabel('Stats')}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {(kind === 'list' ? [
                  ['Sections', currentList?.sections.length ?? 0, 'view_list'],
                  ['Items', listItems.length, 'checklist'],
                  ['Completed', listItems.filter(t => t.checked).length, 'task_alt'],
                  ['Private', currentList?.isPublic ? 'No' : 'Yes', currentList?.isPublic ? 'public' : 'lock'],
                ] : kind === 'markdownList' ? [
                  ['Blocks', mdBlocks.length, 'view_agenda'],
                  ['Todos', mdBlocks.filter(b => b.type === 'todo').length, 'checklist'],
                  ['Images', mdBlocks.filter(b => b.type === 'image').length, 'image'],
                  ['Private', currentMarkdownList?.isPublic ? 'No' : 'Yes', currentMarkdownList?.isPublic ? 'public' : 'lock'],
                ] : [
                  ['Milestones', milestones.length, 'flag'],
                  ['Done', milestones.filter(m => m.status === 'done').length, 'task_alt'],
                  ['Upcoming', milestones.filter(m => m.status === 'upcoming').length, 'event_upcoming'],
                  ['Private', currentTimeline?.isPublic ? 'No' : 'Yes', currentTimeline?.isPublic ? 'public' : 'lock'],
                ]).map(([label, value, icon]) => (
                  <div key={String(label)} style={{ background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 14, padding: 14 }}>
                    <Icon name={String(icon)} size={16} color="var(--color-primary)" />
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22, fontWeight: 800, color: 'var(--color-text-primary)', marginTop: 8 }}>{value}</div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{label}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── SHARE ── */}
          {activeTab === 'share' && hasShare && itemId && (
            <div style={{ animation: 'sectionFadeUp 340ms cubic-bezier(0.22,1,0.36,1) both' }}>
              <ShareSection kind={kind as 'list' | 'timeline' | 'markdownList'} itemId={itemId} share={share} onShareUpdated={onShareUpdated} />
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ borderTop: '1px solid var(--color-divider)', padding: '14px 24px 18px', display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
          <button
            onClick={onClose}
            style={{ fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-primary)', border: 'none', borderRadius: 10, padding: '10px 28px', cursor: 'pointer', transition: 'filter 140ms, transform 140ms' }}
            onMouseEnter={e => { e.currentTarget.style.filter = 'brightness(0.88)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
            onMouseLeave={e => { e.currentTarget.style.filter = 'none'; e.currentTarget.style.transform = 'translateY(0)'; }}>
            Done
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
