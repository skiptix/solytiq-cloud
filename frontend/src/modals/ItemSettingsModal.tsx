import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Folder } from '../types';
import Icon from '../components/Icon';
import EmojiSelector from '../components/EmojiSelector';
import CalendarPicker from '../components/CalendarPicker';
import CreatorBubble from '../components/CreatorBubble';
import ItemMembersSection from '../components/ItemMembersSection';
import type { SharedItemType } from '../api/client';
import { useMobile } from '../hooks/useBreakpoint';
import { motion } from '../components/animate-ui/motion';
import MotionButton from '../components/animate-ui/MotionButton';
import MotionIn from '../components/animate-ui/MotionIn';
import { EASE_SETTLE, EASE_STANDARD, EASE_SPRING } from '../components/animate-ui/motionTokens';
import {
  apiUpdateListShare, apiUpdateTimelineShare, apiUpdateMarkdownListShare, apiUpdateFolderShare,
  apiUpdateList, apiUpdateTimeline, apiUpdateFolder, apiUpdateMarkdownList,
  apiGetQuickAddMemory,
  asVisibilityConflict, type VisibilityConflict,
  type ShareInfo, type ShareUpdate,
} from '../api/client';
import VisibilityConflictModal from '../components/VisibilityConflictModal';
import useWorkspaceStore from '../store/useWorkspaceStore';
import useAuthStore from '../store/useAuthStore';
import useAppStore from '../store/useAppStore';
import useMarkdownListsStore from '../store/useMarkdownListsStore';
import useAsyncData from '../hooks/useAsyncData';

const FOLDER_COLORS = [
  'var(--color-primary)', 'var(--color-blue-mid-7)', 'var(--color-green-deep-3)', 'var(--color-orange)',
  'var(--color-pink-mid-3)', 'var(--color-error)', 'var(--color-teal-deep-2)', 'var(--color-blue-mid-8)',
];

const KIND_DISPLAY_NAME: Record<'list' | 'folder' | 'timeline' | 'markdownList', string> = {
  list: 'board', folder: 'folder', timeline: 'timeline', markdownList: 'markdown page',
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
  fullWidth?: boolean;
  folderId?: string | null;
  /** Boards only — the Quick Add bar, staging tray and section prediction. */
  quickAddEnabled?: boolean;
}

