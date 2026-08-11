import MemberAvatar from './MemberAvatar';
import Icon from './Icon';
import PopIn from './animate-ui/PopIn';
import type { MentionMember } from '../utils/mention';

// ── @-mention suggestion popover ──────────────────────────────────────────────
// A pure list — the caller positions it (absolute, near the caret/field) and
// owns keyboard nav (the `activeIndex`). Rendered only while a mention is being
// typed and there is at least one candidate.

interface MentionPopoverProps {
  members: MentionMember[];
  activeIndex: number;
  onPick: (m: MentionMember) => void;
  onHover: (index: number) => void;
  style?: React.CSSProperties;
}

export default function MentionPopover({ members, activeIndex, onPick, onHover, style }: MentionPopoverProps) {
  if (members.length === 0) return null;
  // Clamp to the viewport so the picker never runs off-screen on mobile (matches
  // the CalendarPicker/TimePicker convention). Kept above the sibling slash
  // menu (z 210) so a block-anchored mention popover is never occluded.
  const width = Math.min(240, (typeof window !== 'undefined' ? window.innerWidth : 400) - 32);
  return (
    <PopIn
      duration={120}
      style={{
        position: 'absolute', zIndex: 220, width, maxHeight: 232, overflowY: 'auto',
        background: 'var(--color-white)', border: '1px solid var(--color-border)', borderRadius: 12,
        boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.16)', padding: 6,
        ...style,
      }}
      // Keep the textarea focused — don't steal selection on mousedown.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '2px 6px 6px' }}>
        <Icon name="alternate_email" size={12} color="var(--color-primary)" />
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 10.5, fontWeight: 700, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Tag a member</span>
      </div>
      {members.map((m, i) => (
        <button
          key={m.id}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(m)}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '6px 8px', borderRadius: 8,
            border: 'none', cursor: 'pointer', textAlign: 'left',
            background: i === activeIndex ? 'var(--color-surface-tint-3)' : 'transparent',
          }}
        >
          <MemberAvatar userId={m.id} size={24} fallbackName={m.fullName || m.username} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.fullName || m.username}</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)' }}>@{m.username}</div>
          </div>
        </button>
      ))}
    </PopIn>
  );
}
