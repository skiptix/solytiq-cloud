import type { Response } from 'express';

const clients = new Map<string, Set<Response>>();

export function addSseClient(userId: string, res: Response): void {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId)!.add(res);
}

export function removeSseClient(userId: string, res: Response): void {
  clients.get(userId)?.delete(res);
  if (clients.get(userId)?.size === 0) clients.delete(userId);
}

// A compact realtime frame carrying the sync cursor + the entities that changed.
// The frontend treats it as a *nudge*: it pulls `/api/sync/delta` (authoritative)
// rather than trusting the frame's contents, so the frame only needs to say
// "something advanced to <cursor>". `entities` lets the client skip a pull when
// nothing it cares about moved; it is advisory, never the source of truth.
export interface SyncFrame {
  cursor: number;
  entities: Array<{ entity: string; entityId: string; op: 'upsert' | 'delete' }>;
  workspaceId: string | null;
}

function writeFrame(userIds: Iterable<string>, data: string): void {
  for (const uid of userIds) {
    const conns = clients.get(uid);
    if (!conns) continue;
    for (const res of conns) {
      try {
        res.write(data);
      } catch {
        conns.delete(res);
      }
    }
  }
}

/**
 * Push a structured sync frame to every connected device of every user in
 * `userIds`. This is the cross-user fan-out: the sync dispatcher resolves the
 * audience (workspace members + owner + public contributors) and calls this so
 * a collaborator's edit reaches everyone who can see it — not just the author.
 */
export function broadcastToUsers(userIds: string[], frame: SyncFrame): void {
  if (userIds.length === 0) return;
  const data = `event: sync\ndata: ${JSON.stringify(frame)}\n\n`;
  writeFrame(userIds, data);
}

/**
 * Legacy single-user nudge (kept for back-compat with the many existing
 * mutation handlers that still call it). It emits a channel-tagged frame; the
 * frontend treats ANY sync frame as a nudge to pull deltas, so these remain a
 * useful same-user fallback even alongside the cursor-based dispatcher.
 */
export function broadcastToUser(userId: string, event: string): void {
  const userClients = clients.get(userId);
  if (!userClients || userClients.size === 0) return;
  const payload = `event: sync\ndata: ${JSON.stringify({ type: event })}\n\n`;
  writeFrame([userId], payload);
}

/**
 * Emergency broadcast to EVERY currently connected device of EVERY user,
 * regardless of who they are — used only by the admin "Nuke Everything"
 * action. A TRUNCATE does not fire row-level triggers, so the normal
 * sync_log/dispatch pipeline never sees a nuke; this is the dedicated,
 * out-of-band signal that every live tab must drop its cache and bail out to
 * /setup. The connections are then closed (there is nothing left to sync to).
 */
export function broadcastNukeToAll(): void {
  const data = `event: nuke\ndata: {}\n\n`;
  for (const userId of [...clients.keys()]) {
    const conns = clients.get(userId);
    if (!conns) continue;
    for (const res of conns) {
      try { res.write(data); res.end(); } catch { /* already gone */ }
    }
    clients.delete(userId);
  }
}
