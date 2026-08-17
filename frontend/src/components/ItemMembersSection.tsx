import { useState, useEffect, useCallback, useRef } from 'react';
import Icon from './Icon';
import MemberAvatar from './MemberAvatar';
import AnchoredDropdown from './AnchoredDropdown';
import MotionButton from './animate-ui/MotionButton';
import useAuthStore from '../store/useAuthStore';
import useMembersStore from '../store/useMembersStore';
import {
  apiGetItemMembers, apiAddItemMember, apiRemoveItemMember, apiGetMembersBasic,
  type SharedItemType, type ItemMember,
} from '../api/client';

// ── "Invite people" section for a folder / list / timeline / markdown page ────
// Mirrors the workspace members UI, but scoped to one item. Only the owner (or
// admin) sees the invite/remove affordances; everyone who can view the item sees
// the member list. Invited users become full collaborators and get a notification.
//
// A member can also reach this item through a CONTAINER that was shared with
// them — the folder it sits in, an ancestor board, or the markdown page it
// mirrors — in which case the server reports them with `via: 'inherited'`.
// Those rows render with the container's name and no Remove button: the grant
// lives on the container, so a Remove here would delete nothing while looking
// like it worked. Revoking is done where the invitation was made.

interface BasicUser { id: string; username: string; fullName: string | null; hasImage: boolean }

const VIA_ICON: Record<SharedItemType, string> = {
  folder: 'folder', list: 'format_list_bulleted', timeline: 'timeline', markdownList: 'notes',
};

interface ItemMembersSectionProps {
  itemType: SharedItemType;
  itemId: string;
  /** Whether the current user may invite/remove (owner or admin). */
  canManage: boolean;
  /** Optional: notified after any membership change so a parent can refresh. */
  onChanged?: () => void;
}

function nameOf(m: { fullName?: string | null; username?: string | null } | undefined, fallback = 'User') {
  return m?.fullName || m?.username || fallback;
}

