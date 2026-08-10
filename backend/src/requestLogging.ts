// ---------------------------------------------------------------------------
// B9 (Phase 2) — structured (JSON) per-request access logging + request-id
// correlation.
//
// Replaces nothing: the app's existing `wlog`/`wwarn`/`werr` (workspaceUtil.ts)
// human-readable, emoji-prefixed console logs stay exactly as they are — this
// is an ADDITIVE second log line per request, machine-parseable (one JSON
// object per line, the standard "structured logging" convention any log
// aggregator — CloudWatch, Loki, Datadog, a plain `jq` pipeline — can ingest
// without a custom parser), emitted once per request on `res.on('finish')`.
//
// Request-id correlation: honors an inbound `X-Request-Id` (a load balancer
// or upstream proxy's own trace id) when present, else mints one; always
// echoes it back as a response header so a client (or another hop in a
// multi-service call chain) can correlate its own logs against this
// service's. Exported separately (`getOrAssignRequestId`) so it's reusable
// without pulling in the logging side effect.
// ---------------------------------------------------------------------------

import type { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import { globalRequestMetrics } from './requestMetrics';

const REQUEST_ID_HEADER = 'x-request-id';

export function generateRequestId(): string {
  return crypto.randomBytes(12).toString('hex');
}

/** Reads an inbound X-Request-Id (first value if the header was somehow sent
 *  more than once) or mints a fresh one. Pure given its input. */
export function getOrAssignRequestId(inboundHeader: string | string[] | undefined): string {
  const raw = Array.isArray(inboundHeader) ? inboundHeader[0] : inboundHeader;
  if (typeof raw === 'string' && raw.trim().length > 0 && raw.length <= 200) {
    return raw.trim();
  }
  return generateRequestId();
}

/**
 * Reduces an Express route to its PATTERN (e.g. `/api/tasks/:id`), not the
 * raw URL with real ids/tokens/query strings baked in — so a metrics/log
 * line can never leak a share token, a numeric task id, or a query param
 * value. Falls back to the raw path (still without the query string) when
 * Express hasn't resolved a matched route yet (e.g. a 404 on an unknown
 * path — there is no route pattern to report).
 */
function routeLabel(req: Request): string {
  const matched = (req as unknown as { route?: { path?: string } }).route?.path;
  if (typeof matched === 'string') {
    // req.baseUrl is the mount prefix (e.g. "/api/tasks") the router was
    // mounted under; req.route.path is relative to that mount.
    return `${req.baseUrl || ''}${matched}` || req.path;
  }
  return req.path;
}

/**
 * Express middleware: assigns/reads a request id, times the request, and on
 * `finish` emits ONE structured JSON log line + records the sample into the
 * shared metrics ring buffer. Mount this EARLY (before routes) so the id is
 * available to every downstream handler via `res.locals.requestId` and the
 * response header is set before any route can start streaming a body.
 */
export function requestLoggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = getOrAssignRequestId(req.headers[REQUEST_ID_HEADER]);
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const route = routeLabel(req);
    globalRequestMetrics.record({ durationMs, status: res.statusCode, method: req.method, route });
    const line = {
      ts: new Date().toISOString(),
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      msg: 'http_request',
      requestId,
      method: req.method,
      route,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      // req.userId is set by the auth middleware AFTER this middleware runs
      // (it's mounted before routes, auth middleware runs per-route) — by
      // the time `finish` fires the request is fully done, so it's safe to
      // read here. Never logs a token/password — userId only, an opaque
      // identifier, matching the same posture the rest of the app already
      // takes toward what's safe to log (see aiTools.ts's userId-scoping
      // convention).
      userId: (req as unknown as { userId?: string }).userId ?? null,
    };
    console.log(JSON.stringify(line));
  });

  next();
}
