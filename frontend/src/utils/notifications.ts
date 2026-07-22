import type { AppNotification } from '../api/client';

// ── Notification presentation + navigation helpers ────────────────────────────
// Shared by the TopBar slide-in panel and the Dashboard feed so both render the
// same icon/colour per type and resolve the same deep-link target.

export interface NotificationTarget {
  path: string;
  /** When set, switch to this workspace before navigating. */
  workspaceId: string | null;
}

/** Where a notification should navigate on click. Derived from entityType +
 *  `data`, mirroring the app's route table (see App.tsx). */
export function notificationTarget(n: AppNotification): NotificationTarget {
  const data = (n.data ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  switch (n.entityType) {
    case 'workspace':
      return { path: '/dashboard', workspaceId: n.entityId };
    case 'list':
      return { path: n.entityId ? `/list/${n.entityId}` : '/dashboard', workspaceId: n.workspaceId };
    case 'timeline':
      return { path: n.entityId ? `/timeline/${n.entityId}` : '/dashboard', workspaceId: n.workspaceId };
    case 'meeting':
      return { path: '/calendar?show=meetings', workspaceId: null };
    case 'task': {
      const listId = str(data.listId);
      return { path: listId ? `/list/${listId}` : '/dashboard', workspaceId: n.workspaceId };
    }
    case 'milestone': {
      const timelineId = str(data.timelineId);
      return { path: timelineId ? `/timeline/${timelineId}` : '/dashboard', workspaceId: n.workspaceId };
    }
    case 'markdownList':
      return { path: n.entityId ? `/markdown-list/${n.entityId}` : '/dashboard', workspaceId: n.workspaceId };
    case 'automation':
      return { path: n.entityId ? `/automations/${n.entityId}` : '/automations', workspaceId: n.workspaceId };
    default:
      return { path: '/dashboard', workspaceId: n.workspaceId };
  }
}

export interface NotificationVisual {
  icon: string;
  /** CSS color token for the icon. */
  color: string;
  /** CSS color token for the icon's chip background. */
  bg: string;
}

/** Material Symbol + accent colours per notification type, from the design
 *  system palette. `automation_run` shifts to error styling on a failed run. */
export function notificationVisual(n: AppNotification): NotificationVisual {
  switch (n.type) {
    case 'workspace_added':
      return { icon: 'group_add', color: 'var(--color-primary)', bg: 'var(--color-surface-tint)' };
    case 'item_invite':
      return { icon: 'person_add', color: 'var(--color-primary)', bg: 'var(--color-surface-tint)' };
    case 'meeting_invite':
      return { icon: 'event', color: 'var(--color-blue-mid-7)', bg: 'var(--color-blue-pale-2)' };
    case 'item_tagged':
      return { icon: 'sell', color: 'var(--color-primary)', bg: 'var(--color-surface-tint)' };
    case 'mention':
      return { icon: 'alternate_email', color: 'var(--color-primary)', bg: 'var(--color-surface-tint)' };
    case 'automation_run': {
      const failed = (n.data as Record<string, unknown>)?.status === 'failed';
      return failed
        ? { icon: 'bolt', color: 'var(--color-error)', bg: 'var(--color-error-bg)' }
        : { icon: 'bolt', color: 'var(--color-warning)', bg: 'var(--color-orange-pale-3)' };
    }
    case 'deadline_overdue':
      return { icon: 'event_busy', color: 'var(--color-error)', bg: 'var(--color-error-bg)' };
    default:
      return { icon: 'notifications', color: 'var(--color-primary)', bg: 'var(--color-surface-tint)' };
  }
}

/** Compact relative timestamp: "just now", "5m", "3h", "2d", "1w", or a date. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
