import { useEffect } from 'react';
import useMembersStore from '../store/useMembersStore';

// ── Small reusable member avatar ─────────────────────────────────────────────
// Renders a user's profile image (lazily pulled + cached in the members store)
// or their initials on the standard purple gradient. Used by the notification
// panel/feed and the item dialog's Tag row.

function initials(name: string): string {
  return (name || 'U').split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2);
}

interface MemberAvatarProps {
  userId: string;
  size?: number;
  /** Shown while the member row hasn't loaded (e.g. a notification actor). */
  fallbackName?: string | null;
  ring?: boolean;
}

export default function MemberAvatar({ userId, size = 32, fallbackName, ring }: MemberAvatarProps) {
  const member = useMembersStore((s) => s.members[userId]);
  const avatar = useMembersStore((s) => s.avatars[userId]);
  const ensureAvatar = useMembersStore((s) => s.ensureAvatar);

  useEffect(() => {
    if (member?.hasImage) ensureAvatar(userId);
  }, [userId, member?.hasImage, ensureAvatar]);

  const name = member?.fullName || member?.username || fallbackName || 'User';
  const ini = initials(name);

  return (
    <div
      title={name}
      style={{
        width: size, height: size, borderRadius: '50%', overflow: 'hidden', flexShrink: 0,
        background: 'linear-gradient(135deg, var(--color-accent-purple-light) 0%, var(--color-primary) 100%)',
        border: ring ? '2px solid var(--color-white)' : 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      {avatar
        ? <img src={avatar} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : <span style={{ fontFamily: 'var(--font-heading)', fontSize: Math.max(8, Math.round(size * 0.4)), fontWeight: 700, color: 'var(--color-white)', lineHeight: 1 }}>{ini}</span>}
    </div>
  );
}
