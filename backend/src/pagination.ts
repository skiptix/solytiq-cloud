// ---------------------------------------------------------------------------
// B5 (Phase 2) — cursor (keyset) pagination primitive.
//
// Pure, dependency-free, side-effect-free (no DB access) — every exported
// function here is a plain data transform, unit-testable with no mocking.
// Route/builder code owns the actual SQL; this module only owns the OPAQUE
// cursor's shape, its encode/decode, and page-size clamping.
//
// Why keyset (cursor) pagination and not OFFSET/LIMIT: every workspace-scoped
// list in this codebase is ordered `ORDER BY position ASC, created_at ASC`.
// `OFFSET N` forces Postgres to walk and discard the first N matching rows on
// EVERY page — cost grows linearly with how deep into the list a client has
// paged, which is exactly the "doesn't scale" failure mode B5 exists to close
// (see the B6 100k-row seed evidence: a scan that's cheap at row 1 is not
// cheap at row 90,000). A keyset cursor instead encodes the LAST ROW SEEN
// (`position`, `created_at`, `id` — `id` is the necessary tiebreaker since
// `position` and even millisecond `created_at` can collide within a bulk
// insert) and the next page's WHERE clause is a plain row-comparison
// (`(position, created_at, id) > (cursorPosition, cursorCreatedAt, cursorId)`)
// that Postgres can push straight through whatever index already orders the
// table that way — page 90,000 costs the same as page 1.
//
// The cursor is intentionally OPAQUE to the client (base64url of a small JSON
// object) — this is standard cursor-pagination practice (GitHub's API, etc.):
// it keeps the wire contract stable even if the encoded shape changes later,
// and it stops a client from hand-constructing an out-of-range/malformed
// cursor and expecting a particular query-plan behavior from it. A malformed
// or tampered cursor decodes to `null` here and the caller treats that as "no
// cursor" (first page) — never a 500, never a SQL injection surface (the
// decoded fields are used purely as parameterized query values, never
// interpolated into SQL text).
// ---------------------------------------------------------------------------

export interface KeysetCursor {
  /** The `position` column value of the last row on the previous page. */
  position: number;
  /**
   * The last row's `created_at`, as a UTC epoch-SECONDS float (i.e. SQL
   * `EXTRACT(EPOCH FROM created_at)`) — deliberately NOT an ISO string or a
   * JS `Date`. `timestamptz` is stored by Postgres with microsecond
   * precision, but this app's `pg` type-parser config (db.ts) leaves
   * `timestamptz` on its DEFAULT parser, which returns a JS `Date` —
   * millisecond precision only. `JSON.stringify`ing a `Date` (as encoding
   * this cursor would) calls `.toISOString()`, silently truncating any
   * sub-millisecond remainder. For a WHERE-clause boundary comparison that
   * must be exact — the whole point of a keyset cursor is to STRICTLY
   * exclude the row it was captured from — that truncation is a real bug:
   * a row whose stored `created_at` has a non-zero microsecond remainder
   * compares as "still greater than" its own truncated cursor value and
   * gets re-included on the next page (proven by
   * `pagination.integration.test.ts`, which is what caught this before it
   * shipped). `EXTRACT(EPOCH ...)` sidesteps it entirely: it's a plain
   * `double precision` number, timezone-independent by construction (a
   * `timestamptz` denotes one absolute instant), and round-trips through
   * `JSON.stringify`/`JSON.parse` EXACTLY — per the ECMAScript spec,
   * `Number#toString` always produces the shortest decimal string that
   * parses back to the identical IEEE-754 float64 bit pattern.
   */
  createdAt: number;
  /** The `id` column value (stringified — covers both BIGINT and VARCHAR id columns) of the last row on the previous page. */
  id: string;
}

// Phase 2 spec, verbatim: "Default höchstens 50, hartes Maximum 100." These
// two numbers ARE the spec — do not raise them for convenience; a caller
// that needs more rows pages through multiple requests via `nextCursor`
// instead. (An earlier draft of this module shipped 200/1000 — 4-10x over
// spec — caught in review; see pagination.test.ts's dedicated bound tests
// so this can never silently drift back.)
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

/** Every entity type this app paginates by keyset, gated behind this cap so a
 *  single bootstrap/list response can never grow unbounded regardless of how
 *  large the underlying workspace is. See routes/sync.ts's bootstrap use. */
