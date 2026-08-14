import { useState } from 'react';
import type { List, Timeline, MarkdownList } from '../types';
import Icon from '../components/Icon';
import useKnowledgeBaseStore from '../store/useKnowledgeBaseStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import AddListWizard from './AddListWizard';
import AddTimelineWizard from './AddTimelineWizard';
import AddMarkdownListWizard from './AddMarkdownListWizard';
import TemplateSelectStep from './TemplateSelectStep';
import ModalIn from '../components/animate-ui/ModalIn';
import MotionButton from '../components/animate-ui/MotionButton';

interface AddWizardProps {
  onClose: () => void;
  onCreatedList: (list: List) => void;
  onCreatedTimeline: (timeline: Timeline) => void;
  onCreatedMarkdownList: (markdownList: MarkdownList) => void;
  /** The Knowledge Base has no creation wizard — it is created in place and the
   *  caller navigates to it. */
  onCreatedKnowledgeBase: () => void;
  /** Skip the chooser and open a specific creation wizard directly (e.g. the "New list" shortcut). */
  initialMode?: 'list' | 'timeline';
}

const OPTIONS = [
  {
    key: 'list' as const,
    icon: 'format_list_bulleted',
    title: 'Board',
    desc: 'Organize tasks into sections with progress, sharing and more.',
    color: 'var(--color-primary)',
    bg: 'var(--color-surface-tint)',
  },
  {
    key: 'timeline' as const,
    icon: 'timeline',
    title: 'Timeline',
    desc: 'Lay out dated milestones on a vertical timeline — plans, roadmaps, events.',
    color: 'var(--color-blue-mid-7)',
    bg: 'var(--color-blue-pale-2)',
  },
  {
    key: 'markdownList' as const,
    icon: 'notes',
    title: 'Markdown Page',
    desc: 'Craft a document with / commands — headings, images, links, and checkable todos.',
    color: 'var(--color-teal-deep-4)',
    bg: 'var(--color-green-pale-2)',
  },
  {
    key: 'knowledge' as const,
    icon: 'neurology',
    title: 'Knowledge',
    desc: "This workspace's dictionary, as a net — the terms your assistant and MCP clients look up instead of guessing.",
    color: 'var(--color-primary)',
    bg: 'var(--color-purple-pale-21)',
  },
];

type Mode = 'choose' | 'list-templates' | 'timeline-templates' | 'list' | 'timeline' | 'markdownList';

export default function AddWizard({ onClose, onCreatedList, onCreatedTimeline, onCreatedMarkdownList, onCreatedKnowledgeBase, initialMode }: AddWizardProps) {
  const [mode, setMode] = useState<Mode>(
    initialMode === 'list' ? 'list-templates' : initialMode === 'timeline' ? 'timeline-templates' : 'choose'
  );
  // A workspace has exactly one Knowledge Base, so the tile disappears once it
  // exists rather than offering a create that would just resolve to the
  // existing one.
  const workspaceId = useWorkspaceStore(s => s.currentWorkspaceId);
  const existingBase = useKnowledgeBaseStore(s => s.base);
  const createKnowledgeBase = useKnowledgeBaseStore(s => s.create);
  const [creatingKb, setCreatingKb] = useState(false);

  const options = OPTIONS.filter(o => o.key !== 'knowledge' || (!existingBase && workspaceId));

  const handleKnowledge = async () => {
    if (!workspaceId || creatingKb) return;
    setCreatingKb(true);
    try {
      await createKnowledgeBase(workspaceId);
      onCreatedKnowledgeBase();
    } finally {
      setCreatingKb(false);
    }
  };

  // The template-select step comes first for both types: "Start blank" drops
  // into the classic step-by-step wizard below, or pick a template to skip
  // straight to a hydrated list/timeline.
  if (mode === 'list-templates') {
    return (
      <TemplateSelectStep type="list" onBack={() => setMode('choose')} onBlank={() => setMode('list')}
        onCreatedList={onCreatedList} />
    );
  }
  if (mode === 'timeline-templates') {
    return (
      <TemplateSelectStep type="timeline" onBack={() => setMode('choose')} onBlank={() => setMode('timeline')}
        onCreatedTimeline={onCreatedTimeline} />
    );
  }
  if (mode === 'list') {
    return <AddListWizard onClose={() => setMode('list-templates')} onCreated={onCreatedList} />;
  }
  if (mode === 'timeline') {
    return <AddTimelineWizard onClose={() => setMode('timeline-templates')} onCreated={onCreatedTimeline} />;
  }
  if (mode === 'markdownList') {
    // No template step yet — Markdown Pages aren't a supported template type.
    return <AddMarkdownListWizard onClose={() => setMode('choose')} onCreated={onCreatedMarkdownList} />;
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <ModalIn duration={280} style={{ background: 'var(--color-white)', borderRadius: 16, width: '100%', maxWidth: 460, boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid var(--color-surface-tint-2)' }}>
          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>What would you like to add?</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 2 }}>
            <Icon name="close" size={18} color="var(--color-text-tertiary)" />
          </button>
        </div>

        {/* Options */}
        <div style={{ padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {options.map(opt => (
            <MotionButton key={opt.key}
              onClick={() => {
                if (opt.key === 'knowledge') { void handleKnowledge(); return; }
                setMode(opt.key === 'markdownList' ? 'markdownList' : `${opt.key}-templates`);
              }}
              transition={{ duration: 0.16 }} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '16px 18px', borderRadius: 14, border: '1.5px solid var(--color-purple-pale-34)', background: 'var(--color-white)', cursor: 'pointer', textAlign: 'left', width: '100%' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = opt.color; e.currentTarget.style.background = opt.bg; e.currentTarget.style.transform = 'translateY(-1px)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-purple-pale-34)'; e.currentTarget.style.background = 'var(--color-white)'; e.currentTarget.style.transform = 'translateY(0)'; }}>
              <div style={{ width: 46, height: 46, borderRadius: 12, background: opt.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Icon name={opt.icon} size={24} color={opt.color} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 15.5, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 2 }}>{opt.title}</div>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.45 }}>{opt.desc}</div>
              </div>
              <Icon name="chevron_right" size={20} color="var(--color-border-strong)" />
            </MotionButton>
          ))}
        </div>
      </ModalIn>
    </div>
  );
}
