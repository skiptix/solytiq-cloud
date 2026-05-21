import { useState } from 'react';
import type { List } from '../types';
import useAppStore from '../store/useAppStore';
import { apiCreateList, apiCreateSection } from '../api/client';
import Icon from '../components/Icon';

const EMOJIS = ['📋','🎯','🚴','🏃','💡','📚','🛒','🏠','💼','🎵','🏋️','✈️','🌱','💰','🎨','🔬','🍳','🎮','📷','🌍'];
const COLORS = [
  { color: '#5e4dbb', bg: '#F5F3FF' },
  { color: '#1D4ED8', bg: '#eff6ff' },
  { color: '#10B981', bg: 'rgba(16,185,129,0.10)' },
  { color: '#ea580c', bg: '#fff7ed' },
  { color: '#f59e0b', bg: '#fffbeb' },
  { color: '#ba1a1a', bg: '#ffdad6' },
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

  const { setLists } = useAppStore();
  const selectedColor = COLORS[colorIdx];

  const addSection = () => {
    if (!newSection.trim()) return;
    setSections(s => [...s, { id: `section_${Date.now()}`, label: newSection.trim(), emoji: newSectionEmoji }]);
    setNewSection(''); setNewSectionEmoji('📌');
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setLoading(true);
    try {
      const listId = `list_${Date.now()}`;
      const res = await apiCreateList({ id: listId, name: name.trim(), emoji, isPublic, color: selectedColor.color, colorBg: selectedColor.bg, subtitle: subtitle.trim() || undefined });
      const createdList = res.list;
      // Add sections
      for (const sec of sections) {
        try {
          await apiCreateSection(createdList.id, { id: sec.id, label: sec.label, emoji: sec.emoji });
        } catch (e) { console.error('section create failed', e); }
      }
      // Reload to get full list with sections
      const finalList: List = {
        ...createdList,
        sections: sections.map(s => ({ id: s.id, label: s.label, emoji: s.emoji, tasks: [] })),
      };
      setLists(prev => [...prev, finalList]);
      onCreated(finalList);
    } catch (e) {
      console.error('createList failed', e);
      // Fallback: create locally
      const localList: List = {
        id: `list_${Date.now()}`,
        name: name.trim(),
        emoji,
        isPublic,
        color: selectedColor.color,
        colorBg: selectedColor.bg,
        subtitle: subtitle.trim() || undefined,
        sections: sections.map(s => ({ id: s.id, label: s.label, emoji: s.emoji, tasks: [] })),
      };
      setLists(prev => [...prev, localList]);
      onCreated(localList);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 480, boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid #f1ecf6' }}>
          <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>
            {step === 0 ? 'New List' : step === 1 ? 'Add Sections' : 'Review & Create'}
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 2 }}>
            <Icon name="close" size={18} color="#787584" />
          </button>
        </div>

        {/* Progress */}
        <div style={{ display: 'flex', gap: 4, padding: '12px 24px 0' }}>
          {[0,1,2].map(i => <div key={i} style={{ flex: 1, height: 3, borderRadius: 9999, background: i <= step ? '#5e4dbb' : '#e8e4f0', transition: 'background 300ms' }} />)}
        </div>

        <div style={{ padding: '20px 24px 24px' }}>
          {step === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {/* Emoji */}
              <div>
                <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', display: 'block', marginBottom: 8 }}>Icon</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {EMOJIS.map(e => (
                    <button key={e} onClick={() => setEmoji(e)}
                      style={{ width: 36, height: 36, borderRadius: 8, border: `2px solid ${emoji === e ? '#5e4dbb' : 'transparent'}`, background: emoji === e ? '#F5F3FF' : '#f7f4fc', fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms' }}>
                      {e}
                    </button>
                  ))}
                </div>
              </div>
              {/* Name */}
              <div>
                <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', display: 'block', marginBottom: 6 }}>List Name *</label>
                <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Work Projects"
                  style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, border: 'none', borderBottom: '1.5px solid #E5E7EB', padding: '8px 0', outline: 'none', color: '#1c1b22', background: 'transparent' }}
                  onFocus={e => (e.target.style.borderBottomColor = '#5e4dbb')}
                  onBlur={e => (e.target.style.borderBottomColor = '#E5E7EB')} />
              </div>
              {/* Subtitle */}
              <div>
                <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', display: 'block', marginBottom: 6 }}>Subtitle</label>
                <input value={subtitle} onChange={e => setSubtitle(e.target.value)} placeholder="Optional description"
                  style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, border: 'none', borderBottom: '1.5px solid #E5E7EB', padding: '8px 0', outline: 'none', color: '#1c1b22', background: 'transparent' }}
                  onFocus={e => (e.target.style.borderBottomColor = '#5e4dbb')}
                  onBlur={e => (e.target.style.borderBottomColor = '#E5E7EB')} />
              </div>
              {/* Privacy */}
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
                  {isPublic ? 'Everyone can see and edit this list and its items.' : 'Only you can see and edit this list.'}
                </div>
              </div>
              {/* Color */}
              <div>
                <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', display: 'block', marginBottom: 8 }}>Accent Color</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {COLORS.map((c, i) => (
                    <button key={i} onClick={() => setColorIdx(i)}
                      style={{ width: 32, height: 32, borderRadius: '50%', background: c.color, border: `3px solid ${colorIdx === i ? '#1c1b22' : 'transparent'}`, cursor: 'pointer', transition: 'all 150ms' }} />
                  ))}
                </div>
              </div>
              {/* Preview */}
              <div style={{ background: selectedColor.bg, border: `1px solid ${selectedColor.color}40`, borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 20 }}>{emoji}</span>
                <div>
                  <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 700, color: '#1c1b22' }}>{name || 'List Name'}</div>
                  {subtitle && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584' }}>{subtitle}</div>}
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584' }}>Sections organize tasks within your list. You can add or skip them.</div>
              {sections.map(sec => (
                <div key={sec.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: '#f7f4fc', borderRadius: 10, border: '1px solid #e8e4f0' }}>
                  <span style={{ fontSize: 16 }}>{sec.emoji}</span>
                  <span style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{sec.label}</span>
                  <button onClick={() => setSections(s => s.filter(x => x.id !== sec.id))} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                    <Icon name="close" size={14} color="#787584" />
                  </button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select value={newSectionEmoji} onChange={e => setNewSectionEmoji(e.target.value)}
                  style={{ fontFamily: 'Inter, sans-serif', fontSize: 16, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '8px', background: '#f7f4fc', cursor: 'pointer' }}>
                  {EMOJIS.map(e => <option key={e} value={e}>{e}</option>)}
                </select>
                <input value={newSection} onChange={e => setNewSection(e.target.value)} onKeyDown={e => e.key === 'Enter' && addSection()} placeholder="Section name…"
                  style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 14, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '8px 12px', outline: 'none', background: '#fff' }}
                  onFocus={e => (e.target.style.borderColor = '#5e4dbb')} onBlur={e => (e.target.style.borderColor = '#e8e4f0')} />
                <button onClick={addSection} disabled={!newSection.trim()}
                  style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: newSection.trim() ? '#5e4dbb' : '#c9c4d5', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: newSection.trim() ? 'pointer' : 'default' }}>
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
                    <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22' }}>{name}</div>
                    {subtitle && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584' }}>{subtitle}</div>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.5)', padding: '4px 8px', borderRadius: 8 }}>
                    <Icon name={isPublic ? 'public' : 'lock'} size={14} color="#787584" />
                    <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#787584', textTransform: 'uppercase' }}>{isPublic ? 'Public' : 'Private'}</span>
                  </div>
                </div>
                {sections.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {sections.map(s => (
                      <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#787584' }}>
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
        <div style={{ display: 'flex', gap: 10, padding: '0 24px 24px', justifyContent: 'space-between', alignItems: 'center' }}>
          {step > 0 ? (
            <button onClick={() => setStep(s => s - 1)} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: 'none', cursor: 'pointer', padding: '10px 0', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Icon name="chevron_left" size={14} color="#484552" /> Back
            </button>
          ) : <div />}
          {step < 2 ? (
            <button onClick={() => setStep(s => s + 1)} disabled={step === 0 && !name.trim()}
              style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: (step === 0 && !name.trim()) ? '#c9c4d5' : '#5e4dbb', border: 'none', borderRadius: 8, padding: '10px 24px', cursor: (step === 0 && !name.trim()) ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
              {step === 1 ? 'Review' : 'Next'} <Icon name="arrow_forward" size={14} color="#fff" />
            </button>
          ) : (
            <button onClick={handleCreate} disabled={loading}
              style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: loading ? '#9d8dff' : '#5e4dbb', border: 'none', borderRadius: 8, padding: '10px 24px', cursor: loading ? 'wait' : 'pointer' }}>
              {loading ? 'Creating…' : 'Create List'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
