import { useState } from 'react';
import type { MarkdownList } from '../types';
import useMarkdownListsStore from '../store/useMarkdownListsStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import Icon from '../components/Icon';
import EmojiSelector from '../components/EmojiSelector';

const COLORS = [
  { color: '#5e4dbb', bg: '#F5F3FF' },
  { color: '#1D4ED8', bg: '#eff6ff' },
  { color: '#10B981', bg: 'rgba(16,185,129,0.10)' },
  { color: '#ea580c', bg: '#fff7ed' },
  { color: '#f59e0b', bg: '#fffbeb' },
  { color: '#ba1a1a', bg: '#ffdad6' },
];

interface AddMarkdownListWizardProps { onClose: () => void; onCreated: (markdownList: MarkdownList) => void; }

export default function AddMarkdownListWizard({ onClose, onCreated }: AddMarkdownListWizardProps) {
  const [name, setName] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [emoji, setEmoji] = useState('📝');
  const [isPublic, setIsPublic] = useState(false);
  const [colorIdx, setColorIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [createError, setCreateError] = useState('');

  const create = useMarkdownListsStore(s => s.create);
  const currentWorkspaceId = useWorkspaceStore(s => s.currentWorkspaceId);
  const selectedColor = COLORS[colorIdx];

  const handleCreate = async () => {
    if (!name.trim()) return;
    setLoading(true);
    setCreateError('');
    try {
      const created = await create({
        name: name.trim(), emoji, isPublic, color: selectedColor.color, colorBg: selectedColor.bg,
        subtitle: subtitle.trim() || undefined, workspaceId: currentWorkspaceId ?? undefined,
      });
      onCreated(created);
    } catch (e) {
      console.error('createMarkdownList failed', e);
      setCreateError('Failed to create markdown list. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 480, boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid #f1ecf6' }}>
          <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>New Markdown List</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 2 }}>
            <Icon name="close" size={18} color="#787584" />
          </button>
        </div>

        <div style={{ padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div>
            <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', display: 'block', marginBottom: 8 }}>Icon</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <EmojiSelector value={emoji} onChange={setEmoji} direction="down" size={40} allowRemove={false} />
              <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe' }}>Click to choose an emoji</span>
            </div>
          </div>
          <div>
            <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', display: 'block', marginBottom: 6 }}>Name *</label>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Project Notes"
              style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, border: 'none', borderBottom: '1.5px solid #E5E7EB', padding: '8px 0', outline: 'none', color: '#1c1b22', background: 'transparent' }}
              onFocus={e => (e.target.style.borderBottomColor = '#5e4dbb')}
              onBlur={e => (e.target.style.borderBottomColor = '#E5E7EB')} />
          </div>
          <div>
            <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', display: 'block', marginBottom: 6 }}>Subtitle</label>
            <input value={subtitle} onChange={e => setSubtitle(e.target.value)} placeholder="Optional description"
              style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, border: 'none', borderBottom: '1.5px solid #E5E7EB', padding: '8px 0', outline: 'none', color: '#1c1b22', background: 'transparent' }}
              onFocus={e => (e.target.style.borderBottomColor = '#5e4dbb')}
              onBlur={e => (e.target.style.borderBottomColor = '#E5E7EB')} />
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
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584', marginTop: 6 }}>
              {isPublic ? 'Everyone in this workspace can see this markdown list.' : 'Only you can see and edit this markdown list.'}
            </div>
          </div>
          <div>
            <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', display: 'block', marginBottom: 8 }}>Accent Color</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {COLORS.map((c, i) => (
                <button key={i} onClick={() => setColorIdx(i)}
                  style={{ width: 32, height: 32, borderRadius: '50%', background: c.color, border: `3px solid ${colorIdx === i ? '#1c1b22' : 'transparent'}`, cursor: 'pointer', transition: 'all 150ms' }} />
              ))}
            </div>
          </div>
        </div>

        {createError && (
          <div style={{ margin: '0 24px 8px', padding: '8px 12px', background: '#ffdad6', borderRadius: 8, fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a' }}>
            {createError}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, padding: '0 24px 24px', justifyContent: 'flex-end' }}>
          <button onClick={handleCreate} disabled={loading || !name.trim()}
            style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: (loading || !name.trim()) ? '#c9c4d5' : '#5e4dbb', border: 'none', borderRadius: 8, padding: '10px 24px', cursor: (loading || !name.trim()) ? 'not-allowed' : 'pointer' }}>
            {loading ? 'Creating…' : 'Create Markdown List'}
          </button>
        </div>
      </div>
    </div>
  );
}
