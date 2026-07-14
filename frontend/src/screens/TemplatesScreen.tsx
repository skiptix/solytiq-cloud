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

type Filter = 'all' | 'list' | 'timeline';

function TemplateCardMenu({ template, onRename, onEditStructure, onToggleShared, onDelete }: {
  template: Template;
  onRename: () => void;
  onEditStructure: () => void;
  onToggleShared: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ width: 26, height: 26, borderRadius: 7, border: 'none', background: open ? '#ebe6f0' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="more_vert" size={15} color="#9d8dff" />
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, width: 190, background: '#fff', borderRadius: 10, boxShadow: '0 4px 20px rgba(0,0,0,0.13)', border: '1px solid #e8e4f0', padding: '4px 0', zIndex: 400, animation: 'menuIn 140ms ease both' }}>
          <button onClick={() => { setOpen(false); onRename(); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, color: '#1c1b22', textAlign: 'left' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#f5f3ff')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
            <Icon name="edit" size={15} color="#787584" /> Rename
          </button>
          <button onClick={() => { setOpen(false); onEditStructure(); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, color: '#1c1b22', textAlign: 'left' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#f5f3ff')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
            <Icon name="account_tree" size={15} color="#787584" /> Edit structure
          </button>
          <button onClick={() => { setOpen(false); onToggleShared(); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, color: '#1c1b22', textAlign: 'left' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#f5f3ff')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
            <Icon name={template.isShared ? 'lock' : 'public'} size={15} color="#787584" />
            {template.isShared ? 'Make private' : 'Share with everyone'}
          </button>
          <div style={{ height: 1, background: '#f0ecf8', margin: '4px 0' }} />
          <button onClick={() => { setOpen(false); onDelete(); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, color: '#ba1a1a', textAlign: 'left' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#ffdad6')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
            <Icon name="delete" size={15} color="#ba1a1a" /> Delete
          </button>
        </div>
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
  onDelete: () => void;
}) {
  const accent = template.color ?? '#5e4dbb';
  const bg = template.colorBg ?? '#F5F3FF';
  const summary = template.type === 'list'
    ? `${template.summary.sectionCount ?? 0} section${template.summary.sectionCount === 1 ? '' : 's'} · ${template.summary.taskCount ?? 0} task${template.summary.taskCount === 1 ? '' : 's'}`
    : `${template.summary.milestoneCount ?? 0} milestone${template.summary.milestoneCount === 1 ? '' : 's'}`;
  const delay = Math.min(index * 40, 400);

  return (
    <div style={{ background: '#fff', border: '1.5px solid #ece8f4', borderRadius: 16, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10, transition: 'border-color 200ms, box-shadow 200ms, transform 200ms cubic-bezier(0.34,1.56,0.64,1)', animation: `cardIn 340ms cubic-bezier(0.34,1.56,0.64,1) ${delay}ms both` }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = accent; e.currentTarget.style.boxShadow = `0 8px 20px ${accent}1a`; e.currentTarget.style.transform = 'translateY(-3px)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#ece8f4'; e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'translateY(0)'; }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ width: 40, height: 40, borderRadius: 11, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 19 }}>
          {template.emoji ?? (template.type === 'list' ? '📋' : '🗓️')}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14.5, fontWeight: 700, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{template.name}</div>
          <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#787584' }}>{summary}</div>
        </div>
        {template.isOwner && (
          <TemplateCardMenu template={template} onRename={onRename} onEditStructure={onEditStructure} onToggleShared={onToggleShared} onDelete={onDelete} />
        )}
      </div>

      {template.description && (
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12.5, color: '#484552', lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
          {template.description}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {template.isOwner ? (
            template.isShared && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10.5, fontWeight: 700, color: '#5e4dbb', background: '#F5F3FF', padding: '2px 8px', borderRadius: 9999 }}>
                <Icon name="public" size={11} color="#5e4dbb" /> Shared
              </span>
            )
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe' }}>
              <Icon name="person" size={12} color="#b0acbe" /> {template.ownerName ?? 'Another user'}
            </span>
          )}
        </div>
        <button onClick={onUse}
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, color: '#fff', background: accent, border: 'none', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', transition: 'transform 150ms cubic-bezier(0.34,1.56,0.64,1), filter 150ms' }}
          onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.05)'; e.currentTarget.style.filter = 'brightness(1.08)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.filter = 'none'; }}
          onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.96)'; }}
          onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1.05)'; }}>
          <Icon name="add" size={14} color="#fff" /> Use
        </button>
      </div>
    </div>
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
      <div style={{ maxWidth: 980, margin: '0 auto', padding: isMobile ? '16px 12px 48px' : '32px 32px 48px', display: 'flex', flexDirection: 'column', gap: 20, width: '100%', animation: 'sectionFadeUp 360ms cubic-bezier(0.22,1,0.36,1) both' }}>

        {/* Page header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 28, fontWeight: 700, color: '#1c1b22', letterSpacing: '-0.02em', margin: 0 }}>Templates</h1>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', marginTop: 2 }}>
              Save a to-do or timeline's full structure to reuse — or shared by others on this instance.
            </div>
          </div>
          <button onClick={() => setShowCreate(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#5e4dbb', border: 'none', borderRadius: 10, padding: '9px 16px', cursor: 'pointer', transition: 'background 180ms, transform 180ms cubic-bezier(0.34,1.56,0.64,1), box-shadow 180ms' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#4f3fa8'; e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 6px 16px rgba(94,77,187,0.3)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '#5e4dbb'; e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none'; }}>
            <Icon name="add" size={16} color="#fff" /> New Template
          </button>
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', background: '#f1ecf6', borderRadius: 9999, padding: 3, gap: 2 }}>
            {(['all', 'list', 'timeline'] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, padding: '6px 14px', borderRadius: 9999, border: 'none', cursor: 'pointer', background: filter === f ? '#5e4dbb' : 'transparent', color: filter === f ? '#fff' : '#787584', transform: filter === f ? 'scale(1.04)' : 'scale(1)', transition: 'background 180ms, color 180ms, transform 220ms cubic-bezier(0.34,1.56,0.64,1)' }}>
                {f === 'all' ? 'All' : f === 'list' ? 'To-Dos' : 'Timelines'}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 160, position: 'relative', display: 'flex', alignItems: 'center' }}>
            <span style={{ position: 'absolute', left: 12, display: 'flex', pointerEvents: 'none' }}>
              <Icon name="search" size={15} color="#b0acbe" />
            </span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search templates…"
              style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 13, border: '1.5px solid #e8e4f0', borderRadius: 9999, padding: '8px 14px 8px 34px', outline: 'none', background: '#fafafa' }}
              onFocus={(e) => (e.target.style.borderColor = '#5e4dbb')} onBlur={(e) => (e.target.style.borderColor = '#e8e4f0')} />
          </div>
        </div>

        {/* Grid */}
        {loading && templates.length === 0 ? (
          <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', padding: '40px 0', textAlign: 'center' }}>Loading templates…</div>
        ) : filtered.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '60px 20px', color: '#b0acbe', animation: 'cardIn 380ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <div style={{ animation: 'fileDropIconFloat 3s ease-in-out infinite' }}>
              <Icon name="dashboard_customize" size={40} color="#d8d2e8" />
            </div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 600, color: '#787584' }}>
              {templates.length === 0 ? 'No templates yet' : 'No templates match your search'}
            </div>
            {templates.length === 0 && (
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', textAlign: 'center', maxWidth: 320 }}>
                Save any list or timeline you own as a template to quickly recreate its structure later.
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
            {filtered.map((t, i) => (
              <TemplateCard key={t.id} template={t} index={i}
                onUse={() => setUseTarget(t)}
                onRename={() => openRename(t)}
                onEditStructure={() => setStructureTarget(t)}
                onToggleShared={() => update(t.id, { isShared: !t.isShared })}
                onDelete={() => setConfirmDelete(t)} />
            ))}
          </div>
        )}
      </div>

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
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)', backdropFilter: 'blur(5px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)', animation: 'backdropIn 180ms ease both' }}
          onClick={(e) => { if (e.target === e.currentTarget) setRenameTarget(null); }}>
          <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 400, boxShadow: '0 12px 40px rgba(0,0,0,0.18)', padding: 24, animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{ width: 38, height: 38, borderRadius: 10, background: renameTarget.colorBg ?? '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 17 }}>
                {renameTarget.emoji ?? (renameTarget.type === 'list' ? '📋' : '🗓️')}
              </div>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>Rename template</div>
            </div>
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onFocus={(e) => { e.target.select(); e.target.style.borderBottomColor = '#5e4dbb'; }}
              onBlur={(e) => (e.target.style.borderBottomColor = '#E5E7EB')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && renameValue.trim()) commitRename();
                if (e.key === 'Escape') setRenameTarget(null);
              }}
              maxLength={255}
              style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, border: 'none', borderBottom: '1.5px solid #E5E7EB', padding: '8px 0', outline: 'none', color: '#1c1b22', background: 'transparent', marginBottom: 22 }}
            />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setRenameTarget(null)}
                style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: 'none', cursor: 'pointer', padding: '10px 16px' }}>
                Cancel
              </button>
              <button onClick={commitRename} disabled={!renameValue.trim()}
                style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: renameValue.trim() ? '#5e4dbb' : '#c9c4d5', border: 'none', borderRadius: 8, padding: '10px 24px', cursor: renameValue.trim() ? 'pointer' : 'not-allowed', transition: 'background 150ms, transform 150ms cubic-bezier(0.34,1.56,0.64,1)' }}
                onMouseEnter={(e) => { if (renameValue.trim()) e.currentTarget.style.transform = 'scale(1.04)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}>
                Save
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {confirmDelete && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)', backdropFilter: 'blur(5px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setConfirmDelete(null); }}>
          <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 380, boxShadow: '0 12px 40px rgba(0,0,0,0.18)', padding: 24, animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22', marginBottom: 8 }}>Delete "{confirmDelete.name}"?</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', marginBottom: 20 }}>This can't be undone. To-Dos/timelines already created from it are not affected.</div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDelete(null)} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: 'none', cursor: 'pointer', padding: '10px 16px' }}>Cancel</button>
              <button onClick={() => { remove(confirmDelete.id); setConfirmDelete(null); }}
                style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#ba1a1a', border: 'none', borderRadius: 8, padding: '10px 20px', cursor: 'pointer' }}>
                Delete
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
