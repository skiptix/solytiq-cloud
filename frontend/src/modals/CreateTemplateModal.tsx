import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { List, Timeline, Template } from '../types';
import { apiGetLists, apiGetTimelines } from '../api/client';
import useAuthStore from '../store/useAuthStore';
import useTemplatesStore from '../store/useTemplatesStore';
import Icon from '../components/Icon';
import ModalIn from '../components/animate-ui/ModalIn';
import MotionIn from '../components/animate-ui/MotionIn';
import MotionButton from '../components/animate-ui/MotionButton';
import { motion } from '../components/animate-ui/motion';
import { EASE_SETTLE, EASE_SPRING } from '../components/animate-ui/motionTokens';

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
      <ModalIn duration={280} style={{ background: 'var(--color-white)', borderRadius: 16, width: '100%', maxWidth: 480, boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid var(--color-surface-tint-2)' }}>
          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>New Template</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 2 }}>
            <Icon name="close" size={18} color="var(--color-text-tertiary)" />
          </button>
        </div>

        <div style={{ padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {!type && (
            <MotionIn initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: EASE_SETTLE }} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)' }}>What kind of template do you want to create?</div>
              {(['list', 'timeline'] as const).map((k, i) => (
                <MotionButton key={k} onClick={() => setType(k)}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.2, delay: i * 0.04 }}
                  whileHover={{ borderColor: 'var(--color-primary)', background: 'var(--color-surface-tint)', y: -2 }}
                  style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 12, border: '1.5px solid var(--color-purple-pale-34)', background: 'var(--color-white)', cursor: 'pointer', textAlign: 'left' }}>
                  <Icon name={k === 'list' ? 'format_list_bulleted' : 'timeline'} size={22} color="var(--color-primary)" />
                  <div>
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14.5, fontWeight: 700, color: 'var(--color-text-primary)' }}>{k === 'list' ? 'Board' : 'Timeline'}</div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>Save an existing {k} as a reusable template</div>
                  </div>
                </MotionButton>
              ))}
            </MotionIn>
          )}

          {type && (
            <MotionIn initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: EASE_SETTLE }} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div>
                <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 }}>
                  Source {type === 'list' ? 'Board' : 'Timeline'} *
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
                <MotionIn initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: EASE_SETTLE }} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                  <div>
                    <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 }}>Template Name *</label>
                    <motion.input autoFocus value={name} onChange={(e) => setName(e.target.value)}
                      whileFocus={{ borderBottomColor: 'var(--color-primary)' }}
                      transition={{ duration: 0.15 }}
                      style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, border: 'none', borderBottomWidth: 1.5, borderBottomStyle: 'solid', borderBottomColor: 'var(--color-border-alt)', padding: '8px 0', outline: 'none', color: 'var(--color-text-primary)', background: 'transparent' }} />
                  </div>
                  <div>
                    <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 }}>Description</label>
                    <motion.input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional — what's this template for?"
                      whileFocus={{ borderBottomColor: 'var(--color-primary)' }}
                      transition={{ duration: 0.15 }}
                      style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, border: 'none', borderBottomWidth: 1.5, borderBottomStyle: 'solid', borderBottomColor: 'var(--color-border-alt)', padding: '8px 0', outline: 'none', color: 'var(--color-text-primary)', background: 'transparent' }} />
                  </div>
                  <div>
                    <label style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 8 }}>Sharing</label>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <MotionButton onClick={() => setIsShared(false)}
                        animate={{ borderColor: !isShared ? 'var(--color-primary)' : 'var(--color-border-alt)', background: !isShared ? 'var(--color-surface-tint)' : 'var(--color-white)' }}
                        transition={{ duration: 0.15 }}
                        style={{ flex: 1, padding: '10px', borderRadius: 10, borderWidth: 1.5, borderStyle: 'solid', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                        <Icon name="lock" size={16} color={!isShared ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: !isShared ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }}>Just me</span>
                      </MotionButton>
                      <MotionButton onClick={() => setIsShared(true)}
                        animate={{ borderColor: isShared ? 'var(--color-primary)' : 'var(--color-border-alt)', background: isShared ? 'var(--color-surface-tint)' : 'var(--color-white)' }}
                        transition={{ duration: 0.15 }}
                        style={{ flex: 1, padding: '10px', borderRadius: 10, borderWidth: 1.5, borderStyle: 'solid', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                        <Icon name="public" size={16} color={isShared ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: isShared ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }}>Everyone here</span>
                      </MotionButton>
                    </div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 6 }}>
                      {isShared ? 'Every user on this instance can see and use this template (read-only).' : 'Only you can see and use this template.'}
                    </div>
                  </div>
                </MotionIn>
              )}
            </MotionIn>
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
            <MotionButton onClick={handleCreate} disabled={loading || !sourceId || !name.trim()}
              animate={{ background: (loading || !sourceId || !name.trim()) ? 'var(--color-border-strong)' : 'var(--color-primary)' }}
              whileHover={!loading && sourceId && name.trim() ? { scale: 1.04 } : undefined}
              transition={{ background: { duration: 0.15 }, scale: { duration: 0.15, ease: EASE_SPRING } }}
              style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', border: 'none', borderRadius: 8, padding: '10px 24px', cursor: (loading || !sourceId || !name.trim()) ? 'not-allowed' : 'pointer' }}>
              {loading ? 'Saving…' : 'Save Template'}
            </MotionButton>
          )}
        </div>
      </ModalIn>
    </div>,
    document.body
  );
}
