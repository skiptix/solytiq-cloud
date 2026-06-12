import type { Folder } from '../types';
import Icon from '../components/Icon';
import EmojiSelector from '../components/EmojiSelector';

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
  kind: 'list' | 'folder';
  name: string;
  emoji?: string;
  color?: string;
  isPublic?: boolean;
  /** Lists only — available folders for the "Folder" section. */
  folders?: Folder[];
  /** Lists only — id of the folder the list currently lives in. */
  folderId?: string;
  /** Changes apply immediately (optimistic store update + API call). */
  onChange: (updates: ItemSettingsUpdates) => void;
  onClose: () => void;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 600, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
      {children}
    </div>
  );
}

export default function ItemSettingsModal({ kind, name, emoji, color, isPublic, folders, folderId, onChange, onClose }: ItemSettingsModalProps) {
  const accent = color ?? '#5e4dbb';

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'backdropIn 200ms ease both' }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 18, maxWidth: 420, width: '100%', maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 22px 14px', borderBottom: '1px solid #f0ecf8', flexShrink: 0 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {emoji
              ? <span style={{ fontSize: 18 }}>{emoji}</span>
              : <Icon name={kind === 'folder' ? 'folder' : 'format_list_bulleted'} size={18} color={accent} />
            }
          </div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15.5, fontWeight: 700, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#b0acbe' }}>{kind === 'folder' ? 'Folder settings' : 'List settings'}</div>
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

          {/* Accessibility */}
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

          {/* Folder (lists only) */}
          {kind === 'list' && folders && folders.length > 0 && (
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
