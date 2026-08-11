import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Template, List, Timeline } from '../types';
import useTemplatesStore from '../store/useTemplatesStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import useAppStore from '../store/useAppStore';
import Icon from '../components/Icon';
import ModalIn from '../components/animate-ui/ModalIn';
import MotionIn from '../components/animate-ui/MotionIn';
import MotionButton from '../components/animate-ui/MotionButton';
import { EASE_SETTLE, EASE_SPRING } from '../components/animate-ui/motionTokens';

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
          <MotionIn initial={{ opacity: 0, scale: 0.7 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.32, ease: EASE_SPRING }} style={{ background: bg, border: `1px solid ${accent}40`, borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20 }}>{template.emoji ?? (template.type === 'list' ? '📋' : '🗓️')}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{template.name}</div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
                {template.type === 'list'
                  ? `${template.summary.sectionCount ?? 0} section${template.summary.sectionCount === 1 ? '' : 's'} · ${template.summary.taskCount ?? 0} task${template.summary.taskCount === 1 ? '' : 's'}`
                  : `${template.summary.milestoneCount ?? 0} milestone${template.summary.milestoneCount === 1 ? '' : 's'}`}
              </div>
            </div>
          </MotionIn>

          <MotionIn initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.26, delay: 0.04, ease: EASE_SETTLE }}>
            <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 }}>
              {template.type === 'list' ? 'Board' : 'Timeline'} Name *
            </label>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
              style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, border: 'none', borderBottom: '1.5px solid var(--color-border-alt)', padding: '8px 0', outline: 'none', color: 'var(--color-text-primary)', background: 'transparent' }}
              onFocus={(e) => (e.target.style.borderBottomColor = 'var(--color-primary)')}
              onBlur={(e) => (e.target.style.borderBottomColor = 'var(--color-border-alt)')} />
          </MotionIn>

          <MotionIn initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.26, delay: 0.08, ease: EASE_SETTLE }}>
            <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 8 }}>Privacy</label>
            <div style={{ display: 'flex', gap: 10 }}>
              <MotionButton onClick={() => setIsPublic(false)}
                animate={{ borderColor: !isPublic ? 'var(--color-primary)' : 'var(--color-border-alt)', background: !isPublic ? 'var(--color-surface-tint)' : 'var(--color-white)' }}
                whileHover={{ y: -1 }}
                transition={{ borderColor: { duration: 0.15 }, background: { duration: 0.15 }, y: { duration: 0.15, ease: EASE_SPRING } }}
                style={{ flex: 1, padding: '10px', borderRadius: 10, borderWidth: 1.5, borderStyle: 'solid', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <Icon name="lock" size={16} color={!isPublic ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: !isPublic ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }}>Private</span>
              </MotionButton>
              <MotionButton onClick={() => setIsPublic(true)}
                animate={{ borderColor: isPublic ? 'var(--color-primary)' : 'var(--color-border-alt)', background: isPublic ? 'var(--color-surface-tint)' : 'var(--color-white)' }}
                whileHover={{ y: -1 }}
                transition={{ borderColor: { duration: 0.15 }, background: { duration: 0.15 }, y: { duration: 0.15, ease: EASE_SPRING } }}
                style={{ flex: 1, padding: '10px', borderRadius: 10, borderWidth: 1.5, borderStyle: 'solid', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <Icon name="public" size={16} color={isPublic ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: isPublic ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }}>Public</span>
              </MotionButton>
            </div>
          </MotionIn>

          {!template.isOwner && (
            <MotionIn initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.26, delay: 0.12, ease: EASE_SETTLE }} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', background: 'var(--color-yellow-pale-1)', border: '1px solid var(--color-yellow-tint-2)', borderRadius: 10 }}>
              <Icon name="info" size={15} color="var(--color-warning)" />
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-orange-deep-1)', lineHeight: 1.5 }}>
                This template was shared by {template.ownerName ?? 'another user'}. Any attached files won't carry over — you'll need to attach your own.
              </span>
            </MotionIn>
          )}

          {error && (
            <div style={{ padding: '8px 12px', background: 'var(--color-error-bg)', borderRadius: 8, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>{error}</div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, padding: '0 24px 24px', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: 'none', cursor: 'pointer', padding: '10px 16px' }}>
            Cancel
          </button>
          <MotionButton onClick={handleCreate} disabled={loading || !name.trim()}
            animate={{ background: (loading || !name.trim()) ? 'var(--color-border-strong)' : 'var(--color-primary)' }}
            whileHover={!loading && name.trim() ? { scale: 1.04 } : undefined}
            transition={{ background: { duration: 0.15 }, scale: { duration: 0.15, ease: EASE_SPRING } }}
            style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', border: 'none', borderRadius: 8, padding: '10px 24px', cursor: (loading || !name.trim()) ? 'not-allowed' : 'pointer' }}>
            {loading ? 'Creating…' : 'Create'}
          </MotionButton>
        </div>
      </ModalIn>
    </div>,
    document.body
  );
}
