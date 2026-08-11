import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import useMembersStore from '../store/useMembersStore';
import PopIn from './animate-ui/PopIn';

function initials(fullName: string | null, username: string): string {
  return (fullName || username || 'U')
    .split(' ')
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

interface CreatorBubbleProps {
  creatorId: string;
  taskHovered?: boolean;
}

export default function CreatorBubble({ creatorId, taskHovered }: CreatorBubbleProps) {
  const member = useMembersStore(s => s.members[creatorId]);
  const avatar = useMembersStore(s => s.avatars[creatorId]);
  const ensureAvatar = useMembersStore(s => s.ensureAvatar);
  const [cardVisible, setCardVisible] = useState(false);
  const [cardPos, setCardPos] = useState({ x: 0, top: 0, above: false });
  const ref = useRef<HTMLDivElement>(null);

  // Lazily pull this member's avatar (cached in the store) only when they render.
  useEffect(() => {
    if (member?.hasImage) ensureAvatar(creatorId);
  }, [creatorId, member?.hasImage, ensureAvatar]);

  if (!member) return null;

  const ini = initials(member.fullName, member.username);

  const handleMouseEnter = () => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const cardHeight = 172;
    const above = rect.top > cardHeight + 16;
    setCardPos({
      x: rect.left + rect.width / 2,
      top: above ? rect.top - cardHeight - 8 : rect.bottom + 8,
      above,
    });
    setCardVisible(true);
  };

  const avatarStyle = {
    width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
  };

  return (
    <>
      <div
        ref={ref}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => setCardVisible(false)}
        style={{
          width: 22, height: 22, borderRadius: '50%', flexShrink: 0, overflow: 'hidden',
          background: 'linear-gradient(135deg, var(--color-accent-purple-light) 0%, var(--color-primary) 100%)',
          border: '1.5px solid var(--color-white)',
          opacity: taskHovered ? 1 : 0.5,
          transition: 'opacity 150ms',
          cursor: 'default',
        }}
      >
        {avatar
          ? <img src={avatar} alt={member.username} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <span style={{ ...avatarStyle, fontFamily: 'var(--font-heading)', fontSize: 8, fontWeight: 700, color: 'var(--color-white)' }}>{ini}</span>
        }
      </div>

      {cardVisible && createPortal(
        // Static anchor wrapper (unanimated) — keeps the fixed translateX(-50%)
        // centering separate from PopIn's own animated transform.
        <div
          onMouseEnter={() => setCardVisible(true)}
          onMouseLeave={() => setCardVisible(false)}
          style={{ position: 'fixed', left: cardPos.x, top: cardPos.top, transform: 'translateX(-50%)', zIndex: 9999, width: 218 }}
        >
          <PopIn
            duration={180}
            ease="spring"
            style={{
              background: 'var(--color-white)',
              border: '1px solid var(--color-border-alt)',
              borderRadius: 14,
              boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.13)',
              padding: '18px 16px 16px',
            }}
          >
            {/* Avatar */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 52, height: 52, borderRadius: '50%',
                background: 'linear-gradient(135deg, var(--color-accent-purple-light) 0%, var(--color-primary) 100%)',
                overflow: 'hidden', flexShrink: 0,
              }}>
                {avatar
                  ? <img src={avatar} alt={member.username} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', fontFamily: 'var(--font-heading)', fontSize: 19, fontWeight: 700, color: 'var(--color-white)' }}>{ini}</span>
                }
              </div>

              {/* Name + role */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
                <span style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)' }}>
                  {member.fullName || member.username}
                </span>
                {member.isAdmin && (
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, fontWeight: 700, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', borderRadius: 9999, padding: '1px 6px', textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>
                    Admin
                  </span>
                )}
              </div>

              {/* Username */}
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: -4 }}>
                @{member.username}
              </span>

              {/* Divider */}
              <div style={{ width: '100%', height: 1, background: 'var(--color-surface-tint-2)', margin: '2px 0' }} />

              {/* Email */}
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', textAlign: 'center', wordBreak: 'break-all' }}>
                {member.email}
              </span>
            </div>
          </PopIn>
        </div>,
        document.body
      )}
    </>
  );
}
