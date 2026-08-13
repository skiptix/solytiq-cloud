import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle';
import { useMobile } from '../hooks/useBreakpoint';
import type { Template } from '../types';
import useTemplatesStore from '../store/useTemplatesStore';
import useSyncStore from '../store/useSyncStore';
import Icon from '../components/Icon';
import CreateTemplateModal from '../modals/CreateTemplateModal';
import UseTemplateModal from '../modals/UseTemplateModal';
import EditTemplateStructureModal from '../modals/EditTemplateStructureModal';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import PopIn from '../components/animate-ui/PopIn';
import ModalIn from '../components/animate-ui/ModalIn';
import MotionIn from '../components/animate-ui/MotionIn';
import MotionButton from '../components/animate-ui/MotionButton';
import { EASE_STANDARD, EASE_SETTLE, EASE_SPRING } from '../components/animate-ui/motionTokens';

type Filter = 'all' | 'list' | 'timeline';

function TemplateCardMenu({ template, onRename, onEditStructure, onToggleShared, onDelete }: {
  template: Template;
  onRename: () => void;
  onEditStructure: () => void;
  onToggleShared: () => void;
  // Receives the "..." trigger button element (still mounted after the menu
  // closes, unlike the "Delete" menu item itself) so the caller can restore
  // focus to it once the confirmation dialog closes — see the
  // `restoreFocusTo` note on ConfirmDialog below.
  onDelete: (triggerEl: HTMLButtonElement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button ref={triggerRef} onClick={() => setOpen((o) => !o)}
        style={{ width: 26, height: 26, borderRadius: 7, border: 'none', background: open ? 'var(--color-purple-pale-39)' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="more_vert" size={15} color="var(--color-accent-purple-light)" />
      </button>
      {open && (
        <PopIn duration={140} style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, width: 190, background: 'var(--color-white)', borderRadius: 10, boxShadow: '0 4px 20px rgba(var(--color-black-rgb), 0.13)', border: '1px solid var(--color-border)', padding: '4px 0', zIndex: 400 }}>
          <button onClick={() => { setOpen(false); onRename(); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, color: 'var(--color-text-primary)', textAlign: 'left' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-surface-tint)')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
            <Icon name="edit" size={15} color="var(--color-text-tertiary)" /> Rename
          </button>
          <button onClick={() => { setOpen(false); onEditStructure(); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, color: 'var(--color-text-primary)', textAlign: 'left' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-surface-tint)')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
            <Icon name="account_tree" size={15} color="var(--color-text-tertiary)" /> Edit structure
          </button>
          <button onClick={() => { setOpen(false); onToggleShared(); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, color: 'var(--color-text-primary)', textAlign: 'left' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-surface-tint)')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
            <Icon name={template.isShared ? 'lock' : 'public'} size={15} color="var(--color-text-tertiary)" />
            {template.isShared ? 'Make private' : 'Share with everyone'}
          </button>
          <div style={{ height: 1, background: 'var(--color-divider)', margin: '4px 0' }} />
          <button onClick={() => { setOpen(false); onDelete(triggerRef.current); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, color: 'var(--color-error)', textAlign: 'left' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-error-bg)')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
            <Icon name="delete" size={15} color="var(--color-error)" /> Delete
          </button>
        </PopIn>
      )}
    </div>
  );
}

function TemplateCard({ template, index, onUse, onRename, onEditStructure, onToggleShared, onDelete }: {
  template: Template;
  index: number;
  onUse: () => void;
  onRename: () => void;
  onEditStructure: () => void;
  onToggleShared: () => void;
  onDelete: (triggerEl: HTMLButtonElement | null) => void;
}) {
  const accent = template.color ?? 'var(--color-primary)';
  const bg = template.colorBg ?? 'var(--color-surface-tint)';
  const summary = template.type === 'list'
    ? `${template.summary.sectionCount ?? 0} section${template.summary.sectionCount === 1 ? '' : 's'} · ${template.summary.taskCount ?? 0} task${template.summary.taskCount === 1 ? '' : 's'}`
    : `${template.summary.milestoneCount ?? 0} milestone${template.summary.milestoneCount === 1 ? '' : 's'}`;
  const delay = Math.min(index * 40, 400);

  return (
    <MotionIn
      // The staggered card entrance and the hover lift share this element, so
      // they share one transition object rather than one clobbering the other's
      // transform.
      initial={{ opacity: 0, y: 12, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        opacity: { duration: 0.34, delay: delay / 1000, ease: EASE_SPRING },
        scale: { duration: 0.34, delay: delay / 1000, ease: EASE_SPRING },
        y: { duration: 0.2 },
        borderColor: { duration: 0.2 },
        boxShadow: { duration: 0.2 },
      }}
      style={{ background: 'var(--color-white)', border: '1.5px solid var(--color-purple-pale-34)', borderRadius: 16, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}
      whileHover={{ borderColor: accent, boxShadow: `0 8px 20px ${accent}1a`, y: -3 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ width: 40, height: 40, borderRadius: 11, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 19 }}>
          {template.emoji ?? (template.type === 'list' ? '📋' : '🗓️')}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14.5, fontWeight: 700, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{template.name}</div>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>{summary}</div>
        </div>
        {template.isOwner && (
          <TemplateCardMenu template={template} onRename={onRename} onEditStructure={onEditStructure} onToggleShared={onToggleShared} onDelete={onDelete} />
        )}
      </div>

      {template.description && (
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
          {template.description}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {template.isOwner ? (
            template.isShared && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-heading)', fontSize: 10.5, fontWeight: 700, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', padding: '2px 8px', borderRadius: 9999 }}>
                <Icon name="public" size={11} color="var(--color-primary)" /> Shared
              </span>
            )
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)' }}>
              <Icon name="person" size={12} color="var(--color-text-quaternary)" /> {template.ownerName ?? 'Another user'}
            </span>
          )}
        </div>
        <MotionButton onClick={onUse}
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-white)', background: accent, border: 'none', borderRadius: 8, padding: '7px 14px', cursor: 'pointer' }}
          whileHover={{ transform: 'scale(1.05)', filter: 'brightness(1.08)' }}
          transition={{ duration: 0.15 }}
          onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.96)'; }}
          onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1.05)'; }}>
          <Icon name="add" size={14} color="var(--color-white)" /> Use
        </MotionButton>
      </div>
    </MotionIn>
  );
}