interface ItemSettingsModalProps {
  kind: 'list' | 'folder' | 'timeline' | 'markdownList';
  name: string;
  emoji?: string;
  color?: string;
  isPublic?: boolean;
  /** Markdown pages only — whether the page renders full-width in-app. */
  fullWidth?: boolean;
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
    includeAll?: boolean;   // folders only
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
const SHARE_URL_SEGMENT: Record<'list' | 'timeline' | 'markdownList' | 'folder', string> = {
  list: 'list', timeline: 'timeline', markdownList: 'markdown-list', folder: 'folder',
};
const SHARE_UPDATE_FN: Record<'list' | 'timeline' | 'markdownList' | 'folder', (id: string, data: ShareUpdate) => Promise<{ share: ShareInfo }>> = {
  list: apiUpdateListShare, timeline: apiUpdateTimelineShare, markdownList: apiUpdateMarkdownListShare, folder: apiUpdateFolderShare,
};

// ── Share via link ────────────────────────────────────────────────────────────
function ShareSection({ kind, itemId, share, onShareUpdated }: {
  kind: 'list' | 'timeline' | 'markdownList' | 'folder';
  itemId: string;
  share?: ItemSettingsModalProps['share'];
  onShareUpdated?: (share: ShareInfo) => void;
}) {
  const [enabled, setEnabled]         = useState(Boolean(share?.enabled));
  const [token, setToken]             = useState<string | null>(share?.token ?? null);
  const [hasPassword, setHasPassword] = useState(Boolean(share?.hasPassword));
  const [expiresAt, setExpiresAt]     = useState<string>(share?.expiresAt ? share.expiresAt.slice(0, 10) : '');
  const [subpages, setSubpages]       = useState(Boolean(share?.subpages));
  const [includeAll, setIncludeAll]   = useState(Boolean(share?.includeAll));
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
      if (next.includeAll !== undefined) setIncludeAll(next.includeAll);
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
                <MotionButton key={opt.label}
                  disabled={saving}
                  onClick={() => { if (enabled !== opt.val) apply({ enabled: opt.val }); }}
                  animate={{ background: selected ? 'var(--color-primary)' : 'transparent', color: selected ? 'var(--color-white)' : 'var(--color-primary)' }}
                  transition={{ duration: 0.12 }}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '10px 12px', borderRadius: 10, border: 'none', cursor: saving ? 'wait' : 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: selected ? 600 : 500 }}>
                  <Icon name={opt.icon} size={15} color={selected ? 'var(--color-white)' : 'var(--color-primary)'} />
                  {opt.label}
                  {selected && <Icon name="check" size={13} color="var(--color-white)" />}
                </MotionButton>
              );
            })}
          </div>
        </div>
      </div>

      {enabled && (
        <MotionIn initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: EASE_STANDARD }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Copyable link */}
          {shareUrl && (
            <div>
              {sectionLabel('Share URL')}
              <div style={{ background: 'var(--color-surface-tint)', borderRadius: 12, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <Icon name="link" size={16} color="var(--color-primary)" />
                <span style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shareUrl}</span>
                <MotionButton onClick={copyLink}
                  animate={{
                    color: copied ? 'var(--color-success)' : 'var(--color-primary)',
                    background: copied ? 'var(--color-green-pale-1)' : 'var(--color-white)',
                    borderColor: copied ? 'var(--color-green-tint-2)' : 'var(--color-accent-purple-soft-alt)',
                  }}
                  transition={{ duration: 0.15 }}
                  style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, borderWidth: 1, borderStyle: 'solid', borderRadius: 7, padding: '5px 12px', cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Icon name={copied ? 'check' : 'content_copy'} size={12} color={copied ? 'var(--color-success)' : 'var(--color-primary)'} />
                  {copied ? 'Copied!' : 'Copy'}
                </MotionButton>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-quaternary)', lineHeight: 1.4, marginTop: 6, paddingLeft: 2 }}>
                <span style={{ marginTop: 1, flexShrink: 0, display: 'flex' }}><Icon name="visibility" size={13} color="var(--color-text-quaternary)" /></span>
                Anyone with this link can view a read-only copy. No sign-in required.
              </div>
            </div>
          )}

          {/* What to share (folders only) — every item vs only already-shared */}
          {kind === 'folder' && (
            <div>
              {sectionLabel('What to share')}
              <div style={card}>
                <div style={{ padding: '4px', display: 'flex', gap: 4 }}>
                  {([
                    { label: 'All items', icon: 'folder_open', val: true },
                    { label: 'Only shared', icon: 'lock_open', val: false },
                  ] as const).map(opt => {
                    const selected = includeAll === opt.val;
                    return (
                      <MotionButton key={opt.label}
                        disabled={saving}
                        onClick={() => { if (includeAll !== opt.val) apply({ includeAll: opt.val }); }}
                        animate={{ background: selected ? 'var(--color-primary)' : 'transparent', color: selected ? 'var(--color-white)' : 'var(--color-primary)' }}
                        transition={{ duration: 0.12 }}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '10px 8px', borderRadius: 10, border: 'none', cursor: saving ? 'wait' : 'pointer', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: selected ? 600 : 500 }}>
                        <Icon name={opt.icon} size={14} color={selected ? 'var(--color-white)' : 'var(--color-primary)'} />
                        {opt.label}
                      </MotionButton>
                    );
                  })}
                </div>
              </div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-quaternary)', marginTop: 6, lineHeight: 1.4, paddingLeft: 2 }}>
                {includeAll
                  ? 'Every board, timeline and page in this folder is published publicly (inheriting this link’s password & expiry).'
                  : 'Only items you’ve already shared individually appear in the folder’s public navigator.'}
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
                      <MotionButton key={opt.val}
                        disabled={saving}
                        onClick={() => { if (viewMode !== opt.val) apply({ viewMode: opt.val }); }}
                        animate={{ background: selected ? 'var(--color-primary)' : 'transparent', color: selected ? 'var(--color-white)' : 'var(--color-primary)' }}
                        transition={{ duration: 0.12 }}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '10px 8px', borderRadius: 10, border: 'none', cursor: saving ? 'wait' : 'pointer', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: selected ? 600 : 500 }}>
                        <Icon name={opt.icon} size={14} color={selected ? 'var(--color-white)' : 'var(--color-primary)'} />
                        {opt.label}
                      </MotionButton>
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
                      <MotionButton key={opt.label}
                        disabled={saving}
                        onClick={() => { if (subpages !== opt.val) apply({ subpages: opt.val }); }}
                        animate={{ background: selected ? 'var(--color-primary)' : 'transparent', color: selected ? 'var(--color-white)' : 'var(--color-primary)' }}
                        transition={{ duration: 0.12 }}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '10px 12px', borderRadius: 10, border: 'none', cursor: saving ? 'wait' : 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: selected ? 600 : 500 }}>
                        <Icon name={opt.icon} size={14} color={selected ? 'var(--color-white)' : 'var(--color-primary)'} />
                        {opt.label}
                      </MotionButton>
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
        </MotionIn>
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
            <MotionButton key={opt.label}
              disabled={busy}
              onClick={() => { if (pub !== opt.val) apply(opt.val); }}
              animate={{ background: selected ? 'var(--color-primary)' : 'transparent', color: selected ? 'var(--color-white)' : 'var(--color-primary)' }}
              transition={{ duration: 0.12 }}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '10px 12px', borderRadius: 10, border: 'none', cursor: busy ? 'wait' : 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: selected ? 600 : 500 }}>
              <Icon name={opt.icon} size={14} color={selected ? 'var(--color-white)' : 'var(--color-primary)'} />
              {opt.label}
              {selected && <Icon name="check" size={13} color="var(--color-white)" />}
            </MotionButton>
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
type ItemTab = 'appearance' | 'access' | 'organization' | 'share' | 'people' | 'admin';

