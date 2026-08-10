// ---------------------------------------------------------------------------
// B9 (Phase 2) — in-process HTTP request-latency metrics.
//
// Pure, dependency-free (no prom-client / no external time-series DB) — the
// SAME "hand-roll a narrow, self-contained need instead of adding a
// dependency" convention this codebase already applies elsewhere (the
// Automation Hub's http_request action reuses global `fetch` rather than a
// new HTTP client; `graph/metrics.ts`'s pagerank sweep is a hand-rolled
// power-iteration rather than a graph library). A percentile snapshot over
// the last N requests is sufficient for "is this instance healthy / how is
// it performing right now" — a full historical time series belongs in a real
// metrics backend (Prometheus, etc.), which is explicitly out of scope here
// (see DEPRECATIONS.md-style framing: this is a floor, not a replacement for
// real observability infrastructure a production deploy should still add).
//
// Bounded memory by construction: a fixed-size ring buffer (default 2000
// samples) means memory usage never grows with request volume/uptime, unlike
// an unbounded array of every request ever seen.
// ---------------------------------------------------------------------------

export interface RequestSample {
  durationMs: number;
  status: number;
  method: string;
  /** The route PATTERN (e.g. `/api/tasks/:id`), not the raw URL — never a
   *  literal id/token, so this can never leak PII/secrets into metrics. */
  route: string;
}

export interface MetricsSnapshot {
  /** Total requests observed since process start (NOT bounded by the ring
   *  buffer size — this counter never wraps/resets, unlike the percentile
   *  window below). */
  totalRequests: number;
  /** How many samples the percentiles below were computed from (<= ring
   *  buffer capacity — the most recent window, not all-time). */
  windowSize: number;
  /** Latency percentiles in milliseconds over the current window. `null`
   *  when the window is empty (no requests yet). */
  p50: number | null;
  p95: number | null;
  p99: number | null;
  /** Count of 5xx responses within the current window — a quick
   *  "is anything currently erroring" signal without needing a log scrape. */
  errorCount5xx: number;
}

const DEFAULT_RING_SIZE = 2000;

/**
 * A fixed-capacity ring buffer of the most recent request samples. Exported
 * as a class (not a singleton) so it's unit-testable in isolation; `index.ts`
 * holds ONE process-wide instance (see `globalRequestMetrics` below) that the
 * request-logging middleware feeds and `/metrics` reads.
 */
export class RequestMetricsRingBuffer {
  private readonly capacity: number;
  private readonly durations: number[] = [];
  private readonly statuses: number[] = [];
  private writeIndex = 0;
  private filled = false;
  private totalRequests = 0;

  constructor(capacity: number = DEFAULT_RING_SIZE) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error('RequestMetricsRingBuffer capacity must be a positive finite number');
    }
    this.capacity = Math.trunc(capacity);
  }

  record(sample: RequestSample): void {
    this.totalRequests++;
    this.durations[this.writeIndex] = sample.durationMs;
    this.statuses[this.writeIndex] = sample.status;
    this.writeIndex++;
    if (this.writeIndex >= this.capacity) {
      this.writeIndex = 0;
      this.filled = true;
    }
  }

  private currentWindow(): { durations: number[]; statuses: number[] } {
    const len = this.filled ? this.capacity : this.writeIndex;
    return { durations: this.durations.slice(0, len), statuses: this.statuses.slice(0, len) };
  }

  snapshot(): MetricsSnapshot {
    const { durations, statuses } = this.currentWindow();
    const sorted = [...durations].sort((a, b) => a - b);
    return {
      totalRequests: this.totalRequests,
      windowSize: sorted.length,
      p50: percentile(sorted, 0.50),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      errorCount5xx: statuses.filter((s) => s >= 500).length,
    };
  }
}

/**
 * Nearest-rank percentile over an ALREADY-SORTED ascending array. Pure.
 * Returns null for an empty array rather than NaN/undefined — a caller
 * checking `p50 !== null` never has to also special-case NaN.
 */
export function percentile(sortedAscending: number[], p: number): number | null {
  if (sortedAscending.length === 0) return null;
  if (p <= 0) return sortedAscending[0];
  if (p >= 1) return sortedAscending[sortedAscending.length - 1];
  const rank = Math.ceil(p * sortedAscending.length) - 1;
  const clamped = Math.min(Math.max(rank, 0), sortedAscending.length - 1);
  return sortedAscending[clamped];
}

/** The one process-wide instance the request-logging middleware feeds and
 *  `/metrics` reads — see index.ts's wiring. */
export const globalRequestMetrics = new RequestMetricsRingBuffer();
