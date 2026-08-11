import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Template, List, Timeline } from '../types';
import useTemplatesStore from '../store/useTemplatesStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import useAppStore from '../store/useAppStore';
import Icon from '../components/Icon';
import ModalIn from '../components/animate-ui/ModalIn';

interface UseTemplateModalProps {
  template: Template;
  onClose: () => void;
  onCreatedList?: (list: List) => void;
  onCreatedTimeline?: (timeline: Timeline) => void;
}

/** Small "instantiate" step shown after picking a template — collects a name
 *  and visibility, then materializes the list/timeline server-side. Used both
 *  from the Templates page and from the template-select step in AddWizard. */
export default function UseTemplateModal({ template, onClose, onCreatedList, onCreatedTimeline }: UseTemplateModalProps) {
  const [name, setName] = useState(template.name);
  const [isPublic, setIsPublic] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const instantiateTemplate = useTemplatesStore((s) => s.use);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const { setLists, setTimelines } = useAppStore();

  const accent = template.color ?? 'var(--color-primary)';
  const bg = template.colorBg ?? 'var(--color-surface-tint)';

  const handleCreate = async () => {
    if (!name.trim()) return;
    setLoading(true);
    setError('');
    try {
      const res = await instantiateTemplate(template.id, {
        name: name.trim(),
        isPublic,
        workspaceId: currentWorkspaceId ?? undefined,
      });
      if (res.list) {
        setLists((prev) => [...prev, res.list!]);
        onCreatedList?.(res.list);
      } else if (res.timeline) {
        setTimelines((prev) => [...prev, res.timeline!]);
        onCreatedTimeline?.(res.timeline);
      }
    } catch {
      setError('Failed to create from template. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <ModalIn duration={280} style={{ background: 'var(--color-white)', borderRadius: 16, width: '100%', maxWidth: 440, boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid var(--color-surface-tint-2)' }}>
          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>
            New {template.type === 'list' ? 'Board' : 'Timeline'} from Template
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 2 }}>
            <Icon name="close" size={18} color="var(--color-text-tertiary)" />
          </button>
        </div>

        <div style={{ padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ background: bg, border: `1px solid ${accent}40`, borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, animation: 'previewReveal 320ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <span style={{ fontSize: 20 }}>{template.emoji ?? (template.type === 'list' ? '📋' : '🗓️')}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{template.name}</div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
                {template.type === 'list'
                  ? `${template.summary.sectionCount ?? 0} section${template.summary.sectionCount === 1 ? '' : 's'} · ${template.summary.taskCount ?? 0} task${template.summary.taskCount === 1 ? '' : 's'}`
                  : `${template.summary.milestoneCount ?? 0} milestone${template.summary.milestoneCount === 1 ? '' : 's'}`}
              </div>
            </div>
          </div>

          <div style={{ animation: 'wizardStepIn 260ms cubic-bezier(0.22,1,0.36,1) 40ms both' }}>
            <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 }}>
              {template.type === 'list' ? 'Board' : 'Timeline'} Name *
            </label>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
              style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, border: 'none', borderBottom: '1.5px solid var(--color-border-alt)', padding: '8px 0', outline: 'none', color: 'var(--color-text-primary)', background: 'transparent' }}
              onFocus={(e) => (e.target.style.borderBottomColor = 'var(--color-primary)')}
              onBlur={(e) => (e.target.style.borderBottomColor = 'var(--color-border-alt)')} />
          </div>

          <div style={{ animation: 'wizardStepIn 260ms cubic-bezier(0.22,1,0.36,1) 80ms both' }}>
            <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 8 }}>Privacy</label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setIsPublic(false)}
                style={{ flex: 1, padding: '10px', borderRadius: 10, border: `1.5px solid ${!isPublic ? 'var(--color-primary)' : 'var(--color-border-alt)'}`, background: !isPublic ? 'var(--color-surface-tint)' : 'var(--color-white)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'border-color 150ms, background 150ms, transform 150ms cubic-bezier(0.34,1.56,0.64,1)' }}
                onMouseEnter={(e) => (e.currentTarget.style.transform = 'translateY(-1px)')}
                onMouseLeave={(e) => (e.currentTarget.style.transform = 'translateY(0)')}>
                <Icon name="lock" size={16} color={!isPublic ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: !isPublic ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }}>Private</span>
              </button>
              <button onClick={() => setIsPublic(true)}
                style={{ flex: 1, padding: '10px', borderRadius: 10, border: `1.5px solid ${isPublic ? 'var(--color-primary)' : 'var(--color-border-alt)'}`, background: isPublic ? 'var(--color-surface-tint)' : 'var(--color-white)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'border-color 150ms, background 150ms, transform 150ms cubic-bezier(0.34,1.56,0.64,1)' }}
                onMouseEnter={(e) => (e.currentTarget.style.transform = 'translateY(-1px)')}
                onMouseLeave={(e) => (e.currentTarget.style.transform = 'translateY(0)')}>
                <Icon name="public" size={16} color={isPublic ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: isPublic ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }}>Public</span>
              </button>
            </div>
          </div>

          {!template.isOwner && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', background: 'var(--color-yellow-pale-1)', border: '1px solid var(--color-yellow-tint-2)', borderRadius: 10, animation: 'wizardStepIn 260ms cubic-bezier(0.22,1,0.36,1) 120ms both' }}>
              <Icon name="info" size={15} color="var(--color-warning)" />
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-orange-deep-1)', lineHeight: 1.5 }}>
                This template was shared by {template.ownerName ?? 'another user'}. Any attached files won't carry over — you'll need to attach your own.
              </span>
            </div>
          )}

          {error && (
            <div style={{ padding: '8px 12px', background: 'var(--color-error-bg)', borderRadius: 8, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>{error}</div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, padding: '0 24px 24px', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: 'none', cursor: 'pointer', padding: '10px 16px' }}>
            Cancel
          </button>
          <button onClick={handleCreate} disabled={loading || !name.trim()}
            style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: (loading || !name.trim()) ? 'var(--color-border-strong)' : 'var(--color-primary)', border: 'none', borderRadius: 8, padding: '10px 24px', cursor: (loading || !name.trim()) ? 'not-allowed' : 'pointer', transition: 'background 150ms, transform 150ms cubic-bezier(0.34,1.56,0.64,1)' }}
            onMouseEnter={(e) => { if (!loading && name.trim()) e.currentTarget.style.transform = 'scale(1.04)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}>
            {loading ? 'Creating…' : 'Create'}
          </button>
        </div>
      </ModalIn>
    </div>,
    document.body
  );
}
