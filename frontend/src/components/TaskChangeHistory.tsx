import { useEffect, useRef, useState } from 'react';
import type { Task, TaskChangeLogEntry } from '../types';
import { apiGetTaskChangelog } from '../api/client';
import Icon from './Icon';
import CreatorBubble from './CreatorBubble';

interface TaskChangeHistoryProps {
  task: Task;
  listId: string;
  /** Whether the panel/section is currently expanded — drives the lazy fetch
   *  (once) and the open/close animation. The component stays mounted either
   *  way so already-loaded entries survive a collapse/re-open. */
  open: boolean;
  /** 'panel' = desktop side panel (fills parent height, scrolls internally).
   *  'inline' = mobile accordion section (animates its own height). */
  variant: 'panel' | 'inline';
}

const FIELD_META: Record<TaskChangeLogEntry['field'], { label: string; icon: string }> = {
  title:    { label: 'Title',    icon: 'edit' },
  note:     { label: 'Note',     icon: 'description' },
  deadline: { label: 'Deadline', icon: 'calendar_today' },
  priority: { label: 'Priority', icon: 'priority_high' },
  badge:    { label: 'Badge',    icon: 'label' },
  section:  { label: 'Section',  icon: 'view_column' },
};

function formatFieldValue(field: TaskChangeLogEntry['field'], value: string | null): string {
  if (!value) return field === 'deadline' ? 'no deadline' : 'none';
  if (field === 'deadline') {
    const [y, m, d] = value.slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return value;
}

function friendlyTime(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function exactTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  return `${hh}:${mi} - ${dd}.${mo}.${d.getFullYear()}`;
}

/** Fallback badge for an automation-attributed change — automations aren't
 *  real users, so there's no profile image / CreatorBubble to show. */
function AutomationBadge() {
  return (
    <div style={{
      width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
      background: 'linear-gradient(135deg, var(--color-accent-purple-light) 0%, var(--color-primary) 100%)',
      border: '1.5px solid var(--color-white)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <Icon name="bolt" size={12} color="var(--color-white)" />
    </div>
  );
}

/** Fallback badge when an entry's actor can't be resolved to a known user. */
function UnknownBadge() {
  return (
    <div style={{
      width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
      background: 'var(--color-surface-tint)', border: '1.5px solid var(--color-white)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <Icon name="person" size={12} color="var(--color-text-quaternary)" />
    </div>
  );
}

function ActorBadge({ actorType, actorId }: { actorType: 'user' | 'automation'; actorId: string | null }) {
  if (actorType === 'automation') return <AutomationBadge />;
  if (actorId) return <CreatorBubble creatorId={actorId} taskHovered />;
  return <UnknownBadge />;
}

type HistoryItem =
  | { kind: 'change'; key: string; entry: TaskChangeLogEntry }
  | { kind: 'created'; key: string; at: string; creatorId?: string };

export default function TaskChangeHistory({ task, listId, open, variant }: TaskChangeHistoryProps) {
  const [entries, setEntries] = useState<TaskChangeLogEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!open || fetchedRef.current) return;
    fetchedRef.current = true;
    setLoading(true);
    apiGetTaskChangelog(listId, task.id)
      .then(res => setEntries(res.entries))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [open, listId, task.id]);

  const items: HistoryItem[] = [
    ...(entries ?? []).map(e => ({ kind: 'change' as const, key: `c_${e.id}`, entry: e })),
    { kind: 'created' as const, key: 'created', at: task.createdAt ?? '', creatorId: task.creatorId },
  ];

  const isPanel = variant === 'panel';

  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', height: isPanel ? '100%' : undefined, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: isPanel ? '16px 18px 12px' : '2px 0 12px', flexShrink: 0 }}>
        <Icon name="manage_history" size={15} color="var(--color-primary)" />
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)' }}>Change history</span>
      </div>

      <div style={{ flex: isPanel ? 1 : undefined, minHeight: 0, overflowY: isPanel ? 'auto' : undefined, padding: isPanel ? '0 18px 18px' : '0 0 6px' }}>
        {loading && entries === null ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}>
            <div style={{ width: 18, height: 18, border: '2px solid var(--color-border)', borderTopColor: 'var(--color-primary)', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
          </div>
        ) : (
          items.map((item, i) => {
            const isLast = i === items.length - 1;
            return (
              <div key={item.key} style={{ display: 'flex', gap: 10 }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                  {item.kind === 'change'
                    ? <ActorBadge actorType={item.entry.actorType} actorId={item.entry.actorId} />
                    : (item.creatorId ? <CreatorBubble creatorId={item.creatorId} taskHovered /> : <UnknownBadge />)}
                  {!isLast && <div style={{ width: 2, flex: 1, minHeight: 16, background: 'var(--color-purple-pale-23)', marginTop: 4 }} />}
                </div>
                <div style={{ flex: 1, minWidth: 0, paddingBottom: 18 }}>
                  {item.kind === 'change' ? (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 700, color: 'var(--color-text-primary)' }}>
                        <Icon name={FIELD_META[item.entry.field].icon} size={11} color="var(--color-purple-tint-11)" />
                        {FIELD_META[item.entry.field].label} changed
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, fontFamily: 'var(--font-body)', fontSize: 12, flexWrap: 'wrap' }}>
                        <span style={{ color: 'var(--color-text-tertiary)', textDecoration: 'line-through' }}>{formatFieldValue(item.entry.field, item.entry.oldValue)}</span>
                        <Icon name="arrow_forward" size={11} color="var(--color-text-quaternary)" />
                        <span style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{formatFieldValue(item.entry.field, item.entry.newValue)}</span>
                      </div>
                      <div style={{ marginTop: 3, fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-text-quaternary)' }} title={exactTime(item.entry.changedAt)}>
                        {item.entry.actorType === 'automation' ? `Automation: ${item.entry.actorName ?? 'Unknown'}` : (item.entry.actorName ?? 'Someone')} · {friendlyTime(item.entry.changedAt)}
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 700, color: 'var(--color-text-primary)' }}>
                        <Icon name="add_circle" size={11} color="var(--color-purple-tint-11)" />
                        Created
                      </div>
                      {item.at && (
                        <div style={{ marginTop: 3, fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-text-quaternary)' }} title={exactTime(item.at)}>
                          {friendlyTime(item.at)}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  if (isPanel) return body;

  // Mobile: animate this section's own height via the CSS-grid 0fr/1fr trick
  // (the target height is content-dependent, so a plain `height` transition
  // can't target it) rather than the fixed-pixel width transition the
  // desktop panel uses.
  return (
    <div style={{ display: 'grid', gridTemplateRows: open ? '1fr' : '0fr', transition: 'grid-template-rows 320ms cubic-bezier(0.4,0,0.2,1)' }}>
      <div style={{ overflow: 'hidden' }}>
        <div style={{ borderTop: '1px solid var(--color-purple-pale-23)', marginTop: 4, paddingTop: 8 }}>
          {body}
        </div>
      </div>
    </div>
  );
}
