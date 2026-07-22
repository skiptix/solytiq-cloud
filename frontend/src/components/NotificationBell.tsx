import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import NotificationItem from './NotificationItem';
import useNotificationsStore from '../store/useNotificationsStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import { notificationTarget } from '../utils/notifications';
import type { AppNotification } from '../api/client';

// ── TopBar notification bell + right slide-in panel ───────────────────────────
// Sits to the left of the profile avatar. The badge shows the unread count and
// updates live via the sync pipeline (App.tsx → store.syncRefresh). Clicking the
// bell opens a panel that slides in from the right and covers ~1/3 of the
// screen (full width on mobile).

interface NotificationBellProps {
  isMobile?: boolean;
  onNavigate: (path: string) => void;
}

export default function NotificationBell({ isMobile, onNavigate }: NotificationBellProps) {
  const unreadCount = useNotificationsStore((s) => s.unreadCount);
  const panelOpen = useNotificationsStore((s) => s.panelOpen);
  const setPanelOpen = useNotificationsStore((s) => s.setPanelOpen);
  const items = useNotificationsStore((s) => s.items);
  const loading = useNotificationsStore((s) => s.loading);
  const hasMore = useNotificationsStore((s) => s.hasMore);
  const loaded = useNotificationsStore((s) => s.loaded);
  const loadMore = useNotificationsStore((s) => s.loadMore);
  const markRead = useNotificationsStore((s) => s.markRead);
  const markAllRead = useNotificationsStore((s) => s.markAllRead);
  const dismiss = useNotificationsStore((s) => s.dismiss);
  const clearAll = useNotificationsStore((s) => s.clearAll);
  const refreshCount = useNotificationsStore((s) => s.refreshCount);

  const setCurrentWorkspace = useWorkspaceStore((s) => s.setCurrentWorkspace);
  const listRef = useRef<HTMLDivElement>(null);

  // Pull the badge count once on mount (live updates then arrive via sync).
  useEffect(() => { void refreshCount(); }, [refreshCount]);

  // Close on Escape while open.
  useEffect(() => {
    if (!panelOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setPanelOpen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [panelOpen, setPanelOpen]);

  const activate = (n: AppNotification) => {
    void markRead(n.id);
    const target = notificationTarget(n);
    if (target.workspaceId && target.workspaceId !== useWorkspaceStore.getState().currentWorkspaceId) {
      setCurrentWorkspace(target.workspaceId);
    }
    setPanelOpen(false);
    onNavigate(target.path);
  };

  const onListScroll = () => {
    const el = listRef.current;
    if (!el || loading || !hasMore) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) void loadMore();
  };

  const badge = unreadCount > 99 ? '99+' : String(unreadCount);

  return (
    <>
      {/* Bell button */}
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setPanelOpen(!panelOpen)}
          title="Notifications"
          data-touch={isMobile ? true : undefined}
          style={{
            width: isMobile ? 40 : 32, height: isMobile ? 40 : 32, borderRadius: isMobile ? 10 : '50%',
            background: panelOpen ? 'var(--color-surface-tint)' : 'transparent',
            border: isMobile ? 'none' : `1px solid ${panelOpen ? 'var(--color-accent-purple-soft)' : 'var(--color-border)'}`,
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 150ms', position: 'relative', flexShrink: 0,
          }}
          onMouseEnter={(e) => { if (!panelOpen && !isMobile) { e.currentTarget.style.background = 'var(--color-surface-tint)'; e.currentTarget.style.borderColor = 'var(--color-accent-purple-soft)'; } }}
          onMouseLeave={(e) => { if (!panelOpen && !isMobile) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'var(--color-border)'; } }}
        >
          <Icon name={unreadCount > 0 ? 'notifications_active' : 'notifications'} size={isMobile ? 20 : 17} color={panelOpen ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
          {unreadCount > 0 && (
            <span style={{
              position: 'absolute', top: isMobile ? 4 : -3, right: isMobile ? 4 : -3,
              minWidth: 16, height: 16, padding: '0 4px', borderRadius: 9999,
              background: 'var(--color-error)', color: 'var(--color-white)',
              fontFamily: 'var(--font-heading)', fontSize: 9.5, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: '2px solid var(--color-page-bg)', lineHeight: 1,
            }}>
              {badge}
            </span>
          )}
        </button>
      </div>

      {/* Slide-in panel */}
      {panelOpen && createPortal(
        <>
          <div
            onClick={() => setPanelOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 1190, background: 'rgba(var(--color-black-rgb), 0.28)', backdropFilter: 'blur(3px)', animation: 'backdropIn 200ms ease both' }}
          />
          <aside
            style={{
              position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 1200,
              width: isMobile ? '100%' : 'clamp(360px, 34vw, 560px)',
              background: 'var(--color-white)',
              boxShadow: '-12px 0 48px rgba(var(--color-black-rgb), 0.16)',
              display: 'flex', flexDirection: 'column',
              animation: 'aiPanelIn 300ms cubic-bezier(0.22,1,0.36,1) both',
            }}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 20px 14px', borderBottom: '1px solid var(--color-surface-tint-2)', flexShrink: 0 }}>
              <div style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="notifications" size={18} color="var(--color-primary)" />
              </div>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)' }}>Notifications</div>
              {unreadCount > 0 && (
                <span style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, color: 'var(--color-white)', background: 'var(--color-primary)', borderRadius: 9999, padding: '2px 8px' }}>{unreadCount}</span>
              )}
              <div style={{ flex: 1 }} />
              <button
                onClick={() => setPanelOpen(false)}
                title="Close"
                style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <Icon name="close" size={18} color="var(--color-text-tertiary)" />
              </button>
            </div>

            {/* Action bar */}
            {items.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', borderBottom: '1px solid var(--color-surface-tint-3)', flexShrink: 0 }}>
                <button
                  onClick={() => void markAllRead()}
                  disabled={unreadCount === 0}
                  style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: unreadCount === 0 ? 'var(--color-text-quaternary)' : 'var(--color-primary)', background: 'transparent', border: 'none', cursor: unreadCount === 0 ? 'default' : 'pointer', padding: '4px 6px', borderRadius: 7 }}
                >
                  <Icon name="done_all" size={15} color={unreadCount === 0 ? 'var(--color-text-quaternary)' : 'var(--color-primary)'} /> Mark all read
                </button>
                <div style={{ flex: 1 }} />
                <button
                  onClick={() => void clearAll()}
                  style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)', background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: 7 }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-error)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-tertiary)'; }}
                >
                  <Icon name="delete_sweep" size={15} color="currentColor" /> Clear all
                </button>
              </div>
            )}

            {/* List */}
            <div ref={listRef} onScroll={onListScroll} style={{ flex: 1, overflowY: 'auto', padding: '8px 12px 20px' }}>
              {items.length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '64px 24px', textAlign: 'center' }}>
                  <div style={{ width: 56, height: 56, borderRadius: 16, background: 'var(--color-surface-tint-3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name={loaded ? 'notifications_off' : 'notifications'} size={26} color="var(--color-text-quaternary)" />
                  </div>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                    {loaded ? "You're all caught up" : 'Loading…'}
                  </div>
                  {loaded && (
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-quaternary)', maxWidth: 240, lineHeight: 1.5 }}>
                      Mentions, invites, tags and reminders will show up here.
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {items.map((n) => (
                    <NotificationItem key={n.id} notification={n} onActivate={activate} onDismiss={(x) => void dismiss(x.id)} />
                  ))}
                  {hasMore && (
                    <button
                      onClick={() => void loadMore()}
                      disabled={loading}
                      style={{ margin: '8px auto 0', fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', background: 'transparent', border: 'none', cursor: loading ? 'default' : 'pointer', padding: '6px 12px' }}
                    >
                      {loading ? 'Loading…' : 'Load more'}
                    </button>
                  )}
                </div>
              )}
            </div>
          </aside>
        </>,
        document.body
      )}
    </>
  );
}
