import { useState } from 'react';
import type { Folder } from '../types';
import Icon from '../components/Icon';
import EmojiSelector from '../components/EmojiSelector';
import CalendarPicker from '../components/CalendarPicker';
import {
  apiUpdateListShare, apiUpdateTimelineShare,
  apiUpdateList, apiUpdateTimeline, apiUpdateFolder,
  asVisibilityConflict, type VisibilityConflict,
  type ShareInfo, type ShareUpdate,
} from '../api/client';
import VisibilityConflictModal from '../components/VisibilityConflictModal';
import useWorkspaceStore from '../store/useWorkspaceStore';

const FOLDER_COLORS = [
  '#5e4dbb', '#1D4ED8', '#15803d', '#ea580c',
  '#db2777', '#ba1a1a', '#0d9488', '#6b7280',
];

// Same palette as AddListWizard — lists pair an accent color with a background tint.
const LIST_COLORS = [
  { color: '#5e4dbb', bg: '#F5F3FF' },
  { color: '#1D4ED8', bg: '#eff6ff' },
  { color: '#10B981', bg: 'rgba(16,185,129,0.10)' },
  { color: '#ea580c', bg: '#fff7ed' },
  { color: '#f59e0b', bg: '#fffbeb' },
  { color: '#ba1a1a', bg: '#ffdad6' },
];

export interface ItemSettingsUpdates {
  emoji?: string;
  color?: string;
  colorBg?: string;
  isPublic?: boolean;
  folderId?: string | null;
}

interface ItemSettingsModalProps {
  kind: 'list' | 'folder' | 'timeline';
  name: string;
  emoji?: string;
  color?: string;
  isPublic?: boolean;
  /** Lists only — available folders for the "Folder" section. */
  folders?: Folder[];
  /** Lists only — id of the folder the list currently lives in. */
  folderId?: string;
  /** List / timeline id — required for the public link sharing section. */
  itemId?: string;
  /** Current public-link share state (lists & timelines). */
  share?: {
    enabled?: boolean;
    token?: string | null;
    hasPassword?: boolean;
    expiresAt?: string | null;
    subpages?: boolean;
  };
  /** Called after a share change so the store can reflect the new state. */
  onShareUpdated?: (share: ShareInfo) => void;
  /** Called after the workspace visibility (is_public) is applied server-side. */
  onVisibilityApplied?: (isPublic: boolean) => void;
  /** Changes apply immediately (optimistic store update + API call). */
  onChange: (updates: ItemSettingsUpdates) => void;
  onClose: () => void;
}

