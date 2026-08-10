// Sprint 03, M17 — "korrekte rollenbasierte Anzeige von Workspace-Einstellungen".
//
// Pure, unit-testable derivation of what the Workspace Settings modal may
// show/enable for the CURRENT viewer, mirroring the real, asymmetric server
// authorization model in backend/src/routes/workspaces.ts exactly (verified
// against that file, not assumed):
//   - PUT /:id            (edit name/description/emoji/visibility/…)
//   - PATCH /:id/agent    (agent mode/policy)
//   - DELETE /:id         (delete workspace)
//       → all three: `owner_id !== req.userId && !req.user?.isAdmin` → 403.
//         i.e. the WORKSPACE OWNER **or an instance admin** may do these.
//   - POST /:id/members   (invite)
//   - DELETE /:id/members/:userId (remove someone else)
//       → `owner_id !== req.userId` only — **no** admin bypass. Only the
//         workspace owner may invite/remove members (a member may always
//         remove themself, which is a separate `isSelf` check, not modeled
//         here since it needs no role derivation).
//
// This app's real per-workspace role model has exactly two values,
// `'owner' | 'member'` (see CLAUDE.md's `workspace_members` table and
// `types.ts`'s `Workspace.role` — there is no third "manager" role).
// Instance admin (`users.is_admin`) is an orthogonal, INSTANCE-wide flag, not
// a workspace role — a non-member, non-owner instance admin is exactly the
// case this module exists to get right, since it's the one the previous
// `isOwner = workspace.ownerId === userId || workspace.role === 'owner'`
// computation silently failed: it never considered `isAdmin` at all, so an
// admin managing a workspace they don't personally own saw every
// owner-gated control (Save, the Agent tab, Delete workspace) as disabled or
// hidden — even though the server would have accepted every one of those
// requests. That was a real, confirmed display bug (not a security one: the
// server-side check was and remains correct and authoritative either way).
import type { Workspace } from '../types';

export interface WorkspaceViewerPermissions {
  /** True workspace ownership per the server-computed per-viewer `role` —
   *  used only for the two member-management actions the server keeps
   *  strictly owner-only (no admin bypass). Never use this alone to gate
   *  edit/delete/agent controls — see `canManageWorkspace`. */
  isOwner: boolean;
  /** Can edit workspace settings, delete the workspace, and configure its
   *  AI agent — mirrors `owner_id !== req.userId && !req.user?.isAdmin`
   *  on PUT/:id, PATCH /:id/agent, and DELETE /:id. */
  canManageWorkspace: boolean;
  /** Can invite a new member — mirrors POST /:id/members's owner-only
   *  (no admin bypass) check. */
  canInviteMembers: boolean;
  /** Can remove the given OTHER member — mirrors DELETE
   *  /:id/members/:userId's owner-only (no admin bypass) check. The
   *  workspace owner can never be removed (matches the server's own
   *  `userId === owner_id → 400` guard), and self-removal is a separate,
   *  always-available action this function deliberately does not model. */
  canRemoveMember: (memberRole: 'owner' | 'member') => boolean;
}

export function deriveWorkspacePermissions(
  workspace: Pick<Workspace, 'role'>,
  isAdmin: boolean,
): WorkspaceViewerPermissions {
  // `workspace.role` is the server-computed, per-viewer role (see
  // routes/workspaces.ts's `LEFT JOIN workspace_members ... AND wm.user_id =
  // $currentUser`, defaulted to 'member' when the viewer has no membership
  // row — e.g. viewing a public workspace they haven't joined). It is the
  // single authoritative signal for "is the CURRENT viewer the owner" — no
  // second, redundant `workspace.ownerId === userId` comparison is needed
  // (the two can never legitimately disagree; keeping only one avoids a
  // client-side derivation that duplicates, rather than reads, server state).
  const isOwner = workspace.role === 'owner';
  const canManageWorkspace = isOwner || isAdmin;

  return {
    isOwner,
    canManageWorkspace,
    canInviteMembers: isOwner,
    canRemoveMember: (memberRole) => isOwner && memberRole !== 'owner',
  };
}
