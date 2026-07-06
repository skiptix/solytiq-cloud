import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import useMembersStore from '../store/useMembersStore';

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
          background: 'linear-gradient(135deg, #9d8dff 0%, #5e4dbb 100%)',
          border: '1.5px solid #fff',
          opacity: taskHovered ? 1 : 0.5,
          transition: 'opacity 150ms',
          cursor: 'default',
        }}
      >
        {avatar
          ? <img src={avatar} alt={member.username} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <span style={{ ...avatarStyle, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 8, fontWeight: 700, color: '#fff' }}>{ini}</span>
        }
      </div>

      {cardVisible && createPortal(
        <div
          onMouseEnter={() => setCardVisible(true)}
          onMouseLeave={() => setCardVisible(false)}
          style={{
            position: 'fixed',
            left: cardPos.x,
            top: cardPos.top,
            transform: 'translateX(-50%)',
            zIndex: 9999,
            width: 218,
            background: '#fff',
            border: '1px solid #E5E7EB',
            borderRadius: 14,
            boxShadow: '0 8px 32px rgba(0,0,0,0.13)',
            padding: '18px 16px 16px',
            animation: 'menuIn 180ms cubic-bezier(0.34,1.56,0.64,1) both',
          }}
        >
          {/* Avatar */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 52, height: 52, borderRadius: '50%',
              background: 'linear-gradient(135deg, #9d8dff 0%, #5e4dbb 100%)',
              overflow: 'hidden', flexShrink: 0,
            }}>
              {avatar
                ? <img src={avatar} alt={member.username} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 19, fontWeight: 700, color: '#fff' }}>{ini}</span>
              }
            </div>

            {/* Name + role */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
              <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 700, color: '#1c1b22' }}>
                {member.fullName || member.username}
              </span>
              {member.isAdmin && (
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 9, fontWeight: 700, color: '#5e4dbb', background: '#F5F3FF', borderRadius: 9999, padding: '1px 6px', textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>
                  Admin
                </span>
              )}
            </div>

            {/* Username */}
            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: -4 }}>
              @{member.username}
            </span>

            {/* Divider */}
            <div style={{ width: '100%', height: 1, background: '#f1ecf6', margin: '2px 0' }} />

            {/* Email */}
            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', textAlign: 'center', wordBreak: 'break-all' }}>
              {member.email}
            </span>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
