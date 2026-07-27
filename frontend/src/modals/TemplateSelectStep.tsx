import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Template, List, Timeline } from '../types';
import useTemplatesStore from '../store/useTemplatesStore';
import Icon from '../components/Icon';
import UseTemplateModal from './UseTemplateModal';

interface TemplateSelectStepProps {
  type: 'list' | 'timeline';
  onBack: () => void;
  onBlank: () => void;
  onCreatedList?: (list: List) => void;
  onCreatedTimeline?: (timeline: Timeline) => void;
}

/** Step shown right after choosing List/Timeline in AddWizard, before the
 *  blank-creation wizard: "start blank" or pick an existing template. */
export default function TemplateSelectStep({ type, onBack, onBlank, onCreatedList, onCreatedTimeline }: TemplateSelectStepProps) {
  const { templates, loading, load } = useTemplatesStore();
  const [selected, setSelected] = useState<Template | null>(null);

  useEffect(() => { load(type); }, [type, load]);

  const list = templates.filter((t) => t.type === type);

  if (selected) {
    return (
      <UseTemplateModal
        template={selected}
        onClose={() => setSelected(null)}
        onCreatedList={onCreatedList}
        onCreatedTimeline={onCreatedTimeline}
      />
    );
  }

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onBack(); }}>
      <div style={{ background: 'var(--color-white)', borderRadius: 16, width: '100%', maxWidth: 480, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 24px', borderBottom: '1px solid var(--color-surface-tint-2)', flexShrink: 0 }}>
          <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 2 }}>
            <Icon name="chevron_left" size={20} color="var(--color-text-tertiary)" />
          </button>
          <span style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>
            New {type === 'list' ? 'Board' : 'Timeline'}
          </span>
        </div>

        <div style={{ padding: '16px 24px 24px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button onClick={onBlank}
            style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 12, border: '1.5px dashed var(--color-purple-tint-3)', background: 'var(--color-purple-pale-2)', cursor: 'pointer', textAlign: 'left', transition: 'border-color 150ms, background 150ms, transform 150ms cubic-bezier(0.34,1.56,0.64,1)', animation: 'menuItemIn 200ms ease both' }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.background = 'var(--color-surface-tint)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--color-purple-tint-3)'; e.currentTarget.style.background = 'var(--color-purple-pale-2)'; e.currentTarget.style.transform = 'translateY(0)'; }}>
            <Icon name="add_circle" size={22} color="var(--color-primary)" />
            <div>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)' }}>Start blank</div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>Build it from scratch</div>
            </div>
          </button>

          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-quaternary)', marginTop: 6, animation: 'menuItemIn 200ms ease 40ms both' }}>
            Or use a template
          </div>

          {loading && list.length === 0 ? (
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)', padding: '16px 0', textAlign: 'center' }}>Loading templates…</div>
          ) : list.length === 0 ? (
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)', padding: '16px 0', textAlign: 'center', animation: 'menuItemIn 200ms ease 40ms both' }}>
              No {type} templates yet — save one from the Templates page.
            </div>
          ) : (
            list.map((t, i) => (
              <button key={t.id} onClick={() => setSelected(t)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 12, border: '1.5px solid var(--color-purple-pale-34)', background: 'var(--color-white)', cursor: 'pointer', textAlign: 'left', transition: 'border-color 150ms, background 150ms, transform 150ms cubic-bezier(0.34,1.56,0.64,1)', animation: `menuItemIn 200ms ease ${40 + Math.min(i, 6) * 30}ms both` }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = t.color ?? 'var(--color-primary)'; e.currentTarget.style.background = t.colorBg ?? 'var(--color-surface-tint)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--color-purple-pale-34)'; e.currentTarget.style.background = 'var(--color-white)'; e.currentTarget.style.transform = 'translateY(0)'; }}>
                <div style={{ width: 34, height: 34, borderRadius: 9, background: t.colorBg ?? 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 16 }}>
                  {t.emoji ?? (type === 'list' ? '📋' : '🗓️')}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 700, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
                    {type === 'list'
                      ? `${t.summary.sectionCount ?? 0} section${t.summary.sectionCount === 1 ? '' : 's'} · ${t.summary.taskCount ?? 0} task${t.summary.taskCount === 1 ? '' : 's'}`
                      : `${t.summary.milestoneCount ?? 0} milestone${t.summary.milestoneCount === 1 ? '' : 's'}`}
                    {!t.isOwner && ` · Shared by ${t.ownerName ?? 'another user'}`}
                  </div>
                </div>
                <Icon name="chevron_right" size={18} color="var(--color-border-strong)" />
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
