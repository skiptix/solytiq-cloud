import { useState } from 'react';
import type { List } from '../types';
import useAppStore from '../store/useAppStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import useUserPrefsStore from '../store/useUserPrefsStore';
import { apiCreateList, apiCreateSection } from '../api/client';
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

interface AddListWizardProps { onClose: () => void; onCreated: (list: List) => void; }

export default function AddListWizard({ onClose, onCreated }: AddListWizardProps) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [emoji, setEmoji] = useState('📋');
  const [isPublic, setIsPublic] = useState(false);
  const [colorIdx, setColorIdx] = useState(0);
  const [sections, setSections] = useState<Array<{ id: string; label: string; emoji: string }>>([]);
  const [newSection, setNewSection] = useState('');
  const [newSectionEmoji, setNewSectionEmoji] = useState('📌');
  const [loading, setLoading] = useState(false);
  const [createError, setCreateError] = useState('');

  const { setLists, loadFromApi } = useAppStore();
  const currentWorkspaceId = useWorkspaceStore(s => s.currentWorkspaceId);
  const defaultListViewMode = useUserPrefsStore(s => s.defaultListViewMode);
  const selectedColor = COLORS[colorIdx];

  const addSection = () => {
    if (!newSection.trim()) return;
    setSections(s => [...s, { id: `section_${Date.now()}`, label: newSection.trim(), emoji: newSectionEmoji }]);
    setNewSection(''); setNewSectionEmoji('📌');
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setLoading(true);
    setCreateError('');
    try {
      const listId = `list_${Date.now()}`;
      const res = await apiCreateList({ id: listId, name: name.trim(), emoji, isPublic, color: selectedColor.color, colorBg: selectedColor.bg, subtitle: subtitle.trim() || undefined, workspaceId: currentWorkspaceId ?? undefined, viewMode: defaultListViewMode });
      const createdList = res.list;
      // Add an optimistic placeholder so the list appears immediately
      setLists(prev => [...prev, { ...createdList, sections: [] }]);
      // Create sections sequentially; any individual failure is logged but does not abort
      for (const sec of sections) {
        try {
          await apiCreateSection(createdList.id, { id: sec.id, label: sec.label, emoji: sec.emoji });
        } catch (e) { console.error('section create failed', e); }
      }
      // Reload from server to get the authoritative state (includes only sections that actually saved)
      await loadFromApi(currentWorkspaceId ?? undefined);
      const savedList = useAppStore.getState().lists.find(l => l.id === createdList.id) ?? { ...createdList, sections: [] };
      onCreated(savedList as List);
    } catch (e) {
      console.error('createList failed', e);
      setCreateError('Failed to create list. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--color-white)', borderRadius: 16, width: '100%', maxWidth: 480, boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid var(--color-surface-tint-2)' }}>
          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>
            {step === 0 ? 'New To-Do' : step === 1 ? 'Add Sections' : 'Review & Create'}
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 2 }}>
            <Icon name="close" size={18} color="var(--color-text-tertiary)" />
          </button>
        </div>

        {/* Progress */}
        <div style={{ display: 'flex', gap: 4, padding: '12px 24px 0' }}>
          {[0,1,2].map(i => <div key={i} style={{ flex: 1, height: 3, borderRadius: 9999, background: i <= step ? 'var(--color-primary)' : 'var(--color-border)', transition: 'background 300ms' }} />)}
        </div>

        <div style={{ padding: '20px 24px 24px' }}>
          {step === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {/* Emoji */}
              <div>
                <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 8 }}>Icon</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <EmojiSelector value={emoji} onChange={setEmoji} direction="down" size={40} allowRemove={false} />
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>Click to choose an emoji</span>
                </div>
              </div>
              {/* Name */}
              <div>
                <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 }}>To-Do Name *</label>
                <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Work Projects"
                  style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, border: 'none', borderBottom: '1.5px solid var(--color-border-alt)', padding: '8px 0', outline: 'none', color: 'var(--color-text-primary)', background: 'transparent' }}
                  onFocus={e => (e.target.style.borderBottomColor = 'var(--color-primary)')}
                  onBlur={e => (e.target.style.borderBottomColor = 'var(--color-border-alt)')} />
              </div>
              {/* Subtitle */}
              <div>
                <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 }}>Subtitle</label>
                <input value={subtitle} onChange={e => setSubtitle(e.target.value)} placeholder="Optional description"
                  style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, border: 'none', borderBottom: '1.5px solid var(--color-border-alt)', padding: '8px 0', outline: 'none', color: 'var(--color-text-primary)', background: 'transparent' }}
                  onFocus={e => (e.target.style.borderBottomColor = 'var(--color-primary)')}
                  onBlur={e => (e.target.style.borderBottomColor = 'var(--color-border-alt)')} />
              </div>
              {/* Privacy */}
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
                  {isPublic ? 'Everyone in this workspace can see this to-do.' : 'Only you can see and edit this to-do.'}
                </div>
              </div>
              {/* Color */}
              <div>
                <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 8 }}>Accent Color</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {COLORS.map((c, i) => (
                    <button key={i} onClick={() => setColorIdx(i)}
                      style={{ width: 32, height: 32, borderRadius: '50%', background: c.color, border: `3px solid ${colorIdx === i ? 'var(--color-text-primary)' : 'transparent'}`, cursor: 'pointer', transition: 'all 150ms' }} />
                  ))}
                </div>
              </div>
              {/* Preview */}
              <div style={{ background: selectedColor.bg, border: `1px solid ${selectedColor.color}40`, borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 20 }}>{emoji}</span>
                <div>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)' }}>{name || 'To-Do Name'}</div>
                  {subtitle && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>{subtitle}</div>}
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)' }}>Sections organize tasks within your to-do. You can add or skip them.</div>
              {sections.map(sec => (
                <div key={sec.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'var(--color-purple-pale-11)', borderRadius: 10, border: '1px solid var(--color-border)' }}>
                  <span style={{ fontSize: 16 }}>{sec.emoji}</span>
                  <span style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{sec.label}</span>
                  <button onClick={() => setSections(s => s.filter(x => x.id !== sec.id))} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                    <Icon name="close" size={14} color="var(--color-text-tertiary)" />
                  </button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <EmojiSelector value={newSectionEmoji} onChange={setNewSectionEmoji} direction="down" size={38} allowRemove={false} />
                <input value={newSection} onChange={e => setNewSection(e.target.value)} onKeyDown={e => e.key === 'Enter' && addSection()} placeholder="Section name…"
                  style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 14, border: '1.5px solid var(--color-border)', borderRadius: 8, padding: '8px 12px', outline: 'none', background: 'var(--color-white)' }}
                  onFocus={e => (e.target.style.borderColor = 'var(--color-primary)')} onBlur={e => (e.target.style.borderColor = 'var(--color-border)')} />
                <button onClick={addSection} disabled={!newSection.trim()}
                  style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: newSection.trim() ? 'var(--color-primary)' : 'var(--color-border-strong)', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: newSection.trim() ? 'pointer' : 'default' }}>
                  Add
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ background: selectedColor.bg, border: `1px solid ${selectedColor.color}40`, borderRadius: 12, padding: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <span style={{ fontSize: 24 }}>{emoji}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)' }}>{name}</div>
                    {subtitle && <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)' }}>{subtitle}</div>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(var(--color-white-rgb), 0.5)', padding: '4px 8px', borderRadius: 8 }}>
                    <Icon name={isPublic ? 'public' : 'lock'} size={14} color="var(--color-text-tertiary)" />
                    <span style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase' }}>{isPublic ? 'Public' : 'Private'}</span>
                  </div>
                </div>
                {sections.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {sections.map(s => (
                      <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-tertiary)' }}>
                        <span>{s.emoji}</span> {s.label}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {createError && (
          <div style={{ margin: '0 24px 8px', padding: '8px 12px', background: 'var(--color-error-bg)', borderRadius: 8, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>
            {createError}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, padding: '0 24px 24px', justifyContent: 'space-between', alignItems: 'center' }}>
          {step > 0 ? (
            <button onClick={() => setStep(s => s - 1)} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: 'none', cursor: 'pointer', padding: '10px 0', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Icon name="chevron_left" size={14} color="var(--color-text-secondary)" /> Back
            </button>
          ) : <div />}
          {step < 2 ? (
            <button onClick={() => setStep(s => s + 1)} disabled={step === 0 && !name.trim()}
              style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: (step === 0 && !name.trim()) ? 'var(--color-border-strong)' : 'var(--color-primary)', border: 'none', borderRadius: 8, padding: '10px 24px', cursor: (step === 0 && !name.trim()) ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
              {step === 1 ? 'Review' : 'Next'} <Icon name="arrow_forward" size={14} color="var(--color-white)" />
            </button>
          ) : (
            <button onClick={handleCreate} disabled={loading}
              style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: loading ? 'var(--color-accent-purple-light)' : 'var(--color-primary)', border: 'none', borderRadius: 8, padding: '10px 24px', cursor: loading ? 'wait' : 'pointer' }}>
              {loading ? 'Creating…' : 'Create To-Do'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
