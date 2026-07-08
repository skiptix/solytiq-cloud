import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { List, Timeline, Template } from '../types';
import { apiGetLists, apiGetTimelines } from '../api/client';
import useAuthStore from '../store/useAuthStore';
import useTemplatesStore from '../store/useTemplatesStore';
import Icon from '../components/Icon';

interface CreateTemplateModalProps {
  onClose: () => void;
  onCreated?: (template: Template) => void;
  /** Skip the type-picker and go straight to picking a source of this type. */
  initialType?: 'list' | 'timeline';
}

export default function CreateTemplateModal({ onClose, onCreated, initialType }: CreateTemplateModalProps) {
  const [type, setType] = useState<'list' | 'timeline' | null>(initialType ?? null);
  const [ownLists, setOwnLists] = useState<List[] | null>(null);
  const [ownTimelines, setOwnTimelines] = useState<Timeline[] | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isShared, setIsShared] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const userId = useAuthStore((s) => s.userId);
  const create = useTemplatesStore((s) => s.create);

  useEffect(() => {
    if (type === 'list' && ownLists === null) {
      apiGetLists().then((r) => setOwnLists(r.lists.filter((l) => l.userId === userId))).catch(() => setOwnLists([]));
    }
    if (type === 'timeline' && ownTimelines === null) {
      apiGetTimelines().then((r) => setOwnTimelines(r.timelines.filter((t) => t.userId === userId))).catch(() => setOwnTimelines([]));
    }
  }, [type, ownLists, ownTimelines, userId]);

  const sourceOptions = type === 'list' ? ownLists : type === 'timeline' ? ownTimelines : null;

  const handleSelectSource = (id: string) => {
    setSourceId(id);
    if (!name) {
      const picked = sourceOptions?.find((s) => s.id === id);
      if (picked) setName(picked.name);
    }
  };

  const handleCreate = async () => {
    if (!type || !sourceId || !name.trim()) return;
    setLoading(true);
    setError('');
    try {
      const tpl = await create({ type, sourceId, name: name.trim(), description: description.trim() || undefined, isShared });
      onCreated?.(tpl);
      onClose();
    } catch {
      setError('Failed to create template. Please try again.');
      setLoading(false);
    }
  };

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 480, boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid #f1ecf6' }}>
          <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>New Template</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 2 }}>
            <Icon name="close" size={18} color="#787584" />
          </button>
        </div>

        <div style={{ padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {!type && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584' }}>What kind of template do you want to create?</div>
              {(['list', 'timeline'] as const).map((k) => (
                <button key={k} onClick={() => setType(k)}
                  style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 12, border: '1.5px solid #ece8f4', background: '#fff', cursor: 'pointer', textAlign: 'left', transition: 'all 150ms' }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#5e4dbb'; e.currentTarget.style.background = '#F5F3FF'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#ece8f4'; e.currentTarget.style.background = '#fff'; }}>
                  <Icon name={k === 'list' ? 'format_list_bulleted' : 'timeline'} size={22} color="#5e4dbb" />
                  <div>
                    <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14.5, fontWeight: 700, color: '#1c1b22' }}>{k === 'list' ? 'List' : 'Timeline'}</div>
                    <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584' }}>Save an existing {k} as a reusable template</div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {type && (
            <>
              <div>
                <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', display: 'block', marginBottom: 6 }}>
                  Source {type === 'list' ? 'List' : 'Timeline'} *
                </label>
                {sourceOptions === null ? (
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>Loading…</div>
                ) : sourceOptions.length === 0 ? (
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>
                    You don't own any {type === 'list' ? 'lists' : 'timelines'} yet.
                  </div>
                ) : (
                  <select value={sourceId} onChange={(e) => handleSelectSource(e.target.value)}
                    style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, border: '1.5px solid #E5E7EB', borderRadius: 8, padding: '9px 10px', outline: 'none', color: '#1c1b22', background: '#fff' }}>
                    <option value="">Select a {type}…</option>
                    {sourceOptions.map((s) => (
                      <option key={s.id} value={s.id}>{s.emoji ? `${s.emoji} ` : ''}{s.name}</option>
                    ))}
                  </select>
                )}
              </div>

              {sourceId && (
                <>
                  <div>
                    <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', display: 'block', marginBottom: 6 }}>Template Name *</label>
                    <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
                      style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, border: 'none', borderBottom: '1.5px solid #E5E7EB', padding: '8px 0', outline: 'none', color: '#1c1b22', background: 'transparent' }}
                      onFocus={(e) => (e.target.style.borderBottomColor = '#5e4dbb')}
                      onBlur={(e) => (e.target.style.borderBottomColor = '#E5E7EB')} />
                  </div>
                  <div>
                    <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', display: 'block', marginBottom: 6 }}>Description</label>
                    <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional — what's this template for?"
                      style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, border: 'none', borderBottom: '1.5px solid #E5E7EB', padding: '8px 0', outline: 'none', color: '#1c1b22', background: 'transparent' }}
                      onFocus={(e) => (e.target.style.borderBottomColor = '#5e4dbb')}
                      onBlur={(e) => (e.target.style.borderBottomColor = '#E5E7EB')} />
                  </div>
                  <div>
                    <label style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', display: 'block', marginBottom: 8 }}>Sharing</label>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button onClick={() => setIsShared(false)}
                        style={{ flex: 1, padding: '10px', borderRadius: 10, border: `1.5px solid ${!isShared ? '#5e4dbb' : '#E5E7EB'}`, background: !isShared ? '#F5F3FF' : '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'all 150ms' }}>
                        <Icon name="lock" size={16} color={!isShared ? '#5e4dbb' : '#787584'} />
                        <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: !isShared ? '#5e4dbb' : '#787584' }}>Just me</span>
                      </button>
                      <button onClick={() => setIsShared(true)}
                        style={{ flex: 1, padding: '10px', borderRadius: 10, border: `1.5px solid ${isShared ? '#5e4dbb' : '#E5E7EB'}`, background: isShared ? '#F5F3FF' : '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'all 150ms' }}>
                        <Icon name="public" size={16} color={isShared ? '#5e4dbb' : '#787584'} />
                        <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: isShared ? '#5e4dbb' : '#787584' }}>Everyone here</span>
                      </button>
                    </div>
                    <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584', marginTop: 6 }}>
                      {isShared ? 'Every user on this instance can see and use this template (read-only).' : 'Only you can see and use this template.'}
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {error && (
            <div style={{ padding: '8px 12px', background: '#ffdad6', borderRadius: 8, fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a' }}>{error}</div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, padding: '0 24px 24px', justifyContent: 'space-between', alignItems: 'center' }}>
          {type ? (
            <button onClick={() => (initialType ? onClose() : setType(null))} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: 'none', cursor: 'pointer', padding: '10px 0', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Icon name="chevron_left" size={14} color="#484552" /> Back
            </button>
          ) : <div />}
          {type && (
            <button onClick={handleCreate} disabled={loading || !sourceId || !name.trim()}
              style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: (loading || !sourceId || !name.trim()) ? '#c9c4d5' : '#5e4dbb', border: 'none', borderRadius: 8, padding: '10px 24px', cursor: (loading || !sourceId || !name.trim()) ? 'not-allowed' : 'pointer' }}>
              {loading ? 'Saving…' : 'Save Template'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
