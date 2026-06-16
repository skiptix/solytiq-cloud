import { useState } from 'react';
import type { List, Timeline } from '../types';
import Icon from '../components/Icon';
import AddListWizard from './AddListWizard';
import AddTimelineWizard from './AddTimelineWizard';

interface AddWizardProps {
  onClose: () => void;
  onCreatedList: (list: List) => void;
  onCreatedTimeline: (timeline: Timeline) => void;
}

const OPTIONS = [
  {
    key: 'list' as const,
    icon: 'format_list_bulleted',
    title: 'List',
    desc: 'Organize tasks into sections with progress, sharing and more.',
    color: '#5e4dbb',
    bg: '#F5F3FF',
  },
  {
    key: 'timeline' as const,
    icon: 'timeline',
    title: 'Timeline',
    desc: 'Lay out dated milestones on a vertical timeline — plans, roadmaps, events.',
    color: '#1D4ED8',
    bg: '#eff6ff',
  },
];

export default function AddWizard({ onClose, onCreatedList, onCreatedTimeline }: AddWizardProps) {
  const [mode, setMode] = useState<'choose' | 'list' | 'timeline'>('choose');

  if (mode === 'list') {
    return <AddListWizard onClose={() => setMode('choose')} onCreated={onCreatedList} />;
  }
  if (mode === 'timeline') {
    return <AddTimelineWizard onClose={() => setMode('choose')} onCreated={onCreatedTimeline} />;
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 460, boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid #f1ecf6' }}>
          <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>What would you like to add?</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 2 }}>
            <Icon name="close" size={18} color="#787584" />
          </button>
        </div>

        {/* Options */}
        <div style={{ padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {OPTIONS.map(opt => (
            <button key={opt.key}
              onClick={() => setMode(opt.key)}
              style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '16px 18px', borderRadius: 14, border: '1.5px solid #ece8f4', background: '#fff', cursor: 'pointer', textAlign: 'left', transition: 'all 160ms', width: '100%' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = opt.color; e.currentTarget.style.background = opt.bg; e.currentTarget.style.transform = 'translateY(-1px)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = '#ece8f4'; e.currentTarget.style.background = '#fff'; e.currentTarget.style.transform = 'translateY(0)'; }}>
              <div style={{ width: 46, height: 46, borderRadius: 12, background: opt.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Icon name={opt.icon} size={24} color={opt.color} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15.5, fontWeight: 700, color: '#1c1b22', marginBottom: 2 }}>{opt.title}</div>
                <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12.5, color: '#787584', lineHeight: 1.45 }}>{opt.desc}</div>
              </div>
              <Icon name="chevron_right" size={20} color="#c9c4d5" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
