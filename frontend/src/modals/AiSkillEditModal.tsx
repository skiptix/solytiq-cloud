import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from '@/components/animate-ui/motion';
import Icon from '../components/Icon';
import useAiSkillsStore from '../store/useAiSkillsStore';
import { apiGetAiSkill, apiReplaceAiSkillBundle, ApiError } from '../api/client';
import { backdropVariants, modalVariants, crossFadeVariants } from '@/components/animate-ui/motionTokens';
import type { AiSkill, AiSkillFile } from '../types';

interface AiSkillEditModalProps {
  skillId: string;
  onClose: () => void;
}

const fi = { width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-primary)', background: 'transparent', border: 'none', outline: 'none', padding: '6px 0' };
const fieldLabel = { fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: 4 };
const fieldWrap = { borderBottom: '1px solid var(--color-border)', paddingBottom: 10, marginBottom: 16 };

function formatBytes(n: number): string {
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

export default function AiSkillEditModal({ skillId, onClose }: AiSkillEditModalProps) {
  const update = useAiSkillsStore((s) => s.update);
  const setEnabled = useAiSkillsStore((s) => s.setEnabled);
  const remove = useAiSkillsStore((s) => s.remove);
  const patchOne = useAiSkillsStore((s) => s.patchOne);

  const [skill, setSkill] = useState<AiSkill | null>(null);
  const [files, setFiles] = useState<AiSkillFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [replaceProgress, setReplaceProgress] = useState(0);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const bundleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    apiGetAiSkill(skillId).then((res) => {
      if (cancelled) return;
      setSkill(res.skill);
      setFiles(res.files);
      setName(res.skill.name);
      setDescription(res.skill.description);
      setContent(res.skill.content);
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [skillId]);

  const dirty = !!skill && (name !== skill.name || description !== skill.description || content !== skill.content);

  const handleSave = async () => {
    if (!skill || !name.trim() || !content.trim()) { setError('Name and content are required.'); return; }
    setSaving(true);
    setError(null);
    try {
      const updated = await update(skill.id, { name: name.trim(), description: description.trim(), content });
      setSkill(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!skill) return;
    const next = !skill.enabled;
    setSkill({ ...skill, enabled: next });
    await setEnabled(skill.id, next);
  };

  const handleReplaceBundle = async (file: File) => {
    if (!skill) return;
    setReplacing(true);
    setReplaceProgress(0);
    setError(null);
    try {
      const res = await apiReplaceAiSkillBundle(skill.id, file, setReplaceProgress);
      setSkill(res.skill);
      setFiles(res.files);
      setName(res.skill.name);
      setDescription(res.skill.description);
      setContent(res.skill.content);
      patchOne(res.skill);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not replace the bundle.');
    } finally {
      setReplacing(false);
    }
  };

  const handleDelete = async () => {
    if (!skill) return;
    setDeleting(true);
    try {
      await remove(skill.id);
      onClose();
    } catch {
      setDeleting(false);
    }
  };

  return createPortal(
    <motion.div
      variants={backdropVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        variants={modalVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        style={{ background: 'var(--color-white)', borderRadius: 20, width: '100%', maxWidth: 560, maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {loading || !skill ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '80px 0' }}>
            <div style={{ width: 28, height: 28, border: '3px solid var(--color-border)', borderTopColor: 'var(--color-primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '22px 24px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Icon name="auto_awesome" size={18} color="var(--color-primary)" />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{skill.name}</div>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-quaternary)' }}>
                    {skill.source === 'manual' ? 'Written manually' : skill.source === 'upload_zip' ? 'Uploaded .zip bundle' : 'Uploaded SKILL.md'}
                    {skill.origin === 'ai' ? ' · created by Sol' : ''}
                  </div>
                </div>
              </div>
              <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--color-surface-tint-2)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Icon name="close" size={15} color="var(--color-text-secondary)" />
              </button>
            </div>

            <div style={{ padding: '20px 24px' }}>
              {/* Enabled toggle */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 18, padding: '10px 14px', background: 'var(--color-surface-neutral)', borderRadius: 10 }}>
                <div>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>Enabled</div>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>{skill.enabled ? 'Sol can use this skill right now.' : 'Hidden from every user\'s assistant.'}</div>
                </div>
                <button
                  onClick={handleToggleEnabled}
                  style={{ width: 44, height: 24, borderRadius: 12, background: skill.enabled ? 'var(--color-primary)' : 'var(--color-border)', border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 200ms' }}
                >
                  <span style={{ position: 'absolute', top: 2, left: skill.enabled ? 22 : 2, width: 20, height: 20, borderRadius: '50%', background: 'var(--color-white)', boxShadow: '0 1px 4px rgba(var(--color-black-rgb), 0.2)', transition: 'left 200ms' }} />
                </button>
              </div>

              <div style={fieldWrap}>
                <div style={fieldLabel}>Name</div>
                <input value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} style={fi} />
              </div>
              <div style={fieldWrap}>
                <div style={fieldLabel}>Description</div>
                <input value={description} onChange={(e) => { setDescription(e.target.value); setSaved(false); }} placeholder="One line — when should this skill be used?" style={fi} />
              </div>
              <div style={{ ...fieldWrap, marginBottom: 12 }}>
                <div style={fieldLabel}>Content (SKILL.md)</div>
                <textarea
                  value={content} onChange={(e) => { setContent(e.target.value); setSaved(false); }}
                  rows={10}
                  style={{ ...fi, resize: 'vertical' as const, fontFamily: 'var(--font-mono, monospace)', fontSize: 13, lineHeight: 1.5, border: '1px solid var(--color-border)', borderRadius: 8, padding: 10 }}
                />
              </div>

              {/* Bundled files */}
              {files.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={fieldLabel}>Bundled reference files ({files.length})</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {files.map((f) => {
                      const expanded = expandedFile === f.filePath;
                      return (
                        <div key={f.id} style={{ border: '1px solid var(--color-border-alt)', borderRadius: 8, overflow: 'hidden' }}>
                          <button
                            onClick={() => setExpandedFile(expanded ? null : f.filePath)}
                            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 12px', background: 'var(--color-surface-neutral)', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                          >
                            <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                              <Icon name="description" size={13} color="var(--color-text-tertiary)" />
                              <span style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.filePath}</span>
                            </span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                              <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)' }}>{formatBytes(f.sizeBytes)}</span>
                              <Icon name={expanded ? 'expand_less' : 'expand_more'} size={15} color="var(--color-text-quaternary)" />
                            </span>
                          </button>
                          {expanded && (
                            <pre style={{ margin: 0, padding: 12, fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5, lineHeight: 1.5, color: 'var(--color-text-secondary)', background: 'var(--color-white)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 220, overflowY: 'auto' }}>
                              {f.content}
                            </pre>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Replace bundle */}
              <div style={{ marginBottom: 18 }}>
                <input ref={bundleInputRef} type="file" accept=".md,.markdown,.zip" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) handleReplaceBundle(f); }} />
                <button
                  onClick={() => bundleInputRef.current?.click()}
                  disabled={replacing}
                  style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 14px', borderRadius: 9, border: '1.5px solid var(--color-border)', background: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-tertiary)', cursor: replacing ? 'wait' : 'pointer' }}
                >
                  <Icon name="upload_file" size={14} color="var(--color-text-tertiary)" />
                  {replacing ? `Replacing… ${replaceProgress}%` : 'Replace with a new file/bundle'}
                </button>
              </div>

              {error && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, padding: '10px 14px', background: 'var(--color-error-bg-alt)', borderRadius: 8, border: '1px solid var(--color-error-bg)' }}>
                  <Icon name="error" size={15} color="var(--color-error)" />
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>{error}</span>
                </div>
              )}

              <AnimatePresence mode="wait" initial={false}>
                {confirmDelete ? (
                  <motion.div key="confirm" variants={crossFadeVariants} initial="initial" animate="animate" exit="exit" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', background: 'var(--color-error-bg)', borderRadius: 10 }}>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-error)', lineHeight: 1.4 }}>
                      Delete "{skill.name}" permanently? This cannot be undone.
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => setConfirmDelete(false)} style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: 'none', background: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-secondary)', cursor: 'pointer' }}>Cancel</button>
                      <button onClick={handleDelete} disabled={deleting} style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: 'none', background: 'var(--color-error)', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-white)', cursor: deleting ? 'not-allowed' : 'pointer' }}>
                        {deleting ? 'Deleting…' : 'Delete Skill'}
                      </button>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div key="actions" variants={crossFadeVariants} initial="initial" animate="animate" exit="exit" style={{ display: 'flex', gap: 10 }}>
                    <button onClick={() => setConfirmDelete(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-error)', background: 'transparent', border: 'none', borderRadius: 8, padding: '11px 12px', cursor: 'pointer' }}>
                      <Icon name="delete" size={14} color="var(--color-error)" />
                      Delete
                    </button>
                    <div style={{ flex: 1 }} />
                    <button
                      onClick={handleSave}
                      disabled={saving || !dirty || !name.trim() || !content.trim()}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600,
                        color: saved ? 'var(--color-success)' : 'var(--color-white)',
                        background: saved ? 'rgba(var(--color-success-rgb), 0.12)' : (saving || !dirty) ? 'var(--color-border-strong)' : 'var(--color-primary)',
                        border: saved ? '1.5px solid rgba(var(--color-success-rgb), 0.3)' : 'none',
                        borderRadius: 8, padding: '11px 20px',
                        cursor: (saving || !dirty) ? 'not-allowed' : 'pointer',
                      }}
                    >
                      <Icon name={saved ? 'check' : 'save'} size={14} color={saved ? 'var(--color-success)' : 'var(--color-white)'} />
                      {saved ? 'Saved' : saving ? 'Saving…' : 'Save Changes'}
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </>
        )}
      </motion.div>
    </motion.div>,
    document.body
  );
}
