import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import type { MarkdownBlock } from '../types';
import useMarkdownListsStore from '../store/useMarkdownListsStore';
import { useMobile } from '../hooks/useBreakpoint';
import Icon from '../components/Icon';
import BlockEditor from '../components/markdown/BlockEditor';
import { makeEmptyBlock } from '../utils/markdownBlocks';
import { type MentionMember } from '../utils/mention';
import { apiUploadMarkdownImage, markdownImageUrl, apiGetWorkspaceMembers, apiGetItemMembers, ensureAssetTicket, type ShareInfo } from '../api/client';
import type { WorkspaceMember } from '../types';
import useAuthStore from '../store/useAuthStore';
import useAIStore from '../store/useAIStore';
import ItemSettingsModal, { type ItemSettingsUpdates } from '../modals/ItemSettingsModal';
import MarkdownListAIAssist from '../components/AIAssistant/MarkdownListAIAssist';
import SaveStatusDot from '../components/SaveStatusDot';
import BacklinksPanel from '../components/graph/BacklinksPanel';
import useInstalledAppsStore from '../store/useInstalledAppsStore';
import PopIn from '../components/animate-ui/PopIn';
import ModalIn from '../components/animate-ui/ModalIn';
import { motion } from '../components/animate-ui/motion';
import { EASE_STANDARD } from '../components/animate-ui/motionTokens';
import MotionIn from '../components/animate-ui/MotionIn';
import useAsyncData from '../hooks/useAsyncData';

// ── Screen ────────────────────────────────────────────────────────────────────
/** Stable identities — see useAsyncData's `initial`. */
const EMPTY_WS_MEMBERS: WorkspaceMember[] = [];
const EMPTY_MENTION_MEMBERS: MentionMember[] = [];

