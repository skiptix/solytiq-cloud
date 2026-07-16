import { useState } from 'react';
import type { MarkdownList } from '../types';
import useMarkdownListsStore from '../store/useMarkdownListsStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import Icon from '../components/Icon';
import EmojiSelector from '../components/EmojiSelector';

const COLORS = [
  { color: 'var(--color-primary)', bg: 'var(--color-surface-tint)' },
  { color: 'var(--color-blue-mid-7)', bg: 'var(--color-blue-pale-2)' },
  { color: 'var(--color-success)', bg: 'rgba(var(--color-success-rgb), 0.10)' },
  { color: 'var(--color-orange)', bg: 'var(--color-orange-pale-3)' },
  { color: 'var(--color-warning-alt)', bg: 'var(--color-yellow-pale-1)' },
  { color: 'var(--color-error)', bg: 'var(--color-error-bg)' },
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
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--color-white)', borderRadius: 16, width: '100%', maxWidth: 480, boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid var(--color-surface-tint-2)' }}>
          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>New Markdown List</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 2 }}>
            <Icon name="close" size={18} color="var(--color-text-tertiary)" />
          </button>
        </div>

        <div style={{ padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div>
            <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 8 }}>Icon</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <EmojiSelector value={emoji} onChange={setEmoji} direction="down" size={40} allowRemove={false} />
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>Click to choose an emoji</span>
            </div>
          </div>
          <div>
            <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 }}>Name *</label>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Project Notes"
              style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, border: 'none', borderBottom: '1.5px solid var(--color-border-alt)', padding: '8px 0', outline: 'none', color: 'var(--color-text-primary)', background: 'transparent' }}
              onFocus={e => (e.target.style.borderBottomColor = 'var(--color-primary)')}
              onBlur={e => (e.target.style.borderBottomColor = 'var(--color-border-alt)')} />
          </div>
          <div>
            <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 }}>Subtitle</label>
            <input value={subtitle} onChange={e => setSubtitle(e.target.value)} placeholder="Optional description"
              style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, border: 'none', borderBottom: '1.5px solid var(--color-border-alt)', padding: '8px 0', outline: 'none', color: 'var(--color-text-primary)', background: 'transparent' }}
              onFocus={e => (e.target.style.borderBottomColor = 'var(--color-primary)')}
              onBlur={e => (e.target.style.borderBottomColor = 'var(--color-border-alt)')} />
          </div>
          <div>
            <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 8 }}>Privacy</label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setIsPublic(false)}
                style={{ flex: 1, padding: '10px', borderRadius: 10, border: `1.5px solid ${!isPublic ? 'var(--color-primary)' : 'var(--color-border-alt)'}`, background: !isPublic ? 'var(--color-surface-tint)' : 'var(--color-white)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'all 150ms' }}>
                <Icon name="lock" size={16} color={!isPublic ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: !isPublic ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }}>Private</span>
              </button>
              <button onClick={() => setIsPublic(true)}
                style={{ flex: 1, padding: '10px', borderRadius: 10, border: `1.5px solid ${isPublic ? 'var(--color-primary)' : 'var(--color-border-alt)'}`, background: isPublic ? 'var(--color-surface-tint)' : 'var(--color-white)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'all 150ms' }}>
                <Icon name="public" size={16} color={isPublic ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: isPublic ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }}>Public</span>
              </button>
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 6 }}>
              {isPublic ? 'Everyone in this workspace can see this markdown list.' : 'Only you can see and edit this markdown list.'}
            </div>
          </div>
          <div>
            <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 8 }}>Accent Color</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {COLORS.map((c, i) => (
                <button key={i} onClick={() => setColorIdx(i)}
                  style={{ width: 32, height: 32, borderRadius: '50%', background: c.color, border: `3px solid ${colorIdx === i ? 'var(--color-text-primary)' : 'transparent'}`, cursor: 'pointer', transition: 'all 150ms' }} />
              ))}
            </div>
          </div>
        </div>

        {createError && (
          <div style={{ margin: '0 24px 8px', padding: '8px 12px', background: 'var(--color-error-bg)', borderRadius: 8, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>
            {createError}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, padding: '0 24px 24px', justifyContent: 'flex-end' }}>
          <button onClick={handleCreate} disabled={loading || !name.trim()}
            style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: (loading || !name.trim()) ? 'var(--color-border-strong)' : 'var(--color-primary)', border: 'none', borderRadius: 8, padding: '10px 24px', cursor: (loading || !name.trim()) ? 'not-allowed' : 'pointer' }}>
            {loading ? 'Creating…' : 'Create Markdown List'}
          </button>
        </div>
      </div>
    </div>
  );
}
