import type { Request, Response } from 'express';
import { pool, query as dbQuery } from './db';
import { verifyToken } from './auth';
import { consumeAssetTicket } from './assetTickets';
import { SSE_MAX_CONNECTIONS_PER_USER, SSE_MAX_QUEUE_BYTES, SSE_MAX_CONNECTION_AGE_MS } from './sseConfig';

interface SseClient {
  res: Response;
  userId: string;
  /** `token_version` at connect time — re-checked by sweepStaleSseConnections()
   *  so a password change / forced logout / 2FA toggle closes any already-open
   *  stream, not just new connection attempts (S4: "same revocation checks as
   *  a normal API request, applied to long-lived connections too"). */
  tokenVersion: number;
  /** Present for a mobile-app session — re-checked the same way a normal
   *  request's `authenticate` middleware does (device revoked / mobile
   *  access disabled instance-wide). */
  connectionId?: string;
  /** B7: connect time, in ms since epoch — used to force-close connections
   *  past SSE_MAX_CONNECTION_AGE_MS (see sweepStaleSseConnections below). */
  connectedAt: number;
  /** B7 backpressure state — see enqueueWrite/flushQueue. `paused` is true
   *  once `res.write()` has returned false and we're waiting for 'drain';
   *  while paused, further frames go into `queue` (bounded by
   *  SSE_MAX_QUEUE_BYTES) instead of being written directly. */
  paused: boolean;
  queue: string[];
  queuedBytes: number;
}

const clients = new Map<string, Set<SseClient>>();

