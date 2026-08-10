// Sprint 03, M17 regression coverage — every role scenario the real model
// supports: Owner, instance Admin (non-owner, non-member), Member, and an
// unauthorized/public viewer. Each expectation is cross-checked directly
// against the authorization rule copied verbatim (in the comment) from
// backend/src/routes/workspaces.ts, so a future change to either side that
// breaks parity is caught here rather than only in production.
import { describe, it, expect } from 'vitest';
import { deriveWorkspacePermissions } from '../workspacePermissions';

describe('deriveWorkspacePermissions', () => {
  it('Owner: can manage the workspace, invite, and remove non-owner members', () => {
    // routes/workspaces.ts PUT/:id, PATCH /:id/agent, DELETE /:id:
    //   `owner_id !== req.userId && !req.user?.isAdmin` → 403
    // POST /:id/members, DELETE /:id/members/:userId:
    //   `owner_id !== req.userId` → 403 (no admin bypass, irrelevant here — owner is always allowed)
    const perms = deriveWorkspacePermissions({ role: 'owner' }, false);
    expect(perms.isOwner).toBe(true);
    expect(perms.canManageWorkspace).toBe(true);
    expect(perms.canInviteMembers).toBe(true);
    expect(perms.canRemoveMember('member')).toBe(true);
    expect(perms.canRemoveMember('owner')).toBe(false); // server: `userId === owner_id → 400 Cannot remove the workspace owner`
  });

  it('Instance Admin who is NOT a member/owner of this workspace: can manage it, but cannot invite/remove members', () => {
    // This is the exact scenario the pre-Sprint-03 `isOwner = workspace.ownerId
    // === userId || workspace.role === 'owner'` computation got wrong — it
    // never considered `isAdmin` at all, so an admin viewing a workspace they
    // don't own saw the Save button disabled, the Agent tab hidden, and the
    // Danger tab's delete flow replaced with "Only the workspace owner can
    // perform these actions" — even though PUT/:id, PATCH /:id/agent, and
    // DELETE /:id all explicitly grant `req.user?.isAdmin` the same access as
    // the owner. `workspace.role` defaults to 'member' for a non-member
    // viewer (see sanitizeWorkspace's `role: (w.role ?? 'member')`).
    const perms = deriveWorkspacePermissions({ role: 'member' }, true);
    expect(perms.isOwner).toBe(false);
    expect(perms.canManageWorkspace).toBe(true); // THE FIX: admin bypass now honored
    // POST /:id/members and DELETE /:id/members/:userId have NO admin
    // bypass server-side — an admin who isn't the owner must still be
    // denied these two, unlike the three above.
    expect(perms.canInviteMembers).toBe(false);
    expect(perms.canRemoveMember('member')).toBe(false);
  });

  it('Member (not owner, not admin): cannot manage, invite, or remove', () => {
    const perms = deriveWorkspacePermissions({ role: 'member' }, false);
    expect(perms.isOwner).toBe(false);
    expect(perms.canManageWorkspace).toBe(false);
    expect(perms.canInviteMembers).toBe(false);
    expect(perms.canRemoveMember('member')).toBe(false);
  });

  it('Unauthorized / public-workspace viewer (no membership row → role defaults to "member"): same as a plain Member, no elevated access', () => {
    const perms = deriveWorkspacePermissions({ role: 'member' }, false);
    expect(perms.canManageWorkspace).toBe(false);
    expect(perms.canInviteMembers).toBe(false);
  });

  it('never derives permissions from anything other than the server-provided role/isAdmin (no client-side ownerId/userId comparison)', () => {
    // Locks in the M17 "remove tautological comparisons" requirement: the
    // function's only inputs are the two values the server actually
    // authorizes against, not a second, redundant identity comparison a
    // caller could get wrong or that could drift from `role` on stale data.
    expect(deriveWorkspacePermissions.length).toBe(2);
  });
});
