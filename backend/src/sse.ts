import type { Request, Response } from 'express';
import { pool, query as dbQuery } from './db';
import { verifyToken } from './auth';
import { consumeAssetTicket } from './assetTickets';

interface SseClient {
  res: Response;
  /** `token_version` at connect time — re-checked by sweepStaleSseConnections()
   *  so a password change / forced logout / 2FA toggle closes any already-open
   *  stream, not just new connection attempts (S4: "same revocation checks as
   *  a normal API request, applied to long-lived connections too"). */
  tokenVersion: number;
  /** Present for a mobile-app session — re-checked the same way a normal
   *  request's `authenticate` middleware does (device revoked / mobile
   *  access disabled instance-wide). */
  connectionId?: string;
}

const clients = new Map<string, Set<SseClient>>();

// SECURITY (S4): cap simultaneous SSE connections per user. Before this,
// nothing stopped an unbounded number of open streams accumulating for one
// user (a stuck reconnect loop, or a stolen-but-not-yet-revoked token kept
// alive indefinitely) — each one is a live file descriptor + heartbeat timer
// held open server-side.
const MAX_CONNECTIONS_PER_USER = 8;

export function addSseClient(userId: string, res: Response, tokenVersion: number, connectionId?: string): void {
  if (!clients.has(userId)) clients.set(userId, new Set());
  const set = clients.get(userId)!;
  if (set.size >= MAX_CONNECTIONS_PER_USER) {
    const oldest = set.values().next().value as SseClient | undefined;
    if (oldest) {
      try { oldest.res.end(); } catch { /* already gone */ }
      set.delete(oldest);
    }
  }
  set.add({ res, tokenVersion, connectionId });
}

export function removeSseClient(userId: string, res: Response): void {
  const set = clients.get(userId);
  if (!set) return;
  for (const c of set) {
    if (c.res === res) { set.delete(c); break; }
  }
  if (set.size === 0) clients.delete(userId);
}

/**
 * The real `GET /api/events` handler — extracted out of index.ts (which now
 * just does `app.get('/api/events', handleSseEventsRequest)`) so an
 * integration test can mount and exercise the EXACT production code path
 * instead of a hand-copied stand-in that could silently drift from it and
 * pass even if the real route regressed. See auth.ts's Authorization-header
 * vs assetTickets.ts's `?ticket=` dual auth, and this module's header comment
 * above on why connectionId must be threaded through to addSseClient() for
 * mobile-device revocation to actually work.
 */
export async function handleSseEventsRequest(req: Request, res: Response): Promise<void> {
  const headerToken = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
  const ticketParam = typeof req.query.ticket === 'string' ? req.query.ticket : null;

  let userId: string;
  let connectionId: string | undefined;
  if (headerToken) {
    try {
      ({ userId, connectionId } = verifyToken(headerToken));
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
  } else if (ticketParam) {
    const consumed = consumeAssetTicket(ticketParam, 'sse');
    if (!consumed) {
      res.status(401).json({ error: 'Invalid or expired ticket' });
      return;
    }
    userId = consumed.userId;
  } else {
    res.status(401).json({ error: 'Missing credentials' });
    return;
  }

  // Snapshot the user's CURRENT token_version so sweepStaleSseConnections()
  // can detect a LATER revocation (password change, forced logout, 2FA
  // toggle) for the whole lifetime of this now-open stream — the ticket/JWT
  // check above only proves validity at the moment of connecting.
  const userRow = await dbQuery<{ token_version: number }>('SELECT token_version FROM users WHERE id = $1', [userId]);
  if (userRow.rows.length === 0) {
    res.status(401).json({ error: 'User not found' });
    return;
  }
  const tokenVersion = userRow.rows[0].token_version;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(': connected\n\n');

  addSseClient(userId, res, tokenVersion, connectionId);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeSseClient(userId, res);
  });
}

/**
 * SECURITY (S4): re-run the SAME revocation checks `middleware.ts`'s
 * `authenticate` applies to every ordinary API request, against every
 * currently-open SSE stream — a long-lived connection that authenticated
 * once at connect time otherwise never re-validates for the life of the
 * stream, so a password change, forced logout (`token_version` bump), 2FA
 * toggle, revoked mobile device, or an admin disabling mobile access
 * instance-wide would only block the NEXT reconnect, leaving the already-
 * open stream (and the realtime data it keeps pushing) alive indefinitely.
 * Registered on a short interval in index.ts's start(), same pattern as the
 * other periodic sweeps.
 */
export async function sweepStaleSseConnections(): Promise<void> {
  if (clients.size === 0) return;
  const userIds = [...clients.keys()];

  const usersRes = await pool.query<{ id: string; token_version: number }>(
    `SELECT id, token_version FROM users WHERE id = ANY($1::uuid[])`,
    [userIds]
  );
  const currentTokenVersion = new Map(usersRes.rows.map((r) => [r.id, r.token_version]));

  const connectionIds = [...clients.values()].flatMap((set) => [...set].map((c) => c.connectionId).filter((x): x is string => !!x));
  let validConnectionIds = new Set<string>();
  let mobileEnabled = true;
  if (connectionIds.length > 0) {
    const [connRes, settingRes] = await Promise.all([
      pool.query<{ id: string }>(`SELECT id FROM mobile_connections WHERE id = ANY($1::uuid[])`, [connectionIds]),
      pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'mobile_app_enabled'`),
    ]);
    validConnectionIds = new Set(connRes.rows.map((r) => r.id));
    mobileEnabled = settingRes.rows[0]?.value !== 'false';
  }

  for (const userId of userIds) {
    const set = clients.get(userId);
    if (!set) continue;
    // A user deleted mid-stream (admin removed the account) has no row at
    // all — current() is undefined, which never matches any stored version,
    // so every one of their connections is correctly closed below.
    const current = currentTokenVersion.get(userId);
    for (const client of [...set]) {
      const tokenStale = current === undefined || client.tokenVersion !== current;
      const mobileRevoked = !!client.connectionId && (!mobileEnabled || !validConnectionIds.has(client.connectionId));
      if (tokenStale || mobileRevoked) {
        try { client.res.end(); } catch { /* already gone */ }
        set.delete(client);
      }
    }
    if (set.size === 0) clients.delete(userId);
  }
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
    for (const c of conns) {
      try {
        c.res.write(data);
      } catch {
        conns.delete(c);
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
    for (const c of conns) {
      try { c.res.write(data); c.res.end(); } catch { /* already gone */ }
    }
    clients.delete(userId);
  }
}

/** Test-only: current connection count for a user, and a full reset. */
export function __sseConnectionCountForTests(userId: string): number {
  return clients.get(userId)?.size ?? 0;
}
export function __clearAllSseClientsForTests(): void {
  clients.clear();
}
/** Test-only: the connectionId(s) currently registered for a user's open SSE
 *  connections — lets a test prove a real request handler actually threaded
 *  a connectionId into addSseClient() end-to-end, not just that the sweep's
 *  own logic is correct in isolation. */
export function __getSseClientConnectionIdsForTests(userId: string): (string | undefined)[] {
  return [...(clients.get(userId) ?? [])].map((c) => c.connectionId);
}
