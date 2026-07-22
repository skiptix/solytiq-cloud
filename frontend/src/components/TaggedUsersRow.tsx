import { useState, useEffect, useRef, useCallback } from 'react';
import Icon from './Icon';
import MemberAvatar from './MemberAvatar';
import useMembersStore from '../store/useMembersStore';
import { apiGetTaskTags, apiAddTaskTag, apiRemoveTaskTag, apiGetWorkspaceMembers, type TaskTag } from '../api/client';
import type { WorkspaceMember } from '../types';

// ── Item "Tag" row ────────────────────────────────────────────────────────────
// Replaces the old badge chips AND the Owner row in the item dialog. Shows the
// item creator (implicit, non-removable "Owner" chip) plus any tagged users, and
// — for the item owner — an add control that tags another workspace member. A
// tagged member always gets a notification (handled server-side). Members-only:
// only users already in the item's workspace can be tagged.

interface TaggedUsersRowProps {
  taskId: number;
  workspaceId?: string | null;
  creatorId?: string;
  /** Only the item owner (or admin) may add/remove tags. */
  canEdit: boolean;
  /** Preloaded workspace members (from the parent) — avoids a second fetch. */
  members?: WorkspaceMember[];
}

function nameOf(m: { fullName?: string | null; username?: string | null } | undefined, fallback = 'User'): string {
  return m?.fullName || m?.username || fallback;
}

export default function TaggedUsersRow({ taskId, workspaceId, creatorId, canEdit, members: membersProp }: TaggedUsersRowProps) {
  const [tags, setTags] = useState<TaskTag[]>([]);
  const [fetchedMembers, setFetchedMembers] = useState<WorkspaceMember[]>([]);
  const members = membersProp && membersProp.length > 0 ? membersProp : fetchedMembers;
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const membersStore = useMembersStore((s) => s.members);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    apiGetTaskTags(taskId).then((r) => { if (alive) setTags(r.tags); }).catch(() => {});
    return () => { alive = false; };
  }, [taskId]);

  const loadMembers = useCallback(() => {
    if (!workspaceId || membersProp?.length || fetchedMembers.length > 0) return;
    apiGetWorkspaceMembers(workspaceId).then((r) => setFetchedMembers(r.members)).catch(() => {});
  }, [workspaceId, membersProp, fetchedMembers.length]);

  // Close the add popover on outside click.
  useEffect(() => {
    if (!adding) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) { setAdding(false); setSearch(''); }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [adding]);

  const taggedIds = new Set(tags.map((t) => t.userId));
  const addable = members.filter((m) =>
    m.userId !== creatorId &&
    !taggedIds.has(m.userId) &&
    nameOf(m).toLowerCase().includes(search.toLowerCase())
  );

  const handleAdd = async (userId: string) => {
    setBusy(true);
    try {
      const r = await apiAddTaskTag(taskId, userId);
      setTags(r.tags);
      setSearch('');
    } catch { /* silent */ } finally { setBusy(false); }
  };

  const handleRemove = async (userId: string) => {
    setBusy(true);
    try {
      const r = await apiRemoveTaskTag(taskId, userId);
      setTags(r.tags);
    } catch { /* silent */ } finally { setBusy(false); }
  };

  const chip = (userId: string, label: string, opts: { owner?: boolean; removable?: boolean }) => (
    <div key={userId} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px 3px 4px', borderRadius: 9999,
      background: opts.owner ? 'var(--color-surface-tint)' : 'var(--color-surface-tint-3)',
      border: `1px solid ${opts.owner ? 'var(--color-accent-purple-soft-alt)' : 'var(--color-purple-pale-23)'}`,
    }}>
      <MemberAvatar userId={userId} size={20} fallbackName={label} />
      <span style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, fontWeight: 500, color: 'var(--color-text-secondary)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {opts.owner && (
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 8.5, fontWeight: 700, color: 'var(--color-primary)', textTransform: 'uppercase', letterSpacing: '0.04em', background: 'var(--color-white)', borderRadius: 9999, padding: '1px 5px' }}>Owner</span>
      )}
      {opts.removable && (
        <button
          onClick={() => void handleRemove(userId)}
          disabled={busy}
          title="Remove tag"
          style={{ display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', cursor: busy ? 'default' : 'pointer', padding: 1, borderRadius: 9999 }}
        >
          <Icon name="close" size={12} color="var(--color-text-quaternary)" />
        </button>
      )}
    </div>
  );

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {/* Owner (creator) chip — always present, non-removable */}
      {creatorId && chip(creatorId, nameOf(membersStore[creatorId], 'Owner'), { owner: true })}

      {/* Tagged users */}
      {tags.filter((t) => t.userId !== creatorId).map((t) =>
        chip(t.userId, nameOf(t), { removable: canEdit })
      )}

      {/* Add control */}
      {canEdit && (
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => { setAdding((v) => !v); loadMembers(); }}
            title="Tag a workspace member"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 9999,
              border: '1px dashed var(--color-purple-pale-44)', background: adding ? 'var(--color-surface-tint)' : 'transparent',
              cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', transition: 'all 120ms',
            }}
            onMouseEnter={(e) => { if (!adding) e.currentTarget.style.background = 'var(--color-surface-tint-3)'; }}
            onMouseLeave={(e) => { if (!adding) e.currentTarget.style.background = 'transparent'; }}
          >
            <Icon name="add" size={13} color="var(--color-primary)" /> Tag
          </button>

          {adding && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 60, width: Math.min(240, window.innerWidth - 32),
              background: 'var(--color-white)', border: '1px solid var(--color-border)', borderRadius: 12,
              boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.16)', padding: 8, animation: 'menuIn 140ms ease both',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '6px 9px', marginBottom: 6 }}>
                <Icon name="search" size={14} color="var(--color-text-quaternary)" />
                <input
                  autoFocus value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search members…"
                  style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-primary)' }}
                />
              </div>
              <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                {!workspaceId ? (
                  <div style={{ padding: '12px 8px', textAlign: 'center', fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>Only items in a shared workspace can be tagged.</div>
                ) : addable.length === 0 ? (
                  <div style={{ padding: '12px 8px', textAlign: 'center', fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>{search ? 'No matching members' : 'No one else to tag'}</div>
                ) : (
                  addable.map((m) => (
                    <button
                      key={m.userId}
                      onClick={() => void handleAdd(m.userId)}
                      disabled={busy}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '6px 8px', borderRadius: 8, border: 'none', background: 'transparent', cursor: busy ? 'default' : 'pointer', textAlign: 'left' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-tint-3)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <MemberAvatar userId={m.userId} size={24} fallbackName={nameOf(m)} />
                      <span style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(m)}</span>
                      <Icon name="add" size={15} color="var(--color-border-strong)" />
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
