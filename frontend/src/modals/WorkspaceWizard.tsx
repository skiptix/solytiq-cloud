import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../components/Icon';
import useWorkspaceStore from '../store/useWorkspaceStore';
import type { WorkspaceMember } from '../types';
import { EmojiGrid } from '../components/EmojiSelector';
import Spinner from '@/components/animate-ui/Spinner';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

interface Props { onClose: () => void; onCreated?: (wsId: string) => void; forced?: boolean; }

export default function WorkspaceWizard({ onClose, onCreated, forced }: Props) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [emoji, setEmoji] = useState('🏠');
  const [useImage, setUseImage] = useState(false);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [imgError, setImgError] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [memberUsername, setMemberUsername] = useState('');
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [memberLoading, setMemberLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { createWorkspace, setCurrentWorkspace } = useWorkspaceStore();

  const handleClose = () => {
    setClosing(true);
    setTimeout(() => onClose(), 190);
  };

  function processFile(file: File) {
    setImgError(null);
    if (!ACCEPTED_TYPES.includes(file.type)) { setImgError('Unsupported format. Use JPEG, PNG, GIF, or WebP.'); return; }
    if (file.size > MAX_IMAGE_BYTES) { setImgError('File is too large (max 2 MB).'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      if (result) { setPendingImage(result); setUseImage(true); }
    };
    reader.readAsDataURL(file);
  }

  const handleAddMember = async () => {
    const uname = memberUsername.trim();
    if (!uname) return;
    if (members.find(m => m.username === uname)) { setMemberError('Already added.'); return; }
    setMemberLoading(true);
    setMemberError(null);
    try {
      // We'll add members after creation; for now just validate by checking if the username looks reasonable
      // Actually, we store them locally and add them post-creation
      const { apiGetMembers } = await import('../api/client');
      const res = await apiGetMembers();
      const found = res.members.find(m => m.username === uname);
      if (!found) { setMemberError('User not found.'); return; }
      setMembers(prev => [...prev, { userId: found.id, username: found.username, fullName: found.fullName ?? undefined, profileImage: found.profileImage ?? undefined, role: 'member' }]);
      setMemberUsername('');
    } catch {
      setMemberError('Failed to look up user.');
    } finally {
      setMemberLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const ws = await createWorkspace({
        name: name.trim(),
        description: description.trim() || undefined,
        emoji: useImage ? undefined : emoji,
        image: useImage ? pendingImage ?? undefined : undefined,
        visibility,
      });
      // Add members
      if (members.length > 0) {
        const { apiAddWorkspaceMember } = await import('../api/client');
        for (const m of members) {
          await apiAddWorkspaceMember(ws.id, m.username).catch(() => {});
        }
      }

      setCurrentWorkspace(ws.id);
      setStep(2);
      onCreated?.(ws.id);
    } catch {
      // silent — stay on step 1
    } finally {
      setSaving(false);
    }
  };

  const panelAnim = closing
    ? 'settingsModalOut 190ms ease-in both'
    : 'settingsModalIn 360ms cubic-bezier(0.22,1,0.36,1) both';
  const backdropAnim = closing
    ? 'backdropOut 190ms ease both'
    : 'backdropIn 220ms ease both';

  return createPortal(
    <div
      onClick={e => { if (e.target === e.currentTarget && !forced) handleClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.28)', backdropFilter: 'blur(5px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)', animation: backdropAnim }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--color-white)', borderRadius: 20, width: '100%', maxWidth: 500, boxShadow: '0 20px 60px rgba(var(--color-black-rgb), 0.18)', animation: panelAnim, overflow: 'hidden', position: 'relative' }}>

        {/* Step indicator */}
        <div style={{ padding: '20px 24px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
          {[0, 1].map(i => (
            <div key={i} style={{ height: 3, flex: 1, borderRadius: 9999, background: step > i ? 'var(--color-primary)' : step === i ? 'var(--color-accent-purple-light)' : 'var(--color-border)', transition: 'background 300ms' }} />
          ))}
        </div>

        {/* ── Step 0: Details ── */}
        {step === 0 && (
          <div style={{ padding: '20px 24px 24px', animation: 'wizardStepIn 220ms cubic-bezier(0.22,1,0.36,1) both' }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 4 }}>{forced ? 'Create your first workspace' : 'Create workspace'}</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', marginBottom: 22 }}>{forced ? 'You need a workspace to get started. Give it a name and identity.' : 'Give your workspace a name and identity.'}</div>

            {/* Icon area */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 18 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                {/* Avatar preview */}
                <div style={{ width: 72, height: 72, borderRadius: 18, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', overflow: 'hidden', border: '2px solid var(--color-border)', flexShrink: 0 }}
                  onClick={() => useImage ? (fileInputRef.current?.click()) : setShowEmojiPicker(p => !p)}>
                  {useImage && pendingImage
                    ? <img src={pendingImage} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <span style={{ fontSize: 36 }}>{emoji}</span>
                  }
                </div>
                {/* Toggle tabs */}
                <div style={{ display: 'flex', background: 'var(--color-surface-tint-2)', borderRadius: 8, padding: 2, gap: 2 }}>
                  <button onClick={() => setUseImage(false)} style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6, border: 'none', cursor: 'pointer', background: !useImage ? 'var(--color-primary)' : 'transparent', color: !useImage ? 'var(--color-white)' : 'var(--color-text-tertiary)', transition: 'all 150ms' }}>Emoji</button>
                  <button onClick={() => { setUseImage(true); }} style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6, border: 'none', cursor: 'pointer', background: useImage ? 'var(--color-primary)' : 'transparent', color: useImage ? 'var(--color-white)' : 'var(--color-text-tertiary)', transition: 'all 150ms' }}>Image</button>
                </div>
              </div>

              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <input
                  autoFocus
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Workspace name…"
                  maxLength={60}
                  onKeyDown={e => { if (e.key === 'Enter' && name.trim()) setStep(1); }}
                  style={{ width: '100%', fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 600, padding: '10px 14px', borderRadius: 10, border: '1.5px solid var(--color-border)', outline: 'none', color: 'var(--color-text-primary)', background: 'var(--color-surface-neutral)', boxSizing: 'border-box' }}
                />
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="Description (optional)…"
                  rows={2}
                  maxLength={300}
                  style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 13, padding: '10px 14px', borderRadius: 10, border: '1.5px solid var(--color-border)', outline: 'none', color: 'var(--color-text-secondary)', background: 'var(--color-surface-neutral)', resize: 'none', boxSizing: 'border-box' }}
                />
              </div>
            </div>

            {/* Emoji picker */}
            {!useImage && showEmojiPicker && (
              <div style={{ marginBottom: 14, border: '1px solid var(--color-border)', borderRadius: 12, padding: 10, background: 'var(--color-white)', width: 'fit-content', animation: 'menuIn 160ms ease both', transformOrigin: 'top left' }}>
                <EmojiGrid value={emoji} onSelect={em => { setEmoji(em); setShowEmojiPicker(false); }} />
              </div>
            )}

            {/* Image upload */}
            {useImage && (
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) processFile(f); }}
                onClick={() => fileInputRef.current?.click()}
                style={{ border: `2px dashed ${dragOver ? 'var(--color-primary)' : 'var(--color-accent-purple-soft-alt)'}`, borderRadius: 12, padding: '20px', textAlign: 'center', cursor: 'pointer', marginBottom: 14, background: dragOver ? 'var(--color-surface-tint-alt)' : 'var(--color-blue-pale-1)', transition: 'all 150ms' }}>
                <Icon name="upload" size={24} color="var(--color-accent-purple-light)" />
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-tertiary)', marginTop: 6 }}>
                  {pendingImage ? 'Click to change image' : 'Drop image here or click to upload'}
                </div>
                {imgError && <div style={{ color: 'var(--color-error)', fontSize: 12, marginTop: 4 }}>{imgError}</div>}
              </div>
            )}
            <input ref={fileInputRef} type="file" accept={ACCEPTED_TYPES.join(',')} style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) processFile(f); e.target.value = ''; }} />

            {/* Visibility */}
            <div style={{ marginBottom: 22 }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Visibility</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {(['private', 'public'] as const).map(v => (
                  <button key={v} onClick={() => setVisibility(v)}
                    style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, border: `1.5px solid ${visibility === v ? 'var(--color-primary)' : 'var(--color-border)'}`, background: visibility === v ? 'var(--color-surface-tint)' : 'var(--color-surface-neutral)', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: visibility === v ? 600 : 450, color: visibility === v ? 'var(--color-primary)' : 'var(--color-text-secondary)', transition: 'all 150ms' }}>
                    <Icon name={v === 'private' ? 'lock' : 'public'} size={16} color={visibility === v ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                    <div style={{ textAlign: 'left' }}>
                      <div>{v === 'private' ? 'Private' : 'Public'}</div>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 400, color: 'var(--color-text-quaternary)', marginTop: 1 }}>
                        {v === 'private' ? 'Invited members only' : 'Visible to all users'}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              {!forced && (
                <button onClick={handleClose} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 10, padding: '10px 20px', cursor: 'pointer' }}>Cancel</button>
              )}
              <button onClick={() => setStep(1)} disabled={!name.trim()} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: name.trim() ? 'var(--color-primary)' : 'var(--color-accent-purple-soft-alt)', border: 'none', borderRadius: 10, padding: '10px 20px', cursor: name.trim() ? 'pointer' : 'default', transition: 'background 150ms' }}>
                Next <Icon name="arrow_forward" size={15} color="var(--color-white)" />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 1: Invite members ── */}
        {step === 1 && (
          <div style={{ padding: '20px 24px 24px', animation: 'wizardStepIn 220ms cubic-bezier(0.22,1,0.36,1) both' }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 4 }}>Invite members</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', marginBottom: 20 }}>Add people to your workspace. You can skip this and invite later.</div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, background: 'var(--color-purple-pale-11)', borderRadius: 10, padding: '8px 14px' }}>
                <Icon name="person" size={16} color="var(--color-text-tertiary)" />
                <input
                  autoFocus
                  value={memberUsername}
                  onChange={e => { setMemberUsername(e.target.value); setMemberError(null); }}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddMember(); }}
                  placeholder="Username…"
                  style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-primary)' }}
                />
              </div>
              <button onClick={handleAddMember} disabled={memberLoading || !memberUsername.trim()}
                style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, padding: '0 16px', borderRadius: 10, border: 'none', background: memberUsername.trim() ? 'var(--color-primary)' : 'var(--color-border)', color: memberUsername.trim() ? 'var(--color-white)' : 'var(--color-text-quaternary)', cursor: memberUsername.trim() ? 'pointer' : 'default', flexShrink: 0, height: 40, transition: 'all 150ms' }}>
                Add
              </button>
            </div>
            {memberError && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)', marginBottom: 8 }}>{memberError}</div>}

            {members.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 20 }}>
                {members.map(m => (
                  <div key={m.userId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--color-purple-pale-11)', borderRadius: 10 }}>
                    {m.profileImage
                      ? <img src={m.profileImage} style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                      : <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 700, color: 'var(--color-white)' }}>{m.username[0].toUpperCase()}</span>
                        </div>
                    }
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{m.fullName ?? m.username}</div>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-tertiary)' }}>@{m.username}</div>
                    </div>
                    <button onClick={() => setMembers(prev => prev.filter(x => x.userId !== m.userId))}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 4 }}>
                      <Icon name="close" size={15} color="var(--color-text-tertiary)" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {members.length === 0 && (
              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-body)', fontSize: 13 }}>
                No members added yet.
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setStep(0)} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 10, padding: '10px 20px', cursor: 'pointer' }}>Back</button>
              <button onClick={handleCreate} disabled={saving}
                style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-primary)', border: 'none', borderRadius: 10, padding: '10px 22px', cursor: saving ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                {saving
                  ? <><Spinner size={14} thickness={2} trackColor="rgba(var(--color-white-rgb), 0.3)" indicatorColor="var(--color-white)" durationMs={600} /> Creating…</>
                  : 'Create workspace'
                }
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: Done ── */}
        {step === 2 && (
          <div style={{ padding: '40px 24px', textAlign: 'center', animation: 'wizardStepIn 280ms cubic-bezier(0.22,1,0.36,1) both' }}>
            <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 32 }}>
              {useImage && pendingImage
                ? <img src={pendingImage} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
                : <span>{emoji}</span>
              }
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}>
              "{name}" created!
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', marginBottom: 28 }}>
              Your workspace is ready. Start adding lists and folders.
            </div>
            <button onClick={handleClose}
              style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-primary)', border: 'none', borderRadius: 10, padding: '11px 28px', cursor: 'pointer' }}>
              Go to workspace
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
