import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import MemberAvatar from './MemberAvatar';
import AnchoredDropdown from './AnchoredDropdown';
import ModalIn from './animate-ui/ModalIn';
import useMembersStore from '../store/useMembersStore';
import useSharedItemsStore from '../store/useSharedItemsStore';
import {
  apiGetTaskTags, apiAddTaskTag, apiRemoveTaskTag, apiGetItemMembers,
  apiAddItemMember, apiAddWorkspaceMember, apiGetMembersBasic,
  type TaskTag,
} from '../api/client';
import type { WorkspaceMember } from '../types';
import MotionButton from './animate-ui/MotionButton';

// ── Item "Tag" row ────────────────────────────────────────────────────────────
// Replaces the old badge chips AND the Owner row. Shows the item creator (the
// non-removable "Owner" chip) plus any tagged users, and lets the owner tag
// anyone on the instance. Tagging notifies the tagged user; if that user can't
// yet see the item, a prompt offers to share JUST this item (a per-item invite)
// or add them to the whole workspace.

interface BasicUser { id: string; username: string; fullName: string | null; hasImage: boolean }

interface TaggedUsersRowProps {
  taskId: number;
  workspaceId?: string | null;
  /** The task's parent list (list tasks only) — the item shared by "just this item". */
  listId?: string | null;
  creatorId?: string;
  /** Only the item owner (or admin) may add/remove tags. */
  canEdit: boolean;
  /** Preloaded workspace members (from the parent) — avoids a second fetch. */
  members?: WorkspaceMember[];
}

function nameOf(m: { fullName?: string | null; username?: string | null } | undefined, fallback = 'User'): string {
  return m?.fullName || m?.username || fallback;
}