// B7: cap simultaneous SSE connections per user (S4 originally introduced
// this; B7 makes the limit centrally configurable — see sseConfig.ts — and
// lowers the default to the value the Phase 2 spec calls out explicitly).
// Before ANY of this existed, nothing stopped an unbounded number of open
// streams accumulating for one user (a stuck reconnect loop, or a
// stolen-but-not-yet-revoked token kept alive indefinitely) — each one is a
// live file descriptor + heartbeat timer held open server-side.
export function addSseClient(userId: string, res: Response, tokenVersion: number, connectionId?: string): void {
  if (!clients.has(userId)) clients.set(userId, new Set());
  const set = clients.get(userId)!;
  if (set.size >= SSE_MAX_CONNECTIONS_PER_USER) {
    const oldest = set.values().next().value as SseClient | undefined;
    if (oldest) {
      try { oldest.res.end(); } catch { /* already gone */ }
      set.delete(oldest);
    }
  }
  set.add({ res, userId, tokenVersion, connectionId, connectedAt: Date.now(), paused: false, queue: [], queuedBytes: 0 });
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
 * B7 — SSE backpressure. `res.write()` returns `false` when Node's internal
 * write buffer for this socket is full (the client isn't reading as fast as
 * we're writing — a suspended tab, a slow/stalled network path). Before
 * this, every write site (`writeFrame`, the heartbeat, `broadcastNukeToAll`)
 * ignored that return value entirely, so a non-reading client's buffered,
 * UNSENT bytes could grow without limit, held in this process's memory for
 * as long as the (dead-but-not-yet-detected) connection stayed "open".
 *
 * `enqueueWrite` is now the ONE place any frame reaches a client's socket:
 *   - Not currently backed up → write directly; if THAT returns false, flip
 *     to `paused` and register a one-time `'drain'` listener.
 *   - Already backed up → buffer the frame instead of writing it, bounded by
 *     SSE_MAX_QUEUE_BYTES; exceeding that bound means this client is falling
 *     behind badly enough that RESPECTING it any further would mean holding
 *     unbounded memory hostage to one unresponsive connection, so the
 *     connection is dropped instead — the client's own EventSource
 *     reconnects and resyncs via `/api/sync/delta` (every SSE frame is a
 *     nudge, never the source of truth — see syncLog.ts), so dropping one
 *     is always safe, never a data-loss event.
 */
function enqueueWrite(client: SseClient, data: string): void {
  if (!client.paused) {
    let ok: boolean;
    try {
      ok = client.res.write(data);
    } catch {
      dropSseClient(client);
      return;
    }
    if (!ok) {
      client.paused = true;
      client.res.once('drain', () => flushSseQueue(client));
    }
    return;
  }
  const bytes = Buffer.byteLength(data);
  if (client.queuedBytes + bytes > SSE_MAX_QUEUE_BYTES) {
    dropSseClient(client); // see function header — bounded queue, not unbounded memory
    return;
  }
  client.queue.push(data);
  client.queuedBytes += bytes;
}

function flushSseQueue(client: SseClient): void {
  client.paused = false;
  while (client.queue.length > 0) {
    const next = client.queue[0];
    let ok: boolean;
    try {
      ok = client.res.write(next);
    } catch {
      dropSseClient(client);
      return;
    }
    client.queue.shift();
    client.queuedBytes -= Buffer.byteLength(next);
    if (!ok) {
      client.paused = true;
      client.res.once('drain', () => flushSseQueue(client));
      return;
    }
  }
}

function dropSseClient(client: SseClient): void {
  try { client.res.end(); } catch { /* already gone */ }
  removeSseClient(client.userId, client.res);
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
  // B7: every write past the initial handshake above goes through
  // enqueueWrite's backpressure handling — including the heartbeat itself,
  // which would otherwise keep writing into a backed-up socket's buffer
  // every 25s regardless of whether the client is still reading.
  const client = [...(clients.get(userId) ?? [])].find((c) => c.res === res);

  const heartbeat = setInterval(() => {
    if (!client) return;
    enqueueWrite(client, ': ping\n\n');
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
export async function sweepStaleSseConnections(now: number = Date.now()): Promise<void> {
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
      // B7: force-close a connection past its max age (see sseConfig.ts) —
      // the client's own EventSource reconnects transparently, so this is
      // invisible to the user and bounds how long a single connection (and
      // whatever it re-validated at connect time) can go without a fresh
      // handshake.
      const tooOld = now - client.connectedAt > SSE_MAX_CONNECTION_AGE_MS;
      if (tokenStale || mobileRevoked || tooOld) {
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
    // Snapshot before iterating — enqueueWrite can synchronously call
    // dropSseClient (mutating `conns` via removeSseClient) on a write error
    // or an over-budget queue, which would otherwise invalidate this Set's
    // iterator mid-loop.
    for (const c of [...conns]) {
      enqueueWrite(c, data);
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

/**
 * B8 — graceful shutdown: ends every open SSE stream (of every user, on THIS
 * process) and clears the registry. Called once from shutdown.ts's drain
 * sequence, before the HTTP server itself is closed — a still-open SSE
 * response counts as an in-flight connection to Node's HTTP server, which
 * would otherwise keep `server.close()`'s callback from ever firing.
 */
/**
 * B9 — a safe, aggregate-only snapshot for the `/metrics` endpoint: total
 * open connections, distinct connected users, and total queued (buffered,
 * not-yet-flushed — see the B7 backpressure queue) bytes across every
 * connection. Deliberately reports COUNTS only, never a user id/connection
 * id list — this is read from an unauthenticated endpoint (see index.ts's
 * `/metrics`, same posture as `/readyz`), so it must never become a way to
 * enumerate who is currently online.
 */
export function getSseConnectionStats(): { totalConnections: number; uniqueUsers: number; totalQueuedBytes: number } {
  let totalConnections = 0;
  let totalQueuedBytes = 0;
  for (const conns of clients.values()) {
    totalConnections += conns.size;
    for (const c of conns) totalQueuedBytes += c.queuedBytes;
  }
  return { totalConnections, uniqueUsers: clients.size, totalQueuedBytes };
}

export function closeAllSseConnectionsForShutdown(): void {
  for (const [userId, conns] of clients) {
    for (const c of conns) {
      try { c.res.end(); } catch { /* already gone */ }
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

/** B7 test-only: current backpressure queue state for every one of a user's
 *  connections — `{paused, queuedBytes, queueLength}` per connection, in
 *  the SAME iteration order as `clients.get(userId)`. */
export function __getSseQueueStateForTests(userId: string): Array<{ paused: boolean; queuedBytes: number; queueLength: number }> {
  return [...(clients.get(userId) ?? [])].map((c) => ({ paused: c.paused, queuedBytes: c.queuedBytes, queueLength: c.queue.length }));
}

/** B7 test-only: backdate a user's single open connection's `connectedAt` so
 *  sweepStaleSseConnections' max-age check can be exercised without a real
 *  sleep. Throws if the user doesn't have EXACTLY one open connection (the
 *  ambiguity of "which one" otherwise) — tests should set up exactly one. */
export function __setSseConnectionAgeForTests(userId: string, connectedAt: number): void {
  const set = clients.get(userId);
  if (!set || set.size !== 1) throw new Error(`__setSseConnectionAgeForTests requires exactly one open connection for ${userId}, found ${set?.size ?? 0}`);
  const client = [...set][0];
  client.connectedAt = connectedAt;
}
