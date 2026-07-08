import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Template, List, Timeline } from '../types';
import useTemplatesStore from '../store/useTemplatesStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import useAppStore from '../store/useAppStore';
import Icon from '../components/Icon';

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

  const accent = template.color ?? '#5e4dbb';
  const bg = template.colorBg ?? '#F5F3FF';

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
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 440, boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid #f1ecf6' }}>
          <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>
            New {template.type === 'list' ? 'List' : 'Timeline'} from Template
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 2 }}>
            <Icon name="close" size={18} color="#787584" />
          </button>
        </div>

        <div style={{ padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ background: bg, border: `1px solid ${accent}40`, borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20 }}>{template.emoji ?? (template.type === 'list' ? '📋' : '🗓️')}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 700, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{template.name}</div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#787584' }}>
                {template.type === 'list'
                  ? `${template.summary.sectionCount ?? 0} section${template.summary.sectionCount === 1 ? '' : 's'} · ${template.summary.taskCount ?? 0} task${template.summary.taskCount === 1 ? '' : 's'}`
                  : `${template.summary.milestoneCount ?? 0} milestone${template.summary.milestoneCount === 1 ? '' : 's'}`}
              </div>
            </div>
          </div>

          <div>
            <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', display: 'block', marginBottom: 6 }}>
              {template.type === 'list' ? 'List' : 'Timeline'} Name *
            </label>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
              style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, border: 'none', borderBottom: '1.5px solid #E5E7EB', padding: '8px 0', outline: 'none', color: '#1c1b22', background: 'transparent' }}
              onFocus={(e) => (e.target.style.borderBottomColor = '#5e4dbb')}
              onBlur={(e) => (e.target.style.borderBottomColor = '#E5E7EB')} />
          </div>

          <div>
            <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', display: 'block', marginBottom: 8 }}>Privacy</label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setIsPublic(false)}
                style={{ flex: 1, padding: '10px', borderRadius: 10, border: `1.5px solid ${!isPublic ? '#5e4dbb' : '#E5E7EB'}`, background: !isPublic ? '#F5F3FF' : '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'all 150ms' }}>
                <Icon name="lock" size={16} color={!isPublic ? '#5e4dbb' : '#787584'} />
                <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: !isPublic ? '#5e4dbb' : '#787584' }}>Private</span>
              </button>
              <button onClick={() => setIsPublic(true)}
                style={{ flex: 1, padding: '10px', borderRadius: 10, border: `1.5px solid ${isPublic ? '#5e4dbb' : '#E5E7EB'}`, background: isPublic ? '#F5F3FF' : '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'all 150ms' }}>
                <Icon name="public" size={16} color={isPublic ? '#5e4dbb' : '#787584'} />
                <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: isPublic ? '#5e4dbb' : '#787584' }}>Public</span>
              </button>
            </div>
          </div>

          {!template.isOwner && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10 }}>
              <Icon name="info" size={15} color="#d97706" />
              <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#92400e', lineHeight: 1.5 }}>
                This template was shared by {template.ownerName ?? 'another user'}. Any attached files won't carry over — you'll need to attach your own.
              </span>
            </div>
          )}

          {error && (
            <div style={{ padding: '8px 12px', background: '#ffdad6', borderRadius: 8, fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a' }}>{error}</div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, padding: '0 24px 24px', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: 'none', cursor: 'pointer', padding: '10px 16px' }}>
            Cancel
          </button>
          <button onClick={handleCreate} disabled={loading || !name.trim()}
            style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: (loading || !name.trim()) ? '#c9c4d5' : '#5e4dbb', border: 'none', borderRadius: 8, padding: '10px 24px', cursor: (loading || !name.trim()) ? 'not-allowed' : 'pointer' }}>
            {loading ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