export default function TaggedUsersRow({ taskId, workspaceId, listId, creatorId, canEdit, members: membersProp }: TaggedUsersRowProps) {
  const [tags, setTags] = useState<TaskTag[]>([]);
  const [allUsers, setAllUsers] = useState<BasicUser[]>([]);
  const [invitedIds, setInvitedIds] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [prompt, setPrompt] = useState<BasicUser | null>(null);
  const membersStore = useMembersStore((s) => s.members);
  const refreshShared = useSharedItemsStore((s) => s.load);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tagBtnRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const workspaceMemberIds = new Set((membersProp ?? []).map((m) => m.userId));

  useEffect(() => {
    let alive = true;
    apiGetTaskTags(taskId).then((r) => { if (alive) setTags(r.tags); }).catch(() => {});
    return () => { alive = false; };
  }, [taskId]);

  // Who already has direct access to this specific item (so we don't re-prompt).
  useEffect(() => {
    if (!canEdit || !listId) return;
    let alive = true;
    apiGetItemMembers('list', listId).then((r) => { if (alive) setInvitedIds(new Set(r.members.map((m) => m.userId))); }).catch(() => {});
    return () => { alive = false; };
  }, [canEdit, listId]);

  const loadUsers = useCallback(() => {
    if (!canEdit || allUsers.length > 0) return;
    apiGetMembersBasic().then((r) => setAllUsers(r.members)).catch(() => {});
  }, [canEdit, allUsers.length]);

  useEffect(() => {
    if (!adding) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // The picker is portaled to document.body, so it is NOT inside wrapRef —
      // without the second test, clicking a person would read as a click
      // outside and close the picker before the pick registered.
      if (wrapRef.current?.contains(target) || pickerRef.current?.contains(target)) return;
      setAdding(false); setSearch('');
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [adding]);

  const taggedIds = new Set(tags.map((t) => t.userId));
  const addable = allUsers.filter((u) =>
    u.id !== creatorId && !taggedIds.has(u.id) &&
    (nameOf(u).toLowerCase().includes(search.toLowerCase()) || u.username.toLowerCase().includes(search.toLowerCase()))
  ).slice(0, 8);

  /** True if this user can already see the item (so we can tag without sharing). */
  const canAlreadyView = (userId: string) => workspaceMemberIds.has(userId) || invitedIds.has(userId);

  const tagUser = async (userId: string) => {
    const r = await apiAddTaskTag(taskId, userId);
    setTags(r.tags);
  };

  const handlePick = async (u: BasicUser) => {
    // Already has access → tag straight away.
    if (canAlreadyView(u.id)) {
      setBusy(true);
      try { await tagUser(u.id); setSearch(''); } catch { /* silent */ } finally { setBusy(false); }
      return;
    }
    // Needs access → ask how to share.
    setPrompt(u);
    setAdding(false);
  };

  const shareAndTag = async (mode: 'item' | 'workspace') => {
    if (!prompt) return;
    setBusy(true);
    try {
      if (mode === 'item') {
        if (listId) await apiAddItemMember('list', listId, prompt.username);
      } else {
        if (workspaceId) await apiAddWorkspaceMember(workspaceId, prompt.username).catch(() => {});
        // Guarantee they can see THIS item even if the list is private.
        if (listId) await apiAddItemMember('list', listId, prompt.username);
      }
      setInvitedIds((prev) => new Set(prev).add(prompt.id));
      await tagUser(prompt.id);
      setPrompt(null);
      setSearch('');
      void refreshShared();
    } catch { /* silent */ } finally { setBusy(false); }
  };

  const handleRemove = async (userId: string) => {
    setBusy(true);
    try { const r = await apiRemoveTaskTag(taskId, userId); setTags(r.tags); } catch { /* silent */ } finally { setBusy(false); }
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
        <button onClick={() => void handleRemove(userId)} disabled={busy} title="Remove tag"
          style={{ display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', cursor: busy ? 'default' : 'pointer', padding: 1, borderRadius: 9999 }}>
          <Icon name="close" size={12} color="var(--color-text-quaternary)" />
        </button>
      )}
    </div>
  );

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {creatorId && chip(creatorId, nameOf(membersStore[creatorId], 'Owner'), { owner: true })}
      {tags.filter((t) => t.userId !== creatorId).map((t) => chip(t.userId, nameOf(t), { removable: canEdit }))}

      {canEdit && (
        <div style={{ position: 'relative' }}>
          <MotionButton
            ref={tagBtnRef}
            onClick={() => { setAdding((v) => !v); loadUsers(); }}
            title="Tag a person"
            transition={{ duration: 0.12 }} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 9999, border: '1px dashed var(--color-purple-pale-44)', background: adding ? 'var(--color-surface-tint)' : 'transparent', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', }}
            onMouseEnter={(e) => { if (!adding) e.currentTarget.style.background = 'var(--color-surface-tint-3)'; }}
            onMouseLeave={(e) => { if (!adding) e.currentTarget.style.background = 'transparent'; }}>
            <Icon name="add" size={13} color="var(--color-primary)" /> Tag
          </MotionButton>

          {/* Portaled, not absolutely positioned: TaskDialog's card has
              `overflow: hidden` AND a transform, either of which would hide
              this list. See AnchoredDropdown's header. */}
          <AnchoredDropdown anchorRef={tagBtnRef} open={adding} panelRef={pickerRef} width={260} maxHeight={300}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '6px 9px', marginBottom: 6 }}>
                <Icon name="search" size={14} color="var(--color-text-quaternary)" />
                <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people…"
                  style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-primary)' }} />
              </div>
              <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                {addable.length === 0 ? (
                  <div style={{ padding: '12px 8px', textAlign: 'center', fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>{search ? 'No matching people' : 'No one to tag'}</div>
                ) : addable.map((u) => (
                  <button key={u.id} onClick={() => void handlePick(u)} disabled={busy}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '6px 8px', borderRadius: 8, border: 'none', background: 'transparent', cursor: busy ? 'default' : 'pointer', textAlign: 'left' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-tint-3)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                    <MemberAvatar userId={u.id} size={24} fallbackName={nameOf(u)} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(u)}</div>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)' }}>@{u.username}{!canAlreadyView(u.id) && <span style={{ color: 'var(--color-warning)' }}> · needs access</span>}</div>
                    </div>
                    <Icon name="add" size={15} color="var(--color-border-strong)" />
                  </button>
                ))}
              </div>
          </AnchoredDropdown>
        </div>
      )}

      {/* Share-access prompt for a user who can't yet see the item */}
      {prompt && createPortal(
        <div onClick={() => { if (!busy) setPrompt(null); }}
          style={{ position: 'fixed', inset: 0, zIndex: 1600, background: 'rgba(var(--color-black-rgb), 0.32)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}>
          <ModalIn onClick={(e) => e.stopPropagation()} duration={240}
            style={{ width: '100%', maxWidth: 400, background: 'var(--color-white)', borderRadius: 18, boxShadow: '0 24px 60px rgba(var(--color-black-rgb), 0.22)', padding: 22 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 8 }}>
              <MemberAvatar userId={prompt.id} size={38} fallbackName={nameOf(prompt)} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)' }}>Share with {nameOf(prompt)}?</div>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>They can't see this item yet.</div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
              {listId && (
                <button onClick={() => void shareAndTag('item')} disabled={busy}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderRadius: 11, border: '1.5px solid var(--color-purple-pale-38)', background: 'var(--color-surface-tint-3)', cursor: busy ? 'default' : 'pointer', textAlign: 'left' }}>
                  <Icon name="description" size={18} color="var(--color-primary)" />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)' }}>Share just this item</div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>They get access to this list only.</div>
                  </div>
                </button>
              )}
              {workspaceId && (
                <button onClick={() => void shareAndTag('workspace')} disabled={busy}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderRadius: 11, border: '1.5px solid var(--color-purple-pale-38)', background: 'var(--color-surface-tint-3)', cursor: busy ? 'default' : 'pointer', textAlign: 'left' }}>
                  <Icon name="workspaces" size={18} color="var(--color-primary)" />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)' }}>Add to the whole workspace</div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>They join the workspace and see this item.</div>
                  </div>
                </button>
              )}
              <button onClick={() => setPrompt(null)} disabled={busy}
                style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: '1px solid var(--color-border-alt)', borderRadius: 9, padding: '9px 0', cursor: 'pointer', marginTop: 2 }}>
                Cancel
              </button>
            </div>
          </ModalIn>
        </div>,
        document.body
      )}
    </div>
  );
}