export default function ItemMembersSection({ itemType, itemId, canManage, onChanged }: ItemMembersSectionProps) {
  const currentUserId = useAuthStore(s => s.userId);
  const membersStore = useMembersStore(s => s.members);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [members, setMembers] = useState<ItemMember[]>([]);
  const [allUsers, setAllUsers] = useState<BasicUser[]>([]);
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showSuggest, setShowSuggest] = useState(false);
  // Folder invites only: does a new invitee also get everything inside the
  // folder? Defaults to yes — handing over the contents is the point of sharing
  // a folder, and the alternative is the deliberate, opt-in narrower case.
  const [includeAll, setIncludeAll] = useState(true);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRowRef = useRef<HTMLDivElement>(null);
  const suggestRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    apiGetItemMembers(itemType, itemId)
      .then(r => { if (alive) { setOwnerId(r.ownerId); setMembers(r.members); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [itemType, itemId]);

  useEffect(() => {
    if (!canManage || allUsers.length > 0) return;
    apiGetMembersBasic().then(r => setAllUsers(r.members)).catch(() => {});
  }, [canManage, allUsers.length]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // The suggestion list is portaled to document.body, so it is NOT inside
      // wrapRef — without the second test, clicking a suggestion would count as
      // a click outside and close the list before the pick registered.
      if (wrapRef.current?.contains(target) || suggestRef.current?.contains(target)) return;
      setShowSuggest(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const memberIds = new Set(members.map(m => m.userId));
  const suggestions = allUsers.filter(u =>
    u.id !== ownerId && !memberIds.has(u.id) &&
    (invite.trim() === '' || nameOf(u).toLowerCase().includes(invite.toLowerCase()) || u.username.toLowerCase().includes(invite.toLowerCase()))
  ).slice(0, 6);

  const doInvite = useCallback(async (username: string, scope = includeAll) => {
    if (!username.trim()) return;
    setBusy(true); setError('');
    try {
      const r = await apiAddItemMember(itemType, itemId, username.trim(), scope);
      setMembers(r.members);
      setInvite('');
      setShowSuggest(false);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error && /not found/i.test(e.message) ? 'No user with that username.' : 'Could not invite that user.');
    } finally { setBusy(false); }
  }, [itemType, itemId, onChanged, includeAll]);

  /** Flip an existing folder member between "everything inside" and
   *  "folder only" — re-sending the invite with the other scope updates it. */
  const doSetScope = async (m: ItemMember, scope: boolean) => {
    setBusy(true);
    try {
      const r = await apiAddItemMember(itemType, itemId, m.username, scope);
      setMembers(r.members);
      onChanged?.();
    } catch { /* silent */ } finally { setBusy(false); }
  };

  const doRemove = async (userId: string) => {
    setBusy(true);
    try {
      const r = await apiRemoveItemMember(itemType, itemId, userId);
      setMembers(r.members);
      onChanged?.();
    } catch { /* silent */ } finally { setBusy(false); }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Icon name="group_add" size={16} color="var(--color-primary)" />
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)' }}>People with access</span>
      </div>

      {/* Owner + members */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: canManage ? 12 : 0 }}>
        {ownerId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 10, background: 'var(--color-surface-tint-3)', border: '1px solid var(--color-purple-pale-23)' }}>
            <MemberAvatar userId={ownerId} size={26} />
            <span style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {ownerId === currentUserId ? 'You' : nameOf(membersStore[ownerId])}
            </span>
            <span style={{ fontFamily: 'var(--font-heading)', fontSize: 9.5, fontWeight: 700, color: 'var(--color-primary)', textTransform: 'uppercase', letterSpacing: '0.04em', background: 'var(--color-surface-tint)', borderRadius: 9999, padding: '2px 8px' }}>Owner</span>
          </div>
        )}
        {members.map(m => (
          <div key={m.userId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 10, background: 'var(--color-surface-tint-3)', border: '1px solid var(--color-purple-pale-23)' }}>
            <MemberAvatar userId={m.userId} size={26} fallbackName={nameOf(m)} />
            <span style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(m)}</span>
            {m.via === 'inherited' ? (
              <span
                title={`Invited to ${m.viaName ? `“${m.viaName}”` : 'a parent item'} — remove them there`}
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-heading)', fontSize: 9.5, fontWeight: 700, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em', background: 'var(--color-surface-gray)', borderRadius: 9999, padding: '2px 8px', flexShrink: 0, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                <Icon name={VIA_ICON[m.viaType ?? 'folder']} size={11} color="var(--color-text-tertiary)" />
                {m.viaName ?? 'Inherited'}
              </span>
            ) : (
              <>
                {/* Folder members carry a scope; clicking flips it, so a choice
                    made at invite time is never a one-way door. */}
                {itemType === 'folder' && (
                  <button
                    onClick={canManage ? () => void doSetScope(m, !m.includeAll) : undefined}
                    disabled={busy || !canManage}
                    title={canManage
                      ? (m.includeAll ? 'Has the folder and everything in it — click for folder only' : 'Has the folder only — click to include everything in it')
                      : (m.includeAll ? 'Has the folder and everything in it' : 'Has the folder only')}
                    style={{ display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-heading)', fontSize: 9.5, fontWeight: 700, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em', background: 'var(--color-surface-gray)', border: 'none', borderRadius: 9999, padding: '3px 8px', flexShrink: 0, cursor: canManage && !busy ? 'pointer' : 'default' }}
                  >
                    <Icon name={m.includeAll ? 'folder_open' : 'folder'} size={11} color="var(--color-text-tertiary)" />
                    {m.includeAll ? 'All items' : 'Folder only'}
                  </button>
                )}
                {(canManage || m.userId === currentUserId) && (
              <button
                onClick={() => void doRemove(m.userId)}
                disabled={busy}
                title={m.userId === currentUserId ? 'Leave' : 'Remove'}
                style={{ width: 26, height: 26, borderRadius: 7, border: 'none', background: 'transparent', cursor: busy ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-error-bg)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                <Icon name="close" size={14} color="var(--color-error)" />
              </button>
                )}
              </>
            )}
          </div>
        ))}
        {members.length === 0 && !canManage && (
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-quaternary)', padding: '4px 2px' }}>No one else has been invited.</div>
        )}
      </div>

      {/* What a new invitee gets (folders only) — the folder's contents, or the
          folder alone. Mirrors the public share link's own "What to share"
          choice in ItemSettingsModal, so both sharing mechanisms read the same. */}
      {canManage && itemType === 'folder' && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
            What they get
          </div>
          <div style={{ display: 'flex', gap: 4, background: 'var(--color-surface-tint)', borderRadius: 10, padding: 4 }}>
            {([
              { label: 'Folder + all items', icon: 'folder_open', val: true },
              { label: 'Folder only', icon: 'folder', val: false },
            ] as const).map(opt => {
              const selected = includeAll === opt.val;
              return (
                <MotionButton key={opt.label}
                  onClick={() => setIncludeAll(opt.val)}
                  animate={{ background: selected ? 'var(--color-primary)' : 'transparent', color: selected ? 'var(--color-white)' : 'var(--color-primary)' }}
                  transition={{ duration: 0.12 }}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, padding: '8px 8px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: selected ? 600 : 500 }}>
                  <Icon name={opt.icon} size={14} color={selected ? 'var(--color-white)' : 'var(--color-primary)'} />
                  {opt.label}
                </MotionButton>
              );
            })}
          </div>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 6, lineHeight: 1.4, paddingLeft: 2 }}>
            {includeAll
              ? 'Every board, timeline and page in this folder — including ones you add later — becomes editable for the people you invite.'
              : 'They see the folder itself. Boards, timelines and pages inside stay private unless you share them individually.'}
          </div>
        </div>
      )}

      {/* Invite input (owner/admin only) */}
      {canManage && (
        <div ref={wrapRef} style={{ position: 'relative' }}>
          <div ref={inputRowRef} style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 9, padding: '8px 11px' }}>
              <Icon name="person_add" size={15} color="var(--color-text-quaternary)" />
              <input
                value={invite}
                onChange={e => { setInvite(e.target.value); setShowSuggest(true); setError(''); }}
                onFocus={() => setShowSuggest(true)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void doInvite(suggestions[0]?.username ?? invite); } }}
                placeholder="Invite by name or username…"
                style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)' }}
              />
            </div>
            <button
              onClick={() => void doInvite(suggestions[0]?.username ?? invite)}
              disabled={busy || !invite.trim()}
              style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: busy || !invite.trim() ? 'var(--color-border-strong)' : 'var(--color-primary)', border: 'none', borderRadius: 9, padding: '0 16px', cursor: busy || !invite.trim() ? 'default' : 'pointer' }}
            >
              Invite
            </button>
          </div>
          {error && <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-error)', marginTop: 6 }}>{error}</div>}

          {/* Portaled, not absolutely positioned: this modal's body scrolls and
              its card is transformed, either of which would hide the list.
              See AnchoredDropdown's header. */}
          <AnchoredDropdown anchorRef={inputRowRef} open={showSuggest && suggestions.length > 0} panelRef={suggestRef}>
              {suggestions.map(u => (
                <button
                  key={u.id}
                  onMouseDown={e => { e.preventDefault(); void doInvite(u.username); }}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '6px 8px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint-3)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <MemberAvatar userId={u.id} size={24} fallbackName={nameOf(u)} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(u)}</div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)' }}>@{u.username}</div>
                  </div>
                </button>
              ))}
          </AnchoredDropdown>
        </div>
      )}
    </div>
  );
}