// ── Main modal ────────────────────────────────────────────────────────────────
export default function ItemSettingsModal({ kind, name, emoji, color, isPublic, fullWidth, folders, folderId, itemId, creatorId, share, onShareUpdated, onVisibilityApplied, onChange, onClose }: ItemSettingsModalProps) {
  const isMobile = useMobile();
  const accent = color ?? 'var(--color-primary)';
  const [fw, setFw] = useState(Boolean(fullWidth));
  const { isAdmin, userId } = useAuthStore();
  const { lists, timelines } = useAppStore();
  const { markdownLists } = useMarkdownListsStore();
  const [copiedAdminId, setCopiedAdminId] = useState(false);

  // Lists, timelines and markdown pages can all live inside a folder; only
  // folders themselves can't be nested.
  const hasFolders = kind !== 'folder' && folders && folders.length > 0;
  const hasShare   = !!itemId;
  const currentList = kind === 'list' && itemId ? lists.find(l => l.id === itemId) : undefined;
  // Buffered like `fw` above: the toggle flips instantly while the PUT is in
  // flight, rather than waiting for the store round trip to repaint it.
  const [quickAdd, setQuickAdd] = useState(Boolean(currentList?.quickAddEnabled));
  const { data: memory } = useAsyncData(
    quickAdd && kind === 'list' && itemId ? itemId : null,
    () => apiGetQuickAddMemory(itemId!),
    null as { remembered: number; events: number } | null,
  );
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
    ...(itemId ? [{ id: 'people' as const, label: 'People', icon: 'group' }] : []),
    ...(isAdmin && itemId && kind !== 'folder' ? [{ id: 'admin' as const, label: 'Admin', icon: 'admin_panel_settings' }] : []),
  ];

  const [activeTab, setActiveTab] = useState<ItemTab>('appearance');

  const modal = (
    <motion.div
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.22, ease: EASE_STANDARD }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.24)', backdropFilter: 'blur(5px)', zIndex: 1200, display: 'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center', padding: isMobile ? 0 : 24 }}>
      <MotionIn
        onClick={e => e.stopPropagation()}
        initial={isMobile ? { opacity: 0.6, y: '100%' } : { opacity: 0, y: 22, scale: 0.96 }}
        animate={isMobile ? { opacity: 1, y: 0 } : { opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: isMobile ? 0.3 : 0.36, ease: EASE_SETTLE }}
        style={{ background: 'var(--color-white)', borderRadius: isMobile ? '16px 16px 0 0' : 22, width: '100%', maxWidth: isMobile ? undefined : 720, boxShadow: '0 20px 60px rgba(var(--color-black-rgb), 0.22)', overflow: 'hidden', maxHeight: isMobile ? '92vh' : '90vh', display: 'flex', flexDirection: 'column' }}>

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
                {kind === 'folder' ? 'Folder settings' : kind === 'timeline' ? 'Timeline settings' : kind === 'markdownList' ? 'Markdown Page settings' : 'Board settings'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            {creatorId && <CreatorBubble creatorId={creatorId} taskHovered />}
            <MotionButton
              onClick={onClose}
              style={{ width: 30, height: 30, borderRadius: '50%', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
              animate={{ background: 'var(--color-surface-tint-2)' }}
              whileHover={{ background: 'var(--color-border)' }}
              transition={{ duration: 0.15 }}
            >
              <Icon name="close" size={15} color="var(--color-text-secondary)" />
            </MotionButton>
          </div>
        </div>

        {/* Tab bar */}
        <div style={{ padding: '16px 24px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 4, background: 'var(--color-surface-tint)', borderRadius: 14, padding: 4, overflowX: isMobile ? 'auto' : undefined, WebkitOverflowScrolling: 'touch' }}>
            {tabs.map(tab => {
              const active = activeTab === tab.id;
              return (
                <MotionButton
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  animate={{
                    color: active ? 'var(--color-white)' : 'var(--color-primary)',
                    background: active ? 'var(--color-primary)' : 'transparent',
                  }}
                  whileHover={!active ? { background: 'var(--color-surface-tint-4)' } : undefined}
                  transition={{ duration: 0.15 }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600,
                    border: 'none', borderRadius: 10, padding: '8px 14px', cursor: 'pointer',
                    flex: '1 1 0', flexBasis: 0, justifyContent: 'center', minWidth: 0,
                  }}
                >
                  <Icon name={tab.icon} size={15} color={active ? 'var(--color-white)' : 'var(--color-primary)'} />
                  <span style={{ whiteSpace: 'nowrap' }}>{tab.label}</span>
                </MotionButton>
              );
            })}
          </div>
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px 28px', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* ── APPEARANCE ── */}
          {activeTab === 'appearance' && (
            <MotionIn initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.34, ease: EASE_SETTLE }}>
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
                        <MotionButton key={c} onClick={() => onChange({ color: c })} title={c}
                          style={{ width: 32, height: 32, borderRadius: '50%', background: c, border: 'none', cursor: 'pointer', padding: 0, outline: 'none', boxShadow: color === c ? `0 0 0 2px white, 0 0 0 4px ${c}` : 'none' }}
                          animate={{ scale: 1 }}
                          whileHover={{ scale: 1.18 }}
                          transition={{ duration: 0.14, ease: EASE_SPRING }} />
                      ))
                      : LIST_COLORS.map(c => (
                        <MotionButton key={c.color} onClick={() => onChange({ color: c.color, colorBg: c.bg })} title={c.color}
                          style={{ width: 32, height: 32, borderRadius: '50%', background: c.color, border: 'none', cursor: 'pointer', padding: 0, outline: 'none', boxShadow: color === c.color ? `0 0 0 2px white, 0 0 0 4px ${c.color}` : 'none' }}
                          animate={{ scale: 1 }}
                          whileHover={{ scale: 1.18 }}
                          transition={{ duration: 0.14, ease: EASE_SPRING }} />
                      ))
                    }
                  </div>
                </div>
              </div>

              {/* Page width (markdown pages only) */}
              {kind === 'markdownList' && (
                <div style={{ marginTop: 20 }}>
                  {sectionLabel('Page width')}
                  <div style={{ ...card, padding: '4px', display: 'flex', gap: 4 }}>
                    {([
                      { label: 'Standard', icon: 'format_align_center', val: false },
                      { label: 'Full width', icon: 'width_full', val: true },
                    ] as const).map(opt => {
                      const selected = fw === opt.val;
                      return (
                        <MotionButton key={opt.label}
                          onClick={() => { if (fw !== opt.val) { setFw(opt.val); onChange({ fullWidth: opt.val }); } }}
                          animate={{ background: selected ? 'var(--color-primary)' : 'transparent', color: selected ? 'var(--color-white)' : 'var(--color-primary)' }}
                          transition={{ duration: 0.12 }}
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '10px 12px', borderRadius: 10, border: 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: selected ? 600 : 500 }}>
                          <Icon name={opt.icon} size={15} color={selected ? 'var(--color-white)' : 'var(--color-primary)'} />
                          {opt.label}
                          {selected && <Icon name="check" size={13} color="var(--color-white)" />}
                        </MotionButton>
                      );
                    })}
                  </div>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-quaternary)', marginTop: 6, lineHeight: 1.4, paddingLeft: 2 }}>
                    Full width stretches sections and side-by-side columns across the whole app — great for wide tables of boxes.
                  </div>
                </div>
              )}

              {/* Quick Add (boards only) */}
              {kind === 'list' && (
                <div style={{ marginTop: 20 }}>
                  {sectionLabel('Quick Add')}
                  <div style={{ ...card, padding: '4px', display: 'flex', gap: 4 }}>
                    {([
                      { label: 'Off', icon: 'block', val: false },
                      { label: 'On', icon: 'bolt', val: true },
                    ] as const).map(opt => {
                      const selected = quickAdd === opt.val;
                      return (
                        <MotionButton key={opt.label}
                          onClick={() => { if (quickAdd !== opt.val) { setQuickAdd(opt.val); onChange({ quickAddEnabled: opt.val }); } }}
                          animate={{ background: selected ? 'var(--color-primary)' : 'transparent', color: selected ? 'var(--color-white)' : 'var(--color-primary)' }}
                          transition={{ duration: 0.12 }}
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '10px 12px', borderRadius: 10, border: 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: selected ? 600 : 500 }}>
                          <Icon name={opt.icon} size={15} color={selected ? 'var(--color-white)' : 'var(--color-primary)'} />
                          {opt.label}
                          {selected && <Icon name="check" size={13} color="var(--color-white)" />}
                        </MotionButton>
                      );
                    })}
                  </div>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-quaternary)', marginTop: 6, lineHeight: 1.4, paddingLeft: 2 }}>
                    Adds an “Add new item” bar under this board's header. New items land in a tray right below it, and the board suggests
                    which section each one belongs in — learned from where items on this board have ended up before.
                  </div>
                  {quickAdd && (
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 8, lineHeight: 1.5, paddingLeft: 2, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                      <Icon name="school" size={14} color="var(--color-accent-purple-light)" />
                      <span>
                        {memory === null
                          ? 'Checking what this board has learned…'
                          : memory.remembered === 0
                            ? 'Nothing learned yet — move a few items into sections and suggestions will start appearing.'
                            : `Knows where ${memory.remembered} ${memory.remembered === 1 ? 'item belongs' : 'items belong'}, from ${memory.events} recorded ${memory.events === 1 ? 'placement' : 'placements'}. Kept as a bubble in this workspace's Knowledge Base.`}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </MotionIn>
          )}

          {/* ── ACCESS ── */}
          {activeTab === 'access' && (
            <MotionIn initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.34, ease: EASE_SETTLE }}>
              {sectionLabel('Workspace visibility')}
              {itemId
                ? <AccessibilitySection kind={kind} itemId={itemId} initialPublic={isPublic} onApplied={onVisibilityApplied} />
                : (
                  <div style={{ ...card, padding: '4px', display: 'flex', gap: 4 }}>
                    {([{ label: 'Private', icon: 'lock', val: false }, { label: 'Public', icon: 'public', val: true }] as const).map(opt => {
                      const selected = isPublic === opt.val;
                      return (
                        <MotionButton key={opt.label}
                          onClick={() => onChange({ isPublic: opt.val })}
                          animate={{ background: selected ? 'var(--color-primary)' : 'transparent', color: selected ? 'var(--color-white)' : 'var(--color-primary)' }}
                          transition={{ duration: 0.12 }}
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '10px 12px', borderRadius: 10, border: 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: selected ? 600 : 500 }}>
                          <Icon name={opt.icon} size={14} color={selected ? 'var(--color-white)' : 'var(--color-primary)'} />
                          {opt.label}
                          {selected && <Icon name="check" size={13} color="var(--color-white)" />}
                        </MotionButton>
                      );
                    })}
                  </div>
                )}
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', marginTop: 10, lineHeight: 1.5, paddingLeft: 2 }}>
                Controls who can see this {KIND_DISPLAY_NAME[kind]} inside your workspace. Does not affect public share links.
              </div>
            </MotionIn>
          )}

          {/* ── ORGANIZATION (folder picker) ── */}
          {activeTab === 'organization' && hasFolders && (
            <MotionIn initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.34, ease: EASE_SETTLE }}>
              {sectionLabel('Folder')}
              <div style={card}>
                {[{ id: null as string | null, name: 'No folder', emoji: undefined as string | undefined, color: undefined as string | undefined }, ...(folders ?? [])].map((f, i, arr) => {
                  const selected = (f.id ?? undefined) === folderId || (f.id === null && !folderId);
                  return (
                    <div key={f.id ?? '__none__'}>
                      <MotionButton
                        onClick={() => { if (!selected) onChange({ folderId: f.id }); }}
                        animate={{ background: selected ? 'var(--color-surface-tint-alt)' : 'transparent', color: selected ? 'var(--color-primary)' : 'var(--color-text-secondary)' }}
                        whileHover={!selected ? { background: 'var(--color-purple-pale-5)' } : undefined}
                        transition={{ duration: 0.12 }}
                        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: selected ? 600 : 450, textAlign: 'left', width: '100%' }}>
                        {f.id === null
                          ? <Icon name="remove_circle_outline" size={17} color={selected ? 'var(--color-primary)' : 'var(--color-text-quaternary)'} />
                          : f.emoji
                            ? <span style={{ fontSize: 16 }}>{f.emoji}</span>
                            : <Icon name="folder" size={17} color={f.color ?? 'var(--color-text-tertiary)'} />
                        }
                        <span style={{ flex: 1 }}>{f.name}</span>
                        {selected && <Icon name="check" size={15} color="var(--color-primary)" />}
                      </MotionButton>
                      {i < arr.length - 1 && <div style={{ height: 1, background: 'var(--color-divider)', marginLeft: 18 }} />}
                    </div>
                  );
                })}
              </div>
            </MotionIn>
          )}


          {/* ── ADMIN ── */}
          {activeTab === 'admin' && isAdmin && itemId && kind !== 'folder' && (
            <MotionIn initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.34, ease: EASE_SETTLE }} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {sectionLabel(`${kind === 'timeline' ? 'Timeline' : kind === 'markdownList' ? 'Markdown Page' : 'Board'} ID`)}
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
            </MotionIn>
          )}

          {/* ── SHARE ── */}
          {activeTab === 'share' && hasShare && itemId && (
            <MotionIn initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.34, ease: EASE_SETTLE }}>
              <ShareSection kind={kind} itemId={itemId} share={share} onShareUpdated={onShareUpdated} />
            </MotionIn>
          )}

          {/* ── PEOPLE (per-item invitations) ── */}
          {activeTab === 'people' && itemId && (
            <MotionIn initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.34, ease: EASE_SETTLE }}>
              <p style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-tertiary)', margin: '0 0 14px', lineHeight: 1.5 }}>
                {kind === 'folder'
                  ? 'Invite people to collaborate on this folder — they can view and edit everything inside it (boards, timelines and pages, including ones you add later), even if they’re not in this workspace.'
                  : `Invite people to collaborate on this ${KIND_DISPLAY_NAME[kind]} directly — they can view and edit it even if it's not shared with the whole workspace.`}
              </p>
              <ItemMembersSection itemType={kind as SharedItemType} itemId={itemId} canManage={creatorId === userId || isAdmin} />
            </MotionIn>
          )}
        </div>

        {/* Footer */}
        <div style={{ borderTop: '1px solid var(--color-divider)', padding: '14px 24px 18px', display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
          <MotionButton
            onClick={onClose}
            style={{ fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-primary)', border: 'none', borderRadius: 10, padding: '10px 28px', cursor: 'pointer' }}
            animate={{ filter: 'brightness(1)', y: 0 }}
            whileHover={{ filter: 'brightness(0.88)', y: -1 }}
            transition={{ duration: 0.14 }}>
            Done
          </MotionButton>
        </div>
      </MotionIn>
    </motion.div>
  );

  return createPortal(modal, document.body);
}
