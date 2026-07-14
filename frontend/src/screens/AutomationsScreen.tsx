import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle';
import { useMobile } from '../hooks/useBreakpoint';
import type { Automation } from '../types';
import useAutomationsStore from '../store/useAutomationsStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import useSyncStore from '../store/useSyncStore';
import Icon from '../components/Icon';

function chainSummary(automation: Automation, nodeTypes: ReturnType<typeof useAutomationsStore.getState>['nodeTypes']): string {
  const trigger = nodeTypes?.triggers.find((t) => t.id === automation.triggerType);
  const actionIds = automation.graph.nodes.filter((n) => n.kind === 'action').map((n) => n.type);
  const actionLabels = actionIds.map((id) => nodeTypes?.actions.find((a) => a.id === id)?.label ?? id);
  return [trigger?.label ?? automation.triggerType, ...actionLabels].join(' → ');
}

function triggerIcon(automation: Automation, nodeTypes: ReturnType<typeof useAutomationsStore.getState>['nodeTypes']): string {
  return nodeTypes?.triggers.find((t) => t.id === automation.triggerType)?.icon ?? 'bolt';
}

function AutomationCardMenu({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
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
      <button onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        style={{ width: 26, height: 26, borderRadius: 7, border: 'none', background: open ? '#ebe6f0' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="more_vert" size={15} color="#9d8dff" />
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, width: 170, background: '#fff', borderRadius: 10, boxShadow: '0 4px 20px rgba(0,0,0,0.13)', border: '1px solid #e8e4f0', padding: '4px 0', zIndex: 400, animation: 'menuIn 140ms ease both' }}>
          <button onClick={(e) => { e.stopPropagation(); setOpen(false); onEdit(); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, color: '#1c1b22', textAlign: 'left' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#f5f3ff')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
            <Icon name="account_tree" size={15} color="#787584" /> Edit
          </button>
          <div style={{ height: 1, background: '#f0ecf8', margin: '4px 0' }} />
          <button onClick={(e) => { e.stopPropagation(); setOpen(false); onDelete(); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, color: '#ba1a1a', textAlign: 'left' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#ffdad6')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
            <Icon name="delete" size={15} color="#ba1a1a" /> Delete
          </button>
        </div>
      )}
    </div>
  );
}

function AutomationCard({ automation, index, nodeTypes, onOpen, onDelete, onToggleEnabled }: {
  automation: Automation;
  index: number;
  nodeTypes: ReturnType<typeof useAutomationsStore.getState>['nodeTypes'];
  onOpen: () => void;
  onDelete: () => void;
  onToggleEnabled: (enabled: boolean) => void;
}) {
  const delay = Math.min(index * 40, 400);
  const icon = triggerIcon(automation, nodeTypes);

  return (
    <div onClick={onOpen} role="button" tabIndex={0}
      style={{ background: '#fff', border: '1.5px solid #ece8f4', borderRadius: 16, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10, cursor: 'pointer', transition: 'border-color 200ms, box-shadow 200ms, transform 200ms cubic-bezier(0.34,1.56,0.64,1)', animation: `cardIn 340ms cubic-bezier(0.34,1.56,0.64,1) ${delay}ms both`, opacity: automation.enabled ? 1 : 0.6 }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#5e4dbb'; e.currentTarget.style.boxShadow = '0 8px 20px rgba(94,77,187,0.10)'; e.currentTarget.style.transform = 'translateY(-3px)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#ece8f4'; e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'translateY(0)'; }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ width: 40, height: 40, borderRadius: 11, background: '#FEF3E2', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon name={icon} size={19} color="#f59e0b" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14.5, fontWeight: 700, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{automation.name}</div>
          <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#787584', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{chainSummary(automation, nodeTypes)}</div>
        </div>
        {automation.isOwner && (
          <div onClick={(e) => e.stopPropagation()}>
            <AutomationCardMenu onEdit={onOpen} onDelete={onDelete} />
          </div>
        )}
      </div>

      {automation.description && (
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12.5, color: '#484552', lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
          {automation.description}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
        {automation.isOwner ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10.5, fontWeight: 700, color: automation.enabled ? '#10B981' : '#b0acbe' }}>
            <Icon name={automation.enabled ? 'check_circle' : 'pause_circle'} size={13} color={automation.enabled ? '#10B981' : '#b0acbe'} />
            {automation.enabled ? 'Enabled' : 'Disabled'}
          </span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe' }}>
            <Icon name="person" size={12} color="#b0acbe" /> {automation.ownerName ?? 'Another user'}
          </span>
        )}
        {automation.isOwner && (
          <button onClick={(e) => { e.stopPropagation(); onToggleEnabled(!automation.enabled); }}
            style={{ width: 36, height: 20, borderRadius: 9999, border: 'none', cursor: 'pointer', background: automation.enabled ? '#5e4dbb' : '#e5e1ee', position: 'relative', transition: 'background 180ms' }}>
            <span style={{ position: 'absolute', top: 2, left: automation.enabled ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.25)', transition: 'left 180ms cubic-bezier(0.34,1.56,0.64,1)' }} />
          </button>
        )}
      </div>
    </div>
  );
}

export default function AutomationsScreen() {
  usePageTitle('Automations');
  const isMobile = useMobile();
  const navigate = useNavigate();
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);

  const { automations, loading, nodeTypes, load, loadNodeTypes, remove, setEnabled } = useAutomationsStore();
  const [search, setSearch] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<Automation | null>(null);

  useEffect(() => { loadNodeTypes(); }, [loadNodeTypes]);
  useEffect(() => { if (currentWorkspaceId) load(currentWorkspaceId); }, [currentWorkspaceId, load]);

  const automationRev = useSyncStore((s) => s.entityRevisions.automation ?? 0);
  useEffect(() => { if (automationRev > 0 && currentWorkspaceId) load(currentWorkspaceId); }, [automationRev, currentWorkspaceId, load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return automations;
    return automations.filter((a) => a.name.toLowerCase().includes(q) || (a.description ?? '').toLowerCase().includes(q));
  }, [automations, search]);

  return (
    <div style={{ flex: 1, height: '100%', overflowY: 'auto' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: isMobile ? '16px 12px 48px' : '32px 32px 48px', display: 'flex', flexDirection: 'column', gap: 20, width: '100%', animation: 'sectionFadeUp 360ms cubic-bezier(0.22,1,0.36,1) both' }}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 28, fontWeight: 700, color: '#1c1b22', letterSpacing: '-0.02em', margin: 0 }}>Automations</h1>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', marginTop: 2 }}>
              Build flow-chart automations for this workspace — visible to everyone here, editable only by their creator.
            </div>
          </div>
          <button onClick={() => navigate('/automations/new')}
            style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#5e4dbb', border: 'none', borderRadius: 10, padding: '9px 16px', cursor: 'pointer', transition: 'background 180ms, transform 180ms cubic-bezier(0.34,1.56,0.64,1), box-shadow 180ms' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#4f3fa8'; e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 6px 16px rgba(94,77,187,0.3)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '#5e4dbb'; e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none'; }}>
            <Icon name="add" size={16} color="#fff" /> New Automation
          </button>
        </div>

        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', maxWidth: 320 }}>
          <span style={{ position: 'absolute', left: 12, display: 'flex', pointerEvents: 'none' }}>
            <Icon name="search" size={15} color="#b0acbe" />
          </span>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search automations…"
            style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 13, border: '1.5px solid #e8e4f0', borderRadius: 9999, padding: '8px 14px 8px 34px', outline: 'none', background: '#fafafa' }}
            onFocus={(e) => (e.target.style.borderColor = '#5e4dbb')} onBlur={(e) => (e.target.style.borderColor = '#e8e4f0')} />
        </div>

        {loading && automations.length === 0 ? (
          <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', padding: '40px 0', textAlign: 'center' }}>Loading automations…</div>
        ) : filtered.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '60px 20px', color: '#b0acbe', animation: 'cardIn 380ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <div style={{ animation: 'fileDropIconFloat 3s ease-in-out infinite' }}>
              <Icon name="bolt" size={40} color="#d8d2e8" />
            </div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 600, color: '#787584' }}>
              {automations.length === 0 ? 'No automations yet' : 'No automations match your search'}
            </div>
            {automations.length === 0 && (
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', textAlign: 'center', maxWidth: 320 }}>
                Automate routine upkeep — like deleting checked items or archiving finished lists — with a trigger and one or more actions.
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
            {filtered.map((a, i) => (
              <AutomationCard key={a.id} automation={a} index={i} nodeTypes={nodeTypes}
                onOpen={() => navigate(`/automations/${a.id}`)}
                onDelete={() => setConfirmDelete(a)}
                onToggleEnabled={(enabled) => setEnabled(a.id, enabled)} />
            ))}
          </div>
        )}
      </div>

      {confirmDelete && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)', backdropFilter: 'blur(5px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setConfirmDelete(null); }}>
          <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 380, boxShadow: '0 12px 40px rgba(0,0,0,0.18)', padding: 24, animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22', marginBottom: 8 }}>Delete "{confirmDelete.name}"?</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', marginBottom: 20 }}>This can't be undone. Its run history will be deleted too.</div>
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