export default function TemplatesScreen() {
  usePageTitle('Templates');
  const isMobile = useMobile();
  const navigate = useNavigate();

  const { templates, loading, load, update, remove } = useTemplatesStore();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [useTarget, setUseTarget] = useState<Template | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Template | null>(null);
  // Sprint 03 review fix: the "..." card-menu trigger button that opened the
  // delete flow — captured so ConfirmDialog can explicitly restore focus to
  // it on close. The "Delete" menu item itself unmounts the instant it's
  // clicked (the menu closes), so Radix's default onCloseAutoFocus (which
  // restores focus to whatever was active when the dialog opened) has
  // nothing left in the DOM to focus by the time the dialog actually closes
  // — it was silently falling back to <body>. The "..." trigger button,
  // unlike the menu item, stays mounted throughout, so it's a valid target.
  const [deleteTriggerEl, setDeleteTriggerEl] = useState<HTMLButtonElement | null>(null);
  const [renameTarget, setRenameTarget] = useState<Template | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [structureTarget, setStructureTarget] = useState<Template | null>(null);

  useEffect(() => { load(); }, [load]);

  // Live refresh when a template changes anywhere (own edits from another tab,
  // or a newly shared template from someone else).
  const templateRev = useSyncStore((s) => s.entityRevisions.template ?? 0);
  useEffect(() => { if (templateRev > 0) load(); }, [templateRev, load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return templates.filter((t) => {
      if (filter !== 'all' && t.type !== filter) return false;
      if (q && !t.name.toLowerCase().includes(q) && !(t.description ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [templates, filter, search]);

  const openRename = (t: Template) => {
    setRenameTarget(t);
    setRenameValue(t.name);
  };

  const commitRename = () => {
    if (!renameTarget) return;
    const next = renameValue.trim();
    if (next && next !== renameTarget.name) update(renameTarget.id, { name: next });
    setRenameTarget(null);
  };

  return (
    <div style={{ flex: 1, height: '100%', overflowY: 'auto' }}>
      <MotionIn style={{ maxWidth: 980, margin: '0 auto', padding: isMobile ? '16px 12px 48px' : '32px 32px 48px', display: 'flex', flexDirection: 'column', gap: 20, width: '100%' }} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.36, ease: EASE_SETTLE }}>

        {/* Page header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontFamily: 'var(--font-heading)', fontSize: 28, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.02em', margin: 0 }}>Templates</h1>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
              Save a board or timeline's full structure to reuse — or shared by others on this instance.
            </div>
          </div>
          <MotionButton onClick={() => setShowCreate(true)}
            transition={{ duration: 0.18 }} style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-primary)', border: 'none', borderRadius: 10, padding: '9px 16px', cursor: 'pointer', }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-purple-mid-10)'; e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 6px 16px rgba(var(--color-primary-rgb), 0.3)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-primary)'; e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none'; }}>
            <Icon name="add" size={16} color="var(--color-white)" /> New Template
          </MotionButton>
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', background: 'var(--color-surface-tint-2)', borderRadius: 9999, padding: 3, gap: 2 }}>
            {(['all', 'list', 'timeline'] as const).map((f) => (
              <MotionButton key={f} onClick={() => setFilter(f)}
                transition={{ duration: 0.18 }} style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, padding: '6px 14px', borderRadius: 9999, border: 'none', cursor: 'pointer', background: filter === f ? 'var(--color-primary)' : 'transparent', color: filter === f ? 'var(--color-white)' : 'var(--color-text-tertiary)', transform: filter === f ? 'scale(1.04)' : 'scale(1)', }}>
                {f === 'all' ? 'All' : f === 'list' ? 'Boards' : 'Timelines'}
              </MotionButton>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 160, position: 'relative', display: 'flex', alignItems: 'center' }}>
            <span style={{ position: 'absolute', left: 12, display: 'flex', pointerEvents: 'none' }}>
              <Icon name="search" size={15} color="var(--color-text-quaternary)" />
            </span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search templates…"
              style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 13, border: '1.5px solid var(--color-border)', borderRadius: 9999, padding: '8px 14px 8px 34px', outline: 'none', background: 'var(--color-surface-neutral)' }}
              onFocus={(e) => (e.target.style.borderColor = 'var(--color-primary)')} onBlur={(e) => (e.target.style.borderColor = 'var(--color-border)')} />
          </div>
        </div>

        {/* Grid */}
        {loading && templates.length === 0 ? (
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)', padding: '40px 0', textAlign: 'center' }}>Loading templates…</div>
        ) : filtered.length === 0 ? (
          <MotionIn style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '60px 20px', color: 'var(--color-text-quaternary)' }} initial={{ opacity: 0, y: 12, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.38, ease: EASE_SETTLE }}>
            <MotionIn animate={{ y: [0, -5, 0] }} transition={{ duration: 3, ease: 'easeInOut', repeat: Infinity }}>
              <Icon name="dashboard_customize" size={40} color="var(--color-purple-tint-3)" />
            </MotionIn>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 600, color: 'var(--color-text-tertiary)' }}>
              {templates.length === 0 ? 'No templates yet' : 'No templates match your search'}
            </div>
            {templates.length === 0 && (
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)', textAlign: 'center', maxWidth: 320 }}>
                Save any list or timeline you own as a template to quickly recreate its structure later.
              </div>
            )}
          </MotionIn>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
            {filtered.map((t, i) => (
              <TemplateCard key={t.id} template={t} index={i}
                onUse={() => setUseTarget(t)}
                onRename={() => openRename(t)}
                onEditStructure={() => setStructureTarget(t)}
                onToggleShared={() => update(t.id, { isShared: !t.isShared })}
                onDelete={(triggerEl) => { setConfirmDelete(t); setDeleteTriggerEl(triggerEl); }} />
            ))}
          </div>
        )}
      </MotionIn>

      {showCreate && <CreateTemplateModal onClose={() => setShowCreate(false)} />}

      {structureTarget && (
        <EditTemplateStructureModal template={structureTarget} onClose={() => setStructureTarget(null)} />
      )}

      {useTarget && (
        <UseTemplateModal
          template={useTarget}
          onClose={() => setUseTarget(null)}
          onCreatedList={(list) => { setUseTarget(null); navigate(`/list/${list.id}`); }}
          onCreatedTimeline={(timeline) => { setUseTarget(null); navigate(`/timeline/${timeline.id}`); }}
        />
      )}

      {renameTarget && createPortal(
        <MotionIn style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.28)', backdropFilter: 'blur(5px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18, ease: EASE_STANDARD }}
          onClick={(e) => { if (e.target === e.currentTarget) setRenameTarget(null); }}>
          <ModalIn duration={280} style={{ background: 'var(--color-white)', borderRadius: 16, width: '100%', maxWidth: 400, boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{ width: 38, height: 38, borderRadius: 10, background: renameTarget.colorBg ?? 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 17 }}>
                {renameTarget.emoji ?? (renameTarget.type === 'list' ? '📋' : '🗓️')}
              </div>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>Rename template</div>
            </div>
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onFocus={(e) => { e.target.select(); e.target.style.borderBottomColor = 'var(--color-primary)'; }}
              onBlur={(e) => (e.target.style.borderBottomColor = 'var(--color-border-alt)')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && renameValue.trim()) commitRename();
                if (e.key === 'Escape') setRenameTarget(null);
              }}
              maxLength={255}
              style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, border: 'none', borderBottom: '1.5px solid var(--color-border-alt)', padding: '8px 0', outline: 'none', color: 'var(--color-text-primary)', background: 'transparent', marginBottom: 22 }}
            />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setRenameTarget(null)}
                style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: 'none', cursor: 'pointer', padding: '10px 16px' }}>
                Cancel
              </button>
              <MotionButton onClick={commitRename} disabled={!renameValue.trim()}
                transition={{ duration: 0.15 }} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: renameValue.trim() ? 'var(--color-primary)' : 'var(--color-border-strong)', border: 'none', borderRadius: 8, padding: '10px 24px', cursor: renameValue.trim() ? 'pointer' : 'not-allowed', }}
                onMouseEnter={(e) => { if (renameValue.trim()) e.currentTarget.style.transform = 'scale(1.04)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}>
                Save
              </MotionButton>
            </div>
          </ModalIn>
        </MotionIn>,
        document.body
      )}

      {/* Sprint 03 Animate-UI production pilot: this used to be a hand-rolled
          createPortal div with a click-outside-to-close handler but no
          dialog semantics — no accessible name, no focus trap, no Escape
          handling. ConfirmDialog wraps the vendored, patched Animate UI
          Radix Dialog primitive and supplies all of that for free, with the
          exact same visual language as before. */}
      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(open) => { if (!open) setConfirmDelete(null); }}
        title={`Delete "${confirmDelete?.name ?? ''}"?`}
        description="This can't be undone. Boards/timelines already created from it are not affected."
        confirmLabel="Delete"
        onConfirm={() => { if (confirmDelete) remove(confirmDelete.id); }}
        restoreFocusTo={deleteTriggerEl}
      />
    </div>
  );
}
