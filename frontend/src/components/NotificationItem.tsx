import { useState } from 'react';
import Icon from './Icon';
import MemberAvatar from './MemberAvatar';
import type { AppNotification } from '../api/client';
import { notificationVisual, relativeTime } from '../utils/notifications';

// ── One notification row ──────────────────────────────────────────────────────
// Shared by the TopBar slide-in panel and the Dashboard feed so both read
// identically. Actor-driven notifications show the actor's avatar with a small
// type badge; system ones (automation runs, overdue deadlines) show a type chip.

interface NotificationItemProps {
  notification: AppNotification;
  onActivate: (n: AppNotification) => void;
  onDismiss?: (n: AppNotification) => void;
  /** Denser padding for the dashboard feed. */
  compact?: boolean;
}

export default function NotificationItem({ notification: n, onActivate, onDismiss, compact }: NotificationItemProps) {
  const [hover, setHover] = useState(false);
  const visual = notificationVisual(n);
  const actorName = n.actor ? (n.actor.fullName || n.actor.username || 'Someone') : null;

  return (
    <div
      role="button"
      tabIndex={0}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onActivate(n)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(n); } }}
      style={{
        position: 'relative',
        display: 'flex', alignItems: 'flex-start', gap: 11,
        padding: compact ? '10px 12px' : '12px 16px',
        borderRadius: 12,
        cursor: 'pointer',
        background: hover ? 'var(--color-surface-tint-3)' : (n.read ? 'transparent' : 'var(--color-purple-pale-7)'),
        transition: 'background 120ms',
      }}
    >
      {/* Unread accent */}
      {!n.read && (
        <span style={{ position: 'absolute', left: 4, top: '50%', transform: 'translateY(-50%)', width: 4, height: 22, borderRadius: 9999, background: 'var(--color-primary)' }} />
      )}

      {/* Avatar / type icon with a corner type badge */}
      <div style={{ position: 'relative', flexShrink: 0, marginLeft: n.read ? 0 : 4 }}>
        {n.actor ? (
          <MemberAvatar userId={n.actor.id} size={36} fallbackName={actorName} />
        ) : (
          <div style={{ width: 36, height: 36, borderRadius: '50%', background: visual.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={visual.icon} size={19} color={visual.color} />
          </div>
        )}
        {n.actor && (
          <div style={{
            position: 'absolute', right: -3, bottom: -3, width: 18, height: 18, borderRadius: '50%',
            background: visual.bg, border: '2px solid var(--color-white)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icon name={visual.icon} size={11} color={visual.color} />
          </div>
        )}
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.4 }}>
          {actorName && (
            <span style={{ fontWeight: 700, color: 'var(--color-text-primary)' }}>{actorName} </span>
          )}
          <span>{n.title}</span>
        </div>
        {n.body && (
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {n.body}
          </div>
        )}
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', marginTop: 3 }}>
          {relativeTime(n.createdAt)}
        </div>
      </div>

      {/* Dismiss */}
      {onDismiss && (
        <button
          onClick={(e) => { e.stopPropagation(); onDismiss(n); }}
          title="Dismiss"
          style={{
            flexShrink: 0, width: 24, height: 24, borderRadius: 7, border: 'none', cursor: 'pointer',
            background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: hover ? 1 : 0, transition: 'opacity 120ms, background 120ms',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <Icon name="close" size={14} color="var(--color-text-quaternary)" />
        </button>
      )}
    </div>
  );
}
