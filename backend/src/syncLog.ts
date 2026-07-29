// ---------------------------------------------------------------------------
// Sync dispatcher — the realtime "nudge" half of the delta-sync engine.
//
// The transactional outbox (the `sync_log` table) is written by database
// TRIGGERS (see runMigrations in index.ts), so EVERY committed mutation — from
// any route, the AI tools, or the CalDAV server — is recorded in the same
// transaction, and it is impossible to forget to log a write. Each trigger also
// `pg_notify`s a compact descriptor of the change.
//
// This module LISTENs for those notifications on a dedicated connection,
// resolves the audience (everyone who can currently SEE the changed workspace),
// and pushes a cursor-tagged SSE frame to all of their devices. The frame is a
// nudge: clients pull `/api/sync/delta` (authoritative) to actually advance.
//
// Design note: the notify→audience→broadcast seam (`dispatch`) is deliberately
// isolated so a Redis pub/sub backplane can replace LISTEN/NOTIFY later for
// horizontal scaling without touching any call site. No Redis today (single
// backend container), per the architecture decision.
// ---------------------------------------------------------------------------

import { Client } from 'pg';
import { query } from './db';
import { broadcastToUsers } from './sse';

export type SyncEntity =
  | 'task' | 'list' | 'folder' | 'timeline' | 'milestone'
  | 'workspace' | 'trash' | 'meeting' | 'file' | 'automation' | 'markdownList'
  | 'notification' | 'link';

/** The channel Postgres triggers NOTIFY on. */
export const SYNC_CHANNEL = 'solytiq_sync';

interface NotifyPayload {
  seq: number;
  entity: SyncEntity;
  entityId: string;
  op: 'upsert' | 'delete';
  workspaceId: string | null;
  ownerId: string;
}

/**
 * Everyone who can currently SEE this workspace's content (members + owner +,
 * for public workspaces, anyone who has contributed content to it). Mirrors the
 * read-side access model in `buildListsForUser` / `userCanAccessWorkspace`, so
 * the push audience matches who the delta endpoint would actually serve.
 *
 * A NULL workspace (meetings, files, user-global rows) is owner-only.
 */
export async function resolveWorkspaceAudience(
  workspaceId: string | null,
  ownerId: string,
): Promise<string[]> {
  if (!workspaceId) return [ownerId];
  const r = await query<{ user_id: string }>(
    `SELECT user_id FROM workspace_members WHERE workspace_id = $1
     UNION SELECT owner_id AS user_id FROM workspaces WHERE id = $1
     UNION SELECT c.user_id FROM (
        SELECT user_id FROM lists     WHERE workspace_id = $1
        UNION SELECT user_id FROM timelines WHERE workspace_id = $1
        UNION SELECT user_id FROM folders   WHERE workspace_id = $1
        UNION SELECT user_id FROM tasks     WHERE workspace_id = $1
        UNION SELECT user_id FROM automations WHERE workspace_id = $1
     ) c
     WHERE EXISTS (SELECT 1 FROM workspaces w WHERE w.id = $1 AND w.visibility = 'public')`,
    [workspaceId],
  );
  const set = new Set<string>(r.rows.map((x) => x.user_id));
  set.add(ownerId);
  return [...set];
}

/**
 * Resolve the audience for a change and fan a cursor-tagged frame out to all of
 * their devices. Never throws into its caller — SSE is best-effort; clients
 * still converge via `/api/sync/delta` on focus / online / reconnect / poll.
 * (Replace this body with a Redis publish to scale horizontally.)
 */
export async function dispatch(frame: {
  cursor: number;
  workspaceId: string | null;
  ownerId: string;
  entities: Array<{ entity: string; entityId: string; op: 'upsert' | 'delete' }>;
}): Promise<void> {
  try {
    const audience = await resolveWorkspaceAudience(frame.workspaceId, frame.ownerId);
    broadcastToUsers(audience, {
      cursor: frame.cursor,
      entities: frame.entities,
      workspaceId: frame.workspaceId,
    });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Coalescing buffer — a burst of trigger notifications (e.g. a reorder that
// touches 30 rows) collapses into one frame per workspace, cutting audience
// lookups and SSE writes to O(workspaces) instead of O(rows).
// ---------------------------------------------------------------------------

interface Pending {
  cursor: number;
  workspaceId: string | null;
  ownerId: string;
  entities: Map<string, { entity: string; entityId: string; op: 'upsert' | 'delete' }>;
}

const FLUSH_MS = 80;
const MAX_ENTITIES_PER_FRAME = 200;
const pending = new Map<string, Pending>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function enqueue(p: NotifyPayload): void {
  const key = p.workspaceId ?? `owner:${p.ownerId}`;
  let bucket = pending.get(key);
  if (!bucket) {
    bucket = { cursor: p.seq, workspaceId: p.workspaceId, ownerId: p.ownerId, entities: new Map() };
    pending.set(key, bucket);
  }
  if (p.seq > bucket.cursor) bucket.cursor = p.seq;
  if (bucket.entities.size < MAX_ENTITIES_PER_FRAME) {
    bucket.entities.set(`${p.entity}:${p.entityId}:${p.op}`, {
      entity: p.entity, entityId: p.entityId, op: p.op,
    });
  }
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

function flush(): void {
  flushTimer = null;
  const buckets = [...pending.values()];
  pending.clear();
  for (const b of buckets) {
    void dispatch({
      cursor: b.cursor,
      workspaceId: b.workspaceId,
      ownerId: b.ownerId,
      entities: [...b.entities.values()],
    });
  }
}

// ---------------------------------------------------------------------------
// LISTEN loop — a dedicated, self-healing connection (kept out of the query
// pool so a permanent LISTEN never starves request handlers).
// ---------------------------------------------------------------------------

let listenClient: Client | null = null;
let stopped = false;
let reconnecting = false;

function connectionConfig() {
  return {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'solytiq',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
  };
}

async function connectListener(): Promise<void> {
  if (stopped) return;
  const client = new Client(connectionConfig());
  listenClient = client;

  client.on('notification', (msg) => {
    if (!msg.payload) return;
    try {
      enqueue(JSON.parse(msg.payload) as NotifyPayload);
    } catch {
      /* ignore malformed */
    }
  });

  // Guarded so a single failure can't schedule twice — a connection error fires
  // BOTH 'error' (which calls end()) AND the resulting 'end', which would
  // otherwise spawn two reconnect timers → two LISTEN clients accumulating.
  const scheduleReconnect = () => {
    if (stopped || reconnecting) return;
    reconnecting = true;
    listenClient = null;
    setTimeout(() => { reconnecting = false; void connectListener(); }, 2000);
  };

  client.on('error', (err) => {
    console.error('📡 sync dispatcher connection error:', err.message);
    try { void client.end(); } catch { /* ignore */ }
    scheduleReconnect();
  });
  client.on('end', scheduleReconnect);

  try {
    await client.connect();
    await client.query(`LISTEN ${SYNC_CHANNEL}`);
    console.log('📡 sync dispatcher listening for realtime changes.');
  } catch (err) {
    console.error('📡 sync dispatcher failed to connect; retrying in 2s:', (err as Error).message);
    scheduleReconnect();
  }
}

/** Start the realtime dispatcher. Idempotent; safe to call once at boot. */
export async function startSyncDispatcher(): Promise<void> {
  stopped = false;
  await connectListener();
}