export const BOOTSTRAP_MAX_ROWS_PER_ENTITY = 2000;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Shared, shape-agnostic wire encoding for every cursor type this module
 *  defines — plain JSON + base64url. Never throws (a cursor is always a
 *  plain, JSON-serializable object by construction). */
function encodeCursor<C>(cursor: C): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Encodes a cursor into the opaque, URL-safe string a client round-trips
 *  back via `?cursor=`. Never throws. */
export function encodeKeysetCursor(cursor: KeysetCursor): string {
  return encodeCursor(cursor);
}

/**
 * Decodes a client-supplied cursor string. Returns `null` for anything
 * missing, malformed, non-JSON, wrong-shaped, or otherwise untrusted — the
 * caller's job is to then treat that exactly like "no cursor" (first page),
 * never to surface a decode failure as an error. This is deliberate: a stale
 * cursor from a client that hasn't refreshed in a while should degrade to
 * "start over," not break the request.
 */
export function decodeKeysetCursor(raw: unknown): KeysetCursor | null {
  if (!isNonEmptyString(raw)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.position === 'number' && Number.isFinite(obj.position) &&
    typeof obj.createdAt === 'number' && Number.isFinite(obj.createdAt) &&
    isNonEmptyString(obj.id)
  ) {
    return { position: obj.position, createdAt: obj.createdAt, id: obj.id };
  }
  return null;
}

/**
 * A keyset cursor for entities with NO `position` column — ordered purely by
 * `created_at DESC, id DESC` (e.g. `shared_files`/"Dateien": files are never
 * manually reordered, only ever listed newest-first). Same `createdAt`
 * epoch-seconds convention and same reasoning as `KeysetCursor.createdAt`
 * above (see its doc comment) — a plain two-column tuple rather than
 * `KeysetCursor`'s three, since there's no `position` to compare.
 */
export interface CreatedAtCursor {
  /** UTC epoch-SECONDS float — `EXTRACT(EPOCH FROM created_at)::double precision`, never a `Date`/ISO string. See `KeysetCursor.createdAt`'s doc comment for exactly why. */
  createdAt: number;
  /** The `id` column value (stringified) of the last row on the previous page. */
  id: string;
}

export function encodeCreatedAtCursor(cursor: CreatedAtCursor): string {
  return encodeCursor(cursor);
}

/** Same fail-closed-to-null contract as `decodeKeysetCursor` — see its doc
 *  comment. */
export function decodeCreatedAtCursor(raw: unknown): CreatedAtCursor | null {
  if (!isNonEmptyString(raw)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.createdAt === 'number' && Number.isFinite(obj.createdAt) &&
    isNonEmptyString(obj.id)
  ) {
    return { createdAt: obj.createdAt, id: obj.id };
  }
  return null;
}

/**
 * Clamps a client-supplied `?limit=` to a safe range. Never throws, never
 * returns something a query could treat as "unbounded" (0/negative/NaN all
 * fall back to the default rather than being passed through).
 */
export function parsePageLimit(raw: unknown, opts: { default?: number; max?: number } = {}): number {
  const fallback = opts.default ?? DEFAULT_PAGE_LIMIT;
  const max = opts.max ?? MAX_PAGE_LIMIT;
  const n = typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0) return Math.min(fallback, max);
  return Math.min(Math.trunc(n), max);
}

/**
 * Given a page of rows (already ORDERed the way the cursor's own columns
 * compare — the caller fetched `limit + 1` rows to detect overflow) and an
 * accessor that reads the cursor's columns off a raw row, returns the page
 * to actually return to the caller plus the next cursor (`null` when this
 * was the last page). Pure — no DB, no I/O.
 *
 * Generic over the cursor SHAPE (`C`) rather than hardcoded to
 * `KeysetCursor` — `routes/tasks.ts` passes `encodeKeysetCursor` (the
 * 3-column position/createdAt/id cursor), `routes/files.ts` passes
 * `encodeCreatedAtCursor` (the 2-column createdAt/id cursor for entities
 * with no `position`) — same pagination MECHANISM, different cursor
 * CONTENTS per entity.
 */
export function paginateRows<T, C>(
  rows: T[],
  limit: number,
  getKeyset: (row: T) => C,
  encode: (cursor: C) => string
): { page: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  if (!hasMore || page.length === 0) return { page, nextCursor: null };
  return { page, nextCursor: encode(getKeyset(page[page.length - 1])) };
}
