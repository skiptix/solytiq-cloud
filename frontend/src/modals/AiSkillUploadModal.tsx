import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../components/Icon';
import useAiSkillsStore from '../store/useAiSkillsStore';
import { apiUploadAiSkill, ApiError } from '../api/client';
import type { AiSkill } from '../types';

interface AiSkillUploadModalProps {
  onClose: () => void;
  onCreated: (skill: AiSkill) => void;
}

type Mode = 'upload' | 'manual';

const fi = { width: '100%', fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-primary)', background: 'transparent', border: 'none', outline: 'none', padding: '6px 0' };
const fieldLabel = { fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-quaternary)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: 4 };
const fieldWrap = { borderBottom: '1px solid var(--color-border)', paddingBottom: 10, marginBottom: 16 };

export default function AiSkillUploadModal({ onClose, onCreated }: AiSkillUploadModalProps) {
  const create = useAiSkillsStore((s) => s.create);
  const patchOne = useAiSkillsStore((s) => s.patchOne);
  const [mode, setMode] = useState<Mode>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [nameOverride, setNameOverride] = useState('');
  const [descriptionOverride, setDescriptionOverride] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualDescription, setManualDescription] = useState('');
  const [manualContent, setManualContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFilePick = (f: File | null) => {
    setFile(f);
    setError(null);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!busy) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (busy) return;
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) handleFilePick(dropped);
  };

  const handleUpload = async () => {
    if (!file) { setError('Choose a SKILL.md file or a .zip bundle first.'); return; }
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      const res = await apiUploadAiSkill(file, { name: nameOverride.trim() || undefined, description: descriptionOverride.trim() || undefined }, setProgress);
      patchOne(res.skill);
      onCreated(res.skill);
      if (res.skippedFiles > 0) {
        setNotice(`Skill created. ${res.skippedFiles} file${res.skippedFiles === 1 ? '' : 's'} in the archive ${res.skippedFiles === 1 ? 'was' : 'were'} skipped (not a supported text reference type, or too large).`);
        setBusy(false);
        return;
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed — please try again.');
      setBusy(false);
    }
  };

  const handleManualCreate = async () => {
    if (!manualName.trim() || !manualContent.trim()) { setError('Name and content are required.'); return; }
    setBusy(true);
    setError(null);
    try {
      const skill = await create({ name: manualName.trim(), description: manualDescription.trim(), content: manualContent });
      onCreated(skill);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the skill — please try again.');
      setBusy(false);
    }
  };

  return createPortal(
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div
        style={{ background: 'var(--color-white)', borderRadius: 20, width: '100%', maxWidth: 480, maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '22px 24px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="auto_awesome" size={18} color="var(--color-primary)" />
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)' }}>Add AI Skill</div>
          </div>
          <button onClick={onClose} disabled={busy} style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--color-surface-tint-2)', border: 'none', cursor: busy ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={15} color="var(--color-text-secondary)" />
          </button>
        </div>

        <div style={{ padding: '20px 24px' }}>
          {/* Mode toggle */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
            {(['upload', 'manual'] as Mode[]).map((m) => {
              const selected = mode === m;
              return (
                <button
                  key={m}
                  onClick={() => { setMode(m); setError(null); }}
                  style={{
                    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                    padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                    border: selected ? '1.5px solid var(--color-primary)' : '1.5px solid var(--color-border)',
                    background: selected ? 'var(--color-purple-pale-14)' : 'var(--color-surface-neutral)',
                  }}
                >
                  <Icon name={m === 'upload' ? 'upload_file' : 'edit_note'} size={15} color={selected ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                  <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: selected ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }}>
                    {m === 'upload' ? 'Upload File' : 'Write Manually'}
                  </span>
                </button>
              );
            })}
          </div>

          {mode === 'upload' ? (
            <>
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                style={{
                  border: `1.5px dashed ${isDragging || file ? 'var(--color-primary)' : 'var(--color-border)'}`, borderRadius: 12,
                  padding: '22px 16px', textAlign: 'center', cursor: 'pointer', marginBottom: 16,
                  background: isDragging || file ? 'var(--color-purple-pale-14)' : 'var(--color-surface-neutral)',
                  transition: 'background 120ms, border-color 120ms',
                }}
              >
                <input
                  ref={fileInputRef} type="file" accept=".md,.markdown,.zip" style={{ display: 'none' }}
                  onChange={(e) => handleFilePick(e.target.files?.[0] ?? null)}
                />
                <Icon name={file ? 'description' : 'upload_file'} size={22} color={isDragging || file ? 'var(--color-primary)' : 'var(--color-text-quaternary)'} />
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginTop: 8 }}>
                  {isDragging ? 'Drop to upload' : file ? file.name : 'Choose a SKILL.md file or a .zip bundle'}
                </div>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-quaternary)', marginTop: 2 }}>
                  A .zip must contain a SKILL.md, optionally with reference files alongside it. Drag and drop works too.
                </div>
              </div>

              <div style={fieldWrap}>
                <div style={fieldLabel}>Name (optional override)</div>
                <input value={nameOverride} onChange={(e) => setNameOverride(e.target.value)} placeholder="Leave blank to use SKILL.md's own name" style={fi} />
              </div>
              <div style={{ ...fieldWrap, marginBottom: 20 }}>
                <div style={fieldLabel}>Description (optional override)</div>
                <input value={descriptionOverride} onChange={(e) => setDescriptionOverride(e.target.value)} placeholder="One line — when should this skill be used?" style={fi} />
              </div>

              {busy && (
                <div style={{ background: 'var(--color-border-alt)', borderRadius: 99, height: 6, overflow: 'hidden', marginBottom: 16 }}>
                  <div style={{ width: `${progress}%`, height: '100%', background: 'var(--color-primary)', borderRadius: 99, transition: 'width 150ms' }} />
                </div>
              )}
            </>
          ) : (
            <>
              <div style={fieldWrap}>
                <div style={fieldLabel}>Name <span style={{ color: 'var(--color-error)' }}>*</span></div>
                <input value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder="e.g. Weekly Report Formatting" style={fi} />
              </div>
              <div style={fieldWrap}>
                <div style={fieldLabel}>Description</div>
                <input value={manualDescription} onChange={(e) => setManualDescription(e.target.value)} placeholder="One line — when should this skill be used?" style={fi} />
              </div>
              <div style={{ ...fieldWrap, marginBottom: 20 }}>
                <div style={fieldLabel}>Content (SKILL.md) <span style={{ color: 'var(--color-error)' }}>*</span></div>
                <textarea
                  value={manualContent} onChange={(e) => setManualContent(e.target.value)}
                  placeholder="Detailed instructions the assistant should follow when this skill applies…"
                  rows={8}
                  style={{ ...fi, resize: 'vertical' as const, fontFamily: 'var(--font-mono, monospace)', fontSize: 13, lineHeight: 1.5, border: '1px solid var(--color-border)', borderRadius: 8, padding: 10 }}
                />
              </div>
            </>
          )}

          {notice && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 16, padding: '10px 14px', background: 'var(--color-yellow-tint-1)', borderRadius: 8 }}>
              <Icon name="info" size={15} color="var(--color-warning)" />
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-secondary)' }}>{notice}</span>
            </div>
          )}
          {error && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, padding: '10px 14px', background: 'var(--color-error-bg-alt)', borderRadius: 8, border: '1px solid var(--color-error-bg)' }}>
              <Icon name="error" size={15} color="var(--color-error)" />
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>{error}</span>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onClose} disabled={busy} style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 8, padding: '11px 0', cursor: busy ? 'not-allowed' : 'pointer' }}>
              {notice ? 'Close' : 'Cancel'}
            </button>
            {!notice && (
              <button
                onClick={mode === 'upload' ? handleUpload : handleManualCreate}
                disabled={busy || (mode === 'upload' ? !file : !manualName.trim() || !manualContent.trim())}
                style={{
                  flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)',
                  background: busy ? 'var(--color-border-strong)' : 'var(--color-primary)', border: 'none', borderRadius: 8, padding: '11px 0',
                  cursor: busy ? 'not-allowed' : 'pointer',
                }}
              >
                {busy ? 'Saving…' : mode === 'upload' ? 'Upload' : 'Create Skill'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
