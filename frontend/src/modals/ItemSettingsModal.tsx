import { useState } from 'react';
import { createPortal } from 'react-dom';
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
  folders?: Folder[];
  folderId?: string;
  itemId?: string;
  share?: {
    enabled?: boolean;
    token?: string | null;
    hasPassword?: boolean;
    expiresAt?: string | null;
    subpages?: boolean;
  };
  onShareUpdated?: (share: ShareInfo) => void;
  onVisibilityApplied?: (isPublic: boolean) => void;
  onChange: (updates: ItemSettingsUpdates) => void;
  onClose: () => void;
}

// ── Section header ────────────────────────────────────────────────────────────
function SectionHeader({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 14 }}>
      <Icon name={icon} size={14} color="#9d8dff" />
      <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 700, color: '#9d8dff', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
        {children}
      </span>
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: '#f0ecf8', flexShrink: 0 }} />;
}

// ── Share via link ────────────────────────────────────────────────────────────
function ShareSection({ kind, itemId, share, onShareUpdated }: {
  kind: 'list' | 'timeline';
  itemId: string;
  share?: ItemSettingsModalProps['share'];
  onShareUpdated?: (share: ShareInfo) => void;
}) {
  const [enabled, setEnabled]         = useState(Boolean(share?.enabled));
  const [token, setToken]             = useState<string | null>(share?.token ?? null);
  const [hasPassword, setHasPassword] = useState(Boolean(share?.hasPassword));
  const [expiresAt, setExpiresAt]     = useState<string>(share?.expiresAt ? share.expiresAt.slice(0, 10) : '');
  const [subpages, setSubpages]       = useState(Boolean(share?.subpages));
  const [pwInput, setPwInput]         = useState('');
  const [saving, setSaving]           = useState(false);
  const [copied, setCopied]           = useState(false);
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* On / Off toggle */}
      <div style={{ display: 'flex', gap: 8 }}>
        {([{ label: 'Off', icon: 'link_off', val: false }, { label: 'On', icon: 'link', val: true }] as const).map(opt => {
          const selected = enabled === opt.val;
          return (
            <button key={opt.label}
              disabled={saving}
              onClick={() => { if (enabled !== opt.val) apply({ enabled: opt.val }); }}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '10px 12px', borderRadius: 10, border: selected ? '1.5px solid #5e4dbb' : '1.5px solid #e8e4f0', background: selected ? '#f0edff' : '#faf8ff', cursor: saving ? 'wait' : 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: selected ? 600 : 500, color: selected ? '#5e4dbb' : '#484552', transition: 'all 120ms' }}>
              <Icon name={opt.icon} size={15} color={selected ? '#5e4dbb' : '#787584'} />
              {opt.label}
              {selected && <Icon name="check" size={13} color="#5e4dbb" />}
            </button>
          );
        })}
      </div>

      {enabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, animation: 'sectionFadeUp 200ms ease both' }}>
          {/* Copyable link */}
          {shareUrl && (
            <div style={{ background: '#F5F3FF', borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <Icon name="link" size={16} color="#5e4dbb" />
              <span style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#5e4dbb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shareUrl}</span>
              <button onClick={copyLink}
                style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: copied ? '#10B981' : '#5e4dbb', background: copied ? '#f0fdf4' : '#fff', border: `1px solid ${copied ? '#a7f3d0' : '#c4b5fd'}`, borderRadius: 7, padding: '5px 12px', cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, transition: 'all 150ms' }}>
                <Icon name={copied ? 'check' : 'content_copy'} size={12} color={copied ? '#10B981' : '#5e4dbb'} />
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#b0acbe', lineHeight: 1.4 }}>
            <Icon name="visibility" size={13} color="#b0acbe" style={{ marginTop: 1, flexShrink: 0 }} />
            Anyone with this link can view a read-only copy. No sign-in required.
          </div>

          {/* Subpages (lists only) */}
          {kind === 'list' && (
            <div>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 500, color: '#787584', marginBottom: 6 }}>Subpages</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {([{ label: 'Keep private', icon: 'lock', val: false }, { label: 'Share too', icon: 'account_tree', val: true }] as const).map(opt => {
                  const selected = subpages === opt.val;
                  return (
                    <button key={opt.label}
                      disabled={saving}
                      onClick={() => { if (subpages !== opt.val) apply({ subpages: opt.val }); }}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '8px 10px', borderRadius: 10, border: selected ? '1.5px solid #5e4dbb' : '1.5px solid #e8e4f0', background: selected ? '#f0edff' : '#faf8ff', cursor: saving ? 'wait' : 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: selected ? 600 : 500, color: selected ? '#5e4dbb' : '#484552', transition: 'all 120ms' }}>
                      <Icon name={opt.icon} size={14} color={selected ? '#5e4dbb' : '#787584'} />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', marginTop: 5, lineHeight: 1.4 }}>
                When shared, nested sublists become clickable links on the public page.
              </div>
            </div>
          )}

          {/* Password */}
          <div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 500, color: '#787584', marginBottom: 6 }}>Password</div>
            {hasPassword && !showPwField ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#F9FAFB', border: '1.5px solid #E5E7EB', borderRadius: 10, padding: '9px 14px' }}>
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
                  style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 13, border: '1.5px solid #e8e4f0', borderRadius: 10, padding: '9px 12px', outline: 'none', background: '#fff', color: '#1c1b22' }}
                  onFocus={e => (e.target.style.borderColor = '#5e4dbb')}
                  onBlur={e => (e.target.style.borderColor = '#e8e4f0')}
                />
                <button disabled={saving || !pwInput.trim()}
                  onClick={() => { apply({ password: pwInput }); setPwInput(''); setShowPwField(false); }}
                  style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: pwInput.trim() ? '#5e4dbb' : '#c9c4d5', border: 'none', borderRadius: 10, padding: '9px 18px', cursor: pwInput.trim() && !saving ? 'pointer' : 'not-allowed', flexShrink: 0 }}>
                  Set
                </button>
              </div>
            )}
          </div>

          {/* Expiry */}
          <div style={{ position: 'relative' }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 500, color: '#787584', marginBottom: 6 }}>Expiry date</div>
            <button
              disabled={saving}
              onClick={() => setShowExpiryCal(s => !s)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: '#fff', border: '1.5px solid #e8e4f0', borderRadius: 10, padding: '9px 14px', cursor: saving ? 'wait' : 'pointer', fontFamily: 'Inter, sans-serif', fontSize: 13, color: expiresAt ? '#1c1b22' : '#b0acbe', textAlign: 'left' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = '#5e4dbb'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = '#e8e4f0'; }}
            >
              <Icon name="calendar_today" size={14} color={expiresAt ? '#5e4dbb' : '#b0acbe'} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {expiresAt ? new Date(expiresAt + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'No expiry'}
              </span>
              {expiresAt && (
                <span onClick={e => { e.stopPropagation(); setShowExpiryCal(false); apply({ expiresAt: null }); }}
                  style={{ color: '#b0acbe', lineHeight: 1, cursor: 'pointer', padding: '0 2px', fontSize: 16 }}>×</span>
              )}
            </button>
            {showExpiryCal && (
              <div style={{ position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, zIndex: 10 }}>
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

// ── Accessibility / workspace visibility ──────────────────────────────────────
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
    const resolving = conflict;
    try {
      await updateFn(itemId, cascade ? { isPublic: value, cascade: true } : { isPublic: value });
      setPub(value);
      setConflict(null);
      onApplied?.(value);
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
    <div>
      <div style={{ display: 'flex', gap: 8 }}>
        {([{ label: 'Private', icon: 'lock', val: false }, { label: 'Public', icon: 'public', val: true }] as const).map(opt => {
          const selected = pub === opt.val;
          return (
            <button key={opt.label}
              disabled={busy}
              onClick={() => { if (pub !== opt.val) apply(opt.val); }}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '10px 12px', borderRadius: 10, border: selected ? '1.5px solid #5e4dbb' : '1.5px solid #e8e4f0', background: selected ? '#f0edff' : '#faf8ff', cursor: busy ? 'wait' : 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: selected ? 600 : 500, color: selected ? '#5e4dbb' : '#484552', transition: 'all 120ms' }}>
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

// ── Main modal ────────────────────────────────────────────────────────────────
export default function ItemSettingsModal({ kind, name, emoji, color, isPublic, folders, folderId, itemId, share, onShareUpdated, onVisibilityApplied, onChange, onClose }: ItemSettingsModalProps) {
  const accent = color ?? '#5e4dbb';

  const modal = (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)', backdropFilter: 'blur(6px)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)', animation: 'backdropIn 200ms ease both' }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 20, maxWidth: 500, width: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 48px rgba(94,77,187,0.16)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}>

        {/* Accent stripe */}
        <div style={{ height: 5, background: `linear-gradient(90deg, ${accent} 0%, ${accent}55 100%)`, flexShrink: 0 }} />

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '18px 24px 16px', flexShrink: 0 }}>
          <div style={{ width: 44, height: 44, borderRadius: 13, background: '#F5F3FF', border: '1px solid #ede8f8', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {emoji
              ? <span style={{ fontSize: 22 }}>{emoji}</span>
              : <Icon name={kind === 'folder' ? 'folder' : kind === 'timeline' ? 'timeline' : 'format_list_bulleted'} size={22} color={accent} />
            }
          </div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe', marginTop: 2 }}>
              {kind === 'folder' ? 'Folder settings' : kind === 'timeline' ? 'Timeline settings' : 'List settings'}
            </div>
          </div>
          <button
            onClick={onClose}
            title="Close"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: '50%', border: 'none', background: '#f1f0f4', cursor: 'pointer', flexShrink: 0, transition: 'background 120ms' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#ebe6f0')}
            onMouseLeave={e => (e.currentTarget.style.background = '#f1f0f4')}>
            <Icon name="close" size={16} color="#787584" />
          </button>
        </div>

        <Divider />

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>

          {/* ── Appearance ─────────────────────────────────────────── */}
          <div style={{ padding: '20px 24px', animation: 'sectionFadeUp 260ms ease both' }}>
            <SectionHeader icon="palette">Appearance</SectionHeader>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
              <EmojiSelector value={emoji ?? ''} onChange={em => onChange({ emoji: em })} direction="down" size={44} />
              <div>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 600, color: '#1c1b22' }}>Icon</div>
                <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe', marginTop: 3, lineHeight: 1.4 }}>
                  {emoji ? 'Click to change or remove' : 'Click to add an emoji icon'}
                </div>
              </div>
            </div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 500, color: '#787584', marginBottom: 8 }}>Color</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {kind === 'folder'
                ? FOLDER_COLORS.map(c => (
                  <button key={c} onClick={() => onChange({ color: c })} title={c}
                    style={{ width: 30, height: 30, borderRadius: '50%', background: c, border: color === c ? '2.5px solid #1c1b22' : '2.5px solid transparent', cursor: 'pointer', padding: 0, outline: 'none', boxShadow: color === c ? `0 0 0 2px white, 0 0 0 4px ${c}` : 'none', transition: 'all 140ms cubic-bezier(0.34,1.56,0.64,1)' }}
                    onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.18)')}
                    onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')} />
                ))
                : LIST_COLORS.map(c => (
                  <button key={c.color} onClick={() => onChange({ color: c.color, colorBg: c.bg })} title={c.color}
                    style={{ width: 30, height: 30, borderRadius: '50%', background: c.color, border: 'none', cursor: 'pointer', padding: 0, outline: 'none', boxShadow: color === c.color ? `0 0 0 2px white, 0 0 0 4px ${c.color}` : 'none', transition: 'all 140ms cubic-bezier(0.34,1.56,0.64,1)' }}
                    onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.18)')}
                    onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')} />
                ))
              }
            </div>
          </div>

          <Divider />

          {/* ── Workspace access ───────────────────────────────────── */}
          <div style={{ padding: '20px 24px', animation: 'sectionFadeUp 260ms ease both', animationDelay: '40ms' }}>
            <SectionHeader icon="people">Workspace access</SectionHeader>
            {itemId
              ? <AccessibilitySection kind={kind} itemId={itemId} initialPublic={isPublic} onApplied={onVisibilityApplied} />
              : (
                <div style={{ display: 'flex', gap: 8 }}>
                  {([{ label: 'Private', icon: 'lock', val: false }, { label: 'Public', icon: 'public', val: true }] as const).map(opt => {
                    const selected = isPublic === opt.val;
                    return (
                      <button key={opt.label}
                        onClick={() => onChange({ isPublic: opt.val })}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '10px 12px', borderRadius: 10, border: selected ? '1.5px solid #5e4dbb' : '1.5px solid #e8e4f0', background: selected ? '#f0edff' : '#faf8ff', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: selected ? 600 : 500, color: selected ? '#5e4dbb' : '#484552', transition: 'all 120ms' }}>
                        <Icon name={opt.icon} size={14} color={selected ? '#5e4dbb' : '#787584'} />
                        {opt.label}
                        {selected && <Icon name="check" size={13} color="#5e4dbb" />}
                      </button>
                    );
                  })}
                </div>
              )}
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe', marginTop: 10, lineHeight: 1.5 }}>
              Controls who can see this {kind} inside your workspace.
            </div>
          </div>

          {/* ── Organization (folder picker) ───────────────────────── */}
          {kind !== 'folder' && folders && folders.length > 0 && (
            <>
              <Divider />
              <div style={{ padding: '20px 24px', animation: 'sectionFadeUp 260ms ease both', animationDelay: '80ms' }}>
                <SectionHeader icon="folder_open">Organization</SectionHeader>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {[{ id: null as string | null, name: 'No folder', emoji: undefined as string | undefined, color: undefined as string | undefined }, ...folders].map(f => {
                    const selected = (f.id ?? undefined) === folderId || (f.id === null && !folderId);
                    return (
                      <button key={f.id ?? '__none__'}
                        onClick={() => { if (!selected) onChange({ folderId: f.id }); }}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', border: 'none', borderRadius: 9, background: selected ? '#f0edff' : 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: selected ? 600 : 450, color: selected ? '#5e4dbb' : '#484552', textAlign: 'left', width: '100%', transition: 'all 120ms' }}
                        onMouseEnter={e => { if (!selected) e.currentTarget.style.background = '#f5f3ff'; }}
                        onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}>
                        {f.id === null
                          ? <Icon name="remove_circle_outline" size={15} color={selected ? '#5e4dbb' : '#787584'} />
                          : f.emoji
                            ? <span style={{ fontSize: 15 }}>{f.emoji}</span>
                            : <Icon name="folder" size={15} color={f.color ?? '#787584'} />
                        }
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                        {selected && <Icon name="check" size={14} color="#5e4dbb" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* ── Share via link ─────────────────────────────────────── */}
          {kind !== 'folder' && itemId && (
            <>
              <Divider />
              <div style={{ padding: '20px 24px', animation: 'sectionFadeUp 260ms ease both', animationDelay: '120ms' }}>
                <SectionHeader icon="link">Share via link</SectionHeader>
                <ShareSection kind={kind} itemId={itemId} share={share} onShareUpdated={onShareUpdated} />
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <Divider />
        <div style={{ padding: '14px 24px 18px', display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
          <button
            onClick={onClose}
            style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 600, color: '#fff', background: accent, border: 'none', borderRadius: 10, padding: '10px 28px', cursor: 'pointer', transition: 'filter 140ms, transform 140ms' }}
            onMouseEnter={e => { e.currentTarget.style.filter = 'brightness(0.88)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
            onMouseLeave={e => { e.currentTarget.style.filter = 'none'; e.currentTarget.style.transform = 'translateY(0)'; }}>
            Done
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
