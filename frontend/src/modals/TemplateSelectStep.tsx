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
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onBack(); }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 480, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 24px', borderBottom: '1px solid #f1ecf6', flexShrink: 0 }}>
          <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 2 }}>
            <Icon name="chevron_left" size={20} color="#787584" />
          </button>
          <span style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>
            New {type === 'list' ? 'To-Do' : 'Timeline'}
          </span>
        </div>

        <div style={{ padding: '16px 24px 24px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button onClick={onBlank}
            style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 12, border: '1.5px dashed #d8d2e8', background: '#fcfbff', cursor: 'pointer', textAlign: 'left', transition: 'border-color 150ms, background 150ms, transform 150ms cubic-bezier(0.34,1.56,0.64,1)', animation: 'menuItemIn 200ms ease both' }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#5e4dbb'; e.currentTarget.style.background = '#F5F3FF'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#d8d2e8'; e.currentTarget.style.background = '#fcfbff'; e.currentTarget.style.transform = 'translateY(0)'; }}>
            <Icon name="add_circle" size={22} color="#5e4dbb" />
            <div>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 700, color: '#1c1b22' }}>Start blank</div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584' }}>Build it from scratch</div>
            </div>
          </button>

          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#b0acbe', marginTop: 6, animation: 'menuItemIn 200ms ease 40ms both' }}>
            Or use a template
          </div>

          {loading && list.length === 0 ? (
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', padding: '16px 0', textAlign: 'center' }}>Loading templates…</div>
          ) : list.length === 0 ? (
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', padding: '16px 0', textAlign: 'center', animation: 'menuItemIn 200ms ease 40ms both' }}>
              No {type} templates yet — save one from the Templates page.
            </div>
          ) : (
            list.map((t, i) => (
              <button key={t.id} onClick={() => setSelected(t)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 12, border: '1.5px solid #ece8f4', background: '#fff', cursor: 'pointer', textAlign: 'left', transition: 'border-color 150ms, background 150ms, transform 150ms cubic-bezier(0.34,1.56,0.64,1)', animation: `menuItemIn 200ms ease ${40 + Math.min(i, 6) * 30}ms both` }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = t.color ?? '#5e4dbb'; e.currentTarget.style.background = t.colorBg ?? '#F5F3FF'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#ece8f4'; e.currentTarget.style.background = '#fff'; e.currentTarget.style.transform = 'translateY(0)'; }}>
                <div style={{ width: 34, height: 34, borderRadius: 9, background: t.colorBg ?? '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 16 }}>
                  {t.emoji ?? (type === 'list' ? '📋' : '🗓️')}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 700, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#787584' }}>
                    {type === 'list'
                      ? `${t.summary.sectionCount ?? 0} section${t.summary.sectionCount === 1 ? '' : 's'} · ${t.summary.taskCount ?? 0} task${t.summary.taskCount === 1 ? '' : 's'}`
                      : `${t.summary.milestoneCount ?? 0} milestone${t.summary.milestoneCount === 1 ? '' : 's'}`}
                    {!t.isOwner && ` · Shared by ${t.ownerName ?? 'another user'}`}
                  </div>
                </div>
                <Icon name="chevron_right" size={18} color="#c9c4d5" />
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