export default function MarkdownListScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isMobile = useMobile();
  const { getDetail, update, remove } = useMarkdownListsStore();

  const [mdId, setMdId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<string | undefined>(undefined);
  const [color, setColor] = useState<string | undefined>(undefined);
  const [subtitle, setSubtitle] = useState<string | undefined>(undefined);
  const [isPublic, setIsPublic] = useState(false);
  const [fullWidth, setFullWidth] = useState(false);
  const [shareInfo, setShareInfo] = useState<{ enabled?: boolean; token?: string | null; hasPassword?: boolean; expiresAt?: string | null }>({});
  const [showSettings, setShowSettings] = useState(false);
  const [todoListId, setTodoListId] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<MarkdownBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  // "Reorder" mode: when on, every block's drag grip is shown so blocks can be
  // dragged to reorder; when off (default) the grips stay hidden for a clean,
  // no-movement reading/editing experience (toggled from the "..." menu).
  const [reorderMode, setReorderMode] = useState(false);
  const [askAiOpen, setAskAiOpen] = useState(false);
  const automationsInstalled = useInstalledAppsStore(s => s.isInstalled('automations'));
  // Same shared store MarkdownListAIAssist itself reads/populates — gates the
  // "Ask AI" menu item so it doesn't sit there as a dead click when Sol is
  // disabled instance-wide, matching what the old standalone button did by
  // simply not rendering itself in that case.
  const aiAssistEnabled = useAIStore(s => s.settings.enabled);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // @-mention typeahead — workspace members that can be tagged in a block, and
  // the in-progress mention (which block + where). Enabled only for docs in a
  // shared workspace.
  const currentUserId = useAuthStore(s => s.userId);
  const [mdWorkspaceId, setMdWorkspaceId] = useState<string | null>(null);
  const { data: wsMembers } = useAsyncData<WorkspaceMember[]>(
    mdWorkspaceId ?? null,
    async () => (await apiGetWorkspaceMembers(mdWorkspaceId!)).members,
    EMPTY_WS_MEMBERS,
  );
  // People invited directly to this page can be @-mentioned even with no
  // workspace members (a private page in a solo workspace shared with someone).
  const { data: mdInvitees } = useAsyncData<MentionMember[]>(
    mdId ?? null,
    async () => (await apiGetItemMembers('markdownList', mdId!)).members
      .map(m => ({ id: m.userId, username: m.username, fullName: m.fullName })),
    EMPTY_MENTION_MEMBERS,
  );
  const mentionMembers: MentionMember[] = (() => {
    const byId = new Map<string, MentionMember>();
    for (const m of wsMembers) if (m.userId !== currentUserId) byId.set(m.userId, { id: m.userId, username: m.username, fullName: m.fullName ?? null });
    for (const m of mdInvitees) if (m.id !== currentUserId) byId.set(m.id, m);
    return [...byId.values()];
  })();

  // NOTE (set-state-in-effect): same case as
  // AutomationEditorScreen: this SEEDS EDITABLE BUFFERS (name, emoji, colour,
  // blocks) that the user then types into, so a key-derived `data` would
  // overwrite their edits on the next render. The synchronous resets are what
  // stop the previous page's content showing under a new id.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see the note above
    setLoading(true);
    setNotFound(false);
    // Mint (or reuse a still-fresh cached) per-document image ticket ALONGSIDE
    // loading the document itself, and wait for both — every <img src> this
    // page renders (via markdownImageUrl) reads the ticket synchronously from
    // the client cache, so it must already be in place before BlockEditor's
    // first paint (see client.ts's "Asset tickets" section), not just started.
    // A ticket-mint failure is swallowed (best-effort: a page with no images
    // yet doesn't need one) rather than blocking the document from loading.
    const ticketReady = ensureAssetTicket(`mdimg:${id}`).catch(() => { /* best-effort */ });
    Promise.all([getDetail(id), ticketReady]).then(([md]) => {
      if (cancelled) return;
      setMdId(md.id);
      setMdWorkspaceId(md.workspaceId ?? null);
      setName(md.name);
      setEmoji(md.emoji);
      setColor(md.color);
      setSubtitle(md.subtitle ?? undefined);
      setIsPublic(Boolean(md.isPublic));
      setFullWidth(Boolean(md.fullWidth));
      setShareInfo({ enabled: md.shareEnabled, token: md.shareToken, hasPassword: md.shareHasPassword, expiresAt: md.shareExpiresAt });
      setTodoListId(md.todoListId ?? null);
      // Opening a brand-new, still-empty document straight into edit mode is
      // BlockEditor's own concern now — it applies that on its first render.
      setBlocks(md.content.blocks.length > 0 ? md.content.blocks : [makeEmptyBlock('paragraph')]);
      setLoading(false);
    }).catch(() => {
      if (!cancelled) { setNotFound(true); setLoading(false); }
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // At most one PUT in flight at a time: a fast typist can trigger the
  // debounced content save and an immediate todo-checkbox save close
  // together, and without this guard their responses could land out of
  // order — an older response's blocks would clobber newer local edits.
  // A save requested while one is already in flight is queued and coalesced
  // into a single trailing call with the latest blocks once the current one
  // settles (never a growing backlog).
  const savingRef = useRef(false);
  const pendingSaveRef = useRef<MarkdownBlock[] | null>(null);

  const persist = useCallback(async (nextBlocks: MarkdownBlock[]) => {
    if (!mdId) return;
    if (savingRef.current) { pendingSaveRef.current = nextBlocks; return; }
    savingRef.current = true;
    try {
      // Drains with a loop rather than recursing back into this callback:
      // same coalescing (a save requested mid-flight replaces any earlier
      // queued one, so there is never a backlog), but a useCallback that
      // calls itself cannot have its memoization preserved.
      let queued: MarkdownBlock[] | null = nextBlocks;
      while (queued) {
        const current = queued;
        queued = null;
        setSaveState('saving');
        try {
          const res = await update(mdId, { content: { version: 1, blocks: current } });
          setTodoListId(res.todoListId ?? null);
          setBlocks(res.content.blocks.length > 0 ? res.content.blocks : [makeEmptyBlock('paragraph')]);
          setSaveState('saved');
        } catch (e) {
          console.error('markdown page save failed', e);
          setSaveState('error');
        }
        queued = pendingSaveRef.current;
        pendingSaveRef.current = null;
      }
    } finally {
      savingRef.current = false;
    }
  }, [mdId, update]);

  const scheduleSave = useCallback((nextBlocks: MarkdownBlock[]) => {
    setSaveState('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void persist(nextBlocks); }, 800);
  }, [persist]);

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  // BlockEditor is controlled and persistence-agnostic: it hands back the new
  // block list and this screen decides what saving means. Ordinary edits go
  // through the 800ms debounce; a `/todo` checkbox flush-saves, because that
  // block mirrors into a real task row and shouldn't sit in a debounce window.
  const handleBlocksChange = useCallback((next: MarkdownBlock[]) => {
    setBlocks(next);
    scheduleSave(next);
  }, [scheduleSave]);

  const handleBlocksChangeImmediate = useCallback((next: MarkdownBlock[]) => {
    setBlocks(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    void persist(next);
  }, [persist]);

  const handleNameSave = () => {
    const trimmed = nameDraft.trim();
    setNameEditing(false);
    if (!mdId || !trimmed || trimmed === name) return;
    setName(trimmed);
    void update(mdId, { name: trimmed });
  };

  const handleDelete = () => {
    if (!mdId) return;
    void remove(mdId);
    navigate('/dashboard');
  };

  const handleSettingsChange = (updates: ItemSettingsUpdates) => {
    if (!mdId) return;
    if (updates.emoji !== undefined) setEmoji(updates.emoji);
    if (updates.color !== undefined) setColor(updates.color);
    if (updates.isPublic !== undefined) setIsPublic(updates.isPublic);
    if (updates.fullWidth !== undefined) setFullWidth(updates.fullWidth);
    // Markdown pages don't expose the Folder tab (no folder-nesting UI yet),
    // so `folderId` never actually arrives here in practice — the cast just
    // satisfies ItemSettingsUpdates' shared shape (folderId: string | null)
    // against the store's Partial<MarkdownList> (folderId?: string).
    void update(mdId, updates as Parameters<typeof update>[1]);
  };

  if (loading) {
    return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-body)', fontSize: 14 }}>Loading…</div>;
  }
  if (notFound || !mdId) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <Icon name="notes" size={40} color="var(--color-border-strong)" />
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>Markdown page not found</div>
        <button onClick={() => navigate('/dashboard')} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-primary)', border: 'none', borderRadius: 8, padding: '10px 20px', cursor: 'pointer' }}>Back to Dashboard</button>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', display: 'flex', justifyContent: 'center', padding: isMobile ? '20px 16px 80px' : '40px 24px 120px' }}>
      <MotionIn transition={{ duration: 0.32 }} style={{ width: '100%', maxWidth: fullWidth ? 1400 : 760, }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 24 }}>
          <span style={{ fontSize: 34, lineHeight: 1.2 }}>{emoji || '📝'}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {nameEditing ? (
                <input autoFocus value={nameDraft} onChange={e => setNameDraft(e.target.value)}
                  onBlur={handleNameSave} onKeyDown={e => { if (e.key === 'Enter') handleNameSave(); if (e.key === 'Escape') setNameEditing(false); }}
                  style={{ fontFamily: 'var(--font-heading)', fontSize: 28, fontWeight: 700, color: 'var(--color-text-primary)', border: 'none', borderBottom: '2px solid var(--color-primary)', outline: 'none', width: '100%', background: 'transparent' }} />
              ) : (
                <h1 onClick={() => { setNameDraft(name); setNameEditing(true); }}
                  style={{ fontFamily: 'var(--font-heading)', fontSize: 28, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0, cursor: 'text', overflowWrap: 'break-word' }}>
                  {name}
                </h1>
              )}
              <SaveStatusDot state={saveState} />
            </div>
            {subtitle && <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-tertiary)', marginTop: 4 }}>{subtitle}</div>}
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexShrink: 0 }}>
          {todoListId && (
            <motion.button
              initial={{ opacity: 0, scale: 0.88, y: -6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{
                // Entrance timing for the pop-in above; the hover tint below
                // carries its own so the two never share a duration.
                default: { duration: 0.16, ease: EASE_STANDARD },
              }}
              onClick={() => navigate(`/list/${todoListId}`)}
              title="Open this page's Todo list"
              whileHover={{
                background: 'var(--color-green-pale-1)',
                borderColor: 'var(--color-success)',
                transition: { duration: 0.12 },
              }}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, height: 32, width: isMobile ? 32 : undefined, padding: isMobile ? 0 : '0 11px', borderRadius: 8, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--color-border)', background: 'var(--color-white)', cursor: 'pointer', flexShrink: 0 }}>
              <Icon name="checklist" size={15} color="var(--color-success)" />
              {!isMobile && <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-success)' }}>Todo list</span>}
            </motion.button>
          )}
          <MarkdownListAIAssist
            markdownListId={mdId}
            markdownListName={name}
            open={askAiOpen}
            onClose={() => setAskAiOpen(false)}
            onUpdated={(md) => {
              const updatedBlocks = md.content.blocks;
              setBlocks(updatedBlocks.length > 0 ? updatedBlocks : [makeEmptyBlock('paragraph')]);
              setTodoListId(md.todoListId ?? null);
              // The page's own settings can change too (via update_markdown_list),
              // so keep the header/appearance in sync with the re-fetched page.
              setName(md.name);
              setEmoji(md.emoji);
              setColor(md.color);
              setSubtitle(md.subtitle ?? undefined);
              setIsPublic(Boolean(md.isPublic));
              setFullWidth(Boolean(md.fullWidth));
            }}
          />
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button onClick={() => setMenuOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-white)', cursor: 'pointer' }}>
              <Icon name="more_vert" size={16} color="var(--color-text-tertiary)" />
            </button>
            {menuOpen && (
              <>
                <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 190 }} />
                <PopIn duration={160} style={{ position: 'absolute', top: 38, right: 0, background: 'var(--color-white)', borderRadius: 10, boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.14)', border: '1px solid var(--color-border)', minWidth: 200, zIndex: 200, overflow: 'hidden' }}>
                  {aiAssistEnabled && (
                    <button onClick={() => { setMenuOpen(false); setAskAiOpen(true); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, color: 'var(--color-text-primary)', textAlign: 'left' }}>
                      <Icon name="auto_awesome" size={16} color="var(--color-primary)" /> Ask AI
                    </button>
                  )}
                  <button onClick={() => { setMenuOpen(false); setReorderMode(r => !r); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, color: 'var(--color-text-primary)', textAlign: 'left' }}>
                    <Icon name="swap_vert" size={16} color="var(--color-text-tertiary)" /> {reorderMode ? 'Done reordering' : 'Reorder blocks'}
                  </button>
                  {automationsInstalled && mdId && (
                    <button onClick={() => { setMenuOpen(false); navigate(`/automations?ownerType=markdownList&ownerId=${mdId}`); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, color: 'var(--color-text-primary)', textAlign: 'left' }}>
                      <Icon name="bolt" size={16} color="var(--color-warning-alt)" /> Automations
                    </button>
                  )}
                  <div style={{ height: 1, background: 'var(--color-divider)', margin: '4px 0' }} />
                  {todoListId && (
                    <button onClick={() => { setMenuOpen(false); navigate(`/list/${todoListId}`); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, color: 'var(--color-text-primary)', textAlign: 'left' }}>
                      <Icon name="check_circle" size={16} color="var(--color-text-tertiary)" /> View Todo list
                    </button>
                  )}
                  <button onClick={() => { setMenuOpen(false); setShowSettings(true); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, color: 'var(--color-text-primary)', textAlign: 'left' }}>
                    <Icon name="tune" size={16} color="var(--color-text-tertiary)" /> More settings…
                  </button>
                  <button onClick={() => { setMenuOpen(false); setShowDeleteDialog(true); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, color: 'var(--color-error)', textAlign: 'left' }}>
                    <Icon name="delete" size={16} color="var(--color-error)" /> Delete
                  </button>
                </PopIn>
              </>
            )}
          </div>
          </div>
        </div>

        {mdId && (
          <div style={{ marginBottom: 20 }}>
            <BacklinksPanel entityType="markdownList" entityId={mdId} compact />
          </div>
        )}

        {/* Blocks */}
        <BlockEditor
          blocks={blocks}
          onChange={handleBlocksChange}
          onChangeImmediate={handleBlocksChangeImmediate}
          imageUrl={imageId => markdownImageUrl(mdId, imageId)}
          uploadImage={(file, onProgress) => apiUploadMarkdownImage(mdId, file, onProgress)}
          isMobile={isMobile}
          reorderMode={reorderMode}
          mentionMembers={mentionMembers}
        />
      </MotionIn>

      {showSettings && mdId && (
        <ItemSettingsModal
          kind="markdownList"
          name={name}
          emoji={emoji}
          color={color}
          isPublic={isPublic}
          fullWidth={fullWidth}
          itemId={mdId}
          share={shareInfo}
          onShareUpdated={(s: ShareInfo) => setShareInfo({ enabled: s.enabled, token: s.token, hasPassword: s.hasPassword, expiresAt: s.expiresAt })}
          onVisibilityApplied={(p: boolean) => setIsPublic(p)}
          onChange={handleSettingsChange}
          onClose={() => setShowSettings(false)}
        />
      )}


      {showDeleteDialog && createPortal(
        <MotionIn onClick={() => setShowDeleteDialog(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.18)', backdropFilter: 'blur(4px)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18, ease: EASE_STANDARD }}>
          <ModalIn duration={280} onClick={e => e.stopPropagation()} style={{ background: 'var(--color-white)', borderRadius: 14, padding: '28px 32px', maxWidth: 380, width: '100%', boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.14)' }}>
            <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--color-error-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Icon name="delete" size={20} color="var(--color-error)" />
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}>Delete "{name}"?</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginBottom: 24 }}>
              This markdown page{todoListId ? ' and its Todo list' : ''} will be moved to Trash.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowDeleteDialog(false)} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleDelete} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-error)', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Delete</button>
            </div>
          </ModalIn>
        </MotionIn>,
        document.body
      )}

    </div>
  );
}