// ── Public link sharing section (lists & timelines) ───────────────────────────
function ShareSection({ kind, itemId, share, onShareUpdated }: {
  kind: 'list' | 'timeline';
  itemId: string;
  share?: ItemSettingsModalProps['share'];
  onShareUpdated?: (share: ShareInfo) => void;
}) {
  const [enabled, setEnabled]       = useState(Boolean(share?.enabled));
  const [token, setToken]           = useState<string | null>(share?.token ?? null);
  const [hasPassword, setHasPassword] = useState(Boolean(share?.hasPassword));
  const [expiresAt, setExpiresAt]   = useState<string>(share?.expiresAt ? share.expiresAt.slice(0, 10) : '');
  const [subpages, setSubpages]     = useState(Boolean(share?.subpages));
  const [pwInput, setPwInput]       = useState('');
  const [saving, setSaving]         = useState(false);
  const [copied, setCopied]         = useState(false);
  const [showPwField, setShowPwField] = useState(false);
  const [showExpiryCal, setShowExpiryCal] = useState(false);

  const shareUrl = token ? `${window.location.origin}/share/${kind}/${token}` : '';

  const apply = async (update: ShareUpdate) => {
    setSaving(true);
    try {
      const fn = kind === 'list' ? apiUpdateListShare : apiUpdateTimelineShare;
      const { share: next } = await fn(itemId, update);
      setEnabled(next.enabled);
      setToken(next.token);
      setHasPassword(next.hasPassword);
      setExpiresAt(next.expiresAt ? next.expiresAt.slice(0, 10) : '');
      if (next.subpages !== undefined) setSubpages(next.subpages);
      onShareUpdated?.(next);
    } catch (err) {
      console.error('share update failed', err);
    } finally {
      setSaving(false);
    }
  };

  const copyLink = () => {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div style={{ animation: 'sectionFadeUp 320ms ease both', animationDelay: '65ms' }}>
      <SectionLabel>Share via link</SectionLabel>

      {/* On / Off toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: enabled ? 12 : 0 }}>
        {([{ label: 'Off', icon: 'link_off', val: false }, { label: 'On', icon: 'link', val: true }] as const).map(opt => {
          const selected = enabled === opt.val;
          return (
            <button key={opt.label}
              disabled={saving}
              onClick={() => { if (enabled !== opt.val) apply({ enabled: opt.val }); }}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '9px 12px', borderRadius: 10, border: selected ? '1.5px solid #5e4dbb' : '1.5px solid #e8e4f0', background: selected ? '#f0edff' : '#fff', cursor: saving ? 'wait' : 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: selected ? 600 : 500, color: selected ? '#5e4dbb' : '#484552', transition: 'background 120ms, border 120ms, color 120ms' }}>
              <Icon name={opt.icon} size={14} color={selected ? '#5e4dbb' : '#787584'} />
              {opt.label}
              {selected && <Icon name="check" size={13} color="#5e4dbb" />}
            </button>
          );
        })}
      </div>

      {enabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, animation: 'sectionFadeUp 240ms ease both' }}>
          {/* Copyable link */}
          {shareUrl && (
            <div style={{ background: '#F5F3FF', borderRadius: 12, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <Icon name="link" size={16} color="#5e4dbb" />
              <span style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#5e4dbb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shareUrl}</span>
              <button onClick={copyLink}
                style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: copied ? '#10B981' : '#5e4dbb', background: copied ? '#f0fdf4' : '#fff', border: `1px solid ${copied ? '#a7f3d0' : '#c4b5fd'}`, borderRadius: 7, padding: '5px 12px', cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, transition: 'all 150ms' }}>
                <Icon name={copied ? 'check' : 'content_copy'} size={12} color={copied ? '#10B981' : '#5e4dbb'} />
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          )}

          {/* Read-only note */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#b0acbe' }}>
            <Icon name="visibility" size={13} color="#b0acbe" />
            Anyone with this link can view a read-only copy. No sign-in required.
          </div>

          {/* Subpages (lists only) */}
          {kind === 'list' && (
            <div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Subpages</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {([{ label: 'Keep private', icon: 'lock', val: false }, { label: 'Share too', icon: 'account_tree', val: true }] as const).map(opt => {
                  const selected = subpages === opt.val;
                  return (
                    <button key={opt.label}
                      disabled={saving}
                      onClick={() => { if (subpages !== opt.val) apply({ subpages: opt.val }); }}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '8px 10px', borderRadius: 10, border: selected ? '1.5px solid #5e4dbb' : '1.5px solid #e8e4f0', background: selected ? '#f0edff' : '#fff', cursor: saving ? 'wait' : 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: selected ? 600 : 500, color: selected ? '#5e4dbb' : '#484552', transition: 'all 120ms' }}>
                      <Icon name={opt.icon} size={14} color={selected ? '#5e4dbb' : '#787584'} />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', marginTop: 5 }}>
                When shared, nested sublists become clickable links on the public page.
              </div>
            </div>
          )}

          {/* Password */}
          <div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Password</div>
            {hasPassword && !showPwField ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#F9FAFB', border: '1.5px solid #E5E7EB', borderRadius: 10, padding: '8px 12px' }}>
                <Icon name="lock" size={15} color="#5e4dbb" />
                <span style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#484552' }}>Password protected</span>
                <button onClick={() => setShowPwField(true)}
                  style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#5e4dbb', background: 'transparent', border: 'none', cursor: 'pointer' }}>Change</button>
                <button disabled={saving} onClick={() => apply({ password: null })}
                  style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#ba1a1a', background: 'transparent', border: 'none', cursor: saving ? 'wait' : 'pointer' }}>Remove</button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="password"
                  value={pwInput}
                  onChange={e => setPwInput(e.target.value)}
                  placeholder="Set a password (optional)"
                  style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 13, border: '1.5px solid #e8e4f0', borderRadius: 10, padding: '8px 12px', outline: 'none', background: '#fff', color: '#1c1b22' }}
                  onFocus={e => (e.target.style.borderColor = '#5e4dbb')}
                  onBlur={e => (e.target.style.borderColor = '#e8e4f0')}
                />
                <button disabled={saving || !pwInput.trim()}
                  onClick={() => { apply({ password: pwInput }); setPwInput(''); setShowPwField(false); }}
                  style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, color: '#fff', background: pwInput.trim() ? '#5e4dbb' : '#c9c4d5', border: 'none', borderRadius: 10, padding: '8px 16px', cursor: pwInput.trim() && !saving ? 'pointer' : 'not-allowed' }}>Set</button>
              </div>
            )}
          </div>

          {/* Expiry */}
          <div style={{ position: 'relative' }}>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Expires</div>
            <button
              disabled={saving}
              onClick={() => setShowExpiryCal(s => !s)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: '#fff', border: '1.5px solid #e8e4f0', borderRadius: 10, padding: '8px 12px', cursor: saving ? 'wait' : 'pointer', fontFamily: 'Inter, sans-serif', fontSize: 13, color: expiresAt ? '#1c1b22' : '#b0acbe', textAlign: 'left' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = '#5e4dbb'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = '#e8e4f0'; }}
            >
              <Icon name="calendar_today" size={14} color={expiresAt ? '#5e4dbb' : '#b0acbe'} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{expiresAt ? new Date(expiresAt + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'No expiry'}</span>
              {expiresAt && (
                <span onClick={e => { e.stopPropagation(); setShowExpiryCal(false); apply({ expiresAt: null }); }} style={{ color: '#b0acbe', lineHeight: 1, cursor: 'pointer', padding: '0 2px' }}>×</span>
              )}
            </button>
            {showExpiryCal && (
              <div style={{ position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, zIndex: 500 }}>
                <CalendarPicker
                  value={expiresAt}
                  onChange={d => { setShowExpiryCal(false); apply({ expiresAt: d || null }); }}
                  onClear={() => { setShowExpiryCal(false); apply({ expiresAt: null }); }}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Accessibility (workspace visibility) section ──────────────────────────────
// Self-contained: calls the API directly so it can enforce the visibility
// hierarchy. On a 409 conflict it surfaces the VisibilityConflictModal, then
// retries with `cascade: true` once the user confirms.
function AccessibilitySection({ kind, itemId, initialPublic, onApplied }: {
  kind: 'list' | 'folder' | 'timeline';
  itemId: string;
  initialPublic?: boolean;
  onApplied?: (isPublic: boolean) => void;
}) {
  const [pub, setPub]           = useState(Boolean(initialPublic));
  const [busy, setBusy]         = useState(false);
  const [conflict, setConflict] = useState<VisibilityConflict | null>(null);
  const [pending, setPending]   = useState(false);
  const loadWorkspaces = useWorkspaceStore(s => s.loadWorkspaces);

  const updateFn = kind === 'list' ? apiUpdateList : kind === 'timeline' ? apiUpdateTimeline : apiUpdateFolder;

  const apply = async (value: boolean, cascade = false) => {
    setBusy(true);
    const resolving = conflict; // the conflict this call resolves, if any
    try {
      await updateFn(itemId, cascade ? { isPublic: value, cascade: true } : { isPublic: value });
      setPub(value);
      setConflict(null);
      onApplied?.(value);
      // A cascade promote may have flipped the workspace to public; the
      // workspace store isn't refreshed by the SSE list/folder reload, so pull
      // it fresh — otherwise "Edit workspace" would still show the old value.
      if (cascade && resolving?.ancestors?.some(a => a.type === 'workspace')) {
        loadWorkspaces();
      }
    } catch (err) {
      const c = asVisibilityConflict(err);
      if (c) { setConflict(c); setPending(value); }
      else console.error('visibility update failed', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ animation: 'sectionFadeUp 320ms ease both', animationDelay: '40ms' }}>
      <SectionLabel>Accessibility</SectionLabel>
      <div style={{ display: 'flex', gap: 8 }}>
        {([{ label: 'Private', icon: 'lock', val: false }, { label: 'Public', icon: 'public', val: true }] as const).map(opt => {
          const selected = pub === opt.val;
          return (
            <button key={opt.label}
              disabled={busy}
              onClick={() => { if (pub !== opt.val) apply(opt.val); }}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '9px 12px', borderRadius: 10, border: selected ? '1.5px solid #5e4dbb' : '1.5px solid #e8e4f0', background: selected ? '#f0edff' : '#fff', cursor: busy ? 'wait' : 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: selected ? 600 : 500, color: selected ? '#5e4dbb' : '#484552', transition: 'background 120ms, border 120ms, color 120ms' }}>
              <Icon name={opt.icon} size={14} color={selected ? '#5e4dbb' : '#787584'} />
              {opt.label}
              {selected && <Icon name="check" size={13} color="#5e4dbb" />}
            </button>
          );
        })}
      </div>
      {conflict && (
        <VisibilityConflictModal
          conflict={conflict}
          busy={busy}
          onCancel={() => setConflict(null)}
          onConfirm={() => apply(pending, true)}
        />
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
      {children}
    </div>
  );
}

export default function ItemSettingsModal({ kind, name, emoji, color, isPublic, folders, folderId, itemId, share, onShareUpdated, onVisibilityApplied, onChange, onClose }: ItemSettingsModalProps) {
  const accent = color ?? '#5e4dbb';

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)', animation: 'backdropIn 200ms ease both' }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 18, maxWidth: 420, width: '100%', maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 22px 14px', borderBottom: '1px solid #f0ecf8', flexShrink: 0 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {emoji
              ? <span style={{ fontSize: 18 }}>{emoji}</span>
              : <Icon name={kind === 'folder' ? 'folder' : kind === 'timeline' ? 'timeline' : 'format_list_bulleted'} size={18} color={accent} />
            }
          </div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15.5, fontWeight: 700, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#b0acbe' }}>{kind === 'folder' ? 'Folder settings' : kind === 'timeline' ? 'Timeline settings' : 'List settings'}</div>
          </div>
          <button
            onClick={onClose}
            title="Close"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: '50%', border: 'none', background: '#f1f0f4', cursor: 'pointer', flexShrink: 0 }}
            onMouseEnter={e => (e.currentTarget.style.background = '#ebe6f0')}
            onMouseLeave={e => (e.currentTarget.style.background = '#f1f0f4')}>
            <Icon name="close" size={15} color="#787584" />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 22px 20px', display: 'flex', flexDirection: 'column', gap: 18 }}>

          {/* Accessibility — workspace visibility with hierarchy enforcement */}
          {itemId
            ? <AccessibilitySection kind={kind} itemId={itemId} initialPublic={isPublic} onApplied={onVisibilityApplied} />
            : (
              <div style={{ animation: 'sectionFadeUp 320ms ease both', animationDelay: '40ms' }}>
                <SectionLabel>Accessibility</SectionLabel>
                <div style={{ display: 'flex', gap: 8 }}>
                  {([{ label: 'Private', icon: 'lock', val: false }, { label: 'Public', icon: 'public', val: true }] as const).map(opt => {
                    const selected = isPublic === opt.val;
                    return (
                      <button key={opt.label}
                        onClick={() => onChange({ isPublic: opt.val })}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '9px 12px', borderRadius: 10, border: selected ? '1.5px solid #5e4dbb' : '1.5px solid #e8e4f0', background: selected ? '#f0edff' : '#fff', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: selected ? 600 : 500, color: selected ? '#5e4dbb' : '#484552', transition: 'background 120ms, border 120ms, color 120ms' }}>
                        <Icon name={opt.icon} size={14} color={selected ? '#5e4dbb' : '#787584'} />
                        {opt.label}
                        {selected && <Icon name="check" size={13} color="#5e4dbb" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

          {/* Share via link (lists & timelines) */}
          {kind !== 'folder' && itemId && (
            <ShareSection kind={kind} itemId={itemId} share={share} onShareUpdated={onShareUpdated} />
          )}

          {/* Color */}
          <div style={{ animation: 'sectionFadeUp 320ms ease both', animationDelay: '90ms' }}>
            <SectionLabel>Color</SectionLabel>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {kind === 'folder'
                ? FOLDER_COLORS.map(c => (
                  <button key={c}
                    onClick={() => onChange({ color: c })}
                    title={c}
                    style={{ width: 26, height: 26, borderRadius: '50%', background: c, border: color === c ? '2.5px solid #1c1b22' : '2px solid transparent', cursor: 'pointer', padding: 0, outline: 'none', transition: 'border 120ms, transform 140ms cubic-bezier(0.34,1.56,0.64,1)' }}
                    onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.15)')}
                    onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')} />
                ))
                : LIST_COLORS.map(c => (
                  <button key={c.color}
                    onClick={() => onChange({ color: c.color, colorBg: c.bg })}
                    title={c.color}
                    style={{ width: 26, height: 26, borderRadius: '50%', background: c.color, border: color === c.color ? '2.5px solid #1c1b22' : '2px solid transparent', cursor: 'pointer', padding: 0, outline: 'none', transition: 'border 120ms, transform 140ms cubic-bezier(0.34,1.56,0.64,1)' }}
                    onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.15)')}
                    onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')} />
                ))
              }
            </div>
          </div>

          {/* Emoji */}
          <div style={{ animation: 'sectionFadeUp 320ms ease both', animationDelay: '140ms' }}>
            <SectionLabel>Emoji</SectionLabel>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <EmojiSelector value={emoji ?? ''} onChange={em => onChange({ emoji: em })} direction="down" size={36} />
              <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe' }}>
                {emoji ? 'Click to change or remove' : 'Click to choose an emoji'}
              </span>
            </div>
          </div>

          {/* Folder (lists & timelines) */}
          {kind !== 'folder' && folders && folders.length > 0 && (
            <div style={{ animation: 'sectionFadeUp 320ms ease both', animationDelay: '190ms' }}>
              <SectionLabel>Folder</SectionLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {[{ id: null as string | null, name: 'No folder', emoji: undefined as string | undefined, color: undefined as string | undefined }, ...folders].map(f => {
                  const selected = (f.id ?? undefined) === folderId || (f.id === null && !folderId);
                  return (
                    <button key={f.id ?? '__none__'}
                      onClick={() => { if (!selected) onChange({ folderId: f.id }); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: 'none', borderRadius: 8, background: selected ? '#f0edff' : 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: selected ? 600 : 450, color: selected ? '#5e4dbb' : '#484552', textAlign: 'left', width: '100%', transition: 'background 120ms, color 120ms' }}
                      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = '#f5f3ff'; }}
                      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}>
                      {f.id === null
                        ? <Icon name="remove_circle_outline" size={14} color={selected ? '#5e4dbb' : '#787584'} />
                        : f.emoji
                          ? <span style={{ fontSize: 14 }}>{f.emoji}</span>
                          : <Icon name="folder" size={14} color={f.color ?? '#787584'} />
                      }
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                      {selected && <Icon name="check" size={14} color="#5e4dbb" />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 22px 18px', borderTop: '1px solid #f0ecf8', display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
          <button
            onClick={onClose}
            style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#5e4dbb', border: 'none', borderRadius: 10, padding: '9px 22px', cursor: 'pointer', transition: 'background 140ms, transform 140ms' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#5240a8'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#5e4dbb'; e.currentTarget.style.transform = 'translateY(0)'; }}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
