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
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--color-white)', borderRadius: 16, width: '100%', maxWidth: 480, boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid var(--color-surface-tint-2)' }}>
          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>New Template</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 2 }}>
            <Icon name="close" size={18} color="var(--color-text-tertiary)" />
          </button>
        </div>

        <div style={{ padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {!type && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, animation: 'wizardStepIn 220ms cubic-bezier(0.22,1,0.36,1) both' }}>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)' }}>What kind of template do you want to create?</div>
              {(['list', 'timeline'] as const).map((k, i) => (
                <button key={k} onClick={() => setType(k)}
                  style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 12, border: '1.5px solid var(--color-purple-pale-34)', background: 'var(--color-white)', cursor: 'pointer', textAlign: 'left', transition: 'border-color 150ms, background 150ms, transform 150ms cubic-bezier(0.34,1.56,0.64,1)', animation: `menuItemIn 200ms ease ${i * 40}ms both` }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.background = 'var(--color-surface-tint)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--color-purple-pale-34)'; e.currentTarget.style.background = 'var(--color-white)'; e.currentTarget.style.transform = 'translateY(0)'; }}>
                  <Icon name={k === 'list' ? 'format_list_bulleted' : 'timeline'} size={22} color="var(--color-primary)" />
                  <div>
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14.5, fontWeight: 700, color: 'var(--color-text-primary)' }}>{k === 'list' ? 'To-Do' : 'Timeline'}</div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>Save an existing {k} as a reusable template</div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {type && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18, animation: 'wizardStepIn 220ms cubic-bezier(0.22,1,0.36,1) both' }}>
              <div>
                <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 }}>
                  Source {type === 'list' ? 'To-Do' : 'Timeline'} *
                </label>
                {sourceOptions === null ? (
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>Loading…</div>
                ) : sourceOptions.length === 0 ? (
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>
                    You don't own any {type === 'list' ? 'lists' : 'timelines'} yet.
                  </div>
                ) : (
                  <select value={sourceId} onChange={(e) => handleSelectSource(e.target.value)}
                    style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, border: '1.5px solid var(--color-border-alt)', borderRadius: 8, padding: '9px 10px', outline: 'none', color: 'var(--color-text-primary)', background: 'var(--color-white)' }}>
                    <option value="">Select a {type}…</option>
                    {sourceOptions.map((s) => (
                      <option key={s.id} value={s.id}>{s.emoji ? `${s.emoji} ` : ''}{s.name}</option>
                    ))}
                  </select>
                )}
              </div>

              {sourceId && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 18, animation: 'wizardStepIn 220ms cubic-bezier(0.22,1,0.36,1) both' }}>
                  <div>
                    <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 }}>Template Name *</label>
                    <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
                      style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, border: 'none', borderBottom: '1.5px solid var(--color-border-alt)', padding: '8px 0', outline: 'none', color: 'var(--color-text-primary)', background: 'transparent' }}
                      onFocus={(e) => (e.target.style.borderBottomColor = 'var(--color-primary)')}
                      onBlur={(e) => (e.target.style.borderBottomColor = 'var(--color-border-alt)')} />
                  </div>
                  <div>
                    <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 }}>Description</label>
                    <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional — what's this template for?"
                      style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, border: 'none', borderBottom: '1.5px solid var(--color-border-alt)', padding: '8px 0', outline: 'none', color: 'var(--color-text-primary)', background: 'transparent' }}
                      onFocus={(e) => (e.target.style.borderBottomColor = 'var(--color-primary)')}
                      onBlur={(e) => (e.target.style.borderBottomColor = 'var(--color-border-alt)')} />
                  </div>
                  <div>
                    <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 8 }}>Sharing</label>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button onClick={() => setIsShared(false)}
                        style={{ flex: 1, padding: '10px', borderRadius: 10, border: `1.5px solid ${!isShared ? 'var(--color-primary)' : 'var(--color-border-alt)'}`, background: !isShared ? 'var(--color-surface-tint)' : 'var(--color-white)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'all 150ms' }}>
                        <Icon name="lock" size={16} color={!isShared ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: !isShared ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }}>Just me</span>
                      </button>
                      <button onClick={() => setIsShared(true)}
                        style={{ flex: 1, padding: '10px', borderRadius: 10, border: `1.5px solid ${isShared ? 'var(--color-primary)' : 'var(--color-border-alt)'}`, background: isShared ? 'var(--color-surface-tint)' : 'var(--color-white)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'all 150ms' }}>
                        <Icon name="public" size={16} color={isShared ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: isShared ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }}>Everyone here</span>
                      </button>
                    </div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 6 }}>
                      {isShared ? 'Every user on this instance can see and use this template (read-only).' : 'Only you can see and use this template.'}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {error && (
            <div style={{ padding: '8px 12px', background: 'var(--color-error-bg)', borderRadius: 8, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>{error}</div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, padding: '0 24px 24px', justifyContent: 'space-between', alignItems: 'center' }}>
          {type ? (
            <button onClick={() => (initialType ? onClose() : setType(null))} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: 'none', cursor: 'pointer', padding: '10px 0', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Icon name="chevron_left" size={14} color="var(--color-text-secondary)" /> Back
            </button>
          ) : <div />}
          {type && (
            <button onClick={handleCreate} disabled={loading || !sourceId || !name.trim()}
              style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: (loading || !sourceId || !name.trim()) ? 'var(--color-border-strong)' : 'var(--color-primary)', border: 'none', borderRadius: 8, padding: '10px 24px', cursor: (loading || !sourceId || !name.trim()) ? 'not-allowed' : 'pointer', transition: 'background 150ms, transform 150ms cubic-bezier(0.34,1.56,0.64,1)' }}
              onMouseEnter={(e) => { if (!loading && sourceId && name.trim()) e.currentTarget.style.transform = 'scale(1.04)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}>
              {loading ? 'Saving…' : 'Save Template'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
